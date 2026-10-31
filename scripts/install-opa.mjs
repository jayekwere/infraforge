import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";

const hashes = {
  darwin_arm64: "41af6de872b3cb1d17eb604779489c83dd9bf377737873f9866814501df6e2d1",
  linux_amd64: "ab4d4f59b3f2e64bfc8b4bde7a1eeb2eb08480dffea685b4bd8297c553769a3a",
  linux_arm64: "f7d146c4338e70d9090b5e0b46e25d185f59e85793ae443f0178ee6acaf0764b",
};
const name = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
if (!hashes[name]) throw new Error(`Unsupported OPA platform: ${name}`);
const response = await fetch(
  `https://github.com/open-policy-agent/opa/releases/download/v1.22.0/opa_${name}`,
);
if (!response.ok) throw new Error(`OPA download failed: ${response.status}`);
const data = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(data).digest("hex") !== hashes[name])
  throw new Error("OPA checksum mismatch");
await mkdir(".tools", { recursive: true });
await writeFile(".tools/opa", data);
await chmod(".tools/opa", 0o755);
