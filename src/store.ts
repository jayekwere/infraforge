import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { Vault } from "./vault.js";
import { randomBytes } from "node:crypto";
import type { Entry, Actor } from "./core.js";
export type Audit = {
	sequence: number;
	at: string;
	actor: string;
	tenant: string;
	action: string;
	id: string;
	detail: string;
	previous: string;
	hash: string;
};
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Every state transition and its audit event commit in the same SQLite transaction. */
export class Store {
	private db: DatabaseSync;
	constructor(
		path = ":memory:",
		private vault = new Vault(randomBytes(32)),
	) {
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		}
		this.db = new DatabaseSync(path);
		const version = Number(
			this.db.prepare("PRAGMA user_version").get()?.user_version,
		);
		if (version !== 0 && version !== 2) {
			this.db.close();
			throw Error(
				"Encrypted schema required. Migrate a copy of version 1 data explicitly.",
			);
		}
		if (path !== ":memory:") chmodSync(path, 0o600);
		this.db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vault_meta(check_value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY, document TEXT NOT NULL); PRAGMA user_version=2;",
		);
		try {
			const check = this.db.prepare("SELECT check_value FROM vault_meta").get();
			if (check)
				this.vault.open(String(check.check_value), "database-key-check");
			else
				this.db
					.prepare("INSERT INTO vault_meta VALUES (?)")
					.run(
						this.vault.seal("infraforge-encrypted-v2", "database-key-check"),
					);
			this.verify();
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}
	get(id: string): Entry | undefined {
		const r = this.db
			.prepare("SELECT document FROM entries WHERE id=?")
			.get(id);
		return r
			? JSON.parse(
					this.vault.open(String(r.document), "entry:" + id).toString(),
				)
			: undefined;
	}
	list(): Entry[] {
		return this.db
			.prepare("SELECT id,document FROM entries ORDER BY rowid")
			.all()
			.map((r) =>
				JSON.parse(
					this.vault
						.open(String(r.document), "entry:" + String(r.id))
						.toString(),
				),
			);
	}
	put(e: Entry) {
		this.db
			.prepare(
				"INSERT INTO entries VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
			)
			.run(e.id, this.vault.seal(JSON.stringify(e), "entry:" + e.id));
	}
	audit(): Audit[] {
		return this.db
			.prepare("SELECT sequence,document FROM audit ORDER BY sequence")
			.all()
			.map((r) =>
				JSON.parse(
					this.vault
						.open(String(r.document), "audit:" + String(r.sequence))
						.toString(),
				),
			);
	}
	event(a: Actor, action: string, id: string, now: number, detail = "") {
		const prior = this.db
			.prepare(
				"SELECT sequence,document FROM audit ORDER BY sequence DESC LIMIT 1",
			)
			.get();
		const last: Audit | undefined = prior
			? JSON.parse(
					this.vault
						.open(String(prior.document), "audit:" + String(prior.sequence))
						.toString(),
				)
			: undefined;
		const event = {
			sequence: (last?.sequence ?? 0) + 1,
			at: new Date(now).toISOString(),
			actor: a.id,
			tenant: a.tenant,
			action,
			id,
			detail,
			previous: last?.hash ?? "",
		};
		this.db
			.prepare("INSERT INTO audit VALUES (?,?)")
			.run(
				event.sequence,
				this.vault.seal(
					JSON.stringify({ ...event, hash: hash(event) }),
					"audit:" + event.sequence,
				),
			);
	}
	verify() {
		let previous = "",
			sequence = 0;
		for (const event of this.audit()) {
			const { hash: actual, ...body } = event;
			if (
				body.previous !== previous ||
				body.sequence !== ++sequence ||
				hash(body) !== actual
			)
				throw Error("Audit chain integrity failure");
			previous = actual;
		}
	}
	importRecords(entries: Entry[], audit: Audit[]) {
		return this.transaction(() => {
			if (this.list().length || this.audit().length)
				throw Error("Import requires empty encrypted store");
			for (const e of entries) this.put(e);
			for (const event of audit)
				this.db
					.prepare("INSERT INTO audit VALUES (?,?)")
					.run(
						event.sequence,
						this.vault.seal(JSON.stringify(event), "audit:" + event.sequence),
					);
			this.verify();
		});
	}

	close() {
		this.db.close();
	}
}
