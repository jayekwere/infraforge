import { Forge } from "./core.js";
import { mkdirSync, writeFileSync } from "node:fs";
const f = new Forge();
const requester = {
	id: "engineer",
	tenant: "demo",
	role: "requester",
} as const;
const approver = { id: "reviewer", tenant: "demo", role: "approver" } as const;
const operator = { id: "runner", tenant: "demo", role: "operator" } as const;
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
const applied = f.apply(operator, e.id, p.plan!.digest);
mkdirSync("docs/evidence", { recursive: true });
writeFileSync(
	"docs/evidence/demo.json",
	JSON.stringify(
		{
			mode: "local-simulation",
			unsafe: denied,
			independentApprovalEnforced: blocked,
			result: applied,
			audit: f.audit,
		},
		null,
		2,
	),
);
console.log(
	"PASS: unsafe denied, corrected, independent approval, local simulation applied",
);
