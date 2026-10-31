import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	appendFileSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Forge, digest } from "../src/core.js";
import { renderAdapter } from "../src/adapters.js";
const a = { id: "alice", tenant: "one", role: "requester" } as const,
	b = { id: "bob", tenant: "one", role: "approver" } as const,
	o = { id: "runner", tenant: "one", role: "operator" } as const;
const spec = {
	name: "durable-network",
	module: "local-network-v1",
	cidr: "10.25.0.0/16",
	subnets: ["10.25.1.0/24"],
	ingress: [],
	iam: [],
	encrypted: true,
	tags: { owner: "platform", environment: "development" },
};
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "infraforge-life-"));
	const options = {
		key: randomBytes(32),
		database: join(dir, "forge.sqlite"),
		workspaces: join(dir, "workspaces"),
	};
	return { dir, options, forge: new Forge(() => Date.now(), options) };
}
test("SQLite restart retains approval, applies exact Terraform plan, then independently approves teardown", () => {
	const { dir, options, forge: f } = setup();
	try {
		const e = f.submit(a, spec);
		const plan = f.plan(a, e.id).plan!;
		assert.ok(plan.artifact?.json.resource_changes);
		f.approve(b, e.id, plan.digest);
		f.close();
		const g = new Forge(() => Date.now(), options);
		try {
			assert.equal(g.get(a, e.id).state, "approved");
			assert.equal(g.apply(o, e.id, plan.digest).state, "applied");
			assert.equal(g.drift(o, e.id).drift?.changed, false);
			assert.throws(() => g.destroy(o, e.id, plan.digest));
			const teardown = g.planDestroy(o, e.id).plan!;
			assert.notEqual(teardown.digest, plan.digest);
			assert.throws(() => g.destroy(o, e.id, teardown.digest));
			assert.throws(() => g.approve({ ...b, id: a.id }, e.id, teardown.digest));
			g.approve(b, e.id, teardown.digest);
			assert.equal(g.destroy(o, e.id, teardown.digest).state, "destroyed");
			assert.equal(g.destroy(o, e.id, teardown.digest).state, "destroyed");
			assert.equal(g.runner.observe(a.tenant, e.id).values, undefined);
			g.store.verify();
		} finally {
			g.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("tampered saved plan and changed state cannot consume an approval", () => {
	const { dir, forge: f } = setup();
	try {
		const e = f.submit(a, spec),
			p = f.plan(a, e.id).plan!;
		f.approve(b, e.id, p.digest);
		const path = join(
			dir,
			"workspaces",
			p.artifact!.workspace,
			"workspace.enc",
		);
		const envelope = JSON.parse(readFileSync(path, "utf8"));
		envelope.tag = Buffer.alloc(16).toString("base64");
		writeFileSync(path, JSON.stringify(envelope));
		assert.throws(() => f.apply(o, e.id, p.digest), /authentication/);
		assert.equal(f.get(a, e.id).state, "approved");
	} finally {
		f.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("uncertain execution is quarantined, cannot replay, and reconciliation proves local state", () => {
	const { dir, forge: f } = setup();
	try {
		const e = f.submit(a, spec),
			p = f.plan(a, e.id).plan!;
		f.approve(b, e.id, p.digest);
		const actual = f.runner.apply.bind(f.runner);
		f.runner.apply = (...args) => {
			actual(...args);
			throw Error("Injected loss after Terraform completion");
		};
		assert.throws(() => f.apply(o, e.id, p.digest), /uncertain/);
		assert.equal(f.get(a, e.id).state, "uncertain");
		assert.throws(() => f.apply(o, e.id, p.digest));
		assert.throws(() => f.revise(a, e.id, spec));
		assert.equal(f.reconcile(o, e.id).state, "applied");
		assert.equal(f.get(a, e.id).approval, undefined);
		assert.ok(f.audit.some((e) => e.action === "execution-uncertain"));
	} finally {
		f.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("transactions roll back state and audit together; separate connections see reservations", () => {
	const { dir, options, forge: f } = setup();
	const g = new Forge(() => Date.now(), options);
	try {
		assert.throws(() =>
			f.store.transaction(() => {
				f.store.event(a, "not-committed", "x", 0);
				throw Error("rollback");
			}),
		);
		assert.equal(f.audit.length, 0);
		f.submit(a, spec);
		assert.throws(() => g.submit(a, spec), /overlaps/);
		assert.equal(g.list(a).length, 1);
	} finally {
		f.close();
		g.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("modified audit records are detected on reopen", () => {
	const { dir, options, forge: f } = setup();
	f.submit(a, spec);
	f.close();
	try {
		const db = new DatabaseSync(options.database);
		db.exec(`UPDATE audit SET document='{}'`);
		db.close();
		assert.throws(() => new Forge(() => Date.now(), options), /authentication/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("cloud adapters render provider-specific networks but cannot execute or ignore unsafe policy", () => {
	for (const module of [
		"aws-network-v1",
		"azure-network-v1",
		"gcp-network-v1",
	]) {
		const { dir, forge: f } = setup();
		try {
			const e = f.submit(a, { ...spec, module });
			const plan = f.plan(a, e.id).plan!;
			assert.ok(plan.preview);
			assert.equal(plan.artifact, undefined);
			f.approve(b, e.id, plan.digest);
			assert.throws(
				() => f.apply(o, e.id, plan.digest),
				/Cloud execution is disabled/,
			);
			assert.equal(f.get(a, e.id).state, "approved");
			const json = JSON.stringify(renderAdapter(e.spec));
			assert.ok(
				json.includes(
					module.startsWith("aws")
						? "aws_vpc"
						: module.startsWith("azure")
							? "azurerm_virtual_network"
							: "google_compute_network",
				),
			);
		} finally {
			f.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
test("expanded local catalog records compute, DNS and load balancer configuration in real Terraform state", () => {
	const { dir, forge: f } = setup();
	try {
		const full = {
			...spec,
			compute: { ami: "ami-00000000000000000", instanceType: "t3.micro" },
			dns: {
				zone: "service.example.internal",
				name: "api",
				address: "10.25.1.10",
			},
			loadBalancer: {
				certificateArn:
					"arn:aws:acm:us-west-2:000000000000:certificate/00000000-0000-0000-0000-000000000000",
				port: 443,
				healthPath: "/health",
			},
			subnets: ["10.25.1.0/24", "10.25.2.0/24"],
		};
		const e = f.submit(a, full),
			p = f.plan(a, e.id).plan!;
		assert.equal((p.artifact!.json.resource_changes as unknown[]).length, 8);
		f.approve(b, e.id, p.digest);
		f.apply(o, e.id, p.digest);
		const observed = f.runner.observe(a.tenant, e.id);
		assert.ok(
			observed.values.root_module.resources.some(
				(r: any) =>
					r.address === "terraform_data.compute[0]" &&
					r.values.output.instanceType === "t3.micro",
			),
		);
	} finally {
		f.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("state drift invalidates saved approval and local inventory drift is observable", () => {
	const { dir, forge: f } = setup();
	try {
		const e = f.submit(a, spec),
			p = f.plan(a, e.id).plan!;
		f.approve(b, e.id, p.digest);
		f.apply(o, e.id, p.digest);
		const teardown = f.planDestroy(o, e.id).plan!;
		f.approve(b, e.id, teardown.digest);
		const path = join(
			dir,
			"workspaces",
			teardown.artifact!.workspace,
			"state.enc",
		);
		const before = readFileSync(path);
		f.runner.vault.write(
			path,
			Buffer.concat([
				f.runner.vault.read(path, "state:" + teardown.artifact!.workspace),
				Buffer.from("\n"),
			]),
			"state:" + teardown.artifact!.workspace,
		);
		assert.throws(() => f.destroy(o, e.id, teardown.digest), /changed/);
		writeFileSync(path, before);
		const replan = f.planDestroy(o, e.id).plan!;
		assert.notEqual(replan.digest, teardown.digest);
		assert.throws(() => f.destroy(o, e.id, teardown.digest));
	} finally {
		f.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("AWS export enforces encrypted private compute, scoped IAM, private DNS and internal HTTPS load balancing", () => {
	const request = {
		...spec,
		module: "aws-network-v1",
		subnets: ["10.25.1.0/24", "10.25.2.0/24"],
		iam: ["logs:PutLogEvents"],
		compute: { ami: "ami-00000000000000000", instanceType: "t3.micro" },
		dns: {
			zone: "service.example.internal",
			name: "api",
			address: "10.25.1.10",
		},
		loadBalancer: {
			certificateArn:
				"arn:aws:acm:us-west-2:000000000000:certificate/00000000-0000-0000-0000-000000000000",
			port: 443,
			healthPath: "/health",
		},
	};
	const f = new Forge();
	try {
		const e = f.submit(a, request),
			exported = renderAdapter(e.spec) as any;
		assert.equal(
			exported.resource.aws_instance.compute.associate_public_ip_address,
			false,
		);
		assert.equal(
			exported.resource.aws_instance.compute.metadata_options.http_tokens,
			"required",
		);
		assert.equal(
			exported.resource.aws_instance.compute.root_block_device.encrypted,
			true,
		);
		assert.equal(exported.resource.aws_lb.internal.internal, true);
		assert.equal(exported.resource.aws_lb_listener.https.protocol, "HTTPS");
		assert.equal(
			exported.resource.aws_lb_target_group.backend.health_check.path,
			"/health",
		);
		assert.ok(exported.resource.aws_route53_zone.private.vpc);
		assert.ok(
			JSON.parse(
				exported.resource.aws_iam_role_policy.logs.policy,
			).Statement[0].Resource.includes("aws_cloudwatch_log_group"),
		);
		assert.throws(() =>
			f.submit(
				{ ...a, tenant: "two" },
				{
					...request,
					tags: { owner: '${file("/etc/passwd")}', environment: "development" },
				},
			),
		);
	} finally {
		f.close();
	}
});
test("drift checks each resource and remediation requires fresh plan approval", () => {
	const { dir, forge: f } = setup();
	try {
		const e = f.submit(a, spec),
			p = f.plan(a, e.id).plan!;
		f.approve(b, e.id, p.digest);
		f.apply(o, e.id, p.digest);
		const path = join(dir, "workspaces", p.artifact!.workspace, "state.enc");
		const state = JSON.parse(
			f.runner.vault.read(path, "state:" + p.artifact!.workspace).toString(),
		);
		const firewall = state.resources.find((r: any) => r.name === "firewall")
			.instances[0];
		firewall.attributes.input.value = [{ cidr: "0.0.0.0/0", port: 22 }];
		firewall.attributes.input.type = [
			"tuple",
			[["object", { cidr: "string", port: "number" }]],
		];
		firewall.attributes.output = structuredClone(firewall.attributes.input);
		f.runner.vault.write(
			path,
			JSON.stringify(state),
			"state:" + p.artifact!.workspace,
		);
		assert.equal(f.drift(o, e.id).drift?.changed, true);
		const repair = f.planRepair(o, e.id).plan!;
		assert.notEqual(repair.digest, p.digest);
		assert.throws(() => f.apply(o, e.id, repair.digest));
		f.approve(b, e.id, repair.digest);
		assert.equal(f.apply(o, e.id, repair.digest).state, "applied");
		assert.equal(f.drift(o, e.id).drift?.changed, false);
	} finally {
		f.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
