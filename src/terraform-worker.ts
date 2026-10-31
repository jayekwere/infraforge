/** Keep state checkpoints encrypted while Terraform is running. Secrets arrive only on stdin. */
import { spawn } from "node:child_process";
import { watch, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "./vault.js";
let raw = "";
for await (const c of process.stdin) {
	raw += c;
	if (raw.length > 65536) throw Error("Worker input too large");
}
const input = JSON.parse(raw),
	vault = new Vault(Buffer.from(input.key, "base64"));
const state = join(input.cwd, "terraform.tfstate");
let failure = false;
function checkpoint() {
	if (!existsSync(state)) return;
	let bytes: Buffer;
	try {
		bytes = readFileSync(state);
		if (!bytes.length) return;
		JSON.parse(bytes.toString());
	} catch {
		return;
	}
	try {
		vault.write(
			join(input.folder, "state.enc"),
			bytes,
			"state:" + input.purpose,
		);
	} catch {
		if (!failure) {
			failure = true;
			queueMicrotask(terminate);
		}
	}
}
const watcher = watch(
	input.cwd,
	(_event: string, file: string | Buffer | null) => {
		if (file === "terraform.tfstate") checkpoint();
	},
);
const child = spawn(input.executable, input.args, {
	cwd: input.cwd,
	env: input.env,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
let stdout = "",
	stderr = "";
child.stdout.on("data", (b) => {
	stdout += b;
	if (stdout.length > 8 * 1024 * 1024) terminate();
});
child.stderr.on("data", (b) => {
	stderr += b;
	if (stderr.length > 1024 * 1024) terminate();
});
let hardKill: ReturnType<typeof setTimeout> | undefined;
function signalGroup(signal: NodeJS.Signals) {
	try {
		process.kill(-child.pid!, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {}
	}
}
function terminate() {
	checkpoint();
	signalGroup("SIGTERM");
	if (!hardKill) hardKill = setTimeout(() => signalGroup("SIGKILL"), 2000);
}
const timer = setTimeout(terminate, 60000);
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, terminate);
child.on("error", () => {
	failure = true;
});
child.on("close", (code) => {
	clearTimeout(timer);
	if (hardKill) clearTimeout(hardKill);
	watcher.close();
	checkpoint();
	process.stdout.write(
		JSON.stringify({ code: failure ? 1 : code, stdout, stderr }),
	);
});
