import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
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
};
const sha = (b: Buffer | string) =>
	createHash("sha256").update(b).digest("hex");
const modulePath = resolve("terraform/local/main.tf");
export class Terraform {
	readonly root: string;
	readonly executable: string;
	constructor(root: string) {
		this.root = resolve(root);
		this.executable = resolve(".tools/terraform");
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
	}
	private workspace(tenant: string, id: string) {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid workspace id");
		const folder = join(this.root, sha(tenant), id);
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		return folder;
	}
	private run(cwd: string, args: string[]) {
		return execFileSync(this.executable, args, {
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: cwd,
				TMPDIR: process.env.TMPDIR,
				TF_IN_AUTOMATION: "1",
				CHECKPOINT_DISABLE: "1",
				TF_INPUT: "0",
			},
			timeout: 60000,
			maxBuffer: 8 * 1024 * 1024,
		}).toString();
	}
	private state(cwd: string) {
		return existsSync(join(cwd, "terraform.tfstate"))
			? sha(readFileSync(join(cwd, "terraform.tfstate")))
			: "empty";
	}
	plan(tenant: string, id: string, spec: Spec, destroy = false): Artifact {
		if (spec.module !== "local-network-v1")
			throw Error(
				"Cloud adapters are export-only. Cloud execution is disabled.",
			);
		const cwd = this.workspace(tenant, id),
			config = readFileSync(modulePath);
		writeFileSync(join(cwd, "main.tf"), config, { mode: 0o600 });
		writeFileSync(
			join(cwd, "request.auto.tfvars.json"),
			JSON.stringify({ request: spec }),
			{ mode: 0o600 },
		);
		this.run(cwd, ["init", "-backend=false", "-input=false", "-no-color"]);
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
		this.validatePlan(json, destroy);
		return {
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
	verify(tenant: string, id: string, artifact: Artifact) {
		const cwd = this.workspace(tenant, id);
		if (
			artifact.workspace !== sha(tenant) + "/" + id ||
			!/^[-a-f0-9]{36}\.tfplan$/.test(artifact.file)
		)
			throw Error("Artifact path rejected");
		if (
			sha(readFileSync(join(cwd, artifact.file))) !== artifact.sha256 ||
			sha(
				[
					readFileSync(join(cwd, "main.tf")),
					readFileSync(join(cwd, "request.auto.tfvars.json")),
				].join("\n"),
			) !== artifact.config ||
			sha(
				readFileSync(modulePath) +
					"\n" +
					readFileSync(join(cwd, "request.auto.tfvars.json")),
			) !== artifact.config ||
			this.state(cwd) !== artifact.state ||
			JSON.parse(this.run(cwd, ["version", "-json"])).terraform_version !==
				artifact.version
		)
			throw Error(
				"Terraform artifact, module, state or version changed. Replan required.",
			);
	}
	apply(tenant: string, id: string, artifact: Artifact) {
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
	matches(observed: any, spec: Spec): boolean {
		const resources = observed.values?.root_module?.resources ?? [];
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

	observe(tenant: string, id: string): any {
		const cwd = this.workspace(tenant, id);
		if (!existsSync(join(cwd, "terraform.tfstate")))
			return { values: { root_module: { resources: [] } } };
		return JSON.parse(this.run(cwd, ["show", "-json"]));
	}
}
