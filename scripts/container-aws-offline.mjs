// Executed inside the image by the smoke test. Only closed loopback endpoints; never apply.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { awsConfiguration, validateAwsPlan } from "/app/dist/src/aws.js";
const dir = mkdtempSync("/tmp/infraforge-aws-offline-");
try {
	const spec = {
		name: "offline-network",
		module: "aws-network-v1",
		cidr: "10.42.0.0/16",
		subnets: ["10.42.1.0/24"],
		ingress: [],
		iam: [],
		encrypted: true,
		tags: { owner: "platform", environment: "development" },
	};
	const target = {
		accountId: "000000000000",
		region: "us-west-2",
		roleArn: "arn:aws:iam::000000000000:role/Offline",
	};
	const config = awsConfiguration(
		spec,
		target,
		"00000000-0000-0000-0000-000000000000",
		"offline",
	);
	Object.assign(config.provider.aws, {
		skip_credentials_validation: true,
		skip_requesting_account_id: true,
		skip_metadata_api_check: true,
		skip_region_validation: true,
		endpoints: [{ ec2: "http://127.0.0.1:1", sts: "http://127.0.0.1:1" }],
	});
	delete config.provider.aws.allowed_account_ids;
	writeFileSync(join(dir, "main.tf.json"), JSON.stringify(config));
	writeFileSync(
		join(dir, ".terraform.lock.hcl"),
		readFileSync("/app/terraform/aws-network/.terraform.lock.hcl"),
	);
	writeFileSync(
		join(dir, "terraform.rc"),
		'provider_installation { filesystem_mirror { path = "/app/.tools/providers" include = ["registry.terraform.io/hashicorp/aws"] } }',
	);
	const run = (args) =>
		execFileSync("/app/.tools/terraform", args, {
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				CHECKPOINT_DISABLE: "1",
				TF_CLI_CONFIG_FILE: join(dir, "terraform.rc"),
				AWS_ACCESS_KEY_ID: "ASIA0000000000000000",
				AWS_SECRET_ACCESS_KEY: "synthetic-secret-for-container-offline-test",
				AWS_SESSION_TOKEN: "synthetic-session-for-container-offline-test",
				AWS_EC2_METADATA_DISABLED: "true",
			},
			timeout: 45000,
			encoding: "utf8",
		});
	run(["init", "-backend=false", "-lockfile=readonly", "-no-color"]);
	run([
		"plan",
		"-input=false",
		"-refresh=false",
		"-out=offline.tfplan",
		"-no-color",
	]);
	const plan = JSON.parse(run(["show", "-json", "offline.tfplan"]));
	validateAwsPlan(plan, spec, false);
	const paid = structuredClone(plan);
	paid.resource_changes.push({
		address: "aws_instance.blocked",
		type: "aws_instance",
		mode: "managed",
		change: { actions: ["create"] },
	});
	let blocked = false;
	try {
		validateAwsPlan(paid, spec, false);
	} catch {
		blocked = true;
	}
	if (!blocked) throw Error("Paid resource accepted");
	console.log("aws-offline-provider-ok");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
