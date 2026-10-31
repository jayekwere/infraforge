import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
mkdirSync(".keys", { recursive: true, mode: 0o700 });
if (!existsSync(".keys/state.key") && existsSync(".data/infraforge.sqlite"))
	throw Error(
		"Existing data requires its original encryption key or explicit offline migration",
	);
if (!existsSync(".keys/state.key"))
	writeFileSync(".keys/state.key", randomBytes(32), {
		mode: 0o600,
		flag: "wx",
	});
mkdirSync(".data", { recursive: true, mode: 0o700 });
const file = ".keys/identities.json";
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
	"Local identities: .keys/identities.json. Use distinct role tokens in the dashboard.",
);
const child = spawn(process.execPath, ["dist/src/server.js"], {
	env: {
		...process.env,
		INFRAFORGE_KEY_FILE: process.env.INFRAFORGE_KEY_FILE || ".keys/state.key",
		INFRAFORGE_IDENTITIES: readFileSync(file, "utf8"),
	},
	stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
