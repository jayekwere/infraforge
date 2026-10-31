# Release notes

## 0.3.0

AES-256-GCM encryption for request/audit documents, Terraform state checkpoints and saved workspaces. External key required, ciphertext/context authentication, explicit offline copy migration and key rotation. Approval-gated AWS isolated-network execution with tenant/account/role binding, temporary session verification, pinned offline provider mirror, request ownership tags and refreshed readback. Positive resource/action cost allowlist blocks paid services, unknown resources and replacements. Independent teardown approval remains mandatory. New encryption, migration and offline AWS tests; Docker verifies encrypted volume contents across restart. AWS workflow testing uses synthetic credentials and an injected execution transport, with a real provider plan generated against blocked loopback endpoints. No live AWS validation or paid provisioning.

## 0.2.0

Durable SQLite requests, reservations, approvals, operation journal and audit chain. Real provider-free Terraform plan/apply/readback, plan-scoped independent teardown approval, resource-level drift detection, approved repair and quarantined uncertain-outcome recovery. AWS private-network and optional secure compute, private DNS and internal HTTPS ALB exports; Azure/GCP network exports. Provider-schema validation without cloud execution. Browser lifecycle test, desktop/mobile screenshots, hardened Docker/Compose persistence tests and hosted evidence artifacts.

Cloud plans/applies, federated authentication, remote encrypted state and distributed workers remain outside this release. No live multi-cloud provisioning is claimed.

## 0.1.0

Initial offline request simulator, REST API, CLI, React dashboard and OPA policy checks. Superseded by the durable Terraform lifecycle in 0.2.0.
