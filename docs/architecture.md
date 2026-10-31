# Architecture and threat model

```mermaid
flowchart LR
  Engineer -->|Bearer token| API[TypeScript REST API]
  Dashboard[React dashboard] --> API
  CLI --> API
  API --> Validation[Strict schema and CIDR reservations]
  Validation --> OPA[Local OPA Rego]
  OPA --> Plan[Saved Terraform plan or cloud export]
  Reviewer -->|Exact digest approval| Plan
  Operator -->|Independent execution| Runner[Fixed local Terraform runner]
  Plan --> Runner
  Runner --> State[Encrypted per tenant and request Terraform state]
  API --> DB[(Encrypted documents in SQLite WAL)]
  Runner --> Readback[Readback and drift verification]
  Readback --> DB
  Plan --> Exports[Azure GCP and paid service exports]
  Runner -->|Opt in approved networking only| AWS[AWS account and role scope]
  Key[Separate encryption key] --> DB
  Key --> State
```

```mermaid
stateDiagram-v2
  submitted --> denied: policy finding
  denied --> submitted: author correction
  submitted --> planned: policy and Terraform validate
  planned --> approved: independent review
  approved --> executing: consume approval and commit journal
  executing --> applied: Terraform apply and readback
  executing --> uncertain: timeout or failure
  uncertain --> applied: operator reconciliation proves state
  applied --> planned: operator repair plan
  applied --> destroy_planned: saved destroy plan
  destroy_planned --> destroy_approved: independent review
  destroy_approved --> executing: consume teardown approval
  executing --> destroyed: destroy readback proves empty state
```

```mermaid
flowchart TD
  VPC[Private network 10.42.0.0/16] --> A[Private subnet 10.42.1.0/24]
  VPC --> B[Private subnet 10.42.2.0/24]
  A -->|Allowed private TCP 443| B
  Internet --> Deny[Public ingress rejected by OPA]
  LB[Optional internal HTTPS ALB] --> Backend[Encrypted private EC2 backend]
  DNS[Optional private DNS record] --> VPC
```

The last diagram describes validated configuration intent and the AWS adapter. The local Terraform module records that intent using terraform_data; it creates no actual network, VM, DNS server or load balancer.

Trust boundaries: browser and CLI input cross a bearer-authenticated API. The server administrator configures identities, trusted policy bytes, the fixed Terraform module and verified binaries. Persistent content is encrypted with AES-256-GCM and purpose-bound authentication. The separate key is never written into the data volume. Terraform plaintext exists only in private transient workspaces; AWS execution requires tmpfs. Each role is deny-by-default. Every lookup is tenant-scoped. Tenant and request workspace paths are derived from a tenant hash and server-generated UUID. Network reservations are transactional within each tenant, and configured AWS tenants sharing an account also share overlap checks.

OPA uses a copied policy file in a private temporary directory and an argument array, timeout and output limit. Terraform uses a fixed executable, fixed local module and generated tfvars, with no shell, provisioner or request-selected module. AWS uses only the pinned provider and generated allowlisted configuration. Local execution inherits no cloud credentials or CLI overrides. Opt-in AWS execution passes only a verified temporary session for the configured account and assumed role. A separate positive resource allowlist blocks paid services and unknown resource types. User-provided tags reject Terraform expression syntax.

A plan digest binds operation, unique generation nonce, revision, request, policy, saved-plan hash, configuration hash, state hash, plan JSON and Terraform version. Approval expires after 15 minutes. Replanning always rotates the digest. Approval and execution require separate identities; neither may turn a cloud export into an execution artifact. Apply verifies hashes twice, executes only the saved plan, and reads Terraform state back before reporting completion. AWS readback additionally uses a refresh-only provider plan; unknown or drifted results cannot prove completion. Teardown uses a fresh destroy plan and independent approval. Drift repair requires a fresh plan and approval too.

SQLite BEGIN IMMEDIATE transactions serialize state changes across connections. State and audit append commit atomically with FULL synchronization and WAL journaling. The execution-start record and consumed approval commit before Terraform runs. A crash leaves executing or uncertain state; further mutation is blocked until controlled reconciliation. Audit hashes detect modification of recorded events on startup, but cannot prove that a privileged filesystem operator did not truncate the chain or replace the database.

Tests cover denied public ingress and IAM escalation, tenant escapes, CIDR overlap, module injection, stale/replayed approval, missing teardown approval, modified plan/state artifacts, SQLite restart/rollback, uncertain completion, local drift and repair. Threats outside this release include compromised administrators, stolen bearer tokens, malicious local binaries, host disk access and denial of service against the synchronous runner. No live AWS trust boundary has been validated; offline tests use a synthetic transport and a real provider plan generated with blocked cloud endpoints. Hosted deployment still needs federated identity, TLS, external audit anchoring and reviewed recovery controls. See the encryption and AWS execution documents for crash and key-loss limits.
