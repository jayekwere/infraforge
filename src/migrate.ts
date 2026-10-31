import { DatabaseSync } from "node:sqlite";
import {
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { Store, type Audit } from "./store.js";
import { Vault } from "./vault.js";
import { Workspaces } from "./workspaces.js";
import { Request, type Entry } from "./core.js";
/** Offline copy migration. Never rewrites or deletes the source or its backups. */
export function migrate(
	source: string,
	destination: string,
	key: Buffer,
	oldKey?: Buffer,
) {
	source = resolve(source);
	destination = resolve(destination);
	if (existsSync(destination) || destination.startsWith(source + "/"))
		throw Error("Migration destination must be a new directory outside source");
	const db = new DatabaseSync(join(source, "infraforge.sqlite"), {
		readOnly: true,
	});
	let entries: Entry[], audit: Audit[];
	try {
		const version = Number(
			db.prepare("PRAGMA user_version").get()?.user_version,
		);
		if (![1, 2].includes(version)) throw Error("Unsupported source schema");
		const old = version === 2 ? new Vault(oldKey ?? key) : undefined;
		if (old)
			old.open(
				String(
					db.prepare("SELECT check_value FROM vault_meta").get()?.check_value,
				),
				"database-key-check",
			);
		const decode = (row: any, purpose: string) =>
			JSON.parse(
				old
					? old.open(String(row.document), purpose).toString()
					: String(row.document),
			);
		entries = db
			.prepare("SELECT id,document FROM entries")
			.all()
			.map((r) => decode(r, "entry:" + r.id));
		audit = db
			.prepare("SELECT sequence,document FROM audit ORDER BY sequence")
			.all()
			.map((r) => decode(r, "audit:" + r.sequence));
		for (const e of entries) {
			if (
				!/^[a-f0-9-]{36}$/.test(e.id) ||
				!e.tenant ||
				["executing", "uncertain"].includes(e.state)
			)
				throw Error(
					"Quarantined or invalid entries require recovery before migration",
				);
			Request.parse(e.spec);
		}
	} finally {
		db.close();
	}
	mkdirSync(destination, { mode: 0o700 });
	writeFileSync(
		join(destination, "migration.pending"),
		"Incomplete offline copy\n",
		{ mode: 0o600 },
	);
	const vault = new Vault(key),
		target = new Store(join(destination, "infraforge.sqlite"), vault),
		workspaces = new Workspaces(join(destination, "workspaces"), vault);
	try {
		target.importRecords(entries, audit);
		for (const e of entries) {
			const sourceFolder = join(
				source,
				"workspaces",
				...[tenantHash(e.tenant), e.id],
			);
			workspaces.with(e.tenant, e.id, (w) => {
				if (existsSync(join(sourceFolder, "workspace.enc"))) {
					const old = new Vault(oldKey ?? key);
					const meta = JSON.parse(
						old
							.read(
								join(sourceFolder, "workspace.enc"),
								"workspace:" + w.purpose,
							)
							.toString(),
					);
					w.backend = meta.backend;
					w.target = meta.target;
				}
				if (existsSync(join(sourceFolder, "state.enc"))) {
					const old = new Vault(oldKey ?? key);
					writeFileSync(
						join(w.cwd, "terraform.tfstate"),
						old.read(join(sourceFolder, "state.enc"), "state:" + w.purpose),
						{ mode: 0o600 },
					);
				} else if (existsSync(join(sourceFolder, "terraform.tfstate")))
					writeFileSync(
						join(w.cwd, "terraform.tfstate"),
						readFileSync(join(sourceFolder, "terraform.tfstate")),
						{ mode: 0o600 },
					);
			});
			target.transaction(() => {
				e.plan = undefined;
				e.approval = undefined;
				e.operation = undefined;
				if (!["applied", "destroyed"].includes(e.state)) e.state = "submitted";
				e.revision++;
				target.put(e);
				target.event(
					{ id: "offline-migration", tenant: e.tenant, role: "operator" },
					"encrypted-migration",
					e.id,
					Date.now(),
				);
			});
		}
		renameSync(
			join(destination, "migration.pending"),
			join(destination, "migration.complete"),
		);
	} finally {
		target.close();
	}
}
import { createHash } from "node:crypto";
function tenantHash(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
if (process.argv[1]?.endsWith("/migrate.js")) {
	const [source, destination, keyFile, oldKeyFile] = process.argv.slice(2);
	if (!source || !destination || !keyFile)
		throw Error("Usage: migrate SOURCE_DATA NEW_DATA KEY_FILE [OLD_KEY_FILE]");
	migrate(
		source,
		destination,
		readFileSync(keyFile),
		oldKeyFile ? readFileSync(oldKeyFile) : undefined,
	);
	console.log(
		"Encrypted offline copy created. Source retained; approvals invalidated.",
	);
}
