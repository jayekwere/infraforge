import React, { useState } from "react";
import { createRoot } from "react-dom/client";
function App() {
	const [token, setToken] = useState(""),
		[data, setData] = useState<any>({ requests: [], audit: [] }),
		[error, setError] = useState(""),
		[json, setJson] = useState(
			JSON.stringify(
				{
					name: "private-service",
					module: "local-network-v1",
					cidr: "10.42.0.0/16",
					subnets: ["10.42.1.0/24", "10.42.2.0/24"],
					ingress: [{ cidr: "10.42.1.0/24", port: 443 }],
					iam: ["logs:PutLogEvents"],
					encrypted: true,
					tags: { owner: "platform", environment: "development" },
				},
				null,
				2,
			),
		);
	async function call(path = "/api/requests", body?: unknown) {
		try {
			const r = await fetch(path, {
				method: body ? "POST" : "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			const result = await r.json();
			if (!r.ok) throw Error(result.error);
			if (body) await call();
			else setData(result);
			setError("");
		} catch (e) {
			setError(String(e));
		}
	}
	return (
		<div className="shell">
			<aside>
				<div className="brand">▧ InfraForge</div>
				<p>PLATFORM ENGINEERING</p>
				<nav>
					◈ Overview
					<br />⇄ Infrastructure requests
					<br />⬡ Network architecture
					<br />◎ Resource inventory
					<br />☷ Audit history
				</nav>
				<footer>
					Local simulator
					<br />
					No cloud resources provisioned
				</footer>
			</aside>
			<main>
				<header>
					<span>WORKSPACE / DEVELOPMENT</span>
					<b>● Offline workflow</b>
				</header>
				<h1>Infrastructure control</h1>
				<p className="muted">
					Request, review and manage infrastructure with explicit authorization.
				</p>
				<section className="stats">
					{[
						["Requests", data.requests.length],
						[
							"Awaiting review",
							data.requests.filter((r: any) => r.state === "planned").length,
						],
						[
							"Applied locally",
							data.requests.filter((r: any) => r.state === "applied").length,
						],
						["Audit events", data.audit.length],
					].map(([label, v]) => (
						<article key={label}>
							<small>{label}</small>
							<strong>{v}</strong>
						</article>
					))}
				</section>
				<section className="panel">
					<h2>Authenticated workspace</h2>
					<input
						aria-label="Access token"
						type="password"
						placeholder="Enter your scoped access token"
						value={token}
						onChange={(e) => setToken(e.target.value)}
					/>
					<button onClick={() => call()}>Connect / refresh</button>
					<p role="alert">{error}</p>
				</section>
				<div className="grid">
					<section className="panel">
						<h2>Infrastructure requests</h2>
						{data.requests.length === 0 && (
							<p className="muted">
								Connect to view requests, or submit your first network.
							</p>
						)}
						{data.requests.map((r: any) => (
							<article className="request" key={r.id}>
								<h3>
									{r.spec.name}
									<span className="badge">{r.state}</span>
								</h3>
								<p>
									{r.spec.cidr} · {r.spec.subnets.length} private segments ·
									revision {r.revision}
								</p>
								<div className="topology">
									<b>VPC {r.spec.cidr}</b>
									{r.spec.subnets.map((s: string) => (
										<span key={s}>↳ Private subnet {s}</span>
									))}
								</div>
								{r.plan && (
									<>
										<h4>Plan and policy review</h4>
										<p>{r.plan.findings.join(" · ") || "Policy passed"}</p>
										<code>{r.plan.digest}</code>
										<pre>{JSON.stringify(r.plan.resources, null, 2)}</pre>
									</>
								)}
								<div className="actions">
									{["plan", "approve", "apply", "destroy"].map((action) => (
										<button
											key={action}
											onClick={() =>
												call(`/api/requests/${r.id}/${action}`, {
													digest: r.plan?.digest,
												})
											}
										>
											{action}
										</button>
									))}
								</div>
								<p className="muted">
									Approval requires a separate reviewer identity. Apply requires
									an operator.
								</p>
							</article>
						))}
					</section>
					<section className="panel">
						<h2>New infrastructure request</h2>
						<p className="muted">Trusted module: local-network-v1</p>
						<textarea
							aria-label="Request JSON"
							value={json}
							onChange={(e) => setJson(e.target.value)}
						/>
						<button
							onClick={() => {
								try {
									call("/api/requests", JSON.parse(json));
								} catch {
									setError("Invalid JSON");
								}
							}}
						>
							Submit for planning
						</button>
					</section>
				</div>
				<section className="panel">
					<h2>Audit timeline</h2>
					{data.audit.map((a: any, i: number) => (
						<div className="event" key={i}>
							<time>{a.at}</time>
							<b>{a.action}</b>
							<span>{a.actor}</span>
							<code>{a.hash.slice(0, 16)}</code>
						</div>
					))}
				</section>
			</main>
		</div>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
