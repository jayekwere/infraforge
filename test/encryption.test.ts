import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../src/vault.js";
import { Forge } from "../src/core.js";
import { migrate } from "../src/migrate.js";
import { DatabaseSync } from "node:sqlite";
const a = { id: "requester", tenant: "demo", role: "requester" } as const;
const spec = {
	name: "confidential-network",
	module: "local-network-v1",
	cidr: "10.72.0.0/16",
	subnets: ["10.72.1.0/24"],
	ingress: [],
	iam: [],
	encrypted: true,
	tags: { owner: "private-platform", environment: "development" },
};
test("AES-GCM authenticates key, ciphertext and context; nonces differ", () => {
	const v = new Vault(randomBytes(32)),
		one = v.seal("secret", "entry:a"),
		two = v.seal("secret", "entry:a");
	assert.notEqual(one, two);
	assert.equal(v.open(one, "entry:a").toString(), "secret");
	assert.throws(() => v.open(one, "entry:b"));
	assert.throws(() => new Vault(randomBytes(32)).open(one, "entry:a"));
	const bad = JSON.parse(one);
	bad.data = Buffer.from("tampered").toString("base64");
	assert.throws(() => v.open(JSON.stringify(bad), "entry:a"));
});
test("database, WAL, saved plan and state contain no plaintext request; restart requires same key", () => {
	const dir = mkdtempSync(join(tmpdir(), "infraforge-crypto-")),
		key = randomBytes(32),
		options = {
			database: join(dir, "infraforge.sqlite"),
			workspaces: join(dir, "workspaces"),
			key,
		};
	let f = new Forge(() => Date.now(), options);
	try {
		const e = f.submit(a, spec);
		f.plan(a, e.id);
		function scan(path: string) {
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				const p = join(path, entry.name);
				if (entry.isDirectory()) scan(p);
				else {
					assert.ok(!/\.(tfstate|tfplan)$/.test(p));
					const b = readFileSync(p);
					assert.equal(b.includes("confidential-network"), false);
					assert.equal(b.includes("10.72.0.0/16"), false);
					assert.equal(b.includes("private-platform"), false);
				}
			}
		}
		scan(dir);
		f.close();
		assert.throws(
			() => new Forge(() => Date.now(), { ...options, key: randomBytes(32) }),
			/authentication/,
		);
		f = new Forge(() => Date.now(), options);
		assert.equal(f.get(a, e.id).state, "planned");
	} finally {
		f.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("offline copy migration and key rotation preserve source and invalidate approvals", () => {
	const root = mkdtempSync(join(tmpdir(), "infraforge-migrate-"));
	try {
		const source = join(root, "legacy");
		mkdirSync(source);
		const db = new DatabaseSync(join(source, "infraforge.sqlite"));
		db.exec(
			"CREATE TABLE entries(id TEXT PRIMARY KEY,document TEXT);CREATE TABLE audit(sequence INTEGER PRIMARY KEY,document TEXT);PRAGMA user_version=1;",
		);
		const id = "00000000-0000-0000-0000-000000000001";
		db.prepare("INSERT INTO entries VALUES (?,?)").run(
			id,
			JSON.stringify({
				id,
				tenant: "demo",
				author: "requester",
				state: "approved",
				spec,
				revision: 1,
				approval: { actor: "reviewer", digest: "old" },
			}),
		);
		db.close();
		const original = readFileSync(join(source, "infraforge.sqlite")),
			first = join(root, "encrypted"),
			second = join(root, "rotated"),
			key = randomBytes(32),
			newKey = randomBytes(32);
		migrate(source, first, key);
		assert.deepEqual(readFileSync(join(source, "infraforge.sqlite")), original);
		migrate(first, second, newKey, key);
		const f = new Forge(() => Date.now(), {
			key: newKey,
			database: join(second, "infraforge.sqlite"),
			workspaces: join(second, "workspaces"),
		});
		try {
			const e = f.get(a, id);
			assert.equal(e.state, "submitted");
			assert.equal(e.approval, undefined);
			assert.equal(e.revision, 3);
			assert.equal(f.audit.length, 2);
		} finally {
			f.close();
		}
		assert.throws(() => migrate(source, first, key), /new directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("key rotation retains real Terraform state and still requires new teardown approval", () => {
	const root = mkdtempSync(join(tmpdir(), "infraforge-state-rotation-")),
		source = join(root, "source"),
		dest = join(root, "rotated"),
		oldKey = randomBytes(32),
		key = randomBytes(32);
	const reviewer = {
			id: "reviewer",
			tenant: "demo",
			role: "approver",
		} as const,
		operator = { id: "runner", tenant: "demo", role: "operator" } as const;
	const f = new Forge(() => Date.now(), {
		key: oldKey,
		database: join(source, "infraforge.sqlite"),
		workspaces: join(source, "workspaces"),
	});
	try {
		const e = f.submit(a, spec),
			p = f.plan(a, e.id).plan!;
		f.approve(reviewer, e.id, p.digest);
		f.apply(operator, e.id, p.digest);
		f.close();
		migrate(source, dest, key, oldKey);
		const g = new Forge(() => Date.now(), {
			key,
			database: join(dest, "infraforge.sqlite"),
			workspaces: join(dest, "workspaces"),
		});
		try {
			assert.equal(g.drift(operator, e.id).drift?.changed, false);
			const teardown = g.planDestroy(operator, e.id).plan!;
			assert.throws(() => g.destroy(operator, e.id, teardown.digest));
			g.approve(reviewer, e.id, teardown.digest);
			assert.equal(
				g.destroy(operator, e.id, teardown.digest).state,
				"destroyed",
			);
		} finally {
			g.close();
		}
	} finally {
		try {
			f.close();
		} catch {}
		rmSync(root, { recursive: true, force: true });
	}
});
