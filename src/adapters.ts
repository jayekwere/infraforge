import type { Spec } from "./core.js";
/** Cloud adapters only render Terraform configuration. No cloud CLI or provider is executed here. */
export function renderAdapter(spec: Spec) {
	const tags = { ...spec.tags, managed_by: "infraforge", Name: spec.name };
	if (spec.module === "aws-network-v1") {
		const result: any = {
			terraform: {
				required_version: ">= 1.15.8, < 1.16",
				required_providers: {
					aws: { source: "hashicorp/aws", version: "6.20.0" },
				},
			},
			provider: { aws: { region: "us-west-2", default_tags: { tags } } },
			resource: {
				aws_vpc: {
					network: {
						cidr_block: spec.cidr,
						enable_dns_support: true,
						enable_dns_hostnames: true,
					},
				},
				aws_subnet: Object.fromEntries(
					spec.subnets.map((cidr, i) => [
						"private_" + i,
						{
							vpc_id: "${aws_vpc.network.id}",
							cidr_block: cidr,
							availability_zone:
								"us-west-2" + String.fromCharCode(97 + (i % 3)),
							map_public_ip_on_launch: false,
						},
					]),
				),
				aws_route_table: { isolated: { vpc_id: "${aws_vpc.network.id}" } },
				aws_route_table_association: Object.fromEntries(
					spec.subnets.map((_, i) => [
						"private_" + i,
						{
							subnet_id: "${aws_subnet.private_" + i + ".id}",
							route_table_id: "${aws_route_table.isolated.id}",
						},
					]),
				),
				aws_security_group: {
					workload: {
						name: spec.name,
						vpc_id: "${aws_vpc.network.id}",
						ingress: spec.ingress.map((r) => ({
							from_port: r.port,
							to_port: r.port,
							protocol: "tcp",
							cidr_blocks: [r.cidr],
							ipv6_cidr_blocks: [],
							prefix_list_ids: [],
							security_groups: [],
							self: false,
							description: "Validated private ingress",
						})),
						egress: [],
					},
				},
				aws_default_security_group: {
					closed: { vpc_id: "${aws_vpc.network.id}", ingress: [], egress: [] },
				},
			},
			output: { vpc_id: { value: "${aws_vpc.network.id}" } },
		};
		if (spec.compute) {
			result.data = { aws_caller_identity: { current: {} } };
			result.resource.aws_kms_key = {
				volume: {
					description: "InfraForge encrypted compute volumes",
					enable_key_rotation: true,
					deletion_window_in_days: 30,
				},
			};
			result.resource.aws_iam_role = {
				compute: {
					name: spec.name,
					assume_role_policy: JSON.stringify({
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: { Service: "ec2.amazonaws.com" },
								Action: "sts:AssumeRole",
							},
						],
					}),
				},
			};
			result.resource.aws_iam_instance_profile = {
				compute: { name: spec.name, role: "${aws_iam_role.compute.name}" },
			};
			if (spec.iam.length) {
				if (spec.iam.some((a) => !a.startsWith("logs:")))
					throw Error(
						"AWS compute adapter only permits scoped CloudWatch Logs actions",
					);
				result.resource.aws_cloudwatch_log_group = {
					compute: { name: "/infraforge/" + spec.name, retention_in_days: 30 },
				};
				result.resource.aws_iam_role_policy = {
					logs: {
						role: "${aws_iam_role.compute.id}",
						policy: JSON.stringify({
							Version: "2012-10-17",
							Statement: [
								{
									Effect: "Allow",
									Action: spec.iam,
									Resource: "${aws_cloudwatch_log_group.compute.arn}:*",
								},
							],
						}),
					},
				};
			}
			result.resource.aws_instance = {
				compute: {
					ami: spec.compute.ami,
					instance_type: spec.compute.instanceType,
					subnet_id: "${aws_subnet.private_0.id}",
					vpc_security_group_ids: ["${aws_security_group.workload.id}"],
					associate_public_ip_address: false,
					iam_instance_profile: "${aws_iam_instance_profile.compute.name}",
					metadata_options: {
						http_endpoint: "enabled",
						http_tokens: "required",
						http_put_response_hop_limit: 1,
					},
					root_block_device: {
						encrypted: true,
						kms_key_id: "${aws_kms_key.volume.arn}",
						volume_type: "gp3",
						volume_size: 20,
					},
					tags,
				},
			};
		}
		if (spec.dns) {
			result.resource.aws_route53_zone = {
				private: {
					name: spec.dns.zone,
					vpc: { vpc_id: "${aws_vpc.network.id}" },
				},
			};
			result.resource.aws_route53_record = {
				service: {
					zone_id: "${aws_route53_zone.private.zone_id}",
					name: spec.dns.name + "." + spec.dns.zone,
					type: "A",
					ttl: 60,
					records: [spec.dns.address],
				},
			};
		}
		if (spec.loadBalancer) {
			result.resource.aws_lb = {
				internal: {
					name: spec.name,
					internal: true,
					load_balancer_type: "application",
					subnets: ["${aws_subnet.private_0.id}", "${aws_subnet.private_1.id}"],
					security_groups: ["${aws_security_group.workload.id}"],
					drop_invalid_header_fields: true,
				},
			};
			result.resource.aws_lb_target_group = {
				backend: {
					name: spec.name,
					port: 443,
					protocol: "HTTPS",
					vpc_id: "${aws_vpc.network.id}",
					target_type: "instance",
					health_check: {
						enabled: true,
						path: spec.loadBalancer.healthPath,
						protocol: "HTTPS",
						matcher: "200-299",
					},
				},
			};
			result.resource.aws_lb_target_group_attachment = {
				compute: {
					target_group_arn: "${aws_lb_target_group.backend.arn}",
					target_id: "${aws_instance.compute.id}",
					port: 443,
				},
			};
			result.resource.aws_lb_listener = {
				https: {
					load_balancer_arn: "${aws_lb.internal.arn}",
					port: 443,
					protocol: "HTTPS",
					ssl_policy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
					certificate_arn: spec.loadBalancer.certificateArn,
					default_action: {
						type: "forward",
						target_group_arn: "${aws_lb_target_group.backend.arn}",
					},
				},
			};
			result.resource.aws_security_group.workload.egress = [
				{
					from_port: 443,
					to_port: 443,
					protocol: "tcp",
					cidr_blocks: [],
					ipv6_cidr_blocks: [],
					prefix_list_ids: [],
					security_groups: [],
					self: true,
					description: "HTTPS to private backends",
				},
			];
		}
		return result;
	}
	if (spec.module === "azure-network-v1")
		return {
			terraform: {
				required_version: ">= 1.15.8, < 1.16",
				required_providers: {
					azurerm: { source: "hashicorp/azurerm", version: "4.50.0" },
				},
			},
			provider: { azurerm: { features: {} } },
			resource: {
				azurerm_resource_group: {
					network: { name: spec.name, location: "westus2", tags: spec.tags },
				},
				azurerm_virtual_network: {
					network: {
						name: spec.name,
						location: "${azurerm_resource_group.network.location}",
						resource_group_name: "${azurerm_resource_group.network.name}",
						address_space: [spec.cidr],
						tags: spec.tags,
					},
				},
				azurerm_subnet: Object.fromEntries(
					spec.subnets.map((cidr, i) => [
						"private_" + i,
						{
							name: "private-" + i,
							resource_group_name: "${azurerm_resource_group.network.name}",
							virtual_network_name: "${azurerm_virtual_network.network.name}",
							address_prefixes: [cidr],
						},
					]),
				),
				azurerm_network_security_group: {
					private: {
						name: spec.name,
						location: "${azurerm_resource_group.network.location}",
						resource_group_name: "${azurerm_resource_group.network.name}",
						security_rule: [
							...spec.ingress.map((r, i) => ({
								name: "private-" + i,
								priority: 100 + i,
								direction: "Inbound",
								access: "Allow",
								protocol: "Tcp",
								description: "InfraForge private segmentation",
								source_port_ranges: [],
								destination_port_ranges: [],
								source_address_prefixes: [],
								destination_address_prefixes: [],
								source_application_security_group_ids: [],
								destination_application_security_group_ids: [],
								source_port_range: "*",
								destination_port_range: String(r.port),
								source_address_prefix: r.cidr,
								destination_address_prefix: spec.cidr,
							})),
							{
								name: "deny-all-inbound",
								priority: 4096,
								direction: "Inbound",
								access: "Deny",
								protocol: "*",
								description: "InfraForge private segmentation",
								source_port_ranges: [],
								destination_port_ranges: [],
								source_address_prefixes: [],
								destination_address_prefixes: [],
								source_application_security_group_ids: [],
								destination_application_security_group_ids: [],
								source_port_range: "*",
								destination_port_range: "*",
								source_address_prefix: "*",
								destination_address_prefix: "*",
							},
							{
								name: "deny-all-outbound",
								priority: 4096,
								direction: "Outbound",
								access: "Deny",
								protocol: "*",
								description: "InfraForge private segmentation",
								source_port_ranges: [],
								destination_port_ranges: [],
								source_address_prefixes: [],
								destination_address_prefixes: [],
								source_application_security_group_ids: [],
								destination_application_security_group_ids: [],
								source_port_range: "*",
								destination_port_range: "*",
								source_address_prefix: "*",
								destination_address_prefix: "*",
							},
						],
					},
				},
				azurerm_subnet_network_security_group_association: Object.fromEntries(
					spec.subnets.map((_, i) => [
						"private_" + i,
						{
							subnet_id: "${azurerm_subnet.private_" + i + ".id}",
							network_security_group_id:
								"${azurerm_network_security_group.private.id}",
						},
					]),
				),
			},
		};
	if (spec.module === "gcp-network-v1")
		return {
			terraform: {
				required_version: ">= 1.15.8, < 1.16",
				required_providers: {
					google: { source: "hashicorp/google", version: "7.10.0" },
				},
			},
			variable: {
				project: {
					type: "string",
					description: "Explicit sandbox project required; no default",
				},
			},
			provider: { google: { project: "${var.project}", region: "us-west1" } },
			resource: {
				google_compute_network: {
					network: {
						name: spec.name,
						auto_create_subnetworks: false,
						delete_default_routes_on_create: true,
					},
				},
				google_compute_subnetwork: Object.fromEntries(
					spec.subnets.map((cidr, i) => [
						"private_" + i,
						{
							name: spec.name + "-" + i,
							ip_cidr_range: cidr,
							region: "us-west1",
							network: "${google_compute_network.network.id}",
							private_ip_google_access: true,
						},
					]),
				),
				google_compute_firewall: Object.fromEntries([
					...spec.ingress.map((r, i) => [
						"private_" + i,
						{
							name: spec.name + "-" + i,
							network: "${google_compute_network.network.name}",
							direction: "INGRESS",
							priority: 1000,
							source_ranges: [r.cidr],
							target_tags: [spec.name],
							allow: [{ protocol: "tcp", ports: [String(r.port)] }],
						},
					]),
					[
						"deny-egress",
						{
							name: spec.name + "-deny-egress",
							network: "${google_compute_network.network.name}",
							direction: "EGRESS",
							priority: 65534,
							destination_ranges: ["0.0.0.0/0"],
							deny: [{ protocol: "all" }],
						},
					],
				]),
			},
		};
	throw Error("No cloud adapter for local module");
}
