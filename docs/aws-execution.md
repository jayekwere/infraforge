# Approval-gated AWS networking

AWS execution is an opt-in administrator capability for a configured tenant/account/role in `us-west-2`. It is disabled by default. Azure and GCP remain exports only. This release was verified offline; no real AWS credentials, live AWS calls, resource creation or teardown were used for validation.

The executable allowlist contains only these networking resource types: `aws_vpc`, `aws_subnet`, `aws_route_table`, `aws_route_table_association`, `aws_security_group` and `aws_default_security_group`. Compute, KMS, DNS, load balancers, NAT gateways, public addresses, flow logs, IPAM, endpoints, IAM changes and every unknown type are blocked. This is a positive resource/action allowlist, not a cost estimate or a reliance on free-tier credits. Requests with compute, DNS, load balancer or IAM fields cannot enter the execution path. They can still be reviewed as exports when AWS execution is disabled.

AWS documents no additional charge for a VPC and private IPv4 addresses, while components including NAT, IPAM and public IPv4 are chargeable. The allowlist deliberately excludes such components. Account-specific taxes, existing account services, organization automation and future pricing changes are outside this code's billing model. Review the policy against current pricing before enabling a real target. Sources: [AWS VPC pricing documentation](https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html#vpc-pricing), [AWS VPC pricing](https://aws.amazon.com/vpc/pricing/).

## Authorization and credentials

An administrator supplies `INFRAFORGE_AWS_CONFIG_FILE`. Copy `examples/aws-execution/config.example.json` and replace its fictional account and role. The file maps each authorized tenant to one account, region and role ARN. There is no request-supplied account, region, endpoint, provider, module or executable override.

The configuration names a separate credential file with this shape:

```json
{
  "accessKeyId": "<temporary ASIA session access key>",
  "secretAccessKey": "<temporary secret>",
  "sessionToken": "<temporary session token>",
  "expiration": "<ISO UTC expiration>"
}
```

The session must have an ASIA key, session token, and declared expiration between five and sixty minutes away. An STS GetCallerIdentity call using the official SDK verifies the exact configured account and assumed-role name. Long-lived AKIA credentials and implicit profile/metadata credential chains are not accepted. The account is also constrained by Terraform's `allowed_account_ids`. Renew the credential file independently; credentials are never part of the request, approval digest or stored workspace. Credentials and the encryption key are passed to internal workers through stdin, and temporary session credentials are passed only to the Terraform process environment. No credentials are printed or committed.

Use a dedicated role whose permissions allow only the listed VPC networking operations in the intended sandbox and enforce InfraForge request/tenant tags where EC2 IAM supports them. Do not grant IAM, compute, KMS, load balancer, DNS or public-address actions. This project does not create or attach that role. Existing organization controls and SCPs remain applicable. The credential expiration field is administrator-supplied metadata; STS validates the session identity, while actual AWS expiration still governs requests.

## Plan and apply

The pinned AWS provider is installed into an offline filesystem mirror during the image build. Runtime init uses only that mirror and the committed dependency lock. The module explicitly disables public subnet addressing, IPv6 assignment and VPC usage metrics, closes the default security group, creates an isolated route table without routes, and limits ingress to requested private CIDRs. Networking requests require /16 through /28 prefixes.

The plan guard checks the exact expected resource addresses, provider, action types, ownership tags and security attributes. Unknown critical attributes, extra resources, replacements, routes, public ingress and egress are rejected. The saved binary plan, configuration, current state, operation, policy and target identity are bound to the approval digest. A requester cannot approve their request. An operator cannot execute a plan they approved. Execution verifies credentials and artifacts again, consumes approval and commits the operation journal before applying the exact saved file.

Apply is followed by provider refresh-only readback. Drift prevents a successful completion claim. Teardown generates a new saved destroy plan and requires its own independent approval. AWS uncertainty can be reconciled only when recorded state plus provider refresh proves completion. AWS repair plans are not enabled in this release; local approved repair remains available.

## Docker opt-in

The default Compose file never enables AWS. For a separately configured target, use the explicit overlay only after reviewing account, role and resource policy:

```sh
export INFRAFORGE_KEY_FILE=/secure/separate/infraforge.key
export INFRAFORGE_AWS_CONFIG_FILE=/secure/separate/aws-config.json
export INFRAFORGE_AWS_SESSION_FILE=/secure/separate/current-session.json
docker compose -f compose.yaml -f compose.aws.yaml up --build -d
```

The config's credential path must be `/run/secrets/aws_session` inside the container. Keep host secret files separate from the data volume and mount them read-only. Ensure file permissions permit only the intended runtime to read them. Do not put actual sessions in `.env`, request JSON or release evidence.

## Offline evidence and limits

`npm run prepare:aws` installs provider software only. `npm run test:aws-plan` runs a real provider plan with synthetic credentials, validation skips confined to that fixture generator, and EC2/STS endpoints forced to a closed loopback port. It never applies that plan. These skips and endpoint overrides are absent from the execution configuration.

`test/aws.test.ts` uses that real plan JSON and an explicitly injected synthetic execution transport to test approvals, target binding, expired credentials, wrong accounts, paid-resource rejection and separate teardown approval. Production has no environment or API switch for that transport. `docs/evidence/aws-offline.json` labels this simulation. Schema validity and offline workflow tests do not establish live provisioning, account permissions, quotas, regional availability or production readiness.
