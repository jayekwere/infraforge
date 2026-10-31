import { execFileSync } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	chmodSync,
	statfsSync,
	rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { Vault } from "./vault.js";
import { Workspaces, type Workspace } from "./workspaces.js";
import {
	AwsGate,
	awsConfiguration,
	validateAwsPlan,
	expectedAwsAddresses,
	scopeHash,
	type AwsTarget,
} from "./aws.js";
import type { Spec } from "./core.js";
export type Artifact = {
	workspace: string;
	file: string;
	sha256: string;
	config: string;
	state: string;
	json: Record<string, unknown>;
	text: string;
	version: string;
	operation: "apply" | "destroy";
	backend?: "local" | "aws";
	target?: AwsTarget;
};
const sha = (b: Buffer | string) =>
	createHash("sha256").update(b).digest("hex");
const modulePath = resolve("terraform/local/main.tf");
export class Terraform {
	readonly root: string;
	readonly executable: string;

	readonly workspaces: Workspaces;
	private current?: Workspace;
	constructor(
		root: string,
		readonly vault = new Vault(randomBytes(32)),
		readonly aws?: AwsGate,
		private executeCommand?: (
			cwd: string,
			args: string[],
			env: Record<string, string | undefined>,
		) => string,
	) {
		this.root = resolve(root);
		this.executable = resolve(".tools/terraform");
		this.workspaces = new Workspaces(
			this.root,
			vault,
			process.env.INFRAFORGE_SCRATCH_DIR,
			!this.executeCommand,
		);
	}
	private context<T>(tenant: string, id: string, fn: () => T): T {
		return this.workspaces.with(tenant, id, (w) => {
			const previous = this.current;
			this.current = w;
			try {
				return fn();
			} finally {
				this.current = previous;
			}
		});
	}
	private workspace(_tenant: string, _id: string) {
		if (!this.current)
			throw Error("Workspace must be opened through encrypted storage");
		return this.current.cwd;
	}
	enabledAws(tenant: string) {
		return !!this.aws?.config.targets[tenant];
	}
	private session() {
		const w = this.current!;
		if (w.backend !== "aws") return;
		if (!this.aws || !w.target) throw Error("AWS execution is disabled");
		const tenant = (w as Workspace & { tenant?: string }).tenant!;
		if (JSON.stringify(this.aws.target(tenant)) !== JSON.stringify(w.target))
			throw Error("AWS target changed. Replan required");
		if (!w.env) w.env = this.aws.session(tenant).env;
	}
	private run(cwd: string, args: string[]) {
		const w = this.current!;
		if (
			w.backend === "aws" &&
			!this.executeCommand &&
			statfsSync(cwd).type !== 0x01021994
		)
			throw Error("AWS execution requires a tmpfs scratch directory");
		this.session();
		const env: Record<string, string | undefined> = {
			PATH: process.env.PATH,
			HOME: cwd,
			TMPDIR: process.env.TMPDIR,
			TF_IN_AUTOMATION: "1",
			CHECKPOINT_DISABLE: "1",
			TF_INPUT: "0",
			AWS_EC2_METADATA_DISABLED: "true",
			...w.env,
		};
		if (w.backend === "aws") {
			if (!this.executeCommand && statfsSync(cwd).type !== 0x01021994)
				throw Error("AWS execution requires a tmpfs scratch directory");
			const rc = join(cwd, "terraform.rc");
			writeFileSync(
				rc,
				`provider_installation { filesystem_mirror { path = "${resolve(".tools/providers")}" include = ["registry.terraform.io/hashicorp/aws"] } }`,
				{ mode: 0o600 },
			);
			env.TF_CLI_CONFIG_FILE = rc;
			if (args[0] !== "init" && !existsSync(join(cwd, ".terraform")))
				this.run(cwd, [
					"init",
					"-backend=false",
					"-input=false",
					"-no-color",
					"-lockfile=readonly",
				]);
		}
		if (this.executeCommand) return this.executeCommand(cwd, args, env);
		try {
			const result = JSON.parse(
				execFileSync(
					process.execPath,
					[resolve("dist/src/terraform-worker.js")],
					{
						input: JSON.stringify({
							cwd,
							args,
							env,
							executable: this.executable,
							folder: w.folder,
							purpose: w.purpose,
							key: this.vault.key.toString("base64"),
						}),
						env: { PATH: process.env.PATH },
						timeout: 65000,
						maxBuffer: 10 * 1024 * 1024,
					},
				).toString(),
			);
			if (result.code !== 0) throw Error();
			return result.stdout as string;
		} catch {
			throw Error(
				"Terraform command failed or timed out; inspect the encrypted operation evidence",
			);
		}
	}
	plan(tenant: string, id: string, spec: Spec, destroy = false) {
		return this.context(tenant, id, () =>
			this.planOpen(tenant, id, spec, destroy),
		);
	}
	verify(tenant: string, id: string, artifact: Artifact) {
		return this.context(tenant, id, () =>
			this.verifyOpen(tenant, id, artifact),
		);
	}
	apply(tenant: string, id: string, artifact: Artifact) {
		return this.context(tenant, id, () => this.applyOpen(tenant, id, artifact));
	}
	observe(tenant: string, id: string): any {
		return this.context(tenant, id, () => this.observeOpen(tenant, id));
	}

