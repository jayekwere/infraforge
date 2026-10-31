# Limitations and recovery

All server state is in memory. Restart loses requests, reservations and audit history. Export evidence before stopping. Restarting the demo safely creates fresh simulated state. The evidence JSON is synthetic and contains no deployed resources.

OPA absence, timeout or malformed output fails closed. Restore the verified binary using the installer, then replan. Any policy change invalidates approval and requires a new plan and reviewer.

Local destruction releases the reservation and deletes simulated inventory only. It has no independent destruction approval and must not be connected to cloud deletion. Distributed locks, durable transactions, retries after remote partial failure and state encryption are not implemented.

The dashboard plan view displays structured intended inputs; it is not a Terraform before/after diff. Drift is an export comparator, not scheduled cloud detection. Browser end-to-end coverage, screenshots, cloud adapters and full Terraform lifecycle integration are still required.

Initial build verification found missing explicit Node type selection with TypeScript 7; tsconfig now lists Node and React types. No cloud execution was attempted.
