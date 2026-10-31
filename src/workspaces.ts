import {
	mkdtempSync,
	mkdirSync,
	existsSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	openSync,
	closeSync,
	statfsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Vault } from "./vault.js";
import type { AwsTarget } from "./aws.js";
export type Workspace = {
	cwd: string;
	folder: string;
	purpose: string;
	backend: "local" | "aws";
	target?: AwsTarget;
	tenant?: string;
	env?: Record<string, string>;
};
const allowed =
	/^(main\.tf|main\.tf\.json|request\.auto\.tfvars\.json|\.terraform\.lock\.hcl|[a-f0-9-]{36}\.tfplan)$/;
export class Workspaces {
	private active = new Map<string, Workspace>();
	constructor(
		readonly root: string,
		readonly vault: Vault,
		readonly scratch = tmpdir(),
		private memoryAws = false,
	) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	with<T>(tenant: string, id: string, fn: (workspace: Workspace) => T): T {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid workspace id");
		const purpose =
			createHash("sha256").update(tenant).digest("hex") + "/" + id;
		if (this.active.has(purpose)) return fn(this.active.get(purpose)!);
		const folder = join(this.root, purpose);
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		if (
			readdirSync(folder).some(
				(n) => !["workspace.enc", "state.enc", "workspace.lock"].includes(n),
			)
		)
			throw Error(
				"Plaintext workspace detected. Migrate an offline copy before starting.",
			);
		const lock = join(folder, "workspace.lock");
		let fd: number;
		try {
			fd = openSync(lock, "wx", 0o600);
		} catch {
			throw Error(
				"Workspace locked. Inspect interrupted operation before unlocking.",
			);
		}
		writeFileSync(
			fd,
			JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
		);
		closeSync(fd);
		const cwd = mkdtempSync(join(this.scratch, "infraforge-runtime-"));
		const workspace: Workspace = {
			cwd,
			folder,
			purpose,
			backend: "local",
			tenant,
		};
		let loaded = false;
		try {
			if (existsSync(join(folder, "workspace.enc"))) {
				const saved = JSON.parse(
					this.vault
						.read(join(folder, "workspace.enc"), "workspace:" + purpose)
						.toString(),
				);
				if (saved.hasState && !existsSync(join(folder, "state.enc")))
					throw Error("Encrypted state checkpoint is missing");
				workspace.backend = saved.backend;
				if (
					this.memoryAws &&
					saved.backend === "aws" &&
					statfsSync(cwd).type !== 0x01021994
				)
					throw Error("AWS execution requires a tmpfs scratch directory");
				workspace.target = saved.target;
				for (const [name, value] of Object.entries(saved.files)) {
					if (!allowed.test(name) || typeof value !== "string")
						throw Error("Invalid encrypted workspace");
					writeFileSync(join(cwd, name), Buffer.from(value, "base64"), {
						mode: 0o600,
					});
				}
			}
			if (existsSync(join(folder, "state.enc")))
				writeFileSync(
					join(cwd, "terraform.tfstate"),
					this.vault.read(join(folder, "state.enc"), "state:" + purpose),
					{ mode: 0o600 },
				);
			loaded = true;
			this.active.set(purpose, workspace);
			return fn(workspace);
		} finally {
			try {
				if (loaded) {
					if (existsSync(join(cwd, "terraform.tfstate")))
						this.vault.write(
							join(folder, "state.enc"),
							readFileSync(join(cwd, "terraform.tfstate")),
							"state:" + purpose,
						);
					const files = Object.fromEntries(
						readdirSync(cwd)
							.filter((n) => allowed.test(n))
							.map((n) => [n, readFileSync(join(cwd, n)).toString("base64")]),
					);
					this.vault.write(
						join(folder, "workspace.enc"),
						JSON.stringify({
							backend: workspace.backend,
							target: workspace.target,
							hasState: existsSync(join(folder, "state.enc")),
							files,
						}),
						"workspace:" + purpose,
					);
				}
			} finally {
				this.active.delete(purpose);
				rmSync(cwd, { recursive: true, force: true });
				rmSync(lock, { force: true });
			}
		}
	}
}
