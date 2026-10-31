# Architecture and threat model

```mermaid
flowchart LR
  Engineer -->|Bearer token| API[TypeScript loopback REST API]
  Dashboard[React dashboard] --> API
  CLI --> API
  API --> Validation[Schema and CIDR checks]
  Validation --> OPA[Local OPA subprocess]
  OPA --> Plan[Digest bound orchestration plan]
  Reviewer -->|Independent approval| Plan
  Plan --> Operator
  Operator --> Inventory[In memory simulated inventory]
  API --> Audit[Hash chained diagnostic events]
```

```mermaid
flowchart TD
  VPC[10.42.0.0/16] --> A[Private segment 10.42.1.0/24]
  VPC --> B[Private segment 10.42.2.0/24]
  A -->|TCP 443 allowed within VPC| B
  Internet -->|Denied by policy| VPC
```

Trust boundaries: browser inputs and bearer tokens enter a loopback service. The operator configures identities and trusted local policy bytes. OPA is executed using a fixed executable and argument array with a timeout; no shell receives request content. Policy is copied into a private temporary directory. Requesters cannot choose a Terraform source or executable.

Threats addressed by tests include cross-tenant reads, self approval, unapproved apply, stale approvals, CIDR escape, network overlap, IAM action escalation and public ingress. Compromised workstation, stolen bearer tokens, malicious operators, memory tampering and policy-author compromise are outside this demo's protection.

Reservations are tenant-scoped. Tenant networks may overlap because the simulator has no shared cloud routing domain. Real cloud integration must enforce network overlap within the actual routing domain.
