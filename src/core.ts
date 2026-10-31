import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const Request = z
	.object({
		name: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/),
		module: z.enum([
			"local-network-v1",
			"aws-network-v1",
			"azure-network-v1",
			"gcp-network-v1",
		]),
		cidr: z.string(),
		subnets: z.array(z.string()).min(1).max(8),
		ingress: z
			.array(
				z
					.object({
						cidr: z.string(),
						port: z.number().int().min(1).max(65535),
					})
					.strict(),
			)
			.max(20),
		iam: z.array(z.string().regex(/^[a-z0-9]+:[A-Za-z]+$/)).max(20),
		encrypted: z.boolean(),
		compute: z
			.object({
				ami: z.string().regex(/^ami-[a-f0-9]{8,17}$/),
				instanceType: z.enum(["t3.micro", "t3.small"]),
			})
			.strict()
			.optional(),
		dns: z
			.object({
				zone: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/),
				name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
				address: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/),
			})
			.strict()
			.optional(),
		loadBalancer: z
			.object({
				certificateArn: z
					.string()
					.regex(/^arn:aws:acm:us-west-2:\d{12}:certificate\/[a-f0-9-]{36}$/),
				port: z.literal(443),
				healthPath: z.string().regex(/^\/[a-zA-Z0-9/_-]{0,80}$/),
			})
			.strict()
			.optional(),
		tags: z
			.object({
				owner: z.string().regex(/^[a-zA-Z0-9_.@ -]{1,80}$/),
				environment: z.enum(["development", "staging"]),
			})
			.strict(),
	})
	.strict();
