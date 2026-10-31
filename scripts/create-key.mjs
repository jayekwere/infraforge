import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const path = process.argv[2];
if (!path) throw Error("Usage: create-key PATH_OUTSIDE_DATA_DIRECTORY");
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
console.log(
	"32-byte encryption key created without displaying it. Back it up separately.",
);
