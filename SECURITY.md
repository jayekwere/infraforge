# Security policy

InfraForge 0.2.x is an offline infrastructure orchestration project, not a production-ready hosted service. Cloud execution is disabled in both the orchestrator and Terraform runner. Do not expose its API publicly, mount cloud credentials into its container or apply fictional cloud examples.

Use distinct strong role tokens and an encrypted host disk. Server identity configuration, local policy/module files and tool binaries are trusted administrator inputs. Tokens stay in browser memory. Local Terraform state is isolated by tenant and request and contains no intended secrets, but it is plaintext. SQLite and audit hashes do not defend against a privileged filesystem administrator replacing or truncating history.

Report vulnerabilities privately through GitHub private vulnerability reporting if enabled; otherwise contact the maintainer before publishing exploit details. Do not include secrets in reports. Supported version: 0.2.x. Security changes need negative tests and complete local verification. Refer to the threat model and recovery procedures before changing approval or execution behavior.
