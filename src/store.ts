import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
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
	constructor(path = ":memory:") {
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		}
		this.db = new DatabaseSync(path);
		const version = Number(
			this.db.prepare("PRAGMA user_version").get()?.user_version,
		);
		if (version > 1) {
			this.db.close();
			throw Error("Unsupported database schema version");
		}
		if (path !== ":memory:") chmodSync(path, 0o600);
		this.db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY, document TEXT NOT NULL); PRAGMA user_version=1;",
		);
		try {
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
		return r ? JSON.parse(String(r.document)) : undefined;
	}
	list(): Entry[] {
		return this.db
			.prepare("SELECT document FROM entries ORDER BY rowid")
			.all()
			.map((r) => JSON.parse(String(r.document)));
	}
	put(e: Entry) {
		this.db
			.prepare(
				"INSERT INTO entries VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
			)
			.run(e.id, JSON.stringify(e));
	}
	audit(): Audit[] {
		return this.db
			.prepare("SELECT document FROM audit ORDER BY sequence")
			.all()
			.map((r) => JSON.parse(String(r.document)));
	}
	event(a: Actor, action: string, id: string, now: number, detail = "") {
		const prior = this.db
			.prepare("SELECT document FROM audit ORDER BY sequence DESC LIMIT 1")
			.get();
		const last: Audit | undefined = prior
			? JSON.parse(String(prior.document))
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
			.run(event.sequence, JSON.stringify({ ...event, hash: hash(event) }));
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
	close() {
		this.db.close();
	}
}
