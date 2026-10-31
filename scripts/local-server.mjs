import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
mkdirSync(".data", { recursive: true, mode: 0o700 });
const file = ".data/identities.json";
if (!existsSync(file)) {
	const roles = ["requester", "approver", "operator", "viewer"];
	writeFileSync(
		file,
		JSON.stringify(
			Object.fromEntries(
				roles.map((role) => [
					randomBytes(32).toString("hex"),
					{ id: role, role, tenant: "demo" },
				]),
			),
			null,
			2,
		) + "\n",
		{ mode: 0o600 },
	);
}
console.log(
	"Local identities: .data/identities.json. Use distinct role tokens in the dashboard.",
);
const child = spawn(process.execPath, ["dist/src/server.js"], {
	env: { ...process.env, INFRAFORGE_IDENTITIES: readFileSync(file, "utf8") },
	stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
