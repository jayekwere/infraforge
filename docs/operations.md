# Operations and recovery

## Storage and backup

The server persists requests, reservations, approvals, operations and hash-chained audit events in `.data/infraforge.sqlite`, schema version 1. SQLite uses WAL and FULL synchronous commits. Terraform uses `.data/workspaces/<tenant-sha256>/<request-uuid>/`. Request workspaces have mode 0700, the database has mode 0600, and the server uses umask 077. Container data lives in a named volume; a container restart retains it.

Run one API service per data directory or named volume. Do not share a writable volume across independently running containers. SQLite serializes database connections, but the local execution owner check is not a distributed lease.

Store the database and workspaces together. Stop the service cleanly before copying the complete data directory or named volume to an encrypted backup destination. Include SQLite WAL/SHM files if present. Restore the complete directory together, keep the same filesystem ownership, and retain `.data/identities.json` separately and securely. Do not restore a database alone over newer Terraform state. Validate requests and audit history after restore; replan approvals if modules, policy or Terraform versions changed. Future database versions are rejected instead of silently downgraded.

Terraform state and plan files are plaintext on the local filesystem. The offline module contains only configuration and Terraform IDs, and no secrets. Protect host disks/backups with encryption. Do not submit secrets as request fields. Remote state, KMS-backed state encryption and cloud credential issuance are not implemented because cloud execution is disabled.

## Interrupted execution

Each execution consumes approval and records its digest before running Terraform. A successful exit also needs state readback to prove the expected resources or empty teardown state. Failed commands and readback failures enter `uncertain`; a process crash may leave `executing`. Automatic retries are blocked. Successful terminal operations accept an idempotent retry with the same digest without executing Terraform again.

1. Stop other service instances and establish that no orphan Terraform process is still running against the request workspace. Do not force-unlock an active Terraform operation.
2. Inspect the operation's audit record, saved plan and `terraform show -json` state within that exact workspace. Workspaces remain reserved and cannot be revised while uncertain.
3. Run `reconcile REQUEST_ID` with an operator token. Reconciliation rejects an executing entry whose original process is still alive. A process session identifier distinguishes a restarted server that reused its own PID. It checks every expected resource's input/output against the approved request; destruction requires empty state.
4. If state proves completion, reconciliation records the terminal state without rerunning Terraform. If state is partial or absent, the workspace remains quarantined. Preserve a full backup and complete forensic review before any manual local repair. There is no API bypass that clears an uncertain operation or reuses its approval.

This recovery mechanism is tested by injecting a lost response after Terraform has completed. It is local-state recovery, not proof of remote cloud recovery. PID reuse can conservatively block reconciliation; resolve that only after process inspection. Multi-host coordination and distributed execution workers are outside this release.

## Drift and remediation

`drift REQUEST_ID` compares Terraform state input and output for every managed local resource against the desired request, including subnets, firewall, identity and optional service configuration. A viewer or operator can check drift. The operator can use `plan-repair REQUEST_ID` to generate an actual saved Terraform change plan; a separate reviewer must approve it before apply. Repair has the same hash and expiry controls as a new deployment. State mutation tests demonstrate detected firewall drift and approved correction. Python `python/drift.py desired.json observed.json` is a separate read-only export comparator.

There is no scheduled cloud drift discovery. Local Terraform state has no remote provider to refresh. Missing/corrupt state that cannot safely generate a plan needs manual inspection, not an automatic recreate or force unlock.

## Policy and artifact failures

Missing OPA, undefined policy output, timeout and malformed output fail closed. Reinstall the verified tool and generate a new plan. Changed policy/module bytes, Terraform version, state or saved plan invalidate execution and require replanning plus fresh approval. A cloud module cannot be executed even if it has an approved export. Azure/GCP unsupported service fields are rejected.

## Observed development failures

- TypeScript 7 required explicit Node/React type selection, now recorded in tsconfig.
- Azure's provider requires all collection fields in inline NSG rule objects. Schema validation exposed the omission; the generator now supplies them and validates successfully.
- Replacing a locally copied read-only Terraform binary initially failed. The installer now writes a unique temporary binary and atomically renames it after checksum verification.
- Browser assertions initially used Playwright's five-second default, which was too short during a loaded local run. They now allow 30 seconds within a bounded two-minute lifecycle test.
- Docker reassigned the dynamically published host port after restart. The smoke test now discovers the port again before checking persistence.

No paid resource provisioning or cloud apply was attempted. Provider-schema validation is not live integration validation.
