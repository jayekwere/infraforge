# Encrypted state storage

Release 0.3 stores request and audit JSON as AES-256-GCM envelopes in SQLite schema 2. Terraform state checkpoints and saved workspace contents, including binary plans, configuration and variables, are separately encrypted. Each encryption uses a fresh random 96-bit nonce and 128-bit authentication tag. Version and purpose are authenticated with additional data; a record cannot be moved to a different row or workspace and still authenticate. A short key fingerprint selects the expected key. SQLite schema, request UUID indexes, audit sequence numbers, file sizes and filesystem timestamps remain visible.

The server requires `INFRAFORGE_KEY_FILE`, a raw 32-byte random key outside `INFRAFORGE_DATA_DIR`. There is no plaintext fallback and no default embedded key. `npm run dev` creates `.keys/state.key` only for a fresh local setup. A missing key for existing data stops startup. Back up the key separately from the data. Lost keys cannot be recovered from the data files. Keep key files out of source control, images, logs and the persistent state volume. Local Compose secrets use bind-mounted files, so their host permissions must permit the container UID to read them. The README creates a read-only Docker copy under a private mode-0700 parent directory; it leaves the original host key mode 0600. Never place a world-readable secret copy in a publicly traversable directory.

```sh
node scripts/create-key.mjs /secure/separate/infraforge.key
export INFRAFORGE_KEY_FILE=/secure/separate/infraforge.key
```

The service encrypts content before SQLite writes it to the database or WAL. State and workspace envelopes use atomic rename after file synchronization. A worker observes valid Terraform state writes and encrypts checkpoints during execution, then seals the final state again at completion. A new state file can be transiently empty while Terraform acquires a lock; the worker skips incomplete JSON instead of treating it as a completed checkpoint.

Terraform still needs plaintext while running. The runner opens a private temporary working directory and removes it on normal completion or failure. Docker uses tmpfs for this directory. Real AWS execution requires a Linux tmpfs scratch directory and refuses ordinary disk scratch. Local execution on a host uses the OS temporary directory by default; use an encrypted disk or explicitly configured RAM filesystem with `INFRAFORGE_SCRATCH_DIR`. Host crashes can leave host temporary files behind. Encryption protects persisted application data, not a compromised running host, process memory, swap or core dumps. Normal checkpoints reduce the crash window; they are not a guarantee against a host dying before a state write is sealed.

## Upgrade from 0.2 and rotate keys

Stop every service and Terraform process using the data directory. Take a complete offline copy of the source, including SQLite WAL/SHM and all workspaces. Migration writes a new destination, retains the source, preserves audit history and state, and invalidates plans and approvals. It refuses interrupted/uncertain operations until they have been recovered. A failed migration leaves a pending marker, and server startup refuses that incomplete destination. Use a fresh destination after investigating the failure. Existing plaintext data is never silently converted in place or advertised as securely erased.

```sh
node scripts/create-key.mjs /secure/separate/new.key
node dist/src/migrate.js /backup/offline-data /new/encrypted-data /secure/separate/new.key
```

For key rotation of schema 2, supply the old key as the fourth argument:

```sh
node dist/src/migrate.js /backup/encrypted-data /new/rotated-data /secure/separate/new.key /secure/separate/old.key
```

Point the server at the new data directory and key. Generate a fresh plan before deployment or teardown. Verify inventory and audit history before retiring old backups. Old plaintext copies, filesystem snapshots, swap and backups need separate retention controls. The migration does not claim secure deletion of old media. The key rotation test carries an actual provider-free Terraform state through migration and independently approved teardown.

## Interrupted operations

A request is journaled as executing before Terraform runs. The encrypted checkpoint may prove completion; if it does not, keep the request quarantined. The workspace lock is separate from Terraform's lock and remains after an abrupt process death. Before manually removing `workspace.lock`, stop the service, inspect its recorded process ID and confirm that no worker, Terraform or provider process is alive. Never remove a lock from an active workspace. A missing encrypted state checkpoint is an error, not evidence that infrastructure has disappeared.

An AWS operation can create a resource immediately before a host crash prevents a checkpoint. State encryption cannot solve that uncertainty. Preserve evidence and investigate tagged resources in the configured account before any recovery. Reconciliation refreshes AWS state through the provider and accepts only complete, matching resources or a recorded empty destroy state. Partial, missing, or drifted results stay quarantined; there is no automatic replay or paid recovery path.
