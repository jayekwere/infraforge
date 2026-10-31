import React, { useState } from "react";
import { createRoot } from "react-dom/client";
const initial = {
	name: "private-service",
	module: "local-network-v1",
	cidr: "10.42.0.0/16",
	subnets: ["10.42.1.0/24", "10.42.2.0/24"],
	ingress: [{ cidr: "10.42.1.0/24", port: 443 }],
	iam: ["logs:PutLogEvents"],
	encrypted: true,
	tags: { owner: "platform", environment: "development" },
};
function App() {
	const [token, setToken] = useState(""),
		[data, setData] = useState<any>({ requests: [], audit: [] }),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[json, setJson] = useState(JSON.stringify(initial, null, 2)),
		[editing, setEditing] = useState("");
	async function call(path = "/api/requests", body?: unknown) {
		setBusy(true);
		setError("");
		try {
			const invoke = async (p: string, b?: unknown) => {
				const r = await fetch(p, {
					method: b ? "POST" : "GET",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					...(b ? { body: JSON.stringify(b) } : {}),
				});
				const result = await r.json();
				if (!r.ok) throw Error(result.error);
				return result;
			};
			await (body ? invoke(path, body) : Promise.resolve());
			setData(await invoke("/api/requests"));
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}
	const role = data.identity?.role;
	const local = (r: any) =>
		r.spec.module === "local-network-v1" ||
		(r.spec.module === "aws-network-v1" &&
			data.capabilities?.awsNetworkExecution);
	function action(r: any, label: string, path: string, enabled: boolean) {
		return (
			<button
				disabled={busy || !enabled}
				onClick={() =>
					call(`/api/requests/${r.id}/${path}`, { digest: r.plan?.digest })
				}
			>
				{label}
			</button>
		);
	}
	return (
		<div className="shell">
			<aside>
				<div className="brand">▧ InfraForge</div>
				<p>PLATFORM ENGINEERING</p>
				<nav>
					<a href="#overview">◈ Overview</a>
					<a href="#requests">⇄ Infrastructure requests</a>
					<a href="#inventory">⬡ Resource inventory</a>
					<a href="#audit">☷ Audit history</a>
				</nav>
				<footer>
					<b>Encrypted state storage</b>
					<br />
					AWS networking requires opt-in
					<br />
					Paid provisioning blocked
				</footer>
			</aside>
			<main id="overview">
				<header>
					<span>WORKSPACE / {data.identity?.tenant || "DISCONNECTED"}</span>
					<b>● Encrypted storage · paid provisioning blocked</b>
				</header>
				<h1>Infrastructure control</h1>
				<p className="muted">
					Validated requests. Independent review. Traceable infrastructure
					changes.
				</p>
				<section className="stats">
					{[
						["Requests", data.requests.length],
						[
							"Awaiting review",
							data.requests.filter((r: any) =>
								["planned", "destroy-planned"].includes(r.state),
							).length,
						],
						[
							"Applied resources",
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
				<section className="panel auth">
					<div>
						<h2>Authenticated workspace</h2>
						<p className="muted">
							{data.identity
								? `${data.identity.id} · ${role} · tenant ${data.identity.tenant}`
								: "Connect with a scoped token. Credentials stay in browser memory."}
						</p>
					</div>
					<input
						aria-label="Access token"
						type="password"
						autoComplete="off"
						placeholder="Scoped access token"
						value={token}
						onChange={(e) => {
							setToken(e.target.value);
							setData({ requests: [], audit: [] });
							setError("");
						}}
					/>
					<button disabled={busy} onClick={() => call()}>
						Connect / refresh
					</button>
				</section>
				<p role="alert" className={error ? "error" : ""}>
					{error}
				</p>
				<div className="grid">
					<section className="panel" id="requests">
						<h2>Infrastructure requests</h2>
						{data.requests.length === 0 && (
							<p className="muted">
								Connect to view requests, or submit your first private network.
							</p>
						)}
						{data.requests.map((r: any) => (
							<article className="request" key={r.id} data-testid="request">
								<h3>
									{r.spec.name}
									<span
										className={`badge ${r.state === "denied" ? "denied" : ""}`}
										data-testid="state"
									>
										{r.state}
									</span>
								</h3>
								<p className="muted">
									{r.spec.module} · revision {r.revision}
								</p>
								<div className="topology">
									<b>Private network {r.spec.cidr}</b>
									<div className="segments">
										{r.spec.subnets.map((s: string) => (
											<span key={s}>
												↳ Subnet
												<br />
												<b>{s}</b>
											</span>
										))}
									</div>
									<small>
										Ingress:{" "}
										{r.spec.ingress
											.map((i: any) => `${i.cidr} TCP ${i.port}`)
											.join(", ") || "deny all"}{" "}
										· encrypted: {String(r.spec.encrypted)}
									</small>
								</div>
								{r.plan && (
									<>
										<h4>
											{r.plan.operation === "destroy"
												? "Teardown"
												: "Deployment"}{" "}
											plan review
										</h4>
										<p
											className={r.plan.findings.length ? "finding" : "passed"}
										>
											{r.plan.findings.join(" · ") || "OPA policy passed"}
										</p>
										<label className="muted">Exact approval digest</label>
										<code className="digest">{r.plan.digest}</code>
										{r.plan.artifact ? (
											<>
												<div className="plan-meta">
													Terraform {r.plan.artifact.version} · saved plan ·
													expires after 15 minutes
												</div>
												<table>
													<thead>
														<tr>
															<th>Planned resource</th>
															<th>Change</th>
														</tr>
													</thead>
													<tbody>
														{r.plan.artifact.json.resource_changes?.map(
															(c: any) => (
																<tr key={c.address}>
																	<td>{c.address}</td>
																	<td>{c.change.actions.join(", ")}</td>
																</tr>
															),
														)}
													</tbody>
												</table>
												<details>
													<summary>Terraform plan diff</summary>
													<pre>{r.plan.artifact.text}</pre>
												</details>
											</>
										) : r.plan.preview ? (
											<details>
												<summary>Cloud export · no executable artifact</summary>
												<pre>{JSON.stringify(r.plan.preview, null, 2)}</pre>
											</details>
										) : null}
									</>
								)}
								{r.failure && <p className="finding">{r.failure}</p>}
								<div className="actions">
									{action(
										r,
										"Generate plan",
										"plan",
										(role === "operator" ||
											(role === "requester" &&
												data.identity?.id === r.author)) &&
											["submitted", "denied", "planned", "approved"].includes(
												r.state,
											),
									)}
									{action(
										r,
										"Approve plan",
										"approve",
										role === "approver" &&
											data.identity?.id !== r.author &&
											["planned", "destroy-planned"].includes(r.state),
									)}
									{action(
										r,
										"Apply approved plan",
										"apply",
										role === "operator" && r.state === "approved" && local(r),
									)}
									{action(
										r,
										"Plan teardown",
										"plan-destroy",
										role === "operator" &&
											local(r) &&
											[
												"applied",
												"destroy-planned",
												"destroy-approved",
											].includes(r.state),
									)}
									{action(
										r,
										"Execute teardown",
										"destroy",
										role === "operator" &&
											local(r) &&
											r.state === "destroy-approved",
									)}
									{action(
										r,
										"Reconcile",
										"reconcile",
										role === "operator" &&
											["executing", "uncertain"].includes(r.state),
									)}
									{role === "requester" &&
										data.identity?.id === r.author &&
										["submitted", "denied", "planned", "approved"].includes(
											r.state,
										) && (
											<button
												className="secondary"
												onClick={() => {
													setEditing(r.id);
													setJson(JSON.stringify(r.spec, null, 2));
												}}
											>
												Edit request
											</button>
										)}
								</div>
								<p className="muted">
									Reviewer approval and operator execution use separate
									identities. Teardown needs a new approval.
								</p>
							</article>
						))}
					</section>
					<section className="panel editor">
						<h2>
							{editing
								? "Correct infrastructure request"
								: "New infrastructure request"}
						</h2>
						<p className="muted">
							Local Terraform runs offline. Configured AWS targets permit
							isolated networking only. Paid service provisioning stays blocked.
						</p>
						<textarea
							aria-label="Request JSON"
							spellCheck={false}
							value={json}
							onChange={(e) => setJson(e.target.value)}
						/>
						<button
							disabled={busy || role !== "requester"}
							onClick={() => {
								try {
									call(
										editing
											? `/api/requests/${editing}/revise`
											: "/api/requests",
										JSON.parse(json),
									);
									setEditing("");
								} catch {
									setError("Invalid JSON");
								}
							}}
						>
							{editing ? "Save correction" : "Submit for planning"}
						</button>
						{editing && (
							<button
								className="secondary"
								onClick={() => {
									setEditing("");
									setJson(JSON.stringify(initial, null, 2));
								}}
							>
								Cancel edit
							</button>
						)}
						<div className="note">
							<b>Approval boundary</b>
							<p>
								Plans bind the request revision, policy, saved Terraform bytes
								and state. Changes require a fresh plan and review.
							</p>
						</div>
					</section>
				</div>
				<section className="panel" id="inventory">
					<h2>Resource inventory & drift</h2>
					{!data.requests.some((r: any) => r.inventory) && (
						<p className="muted">Applied local resources will appear here.</p>
					)}
					{data.requests
						.filter((r: any) => r.inventory)
						.map((r: any) => (
							<div className="inventory" key={r.id}>
								<div>
									<b>{r.spec.name}</b>
									<p>
										{r.spec.cidr} · {r.spec.subnets.length} subnets ·{" "}
										{r.spec.module === "aws-network-v1"
											? "AWS networking"
											: "local Terraform"}{" "}
										· encrypted state
									</p>
									<small>
										{r.drift
											? `${r.drift.changed ? "Drift detected" : "No drift detected"} · ${r.drift.checked}`
											: "Drift not checked"}
									</small>
								</div>
								{action(
									r,
									"Plan repair",
									"plan-repair",
									role === "operator" &&
										r.state === "applied" &&
										r.drift?.changed &&
										r.spec.module === "local-network-v1",
								)}
								{action(
									r,
									"Check drift",
									"drift",
									["operator", "viewer"].includes(role) &&
										r.state === "applied",
								)}
							</div>
						))}
				</section>
				<section className="panel" id="audit">
					<h2>
						Audit timeline <small>Durable · hash chained</small>
					</h2>
					{data.audit.map((a: any) => (
						<div className="event" key={a.sequence}>
							<time>{new Date(a.at).toISOString()}</time>
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