	private state(cwd: string) {
		return existsSync(join(cwd, "terraform.tfstate"))
			? sha(readFileSync(join(cwd, "terraform.tfstate")))
			: "empty";
	}
	private planOpen(
		tenant: string,
		id: string,
		spec: Spec,
		destroy = false,
	): Artifact {
		const w = this.current!;
		// A revised request may select a different allowlisted module. Never load both configurations.
		if (spec.module === "local-network-v1") {
			rmSync(join(w.cwd, "main.tf.json"), { force: true });
			rmSync(join(w.cwd, ".terraform.lock.hcl"), { force: true });
		} else if (spec.module === "aws-network-v1")
			rmSync(join(w.cwd, "main.tf"), { force: true });
		let config: Buffer;
		if (spec.module === "aws-network-v1") {
			if (!this.executeCommand && statfsSync(w.cwd).type !== 0x01021994)
				throw Error("AWS execution requires a tmpfs scratch directory");
			if (!this.aws) throw Error("AWS execution is disabled");
			w.backend = "aws";
			w.target = this.aws.target(tenant);
			w.tenant = tenant;
			config = Buffer.from(
				JSON.stringify(awsConfiguration(spec, w.target, id, tenant)),
			);
			writeFileSync(join(w.cwd, "main.tf.json"), config, { mode: 0o600 });
			writeFileSync(
				join(w.cwd, ".terraform.lock.hcl"),
				readFileSync(resolve("terraform/aws-network/.terraform.lock.hcl")),
				{ mode: 0o600 },
			);
		} else if (spec.module === "local-network-v1") {
			w.backend = "local";
			w.target = undefined;
			w.env = undefined;
			config = readFileSync(modulePath);
		} else throw Error("Cloud execution is disabled");
		const cwd = this.workspace(tenant, id);

		if (w.backend === "local")
			writeFileSync(join(cwd, "main.tf"), config, { mode: 0o600 });
		writeFileSync(
			join(cwd, "request.auto.tfvars.json"),
			JSON.stringify({ request: spec }),
			{ mode: 0o600 },
		);
		this.run(cwd, [
			"init",
			"-backend=false",
			"-input=false",
			"-no-color",
			...(w.backend === "aws" ? ["-lockfile=readonly"] : []),
		]);
		this.run(cwd, ["validate", "-no-color"]);
		const file = `${randomUUID()}.tfplan`,
			state = this.state(cwd);
		const text = this.run(cwd, [
			"plan",
			"-input=false",
			"-no-color",
			"-lock-timeout=5s",
			...(destroy ? ["-destroy"] : []),
			"-out=" + file,
		]);
		chmodSync(join(cwd, file), 0o600);
		const json = JSON.parse(this.run(cwd, ["show", "-json", file]));
		if (w.backend === "aws")
			validateAwsPlan(json, spec, destroy, { id, tenant });
		else this.validatePlan(json, destroy);
		return {
			operation: destroy ? "destroy" : "apply",
			backend: w.backend,
			target: w.target,
			workspace: sha(tenant) + "/" + id,
			file,
			sha256: sha(readFileSync(join(cwd, file))),
			config: sha(
				[config, readFileSync(join(cwd, "request.auto.tfvars.json"))].join(
					"\n",
				),
			),
			state,
			json,
			text,
			version: JSON.parse(this.run(cwd, ["version", "-json"]))
				.terraform_version,
		};
	}
	validatePlan(json: any, destroy: boolean) {
		if (json.errored || !json.planned_values)
			throw Error("Invalid Terraform plan");
		for (const change of json.resource_changes ?? []) {
			if (
				change.mode !== "managed" ||
				change.type !== "terraform_data" ||
				!/^terraform_data\.(network|subnet|firewall|identity|compute|dns|load_balancer)(\[.*\])?$/.test(
					change.address,
				)
			)
				throw Error("Unsupported resource in local plan");
			if (
				change.change.actions.some(
					(a: string) =>
						![
							"create",
							"no-op",
							...(destroy ? ["delete"] : ["update"]),
						].includes(a),
				)
			)
				throw Error("Unexpected Terraform action");
		}
	}
	private verifyOpen(tenant: string, id: string, artifact: Artifact) {
		const cwd = this.workspace(tenant, id);
		const w = this.current!;
		const spec = JSON.parse(
			readFileSync(join(cwd, "request.auto.tfvars.json"), "utf8"),
		).request as Spec;
		const source =
			w.backend === "aws"
				? Buffer.from(
						JSON.stringify(
							awsConfiguration(spec, this.aws!.target(tenant), id, tenant),
						),
					)
				: readFileSync(modulePath);
		const moduleFile = w.backend === "aws" ? "main.tf.json" : "main.tf";
		if (
			(artifact.backend ?? "local") !== w.backend ||
			JSON.stringify(artifact.target) !== JSON.stringify(w.target)
		)
			throw Error("AWS target or backend mismatch");
		if (w.backend === "aws")
			validateAwsPlan(artifact.json, spec, artifact.operation === "destroy", {
				id,
				tenant,
			});
		if (
			artifact.workspace !== sha(tenant) + "/" + id ||
			!/^[-a-f0-9]{36}\.tfplan$/.test(artifact.file)
		)
			throw Error("Artifact path rejected");
		if (
			sha(readFileSync(join(cwd, artifact.file))) !== artifact.sha256 ||
			sha(
				[
					readFileSync(join(cwd, moduleFile)),
					readFileSync(join(cwd, "request.auto.tfvars.json")),
				].join("\n"),
			) !== artifact.config ||
			sha(
				source + "\n" + readFileSync(join(cwd, "request.auto.tfvars.json")),
			) !== artifact.config ||
			this.state(cwd) !== artifact.state ||
			JSON.parse(this.run(cwd, ["version", "-json"])).terraform_version !==
				artifact.version
		)
			throw Error(
				"Terraform artifact, module, state or version changed. Replan required.",
			);
	}
	private applyOpen(tenant: string, id: string, artifact: Artifact) {
		this.verify(tenant, id, artifact);
		const cwd = this.workspace(tenant, id);
		return this.run(cwd, [
			"apply",
			"-input=false",
			"-no-color",
			"-lock-timeout=5s",
			artifact.file,
		]);
	}
	matches(
		observed: any,
		spec: Spec,
		ownership?: { id: string; tenant: string },
	): boolean {
		const resources = observed.values?.root_module?.resources ?? [];
		if (spec.module === "aws-network-v1") {
			try {
				validateAwsPlan(
					{
						planned_values: observed.values,
						resource_changes: resources.map((r: any) => ({
							...r,
							change: {
								actions: ["no-op"],
								after: r.values,
								after_unknown: {},
							},
						})),
					},
					spec,
					false,
					ownership,
				);
				return true;
			} catch {
				return false;
			}
		}
		const network = resources.find(
			(r: any) => r.address === "terraform_data.network",
		);
		if (!network) return false;
		const expected: Record<string, unknown> = {
			"terraform_data.network": spec,
			"terraform_data.firewall": spec.ingress,
			"terraform_data.identity": {
				actions: spec.iam,
				encrypted: spec.encrypted,
				tags: spec.tags,
			},
		};
		for (const cidr of spec.subnets)
			expected["terraform_data.subnet[" + JSON.stringify(cidr) + "]"] = {
				cidr,
				network: network.values.id,
			};
		if (spec.compute) expected["terraform_data.compute[0]"] = spec.compute;
		if (spec.dns) expected["terraform_data.dns[0]"] = spec.dns;
		if (spec.loadBalancer)
			expected["terraform_data.load_balancer[0]"] = spec.loadBalancer;
		const canonical = (v: any): any =>
			Array.isArray(v)
				? v.map(canonical)
				: v && typeof v === "object"
					? Object.fromEntries(
							Object.keys(v)
								.sort()
								.map((k) => [k, canonical(v[k])]),
						)
					: v;
		const same = (a: unknown, b: unknown) =>
			JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
		return (
			resources.length === Object.keys(expected).length &&
			resources.every(
				(r: any) =>
					r.mode === "managed" &&
					r.type === "terraform_data" &&
					r.address in expected &&
					same(r.values.input, expected[r.address]) &&
					same(r.values.output, expected[r.address]),
			)
		);
	}

	private observeOpen(tenant: string, id: string): any {
		const cwd = this.workspace(tenant, id);
		if (
			this.current!.backend === "aws" &&
			!existsSync(join(cwd, "terraform.tfstate"))
		)
			throw Error("AWS state checkpoint missing; completion cannot be proven");
		if (
			this.current!.backend === "aws" &&
			existsSync(join(cwd, "terraform.tfstate"))
		) {
			this.run(cwd, [
				"plan",
				"-refresh-only",
				"-input=false",
				"-no-color",
				"-out=readback.tfplan",
			]);
			const fresh = JSON.parse(
				this.run(cwd, ["show", "-json", "readback.tfplan"]),
			);
			if (fresh.resource_drift?.length)
				throw Error("AWS refreshed state differs from saved state");
		}
		if (!existsSync(join(cwd, "terraform.tfstate")))
			return { values: { root_module: { resources: [] } } };
		return JSON.parse(this.run(cwd, ["show", "-json"]));
	}
}
