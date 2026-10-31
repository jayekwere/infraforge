import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "infraforge-browser-"));
const key = join(dir, "key");
writeFileSync(key, randomBytes(32));
const identities = Object.fromEntries(
	[
		["r", "engineer", "requester"],
		["a", "reviewer", "approver"],
		["o", "runner", "operator"],
	].map(([token, id, role]) => [
		token.repeat(32),
		{ id, tenant: "demo", role },
	]),
);
const child = spawn(process.execPath, ["dist/src/server.js"], {
	env: {
		...process.env,
		PORT: "18082",
		INFRAFORGE_KEY_FILE: key,
		INFRAFORGE_DATA_DIR: join(dir, "data"),
		INFRAFORGE_IDENTITIES: JSON.stringify(identities),
	},
	stdio: "inherit",
});
function stop() {
	child.kill("SIGTERM");
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => {
	rmSync(dir, { recursive: true, force: true });
	process.exit(code ?? 0);
});
