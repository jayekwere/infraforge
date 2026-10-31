# InfraForge

Self-service infrastructure request and approval orchestration. TypeScript REST API, CLI, React dashboard, real local OPA enforcement and a provider-free Terraform fixture.

**Status: initial offline simulator. Cloud provisioning is not implemented.** No cloud credentials or billable resources are used. This release does not fulfill the full planned platform scope.

## Run

Requires Node 24.13+ and an initial network connection for dependencies and checksum-verified OPA installation. Subsequent tests and demo run offline.

```sh
npm ci --ignore-scripts
node scripts/install-opa.mjs
npm run verify
```

`npm run demo` writes `docs/evidence/demo.json`: public ingress rejected, corrected request accepted, self approval rejected, separate reviewer approval accepted, and operator applies to simulated inventory.

For the dashboard, generate three distinct random tokens of at least 32 characters and supply a JSON map in `INFRAFORGE_IDENTITIES`:

```json
{
  "<requester-token>": {"id":"engineer","tenant":"demo","role":"requester"},
  "<reviewer-token>": {"id":"reviewer","tenant":"demo","role":"approver"},
  "<operator-token>": {"id":"runner","tenant":"demo","role":"operator"}
}
```

Run `npm start`, open http://127.0.0.1:8080 and enter the appropriate token. Tokens stay in browser memory. Switch tokens to perform independent actions. API roles are enforced server side. Never put real credentials in request data.

CLI: `INFRAFORGE_TOKEN=... node dist/src/cli.js list`. Submit with `submit request.json`, then `plan ID`, `approve ID digest.json`, and `apply ID digest.json`, where digest.json contains `{"digest":"exact-plan-digest"}`. Revise invalid requests using `revise ID request.json`.

Docker: set the identity map and run `docker compose up --build`. Host networking supports the loopback listener on Linux; Docker Desktop requires host networking enabled. Container execution is not yet verified.

## Implemented boundaries

- Strict module and input schemas, IPv4 CIDR containment and overlap detection, tenant-scoped reservations, deny-by-default roles.
- OPA blocks public or out-of-VPC ingress, unapproved IAM actions, unencrypted requests and public network allocations.
- Approval binds request revision and policy digest, expires after 15 minutes and requires a different identity. Replanning invalidates approval. Apply is idempotent locally.
- Audit events have a hash chain. This is an in-memory diagnostic record, not a durable tamper-proof audit service.
- Dashboard shows actual simulator requests, network segments, policy decisions, exact plan input and audit history.
- Python drift comparison consumes exported desired/observed JSON and never remediates automatically.

## Terraform and cloud scope

`terraform/local` uses the built-in terraform_data resource and needs no provider download. Run `terraform init`, `terraform plan -var='request={name="demo",cidr="10.42.0.0/16",subnets=["10.42.1.0/24"]}' -out=local.tfplan`, then `terraform show -json local.tfplan`. The API plan is a digest-bound orchestration document, not this Terraform plan. There is no automatic Terraform execution in the API.

AWS integration is the intended first cloud adapter. VMs, routing, DNS, load balancers, cloud IAM roles, encrypted remote state, OIDC credentials and cloud teardown remain unimplemented. Azure and GCP have no validated adapters. No live multi-cloud claims are made.

StackGuard remains the separate Terraform security review engine. Its documented plan JSON interface can review future generated plans; InfraForge does not copy its review implementation. Spacelift is not required and is not integrated.

See [architecture and threat model](docs/architecture.md), [security policy](SECURITY.md), and [limitations and recovery](docs/operations.md).
