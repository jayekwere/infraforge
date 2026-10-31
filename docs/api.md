# API contract

All API routes require `Authorization: Bearer TOKEN`. POST bodies require `Content-Type: application/json` and are limited to 32 KiB. Tokens map to server-configured identity and tenant. Request-supplied identity fields are rejected. Authorization failures never grant access to another tenant's object. API errors currently return 400, and missing/invalid bearer tokens return 401. No CORS access is granted.

| Method and route | Role | Body / result |
| --- | --- | --- |
| GET /api/requests | Any authenticated role | Current identity, tenant requests and tenant audit events |
| POST /api/requests | Requester | Strict request schema; reserves network |
| POST /api/requests/:id/revise | Original requester | Replacement spec; invalidates approval |
| POST /api/requests/:id/plan | Author requester or operator | `{}`; policy findings and saved local plan or cloud preview |
| POST /api/requests/:id/approve | Independent approver | `{"digest":"exact plan digest"}` |
| POST /api/requests/:id/apply | Independent operator | Exact digest; local or configured isolated-network AWS saved plan only |
| POST /api/requests/:id/plan-destroy | Operator | `{}`; fresh saved local destroy plan |
| POST /api/requests/:id/destroy | Independent operator | Exact independently approved destroy digest |
| POST /api/requests/:id/drift | Viewer or operator | `{}`; local drift or configured AWS refresh/readback |
| POST /api/requests/:id/plan-repair | Operator | `{}`; fresh local repair plan, then normal review/apply |
| POST /api/requests/:id/reconcile | Operator | `{}`; prove completion of interrupted local or configured AWS operation |

Plan fields include `generation`, `operation`, `created`, `policy`, `digest`, `findings` and `resources`. Local `artifact` contains plan JSON/text, binary plan SHA-256, config/state hashes, version and an isolated workspace reference. Unconfigured cloud `preview` contains Terraform JSON. Configured AWS networking has an executable `artifact` with an account/region/role target and explicit operation; paid resource types stay blocked. Cloud previews are visible under the dashboard export details or in CLI list/plan output; copy the preview object to a `main.tf.json` file for external review. Export is not authorization to execute cloud infrastructure.

Approval and execution use the exact returned digest. A new plan, revision or policy invalidates previous approval. Execution consumes approval before invoking Terraform. Readback must prove completion. Terminal retries with the original operation digest return the recorded result. Request submission is not automatically retried; overlapping reservations reject duplicates. The CLI always connects to local loopback and never accepts a user-selected remote URL.

The list response also reports `capabilities.encryptedStorage`, `capabilities.awsNetworkExecution` for the current tenant, and `capabilities.paidProvisioning` (always false). Persistent request/audit records and Terraform artifacts are encrypted; this authenticated API returns decrypted authorized content.
