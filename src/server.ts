import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Forge, type Actor } from "./core.js";
import { z } from "zod";
import { resolve } from "node:path";
process.umask(0o077);
const dataRoot = resolve(process.env.INFRAFORGE_DATA_DIR || ".data");
const f = new Forge(() => Date.now(), {
	database: resolve(dataRoot, "infraforge.sqlite"),
	workspaces: resolve(dataRoot, "workspaces"),
});
const identityResult = z
	.record(
		z.string().min(32),
		z
			.object({
				id: z.string().min(1).max(80),
				tenant: z.string().regex(/^[a-z0-9-]{1,64}$/),
				role: z.enum(["requester", "approver", "operator", "viewer"]),
			})
			.strict(),
	)
	.safeParse(JSON.parse(process.env.INFRAFORGE_IDENTITIES || "{}"));
if (!identityResult.success)
	throw Error("Invalid server identity configuration");
const identities: Record<string, Actor> = identityResult.data;
if (!Object.keys(identities).length)
	throw Error(
		"Set INFRAFORGE_IDENTITIES to token-to-identity JSON with strong distinct tokens",
	);
if (Object.keys(identities).some((t) => t.length < 32))
	throw Error("Tokens must be at least 32 characters");
export const server = createServer(async (req, res) => {
	res.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
	);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cache-Control", "no-store");
	try {
		const path = new URL(req.url!, "http://localhost").pathname;
		if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(path)) {
			res.setHeader(
				"Content-Type",
				path === "/"
					? "text/html"
					: path.endsWith(".js")
						? "text/javascript"
						: "text/css",
			);
			res.end(
				readFileSync(`web/${path === "/" ? "index.html" : path.slice(1)}`),
			);
			return;
		}
		const token = (req.headers.authorization || "").replace(/^Bearer /, "");
		const key = Object.keys(identities).find(
			(t) =>
				Buffer.byteLength(t) === Buffer.byteLength(token) &&
				timingSafeEqual(Buffer.from(t), Buffer.from(token)),
		);
		if (!key) {
			res.writeHead(401);
			res.end('{"error":"Unauthorized"}');
			return;
		}
		const actor = identities[key];
		res.setHeader("Content-Type", "application/json");
		if (req.method === "GET" && path === "/api/requests") {
			res.end(
				JSON.stringify({
					identity: { id: actor.id, tenant: actor.tenant, role: actor.role },
					requests: f.list(actor),
					audit: f.audit.filter((e) => e.tenant === actor.tenant),
				}),
			);
			return;
		}
		if (req.method !== "POST") throw Error("Unsupported endpoint");
		if (req.headers["content-type"] !== "application/json")
			throw Error("JSON required");
		let raw = "";
		for await (const chunk of req) {
			raw += chunk;
			if (Buffer.byteLength(raw) > 32768) throw Error("Body too large");
		}
		const body = JSON.parse(raw);
		if (path === "/api/requests") {
			res.end(JSON.stringify(f.submit(actor, body)));
			return;
		}
		const m =
			/^\/api\/requests\/([a-f0-9-]+)\/(plan|approve|apply|revise|destroy|plan-destroy|plan-repair|reconcile|drift)$/.exec(
				path,
			);
		if (!m) throw Error("Unknown endpoint");
		const [, id, action] = m;
		const result =
			action === "plan"
				? f.plan(actor, id)
				: action === "approve"
					? f.approve(actor, id, body.digest)
					: action === "apply"
						? f.apply(actor, id, body.digest)
						: action === "revise"
							? f.revise(actor, id, body)
							: action === "plan-repair"
								? f.planRepair(actor, id)
								: action === "plan-destroy"
									? f.planDestroy(actor, id)
									: action === "reconcile"
										? f.reconcile(actor, id)
										: action === "drift"
											? f.drift(actor, id)
											: f.destroy(actor, id, body.digest);
		res.end(JSON.stringify(result));
	} catch (e) {
		res.writeHead(400);
		res.end(
			JSON.stringify({
				error: e instanceof Error ? e.message : "Request rejected",
			}),
		);
	}
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(
	Number(process.env.PORT || 8080),
	process.env.INFRAFORGE_BIND || "127.0.0.1",
	() => console.log("InfraForge local Terraform: http://127.0.0.1:8080"),
);

process.on("SIGTERM", () =>
	server.close(() => {
		f.close();
		process.exit(0);
	}),
);
