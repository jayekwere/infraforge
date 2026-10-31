import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
test("authenticated API lifecycle and tenant isolation", async () => {
	const tokens = {
		["a".repeat(32)]: { id: "alice", tenant: "demo", role: "requester" },
		["b".repeat(32)]: { id: "bob", tenant: "demo", role: "approver" },
		["c".repeat(32)]: { id: "runner", tenant: "demo", role: "operator" },
		["d".repeat(32)]: { id: "other", tenant: "other", role: "viewer" },
	};
	const dir = mkdtempSync(join(tmpdir(), "infraforge-api-"));
	const key = join(dir, "key");
	writeFileSync(key, randomBytes(32));
	const proc = spawn(process.execPath, ["dist/src/server.js"], {
		env: {
			...process.env,
			PORT: "18081",
			INFRAFORGE_KEY_FILE: key,
			INFRAFORGE_DATA_DIR: join(dir, "data"),
			INFRAFORGE_IDENTITIES: JSON.stringify(tokens),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		await new Promise<void>((resolve, reject) => {
			proc.stdout.once("data", () => resolve());
			proc.once("exit", () => reject(Error("Server failed")));
		});
		const call = async (path: string, token: string, body?: unknown) => {
			const r = await fetch(`http://127.0.0.1:18081${path}`, {
				method: body ? "POST" : "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			return { status: r.status, body: (await r.json()) as any };
		};
		assert.equal((await call("/api/requests", "bad")).status, 401);
		const spec = {
			name: "api-network",
			module: "local-network-v1",
			cidr: "10.42.0.0/16",
			subnets: ["10.42.1.0/24"],
			ingress: [],
			iam: [],
			encrypted: true,
			tags: { owner: "platform", environment: "development" },
		};
		const e = (await call("/api/requests", "a".repeat(32), spec)).body;
		const p = (await call(`/api/requests/${e.id}/plan`, "a".repeat(32), {}))
			.body;
		assert.equal(p.state, "planned");
		assert.deepEqual(
			(await call("/api/requests", "d".repeat(32))).body.requests,
			[],
		);
		assert.equal(
			(
				await call(`/api/requests/${e.id}/apply`, "a".repeat(32), {
					digest: p.plan.digest,
				})
			).status,
			400,
		);
		await call(`/api/requests/${e.id}/approve`, "b".repeat(32), {
			digest: p.plan.digest,
		});
		assert.equal(
			(
				await call(`/api/requests/${e.id}/apply`, "c".repeat(32), {
					digest: p.plan.digest,
				})
			).body.state,
			"applied",
		);
	} finally {
		proc.kill();
		await new Promise((r) => proc.once("exit", r));
		rmSync(dir, { recursive: true, force: true });
	}
});
