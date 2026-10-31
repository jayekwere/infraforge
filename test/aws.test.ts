import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync as ensureDir } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AwsGate, validateAwsPlan, assertNetworkOnly } from "../src/aws.js";
import { Forge } from "../src/core.js";
const fixture = JSON.parse(readFileSync("test/fixtures/aws-plan.json", "utf8")),
	target = fixture.target;
const a = { id: "engineer", tenant: "demo", role: "requester" } as const,
	b = { id: "reviewer", tenant: "demo", role: "approver" } as const,
	o = { id: "runner", tenant: "demo", role: "operator" } as const;
function session() {
	return {
		accessKeyId: "ASIA0000000000000000",
		secretAccessKey: "synthetic-secret-for-offline-tests",
		sessionToken: "synthetic-session-token-for-offline-tests",
		expiration: new Date(Date.now() + 1800000).toISOString(),
	};
}
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "infraforge-aws-test-")),
		credentialsFile = join(dir, "session.json");
	writeFileSync(credentialsFile, JSON.stringify(session()));
	let identity = {
		Account: target.accountId,
		Arn: "arn:aws:sts::000000000000:assumed-role/InfraForgeNetwork/offline",
	};
	const gate = new AwsGate(
		{ targets: { demo: target }, credentialsFile },
		() => identity,
	);
	return {
		dir,
		gate,
		credentialsFile,
		identity: (v: typeof identity) => {
			identity = v;
		},
	};
}
test("real offline provider plan passes narrow cost gate; paid resources, public subnets and unknown firewall changes fail closed", () => {
	validateAwsPlan(fixture.plan, fixture.spec, false);
	for (const resource of [
		"aws_instance",
		"aws_kms_key",
		"aws_lb",
		"aws_nat_gateway",
		"aws_eip",
		"aws_route53_zone",
		"aws_unknown",
	]) {
		const bad = structuredClone(fixture.plan);
		bad.resource_changes.push({
			address: resource + ".paid",
			type: resource,
			mode: "managed",
			change: { actions: ["create"], after: {} },
		});
		assert.throws(() => validateAwsPlan(bad, fixture.spec, false), /blocked/);
	}
	for (const mutate of [
		(p: any) =>
			(p.resource_changes.find(
				(r: any) => r.type === "aws_subnet",
			).change.after.map_public_ip_on_launch = true),
		(p: any) =>
			(p.resource_changes.find(
				(r: any) => r.type === "aws_security_group",
			).change.after.ingress = null),
		(p: any) =>
			(p.resource_changes.find(
				(r: any) => r.type === "aws_route_table",
			).change.after.route = [
				{ cidr_block: "0.0.0.0/0", gateway_id: "igw-test" },
			]),
		(p: any) => (p.resource_changes[0].change.actions = ["delete", "create"]),
	]) {
		const bad = structuredClone(fixture.plan);
		mutate(bad);
		assert.throws(() => validateAwsPlan(bad, fixture.spec, false));
	}
	assert.throws(() =>
		assertNetworkOnly({
			...fixture.spec,
			compute: { ami: "ami-00000000000000000", instanceType: "t3.micro" },
		}),
	);
	assert.throws(() =>
		assertNetworkOnly({ ...fixture.spec, iam: ["logs:PutLogEvents"] }),
	);
});
test("AWS target, caller role, temporary credentials and expiry are enforced", () => {
	const s = setup();
	try {
		assert.equal(s.gate.session("demo").target.accountId, target.accountId);
		assert.throws(() => s.gate.session("other"));
		s.identity({
			Account: "111111111111",
			Arn: "arn:aws:sts::111111111111:assumed-role/Other/offline",
		});
		assert.throws(() => s.gate.session("demo"), /account or role/);
		writeFileSync(
			s.credentialsFile,
			JSON.stringify({
				...session(),
				expiration: new Date(Date.now() - 1).toISOString(),
			}),
		);
		assert.throws(() => s.gate.session("demo"), /expire/);
		writeFileSync(
			s.credentialsFile,
			JSON.stringify({ ...session(), accessKeyId: "AKIA0000000000000000" }),
		);
		assert.throws(() => s.gate.session("demo"), /temporary/);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});
/** Synthetic execution transport; production cannot enable it via environment or API. */
export function fakeAwsTransport(calls: string[][] = []) {
	return (
		cwd: string,
		args: string[],
		env: Record<string, string | undefined>,
	) => {
		calls.push(args);
		assert.equal(env.AWS_ACCESS_KEY_ID, "ASIA0000000000000000");
		assert.equal(env.AWS_PROFILE, undefined);
		if (args[0] === "init") {
			mkdirSync(join(cwd, ".terraform"), { recursive: true });
			return "initialized";
		}
		if (args[0] === "validate") return "valid";
		if (args[0] === "version")
			return JSON.stringify({ terraform_version: "1.15.8" });
		if (args[0] === "plan") {
			const filename = args.find((a) => a.startsWith("-out="))!.slice(5);
			if (args.includes("-refresh-only")) {
				writeFileSync(
					join(cwd, filename),
					JSON.stringify({ planned_values: {}, resource_drift: [] }),
				);
				return "Refresh readback";
			}
			const plan = structuredClone(fixture.plan),
				destroy = args.includes("-destroy"),
				config = JSON.parse(readFileSync(join(cwd, "main.tf.json"), "utf8")),
				old = existsSync(join(cwd, "terraform.tfstate"))
					? JSON.parse(readFileSync(join(cwd, "terraform.tfstate"), "utf8"))
					: undefined;
			for (const r of plan.resource_changes) {
				if (destroy) {
					r.change.before = old.values.root_module.resources.find(
						(s: any) => s.address === r.address,
					).values;
					r.change.after = null;
					r.change.actions = ["delete"];
				} else {
					r.change.after.tags_all = config.provider.aws.default_tags.tags;
					r.change.after.id = r.type + "-offline";
					r.change.after.vpc_id = "aws_vpc-offline";
				}
			}
			writeFileSync(join(cwd, filename), JSON.stringify(plan));
			return "SYNTHETIC AWS plan (no cloud calls)";
		}
		if (args[0] === "show")
			return readFileSync(join(cwd, args[2] || "terraform.tfstate"), "utf8");
		if (args[0] === "apply") {
			const p = JSON.parse(readFileSync(join(cwd, args.at(-1)!), "utf8"));
			writeFileSync(
				join(cwd, "terraform.tfstate"),
				JSON.stringify({
					values: {
						root_module: {
							resources: p.resource_changes
								.filter((r: any) => r.change.after)
								.map((r: any) => ({ ...r, values: r.change.after })),
						},
					},
				}),
			);
			return "SYNTHETIC AWS apply";
		}
		throw Error("Unexpected test command");
	};
}
test("offline AWS execution binds account, exact plan and independent deployment and teardown approvals", () => {
	const s = setup(),
		calls: string[][] = [];
	const f = new Forge(() => Date.now(), {
		key: randomBytes(32),
		database: join(s.dir, "infraforge.sqlite"),
		workspaces: join(s.dir, "workspaces"),
		aws: s.gate,
		execute: fakeAwsTransport(calls),
	});
	try {
		const e = f.submit(a, fixture.spec),
			p = f.plan(a, e.id).plan!;
		assert.equal(p.artifact?.backend, "aws");
		assert.deepEqual(p.artifact?.target, target);
		assert.throws(() => f.apply(o, e.id, p.digest));
		assert.throws(() => f.approve({ ...b, id: a.id }, e.id, p.digest));
		f.approve(b, e.id, p.digest);
		assert.throws(
			() => f.apply({ ...o, id: b.id }, e.id, p.digest),
			/independent/,
		);
		writeFileSync(
			s.credentialsFile,
			JSON.stringify({
				...session(),
				expiration: new Date(Date.now() - 1).toISOString(),
			}),
		);
		assert.throws(() => f.apply(o, e.id, p.digest), /expire/);
		assert.equal(f.get(a, e.id).state, "approved");
		writeFileSync(s.credentialsFile, JSON.stringify(session()));
		s.identity({
			Account: "111111111111",
			Arn: "arn:aws:sts::111111111111:assumed-role/Other/offline",
		});
		assert.throws(() => f.apply(o, e.id, p.digest), /account or role/);
		assert.equal(f.get(a, e.id).state, "approved");
		s.identity({
			Account: target.accountId,
			Arn: "arn:aws:sts::000000000000:assumed-role/InfraForgeNetwork/offline",
		});
		assert.equal(f.apply(o, e.id, p.digest).state, "applied");
		assert.ok(
			calls.some(
				(args) => args[0] === "apply" && args.at(-1) === p.artifact!.file,
			),
		);
		assert.throws(() => f.destroy(o, e.id, p.digest));
		const teardown = f.planDestroy(o, e.id).plan!;
		assert.throws(() => f.destroy(o, e.id, teardown.digest));
		f.approve(b, e.id, teardown.digest);
		assert.equal(f.destroy(o, e.id, teardown.digest).state, "destroyed");
		const archive = f.runner.vault
			.read(
				join(s.dir, "workspaces", p.artifact!.workspace, "workspace.enc"),
				"workspace:" + p.artifact!.workspace,
			)
			.toString();
		assert.equal(archive.includes("synthetic-secret-for-offline-tests"), false);
		assert.equal(archive.includes("synthetic-session-token"), false);
		ensureDir("docs/evidence", { recursive: true });
		writeFileSync(
			"docs/evidence/aws-offline.json",
			JSON.stringify(
				{
					mode: "simulated-execution-transport",
					providerPlanFixture:
						"real AWS provider plan with closed loopback endpoints",
					liveAwsCalls: false,
					paidProvisioning: false,
					approvedTarget: target,
					applyPlanDigest: p.digest,
					teardownPlanDigest: teardown.digest,
					independentApprovalRequired: true,
					result: "destroyed",
					credentialsAbsentFromWorkspace: true,
					audit: f.audit,
				},
				null,
				2,
			) + "\n",
		);
	} finally {
		f.close();
		rmSync(s.dir, { recursive: true, force: true });
	}
});
test("enabled AWS refuses paid requests and credentials never enter persistent workspace", () => {
	const s = setup();
	const f = new Forge(() => Date.now(), {
		key: randomBytes(32),
		database: join(s.dir, "infraforge.sqlite"),
		workspaces: join(s.dir, "workspaces"),
		aws: s.gate,
		execute: fakeAwsTransport(),
	});
	try {
		const e = f.submit(a, {
			...fixture.spec,
			compute: { ami: "ami-00000000000000000", instanceType: "t3.micro" },
		});
		assert.throws(() => f.plan(a, e.id), /Paid provisioning blocked/);
		assert.equal(f.get(a, e.id).state, "submitted");
	} finally {
		f.close();
		rmSync(s.dir, { recursive: true, force: true });
	}
});
test("revising an unexecuted local request to AWS removes the old module before provider startup", () => {
	const s = setup(),
		transport = fakeAwsTransport();
	const f = new Forge(() => Date.now(), {
		key: randomBytes(32),
		database: join(s.dir, "infraforge.sqlite"),
		workspaces: join(s.dir, "workspaces"),
		aws: s.gate,
		execute: (cwd, args, env) => {
			if (env.AWS_ACCESS_KEY_ID) {
				assert.equal(existsSync(join(cwd, "main.tf")), false);
				return transport(cwd, args, env);
			}
			return execFileSync(resolve(".tools/terraform"), args, {
				cwd,
				env,
				encoding: "utf8",
				timeout: 60000,
			});
		},
	});
	try {
		const e = f.submit(a, { ...fixture.spec, module: "local-network-v1" });
		f.plan(a, e.id);
		f.revise(a, e.id, fixture.spec);
		assert.equal(f.plan(a, e.id).plan?.artifact?.backend, "aws");
		f.revise(a, e.id, { ...fixture.spec, module: "local-network-v1" });
		const local = f.plan(a, e.id).plan!.artifact!;
		assert.equal(local.backend, "local");
		assert.equal(local.target, undefined);
	} finally {
		f.close();
		rmSync(s.dir, { recursive: true, force: true });
	}
});
