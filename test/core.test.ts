import { test } from "node:test";
import assert from "node:assert/strict";
import { Forge, network, Request } from "../src/core.js";
const a = { id: "alice", tenant: "one", role: "requester" } as const,
	b = { id: "bob", tenant: "one", role: "approver" } as const,
	o = { id: "runner", tenant: "one", role: "operator" } as const;
const spec = {
	name: "service",
	module: "local-network-v1",
	cidr: "10.0.0.0/16",
	subnets: ["10.0.1.0/24"],
	ingress: [],
	iam: ["s3:GetObject"],
	encrypted: true,
	tags: { owner: "platform", environment: "development" },
};
test("CIDRs reject host bits, IPv6, invalid octets", () => {
	for (const c of ["10.0.0.1/24", "::/0", "999.0.0.0/8"])
		assert.throws(() => network(c));
});
test("strict schema blocks module injection and wildcard IAM", () => {
	assert.equal(
		Request.safeParse({ ...spec, module: "../../evil" }).success,
		false,
	);
	assert.equal(Request.safeParse({ ...spec, iam: ["*"] }).success, false);
});
test("network isolation, reservations, containment", () => {
	const f = new Forge(),
		e = f.submit(a, spec);
	assert.throws(() => f.get({ ...a, tenant: "two" }, e.id));
	assert.throws(() => f.submit(a, spec));
	assert.throws(() =>
		new Forge().submit(a, { ...spec, subnets: ["11.0.0.0/24"] }),
	);
	assert.throws(() =>
		new Forge().submit(a, { ...spec, subnets: ["10.0.1.0/24", "10.0.1.0/25"] }),
	);
});
test("OPA blocks unsafe network, IAM and encryption", () => {
	for (const patch of [
		{ ingress: [{ cidr: "0.0.0.0/0", port: 22 }] },
		{ iam: ["iam:CreateUser"] },
		{ encrypted: false },
	]) {
		const f = new Forge(),
			e = f.submit(a, { ...spec, ...patch });
		assert.equal(f.plan(a, e.id).state, "denied");
		assert.throws(() => f.approve(b, e.id, "bad"));
	}
});
test("approval binds exact plan, independent identity, expiry, replay and roles", () => {
	let time = 0;
	const f = new Forge(() => time),
		e = f.submit(a, spec),
		p = f.plan(a, e.id).plan!;
	assert.throws(() => f.apply(o, e.id, p.digest));
	assert.throws(() => f.approve({ ...b, id: a.id }, e.id, p.digest));
	assert.throws(() => f.approve(b, e.id, "wrong"));
	f.approve(b, e.id, p.digest);
	time = 900001;
	assert.throws(() => f.apply(o, e.id, p.digest));
	time = 0;
	f.plan(a, e.id);
	assert.throws(() => f.apply(o, e.id, p.digest));
	f.approve(b, e.id, p.digest);
	assert.equal(f.apply(o, e.id, p.digest).state, "applied");
	assert.equal(f.apply(o, e.id, p.digest).state, "applied");
	assert.throws(() => f.destroy(a, e.id));
	f.destroy(o, e.id);
	assert.throws(() => f.apply(o, e.id, p.digest));
});
