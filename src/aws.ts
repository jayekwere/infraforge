import { z } from "zod";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Spec } from "./core.js";
import { renderAdapter } from "./adapters.js";
export const AwsConfig = z
	.object({
		targets: z.record(
			z.string().regex(/^[a-z0-9-]{1,64}$/),
			z
				.object({
					accountId: z.string().regex(/^\d{12}$/),
					region: z.literal("us-west-2"),
					roleArn: z
						.string()
						.regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]+$/),
				})
				.strict(),
		),
		credentialsFile: z.string().min(1),
	})
	.strict();
export type AwsTarget = z.infer<typeof AwsConfig>["targets"][string];
export const Credentials = z
	.object({
		accessKeyId: z.string().regex(/^ASIA[A-Z0-9]{16}$/),
		secretAccessKey: z.string().min(20),
		sessionToken: z.string().min(20),
		expiration: z.iso.datetime(),
	})
	.strict();
export type Session = z.infer<typeof Credentials>;
export const scopeHash = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class AwsGate {
	readonly config: z.infer<typeof AwsConfig>;
	constructor(
		config: unknown,
		private identity = (session: Session, region: string) => {
			try {
				return JSON.parse(
					execFileSync(
						process.execPath,
						[resolve("dist/src/aws-identity.js")],
						{
							input: JSON.stringify({ session, region }),
							env: { PATH: process.env.PATH },
							timeout: 20000,
							maxBuffer: 8192,
						},
					).toString(),
				);
			} catch {
				throw Error("AWS identity verification failed");
			}
		},
		private now = () => Date.now(),
	) {
		this.config = AwsConfig.parse(config);
		for (const target of Object.values(this.config.targets))
			if (
				!target.roleArn.startsWith(
					"arn:aws:iam::" + target.accountId + ":role/",
				)
			)
				throw Error("AWS role and account mismatch");
	}
	target(tenant: string) {
		const target = this.config.targets[tenant];
		if (!target) throw Error("Tenant has no authorized AWS target");
		return target;
	}
	session(tenant: string) {
		const target = this.target(tenant);
		let session: Session;
		try {
			session = Credentials.parse(
				JSON.parse(readFileSync(this.config.credentialsFile, "utf8")),
			);
		} catch {
			throw Error("A valid temporary AWS session file is required");
		}
		const remaining = Date.parse(session.expiration) - this.now();
		if (remaining < 300000 || remaining > 3600000)
			throw Error("AWS session must expire in 5 to 60 minutes");
		const caller = this.identity(session, target.region);
		const role = target.roleArn.split(":role/")[1].split("/").at(-1);
		if (
			caller.Account !== target.accountId ||
			typeof caller.Arn !== "string" ||
			!caller.Arn.startsWith(
				`arn:aws:sts::${target.accountId}:assumed-role/${role}/`,
			)
		)
			throw Error(
				"AWS caller account or role does not match authorized target",
			);
		return {
			target,
			env: {
				AWS_ACCESS_KEY_ID: session.accessKeyId,
				AWS_SECRET_ACCESS_KEY: session.secretAccessKey,
				AWS_SESSION_TOKEN: session.sessionToken,
				AWS_REGION: target.region,
				AWS_DEFAULT_REGION: target.region,
				AWS_EC2_METADATA_DISABLED: "true",
			},
		};
	}
}
export function assertNetworkOnly(spec: Spec) {
	if (
		spec.module !== "aws-network-v1" ||
		spec.compute ||
		spec.dns ||
		spec.loadBalancer ||
		spec.iam.length
	)
		throw Error(
			"Paid provisioning blocked: AWS execution permits isolated networking only",
		);
	const prefix = Number(spec.cidr.split("/")[1]);
	if (
		prefix < 16 ||
		prefix > 28 ||
		spec.subnets.some(
			(s) => Number(s.split("/")[1]) < 16 || Number(s.split("/")[1]) > 28,
		)
	)
		throw Error("AWS CIDR prefixes must be between /16 and /28");
}
export function awsConfiguration(
	spec: Spec,
	target: AwsTarget,
	id: string,
	tenant: string,
) {
	assertNetworkOnly(spec);
	const result: any = renderAdapter(spec);
	result.resource.aws_route_table.isolated.route = [];
	result.resource.aws_vpc.network.assign_generated_ipv6_cidr_block = false;
	result.resource.aws_vpc.network.enable_network_address_usage_metrics = false;
	result.provider.aws.allowed_account_ids = [target.accountId];
	result.provider.aws.region = target.region;
	Object.assign(result.provider.aws.default_tags.tags, {
		infraforge_request: id,
		infraforge_tenant: scopeHash(tenant),
	});
	return result;
}
export function expectedAwsAddresses(spec: Spec) {
	return [
		"aws_vpc.network",
		"aws_route_table.isolated",
		"aws_security_group.workload",
		"aws_default_security_group.closed",
		...spec.subnets.flatMap((_, i) => [
			"aws_subnet.private_" + i,
			"aws_route_table_association.private_" + i,
		]),
	].sort();
}
/** Exact positive allowlist. There is no price estimate or free-tier assumption. */
export function validateAwsPlan(
	json: any,
	spec: Spec,
	destroy: boolean,
	ownership?: { id: string; tenant: string },
) {
	assertNetworkOnly(spec);
	if (
		json.errored ||
		!json.planned_values ||
		!Array.isArray(json.resource_changes)
	)
		throw Error("Invalid AWS plan");
	const expected = expectedAwsAddresses(spec);
	const changes = json.resource_changes;
	if (
		JSON.stringify(changes.map((r: any) => r.address).sort()) !==
		JSON.stringify(expected)
	)
		throw Error("Paid or unexpected AWS resource blocked");
	for (const r of changes) {
		if (
			r.mode !== "managed" ||
			r.provider_name !== "registry.terraform.io/hashicorp/aws" ||
			r.type !== r.address.split(".")[0] ||
			!Array.isArray(r.change?.actions) ||
			!r.change.actions.length ||
			r.change.actions.some(
				(a: string) =>
					!(
						destroy ? ["delete", "no-op"] : ["create", "no-op", "update"]
					).includes(a),
			)
		)
			throw Error("AWS resource or action blocked");
		const values = destroy ? r.change.before : r.change.after;
		if (
			ownership &&
			r.type !== "aws_route_table_association" &&
			(!values?.tags_all ||
				values.tags_all.infraforge_request !== ownership.id ||
				values.tags_all.infraforge_tenant !== scopeHash(ownership.tenant) ||
				values.tags_all.managed_by !== "infraforge")
		)
			throw Error("AWS resource ownership mismatch");
		if (destroy) continue;
		const after = r.change.after,
			unknown = r.change.after_unknown ?? {};
		if (!after) throw Error("AWS unknown planned attributes blocked");
		const hasUnknown = (value: any): boolean =>
			value === true ||
			(Array.isArray(value) && value.some(hasUnknown)) ||
			(value &&
				typeof value === "object" &&
				Object.values(value).some(hasUnknown));
		for (const field of [
			"cidr_block",
			"map_public_ip_on_launch",
			"assign_ipv6_address_on_creation",
			"ingress",
			"egress",
			"route",
			"tags_all",
			"enable_dns_support",
			"enable_dns_hostnames",
			"instance_tenancy",
			"enable_network_address_usage_metrics",
			"assign_generated_ipv6_cidr_block",
		])
			if (hasUnknown(unknown[field]))
				throw Error("Unknown AWS security attributes blocked");
		if (
			r.type === "aws_vpc" &&
			(after.cidr_block !== spec.cidr ||
				after.enable_dns_support !== true ||
				after.enable_dns_hostnames !== true ||
				after.assign_generated_ipv6_cidr_block !== false ||
				after.enable_network_address_usage_metrics !== false ||
				after.instance_tenancy !== "default" ||
				unknown.cidr_block)
		)
			throw Error("AWS VPC does not match request");
		if (r.type === "aws_subnet") {
			const i = Number(r.name.replace("private_", ""));
			if (
				after.cidr_block !== spec.subnets[i] ||
				after.map_public_ip_on_launch !== false ||
				after.assign_ipv6_address_on_creation !== false ||
				unknown.cidr_block ||
				unknown.map_public_ip_on_launch
			)
				throw Error("Unsafe AWS subnet blocked");
		}
		if (
			r.type === "aws_route_table" &&
			(!Array.isArray(after.route) || after.route.length)
		)
			throw Error("AWS routes must remain isolated");
		if (["aws_security_group", "aws_default_security_group"].includes(r.type)) {
			if (
				!Array.isArray(after.ingress) ||
				!Array.isArray(after.egress) ||
				after.egress.length
			)
				throw Error("AWS firewall unknown or egress blocked");
			const rules = after.ingress;
			if (r.type === "aws_default_security_group" && rules.length)
				throw Error("Default security group must remain closed");
			if (
				r.type === "aws_security_group" &&
				(rules.length !== spec.ingress.length ||
					rules.some(
						(rule: any) =>
							!spec.ingress.some(
								(s) =>
									rule.protocol === "tcp" &&
									rule.from_port === s.port &&
									rule.to_port === s.port &&
									JSON.stringify(rule.cidr_blocks) ==
										JSON.stringify([s.cidr]) &&
									!rule.self &&
									!rule.ipv6_cidr_blocks?.length &&
									!rule.security_groups?.length &&
									!rule.prefix_list_ids?.length,
							),
					))
			)
				throw Error("AWS ingress differs from request");
		}
	}
}
