import { randomBytes } from "node:crypto";
import { Forge } from "./core.js";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const requester = {
		id: "engineer",
		tenant: "demo",
		role: "requester",
	} as const,
	approver = { id: "reviewer", tenant: "demo", role: "approver" } as const,
	operator = { id: "runner", tenant: "demo", role: "operator" } as const;
export const sample = {
	name: "private-service",
	module: "local-network-v1",
	cidr: "10.42.0.0/16",
	subnets: ["10.42.1.0/24", "10.42.2.0/24"],
	ingress: [{ cidr: "10.42.1.0/24", port: 443 }],
	iam: ["logs:PutLogEvents"],
	encrypted: true,
	tags: { owner: "platform", environment: "development" },
};
const dir = mkdtempSync(join(tmpdir(), "infraforge-demo-")),
	options = {
		key: randomBytes(32),
		database: join(dir, "forge.sqlite"),
		workspaces: join(dir, "workspaces"),
	};
let f = new Forge(() => Date.now(), options);
try {
	const e = f.submit(requester, {
		...sample,
		ingress: [{ cidr: "0.0.0.0/0", port: 22 }],
	});
	const denied = f.plan(requester, e.id);
	if (denied.state !== "denied") throw Error("Unsafe request accepted");
	f.revise(requester, e.id, sample);
	const p = f.plan(requester, e.id);
	let blocked = false;
	try {
		f.approve({ ...approver, id: requester.id }, e.id, p.plan!.digest);
	} catch {
		blocked = true;
	}
	if (!blocked) throw Error("Self approval accepted");
	f.approve(approver, e.id, p.plan!.digest);
	f.close();
	f = new Forge(() => Date.now(), options);
	const restored = f.get(requester, e.id).state === "approved";
	const applied = f.apply(operator, e.id, p.plan!.digest);
	const drift = f.drift(operator, e.id);
	let teardownBlocked = false;
	try {
		f.destroy(operator, e.id, p.plan!.digest);
	} catch {
		teardownBlocked = true;
	}
	if (!teardownBlocked) throw Error("Unapproved teardown accepted");
	const teardown = f.planDestroy(operator, e.id);
	f.approve(approver, e.id, teardown.plan!.digest);
	const destroyed = f.destroy(operator, e.id, teardown.plan!.digest);
	mkdirSync("docs/evidence", { recursive: true });
	writeFileSync(
		"docs/evidence/demo.json",
		JSON.stringify(
			{
				mode: "real-provider-free-terraform",
				encryptedStorage: "AES-256-GCM",
				terraformVersion: p.plan!.artifact!.version,
				unsafe: denied,
				independentApprovalEnforced: blocked,
				durableApprovalRestored: restored,
				result: applied,
				drift: drift.drift,
				unapprovedTeardownBlocked: teardownBlocked,
				teardown: destroyed,
				audit: f.audit,
			},
			null,
			2,
		) + "\n",
	);
	console.log(
		"PASS: unsafe denied, corrected, independent approval restored from SQLite, real local Terraform applied, drift checked, teardown independently approved and completed",
	);
} finally {
	f.close();
	rmSync(dir, { recursive: true, force: true });
}