export type Spec = z.infer<typeof Request>;
export type Actor = {
	id: string;
	tenant: string;
	role: "requester" | "approver" | "operator" | "viewer";
};
export type Plan = {
	digest: string;
	policy: string;
	findings: string[];
	created: number;
	resources: Spec;
	generation: string;
	operation: "apply" | "destroy";
	artifact?: Artifact;
	preview?: unknown;
};
export type Entry = {
	id: string;
	tenant: string;
	author: string;
	spec: Spec;
	state:
		| "submitted"
		| "denied"
		| "planned"
		| "approved"
		| "executing"
		| "uncertain"
		| "applied"
		| "destroy-planned"
		| "destroy-approved"
		| "destroyed";
	plan?: Plan;
	approval?: { actor: string; digest: string };
	inventory?: Spec;
	revision: number;
	operation?: {
		kind: "apply" | "destroy";
		digest: string;
		actor: string;
		pid: number;
		session: string;
	};
	failure?: string;
	drift?: { checked: string; changed: boolean };
};
export function digest(v: unknown) {
	const canonical = (x: any): any =>
		Array.isArray(x)
			? x.map(canonical)
			: x && typeof x === "object"
				? Object.fromEntries(
						Object.keys(x)
							.sort()
							.map((k) => [k, canonical(x[k])]),
					)
				: x;
	return createHash("sha256")
		.update(JSON.stringify(canonical(v)) ?? "undefined")
		.digest("hex");
}
export function network(s: string): [number, number] {
	const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(s);
	if (!m) throw Error("IPv4 CIDR required");
	const a = m.slice(1).map(Number),
		p = a[4];
	if (a.slice(0, 4).some((v) => v > 255) || p > 32) throw Error("Invalid CIDR");
	const n = a.slice(0, 4).reduce((n, v) => n * 256 + v, 0),
		size = 2 ** (32 - p);
	if (n % size) throw Error("CIDR must use network address");
	return [n, n + size - 1];
}
export function overlaps(a: string, b: string) {
	const [x, y] = network(a),
		[u, v] = network(b);
	return x <= v && u <= y;
}
export function validate(spec: Spec) {
	const [lo, hi] = network(spec.cidr);
	for (const [i, s] of spec.subnets.entries()) {
		const [a, b] = network(s);
		if (a < lo || b > hi) throw Error("Subnet outside VPC");
		for (const t of spec.subnets.slice(0, i))
			if (overlaps(s, t)) throw Error("Overlapping subnets");
	}
	for (const r of spec.ingress) network(r.cidr);
	if (spec.dns) {
		const [address] = network(spec.dns.address + "/32");
		if (address < lo || address > hi)
			throw Error("DNS address must be private within the network");
	}
	if (spec.loadBalancer && (!spec.compute || spec.subnets.length < 2))
		throw Error("Load balancer requires compute and at least two subnets");
	if (
		["azure-network-v1", "gcp-network-v1"].includes(spec.module) &&
		(spec.compute || spec.dns || spec.loadBalancer || spec.iam.length)
	)
		throw Error(
			"Azure and GCP adapters currently support network-only requests",
		);
	if (spec.module === "aws-network-v1" && spec.iam.length && !spec.compute)
		throw Error("AWS IAM permissions require a compute identity");
}
export const policyPath = resolve("policies/request.rego");
import { readFileSync } from "node:fs";
export function policyHash() {
	return digest(readFileSync(policyPath, "utf8"));
}
export function evaluate(spec: Spec): string[] {
	const dir = mkdtempSync(join(tmpdir(), "infraforge-"));
	try {
		writeFileSync(join(dir, "input.json"), JSON.stringify(spec), {
			mode: 0o600,
		});
		const bytes = readFileSync(policyPath);
		writeFileSync(join(dir, "policy.rego"), bytes, { mode: 0o600 });
		const out = execFileSync(
			resolve(".tools/opa"),
			[
				"eval",
				"--format=json",
				"--data",
				join(dir, "policy.rego"),
				"--input",
				join(dir, "input.json"),
				"data.infraforge.deny",
			],
			{ timeout: 10000, maxBuffer: 1024 * 1024 },
		);
		const value = JSON.parse(out.toString()).result?.[0]?.expressions?.[0]
			?.value;
		if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
			throw Error("Undefined policy result");
		return value;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

import { Vault } from "./vault.js";
import { randomBytes } from "node:crypto";
import { AwsGate } from "./aws.js";
import { Store } from "./store.js";
import { Terraform, type Artifact } from "./terraform.js";
import { renderAdapter } from "./adapters.js";
const processSession = randomUUID();
export class Forge {
	readonly store: Store;
	readonly runner: Terraform;
	constructor(
		private now = () => Date.now(),
		options: {
			database?: string;
			workspaces?: string;
			key?: Buffer;
			aws?: AwsGate;
			execute?: (
				cwd: string,
				args: string[],
				env: Record<string, string | undefined>,
			) => string;
		} = {},
	) {
		if (options.database && !options.key)
			throw Error("Durable storage requires an external encryption key");
		const vault = new Vault(options.key ?? randomBytes(32));
		this.store = new Store(options.database, vault);
		this.runner = new Terraform(
			options.workspaces ?? ".data/workspaces",
			vault,
			options.aws,
			options.execute,
		);
	}
	get audit() {
		return this.store.audit();
	}
	close() {
		this.store.close();
	}
	private event(a: Actor, action: string, id: string, detail = "") {
		this.store.event(a, action, id, this.now(), detail);
	}
	private permit(a: Actor, roles: Actor["role"][]) {
		if (!a.id || !a.tenant || !roles.includes(a.role)) throw Error("Forbidden");
	}
	get(a: Actor, id: string) {
		this.permit(a, ["requester", "approver", "operator", "viewer"]);
		const e = this.store.get(id);
		if (!e || e.tenant !== a.tenant) throw Error("Not found");
		return e;
	}
	list(a: Actor) {
		this.permit(a, ["requester", "approver", "operator", "viewer"]);
		return this.store.list().filter((e) => e.tenant === a.tenant);
	}
	private reservation(a: Actor, spec: Spec, id = "") {
		for (const other of this.store.list())
			if (
				other.id !== id &&
				(other.tenant === a.tenant ||
					(spec.module === "aws-network-v1" &&
						other.spec.module === "aws-network-v1" &&
						this.runner.aws?.config.targets[a.tenant]?.accountId ===
							this.runner.aws?.config.targets[other.tenant]?.accountId &&
						!!this.runner.aws?.config.targets[a.tenant])) &&
				other.state !== "destroyed" &&
				overlaps(spec.cidr, other.spec.cidr)
			)
				throw Error("Network reservation overlaps");
	}
	submit(a: Actor, input: unknown) {
		this.permit(a, ["requester"]);
		return this.store.transaction(() => {
			const spec = Request.parse(input);
			validate(spec);
			this.reservation(a, spec);
			const e: Entry = {
				id: randomUUID(),
				tenant: a.tenant,
				author: a.id,
				spec,
				state: "submitted",
				revision: 1,
			};
			this.store.put(e);
			this.event(a, "submit", e.id);
			return e;
		});
	}
	revise(a: Actor, id: string, input: unknown) {
		this.permit(a, ["requester"]);
		return this.store.transaction(() => {
			const e = this.get(a, id);
			if (
				e.author !== a.id ||
				!!e.inventory ||
				!["submitted", "planned", "denied", "approved"].includes(e.state)
			)
				throw Error("Forbidden transition");
			const spec = Request.parse(input);
			validate(spec);
			this.reservation(a, spec, id);
			e.spec = spec;
			e.revision++;
			e.state = "submitted";
			e.plan = undefined;
			e.approval = undefined;
			this.store.put(e);
			this.event(a, "revise", id);
			return e;
		});
	}
	plan(a: Actor, id: string) {
		return this.makePlan(a, id, "apply");
	}
	planDestroy(a: Actor, id: string) {
		return this.makePlan(a, id, "destroy");
	}
	planRepair(a: Actor, id: string) {
		this.permit(a, ["operator"]);
		return this.makePlan(a, id, "apply", true);
	}
	private makePlan(
		a: Actor,
		id: string,
		operation: "apply" | "destroy",
		repair = false,
	) {
		this.permit(
			a,
			operation === "apply" ? ["requester", "operator"] : ["operator"],
		);
		return this.store.transaction(() => {
			const e = this.get(a, id);
			if (
				!(
					operation === "apply"
						? [
								...(repair ? ["applied"] : []),
								"submitted",
								"denied",
								"planned",
								"approved",
							]
						: ["applied", "destroy-planned", "destroy-approved"]
				).includes(e.state)
			)
				throw Error("Invalid transition");
			if (operation === "apply" && a.role === "requester" && e.author !== a.id)
				throw Error("Only the author can plan this request");
			if (repair && e.spec.module !== "local-network-v1")
				throw Error("Cloud execution is disabled");
			const policy = policyHash(),
				findings = evaluate(e.spec),
				generation = randomUUID();
			let artifact: Artifact | undefined, preview: unknown;
			if (!findings.length) {
				if (
					e.spec.module === "local-network-v1" ||
					(e.spec.module === "aws-network-v1" &&
						this.runner.enabledAws(e.tenant))
				)
					artifact = this.runner.plan(
						e.tenant,
						id,
						e.spec,
						operation === "destroy",
					);
				else {
					if (operation === "destroy")
						throw Error("Cloud execution is disabled");
					preview = renderAdapter(e.spec);
				}
			}
			if (policy !== policyHash())
				throw Error("Policy changed during planning");
			const plan: Plan = {
				digest: "",
				policy,
				findings,
				created: this.now(),
				resources: e.spec,
				generation,
				operation,
				artifact,
				preview,
			};
			plan.digest = digest([id, e.revision, plan]);
			e.plan = plan;
			e.approval = undefined;
			e.operation = undefined;
			e.failure = undefined;
			e.state = findings.length
				? "denied"
				: operation === "apply"
					? "planned"
					: "destroy-planned";
			this.store.put(e);
			this.event(a, e.state, id, plan.digest);
			return e;
		});
	}
	private checkPlan(e: Entry, hash: string, operation: "apply" | "destroy") {
		if (
			!e.plan ||
			digest([e.id, e.revision, { ...e.plan, digest: "" }]) !== e.plan.digest ||
			e.plan.digest !== hash ||
			e.plan.operation !== operation ||
			(!!e.plan.artifact && e.plan.artifact.operation !== operation) ||
			e.plan.findings.length ||
			this.now() - e.plan.created > 900000 ||
			this.now() < e.plan.created ||
			e.plan.policy !== policyHash()
		)
			throw Error("Plan is stale or invalid. Replan required.");
	}
	approve(a: Actor, id: string, hash: string) {
		this.permit(a, ["approver"]);
		return this.store.transaction(() => {
			const e = this.get(a, id);
			if (
				!["planned", "destroy-planned"].includes(e.state) ||
				a.id === e.author
			)
				throw Error("Approval rejected");
			this.checkPlan(
				e,
				hash,
				e.state === "destroy-planned" ? "destroy" : "apply",
			);
			e.approval = { actor: a.id, digest: hash };
			e.state =
				e.plan!.operation === "destroy" ? "destroy-approved" : "approved";
			this.store.put(e);
			this.event(a, "approve-" + e.plan!.operation, id, hash);
			return e;
		});
	}
	apply(a: Actor, id: string, hash: string) {
		return this.execute(a, id, hash, "apply");
	}
	destroy(a: Actor, id: string, hash: string) {
		return this.execute(a, id, hash, "destroy");
	}
	private execute(
		a: Actor,
		id: string,
		hash: string,
		operation: "apply" | "destroy",
	) {
		this.permit(a, ["operator"]);
		const entry = this.store.transaction(() => {
			const e = this.get(a, id);
			if (
				e.state === (operation === "apply" ? "applied" : "destroyed") &&
				e.operation?.digest === hash &&
				e.operation.kind === operation
			)
				return e;
			if (
				e.spec.module !== "local-network-v1" &&
				!(
					e.spec.module === "aws-network-v1" && this.runner.enabledAws(e.tenant)
				)
			)
				throw Error(
					"Cloud execution is disabled. Adapter exports cannot be applied.",
				);
			if (
				e.state !== (operation === "apply" ? "approved" : "destroy-approved") ||
				e.approval?.digest !== hash ||
				e.approval.actor === a.id
			)
				throw Error("Execution requires independent approval and operator");
			this.checkPlan(e, hash, operation);
			if (!e.plan?.artifact || evaluate(e.spec).length)
				throw Error("Apply rejected");
			this.runner.verify(e.tenant, id, e.plan.artifact);
			e.state = "executing";
			e.operation = {
				kind: operation,
				digest: hash,
				actor: a.id,
				pid: process.pid,
				session: processSession,
			};
			e.approval = undefined;
			this.store.put(e);
			this.event(a, "execution-started", id, operation + ":" + hash);
			return e;
		});
		if (entry.state !== "executing") return entry;
		try {
			this.runner.apply(entry.tenant, id, entry.plan!.artifact!);
			const observed = this.runner.observe(entry.tenant, id);
			if (
				operation === "apply"
					? !this.runner.matches(observed, entry.spec, {
							id,
							tenant: entry.tenant,
						})
					: (observed.values?.root_module?.resources ?? []).length !== 0
			)
				throw Error("Terraform readback did not prove completion");
		} catch {
			this.store.transaction(() => {
				const e = this.get(a, id);
				e.state = "uncertain";
				e.failure =
					"Terraform execution failed or timed out. Inspect state and reconcile; approval was consumed.";
				this.store.put(e);
				this.event(a, "execution-uncertain", id, hash);
			});
			throw Error("Terraform outcome uncertain. Reconcile before proceeding.");
		}
		return this.store.transaction(() => {
			const e = this.get(a, id);
			e.state = operation === "apply" ? "applied" : "destroyed";
			e.inventory = operation === "apply" ? e.spec : undefined;
			e.failure = undefined;
			e.drift = undefined;
			this.store.put(e);
			this.event(a, "terraform-" + operation + "-completed", id, hash);
			return e;
		});
	}
	reconcile(a: Actor, id: string) {
		this.permit(a, ["operator"]);
		return this.store.transaction(() => {
			const e = this.get(a, id);
			if (
				!["executing", "uncertain"].includes(e.state) ||
				!e.operation ||
				(e.spec.module !== "local-network-v1" &&
					!(
						e.spec.module === "aws-network-v1" &&
						this.runner.enabledAws(e.tenant)
					))
			)
				throw Error("No uncertain local execution");
			if (e.state === "executing") {
				try {
					if (
						e.operation.pid === process.pid &&
						e.operation.session !== processSession
					) {
						const stale = Object.assign(Error("Prior process session"), {
							code: "ESRCH",
						});
						throw stale;
					}
					process.kill(e.operation.pid, 0);
					throw Error("Execution process is still active");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			const observed = this.runner.observe(e.tenant, id);
			const resources = observed.values?.root_module?.resources ?? [];
			const matches =
				e.operation.kind === "destroy"
					? resources.length === 0
					: this.runner.matches(observed, e.spec, { id, tenant: e.tenant });
			if (!matches)
				throw Error(
					"State does not prove completion. Keep workspace quarantined and inspect locally.",
				);
			e.state = e.operation.kind === "destroy" ? "destroyed" : "applied";
			e.inventory = e.state === "applied" ? e.spec : undefined;
			e.failure = undefined;
			e.drift = undefined;
			this.store.put(e);
			this.event(a, "reconciled-" + e.operation.kind, id, e.operation.digest);
			return e;
		});
	}
	drift(a: Actor, id: string) {
		this.permit(a, ["operator", "viewer"]);
		return this.store.transaction(() => {
			const e = this.get(a, id);
			if (
				e.state !== "applied" ||
				(e.spec.module !== "local-network-v1" &&
					!(
						e.spec.module === "aws-network-v1" &&
						this.runner.enabledAws(e.tenant)
					))
			)
				throw Error("Drift requires applied local state");
			const observed = this.runner.observe(e.tenant, id);
			e.drift = {
				checked: new Date(this.now()).toISOString(),
				changed: !this.runner.matches(observed, e.spec, {
					id,
					tenant: e.tenant,
				}),
			};
			this.store.put(e);
			this.event(a, "drift-check", id, String(e.drift.changed));
			return e;
		});
	}
}
