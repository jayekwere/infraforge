import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
const image = process.argv[2] || "infraforge:verify",
	suffix = randomUUID().slice(0, 8),
	name = "infraforge-test-" + suffix,
	volume = name + "-data";
const composeMode = process.argv.includes("--compose");
const project = name;
let target = name;
const tokens = {
	requester: randomBytes(24).toString("hex"),
	approver: randomBytes(24).toString("hex"),
	operator: randomBytes(24).toString("hex"),
};
const identities = Object.fromEntries(
	Object.entries(tokens).map(([role, token]) => [
		token,
		{ id: role, role, tenant: "docker-demo" },
	]),
);
const docker = (args) =>
	execFileSync("docker", args, {
		encoding: "utf8",
		env: {
			...process.env,
			INFRAFORGE_IDENTITIES: JSON.stringify(identities),
			INFRAFORGE_PORT: "0",
			INFRAFORGE_IMAGE: image,
		},
		timeout: 60000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
let base = "";
const checks = [];
async function ready() {
	for (let i = 0; i < 80; i++) {
		try {
			if ((await fetch(base)).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw Error("Container did not become healthy");
}
async function call(path, role, body, expected = 200) {
	const response = await fetch(base + path, {
		method: body ? "POST" : "GET",
		headers: {
			Authorization: `Bearer ${tokens[role] || "invalid"}`,
			"Content-Type": "application/json",
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const result = await response.json();
	if (response.status !== expected)
		throw Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
	return result;
}
try {
	if (composeMode) {
		docker(["compose", "-p", project, "config", "--quiet"]);
		docker([
			"compose",
			"-p",
			project,
			"up",
			"--detach",
			"--no-build",
			"--wait",
		]);
		target = docker(["compose", "-p", project, "ps", "-q", "infraforge"]);
	} else {
		docker(["volume", "create", volume]);
		docker([
			"run",
			"--detach",
			"--name",
			name,
			"--read-only",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges:true",
			"--pids-limit=128",
			"--memory=512m",
			"--tmpfs",
			"/tmp:rw,size=64m,mode=1777",
			"--mount",
			`type=volume,src=${volume},dst=/app/.data`,
			"--publish",
			"127.0.0.1::8080",
			"--env",
			`INFRAFORGE_IDENTITIES=${JSON.stringify(identities)}`,
			image,
		]);
	}
	const info = JSON.parse(docker(["inspect", target]))[0];
	base =
		"http://127.0.0.1:" + info.NetworkSettings.Ports["8080/tcp"][0].HostPort;
	await ready();
	await call("/api/requests", "invalid", undefined, 401);
	checks.push("unauthenticated access denied");
	const spec = {
		name: "docker-network",
		module: "local-network-v1",
		cidr: "10.61.0.0/16",
		subnets: ["10.61.1.0/24", "10.61.2.0/24"],
		ingress: [],
		iam: [],
		encrypted: true,
		tags: { owner: "platform", environment: "development" },
	};
	const e = await call("/api/requests", "requester", spec);
	const plan = await call(`/api/requests/${e.id}/plan`, "requester", {});
	await call(`/api/requests/${e.id}/approve`, "approver", {
		digest: plan.plan.digest,
	});
	const applied = await call(`/api/requests/${e.id}/apply`, "operator", {
		digest: plan.plan.digest,
	});
	if (applied.state !== "applied") throw Error("Apply incomplete");
	checks.push("real provider-free Terraform applied in hardened container");
	docker(["restart", target]);
	base =
		"http://127.0.0.1:" +
		JSON.parse(docker(["inspect", target]))[0].NetworkSettings.Ports[
			"8080/tcp"
		][0].HostPort;
	await ready();
	const restored = await call("/api/requests", "operator");
	if (restored.requests[0].state !== "applied") throw Error("Persistence lost");
	checks.push("SQLite and Terraform state survive container restart");
	const drift = await call(`/api/requests/${e.id}/drift`, "operator", {});
	if (drift.drift.changed) throw Error("Unexpected drift");
	await call(
		`/api/requests/${e.id}/destroy`,
		"operator",
		{ digest: plan.plan.digest },
		400,
	);
	checks.push("unapproved teardown blocked");
	const teardown = await call(
		`/api/requests/${e.id}/plan-destroy`,
		"operator",
		{},
	);
	await call(`/api/requests/${e.id}/approve`, "approver", {
		digest: teardown.plan.digest,
	});
	const destroyed = await call(`/api/requests/${e.id}/destroy`, "operator", {
		digest: teardown.plan.digest,
	});
	if (destroyed.state !== "destroyed") throw Error("Teardown incomplete");
	checks.push("independently approved saved destroy plan executed");
	const meta = JSON.parse(docker(["image", "inspect", image]))[0];
	mkdirSync("docs/evidence", { recursive: true });
	writeFileSync(
		composeMode ? "docs/evidence/compose.json" : "docs/evidence/docker.json",
		JSON.stringify(
			{
				checkedAt: new Date().toISOString(),
				imageId: meta.Id,
				architecture: meta.Architecture,
				user: info.Config.User,
				readOnly: info.HostConfig.ReadonlyRootfs,
				capDrop: info.HostConfig.CapDrop,
				checks,
				cloudResourcesCreated: 0,
			},
			null,
			2,
		) + "\n",
	);
	console.log("PASS: " + checks.join("; "));
} catch (error) {
	try {
		console.error(docker(["logs", target]));
	} catch {}
	throw error;
} finally {
	try {
		if (composeMode) docker(["compose", "-p", project, "down", "--volumes"]);
		else docker(["rm", "--force", target]);
	} catch {}
	try {
		if (!composeMode) docker(["volume", "rm", volume]);
	} catch {}
}
