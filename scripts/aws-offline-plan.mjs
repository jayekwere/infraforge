// Real provider plan with synthetic credentials and every endpoint forced to a closed loopback port.
// This fixture never applies resources and cannot reach AWS.
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	mkdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { awsConfiguration } from "../dist/src/aws.js";
const spec = {
	name: "offline-network",
	module: "aws-network-v1",
	cidr: "10.42.0.0/16",
	subnets: ["10.42.1.0/24"],
	ingress: [{ cidr: "10.42.1.0/24", port: 443 }],
	iam: [],
	encrypted: true,
	tags: { owner: "platform", environment: "development" },
};
const target = {
	accountId: "000000000000",
	region: "us-west-2",
	roleArn: "arn:aws:iam::000000000000:role/InfraForgeNetwork",
};
const dir = mkdtempSync(join(tmpdir(), "infraforge-aws-plan-"));
try {
	const config = awsConfiguration(
		spec,
		target,
		"00000000-0000-0000-0000-000000000000",
		"demo",
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
		readFileSync("terraform/aws-network/.terraform.lock.hcl"),
	);
	writeFileSync(
		join(dir, "terraform.rc"),
		`provider_installation { filesystem_mirror { path = "${resolve(".tools/providers")}" include = ["registry.terraform.io/hashicorp/aws"] } }`,
	);
	const run = (args) =>
		execFileSync(resolve(".tools/terraform"), args, {
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				TF_CLI_CONFIG_FILE: join(dir, "terraform.rc"),
				AWS_ACCESS_KEY_ID: "ASIA0000000000000000",
				AWS_SECRET_ACCESS_KEY: "synthetic-credentials-for-offline-validation",
				AWS_SESSION_TOKEN: "synthetic-token-for-offline-validation",
				AWS_EC2_METADATA_DISABLED: "true",
				CHECKPOINT_DISABLE: "1",
			},
			encoding: "utf8",
			timeout: 60000,
		});
	run(["init", "-backend=false", "-lockfile=readonly"]);
	run(["plan", "-refresh=false", "-input=false", "-out=offline.tfplan"]);
	const json = JSON.parse(run(["show", "-json", "offline.tfplan"]));
	mkdirSync("test/fixtures", { recursive: true });
	writeFileSync(
		"test/fixtures/aws-plan.json",
		JSON.stringify({ spec, target, plan: json }, null, 2) + "\n",
	);
	console.log(
		"PASS: real AWS provider offline plan generated; no apply and no reachable cloud endpoint",
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
