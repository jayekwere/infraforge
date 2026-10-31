# Operations and recovery

Release 0.3 requires encrypted schema 2, a separate raw 32-byte key file and authenticated encrypted Terraform workspace/state files. Never point it at an old plaintext volume and assume it has been upgraded. Use the explicit offline copy migration described in [encryption and rotation](encryption.md). Retain source backups until the migrated inventory and audit history have been verified.

The default data directory is `.data`, or `INFRAFORGE_DATA_DIR`. Persistent files use owner-only permissions. SQLite uses WAL with FULL synchronization. A read-only root container with a writable data volume, separate key secret and tmpfs scratch is the supported Docker arrangement. Run one API service per data directory. Database transactions serialize local connections; this is not a distributed execution lease.

Every apply or destroy consumes independent approval and commits the operation journal before Terraform runs. The worker encrypts valid state checkpoints during the command. The parent seals the final state and workspace and requires readback before reporting completion. Successful terminal operations accept an idempotent retry with the same digest. Failed, timed-out or interrupted operations are not automatically replayed.

For `executing` or `uncertain` results:

1. Stop competing services and inspect the operation journal and workspace lock. Establish that no worker, Terraform or provider process is still running. Never remove an active lock or force-unlock an active Terraform operation.
2. Preserve the complete encrypted directory and its separate key. Do not modify ciphertext or replace a database independently of its workspaces. Wrong keys, authentication failures and missing checkpoints fail closed.
3. After confirming an abrupt process has exited, remove only its stale `workspace.lock` if necessary and restart the service. Run `reconcile REQUEST_ID` with an operator identity.
4. Reconciliation accepts only matching complete state. AWS reconciliation additionally performs provider refresh in the configured account/role. Missing or partial state remains quarantined. A host crash before checkpoint persistence may require a separate investigation of tagged AWS resources; never claim that a missing state file proves their deletion.

An operator can generate an independently approved local repair plan after state drift. AWS repair remains disabled; the AWS execution scope is new isolated networks and separately approved teardown. AWS provider plans/refreshes, session expiry and permission failures are conservative failures. Replanning invalidates prior approval. A changed target, policy, configuration, version, state or saved plan also invalidates execution.

No automatic cleanup, paid recovery, state import, arbitrary command, user-selected module or cloud execution fallback is offered. Azure/GCP are still exports. See [AWS execution](aws-execution.md) for the strict resource allowlist and offline verification boundaries.

Observed development issues: provider route attributes were initially computed/unknown, so the executable module now explicitly specifies an empty route set. Terraform's initial lock activity can create an empty transient state file; the checkpoint worker waits for valid JSON. Older plaintext fixtures and direct file tamper tests were updated to exercise encrypted archives, wrong contexts and state hashes. Local provider socket operations require an environment that permits local plugin sockets. Docker restart tests rediscover dynamically assigned host ports.

The extended Docker test originally reused an idle HTTP connection after a synchronous provider check. Its client now explicitly closes connections between requests; it does not retry mutations. The final image also carries TLS trust roots and provider checksums for both Linux architectures so the read-only offline mirror can be verified without runtime downloads.
