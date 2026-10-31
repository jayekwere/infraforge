import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, chmod, rm, mkdtemp, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const hashes = {
	darwin_arm64:
		"f210110c5698b94d803a7a63cdb0251b5455c150841478808e2bbb343f95ed68",
	linux_amd64:
		"d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d",
	linux_arm64:
		"8891e9dcedc9e3b8950bc6af9d4d8af1f4cfade3062f53b9dc403a89f6ce8c9c",
};
const platform = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
if (!hashes[platform]) throw Error("Unsupported Terraform platform");
const r = await fetch(
	`https://releases.hashicorp.com/terraform/1.15.8/terraform_1.15.8_${platform}.zip`,
);
if (!r.ok) throw Error("Terraform download failed");
const b = Buffer.from(await r.arrayBuffer());
if (createHash("sha256").update(b).digest("hex") !== hashes[platform])
	throw Error("Terraform checksum mismatch");
const temp = await mkdtemp(join(tmpdir(), "infraforge-install-"));
try {
	await writeFile(join(temp, "terraform.zip"), b);
	execFileSync("unzip", ["-q", join(temp, "terraform.zip"), "-d", temp]);
	await mkdir(".tools", { recursive: true });
	const binaryTemp = ".tools/terraform-" + randomUUID();
	await writeFile(
		binaryTemp,
		await (await import("node:fs/promises")).readFile(join(temp, "terraform")),
	);
	await chmod(binaryTemp, 0o755);
	await rename(binaryTemp, ".tools/terraform");
	await writeFile(
		".tools/TERRAFORM-LICENSE.txt",
		await (await import("node:fs/promises")).readFile(
			join(temp, "LICENSE.txt"),
		),
	);
} finally {
	await rm(temp, { recursive: true, force: true });
}
