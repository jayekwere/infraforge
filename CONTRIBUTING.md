# Contributing

Use Node 24.13+ or Node 26. Install locked dependencies with npm ci --ignore-scripts and install OPA/Terraform with the checksum-verifying scripts. Run npm run verify, browser tests and Python tests before submitting a change. Cloud adapter changes also require provider schema validation. Docker changes require both container and Compose lifecycle tests.

Keep actions SHA-pinned and dependencies locked. Never commit keys or credentials, accept a request-selected module/executable, inherit ambient cloud credential chains, or execute cloud applies from CI. AWS credentials must be explicit temporary sessions with verified account/role scope. Test paid-type rejection and exact-plan approval before changing the networking allowlist. Distinguish contract tests, provider validation, local execution and live cloud validation. New cloud execution capability needs an explicitly authorized design and separate cost approval.

Format TypeScript consistently, document contract changes, and include negative tests for approval, tenant and network boundaries. Pull requests run without repository secrets or write permissions; do not introduce pull_request_target execution of untrusted code.

Encryption changes must verify wrong-key/context rejection, state restart, volume plaintext scans, migration and rotation. Keep encryption keys and identity files outside the data volume. Preserve incomplete migration markers and quarantined execution state.
