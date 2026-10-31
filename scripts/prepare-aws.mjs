// Installs only the pinned provider. Does not configure credentials or contact AWS.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const folder = resolve("terraform/aws-network");
writeFileSync(
	folder + "/versions.tf.json",
	JSON.stringify({
		terraform: {
			required_providers: {
				aws: { source: "hashicorp/aws", version: "6.20.0" },
			},
		},
	}),
);
mkdirSync(".tools/providers", { recursive: true });
execFileSync(
	resolve(".tools/terraform"),
	["init", "-backend=false", "-input=false", "-lockfile=readonly"],
	{ cwd: folder, stdio: "inherit" },
);
const platform =
	process.platform + "_" + (process.arch === "x64" ? "amd64" : process.arch);
const source = resolve(
	folder,
	".terraform/providers/registry.terraform.io/hashicorp/aws/6.20.0",
	platform,
);
const target = resolve(
	".tools/providers/registry.terraform.io/hashicorp/aws/6.20.0",
	platform,
);
mkdirSync(target, { recursive: true });
(await import("node:fs")).cpSync(source, target, {
	recursive: true,
	dereference: true,
});
console.log(
	"Pinned AWS provider prepared in unpacked filesystem mirror; no AWS API calls",
);
