import { mkdirSync, writeFileSync } from "node:fs";
import { renderAdapter } from "../dist/src/adapters.js";
import { Request, validate, evaluate } from "../dist/src/core.js";
const base = {
	name: "private-service",
	cidr: "10.42.0.0/16",
	subnets: ["10.42.1.0/24", "10.42.2.0/24"],
	ingress: [{ cidr: "10.42.0.0/16", port: 443 }],
	iam: [],
	encrypted: true,
	tags: { owner: "platform", environment: "development" },
};
for (const provider of ["aws", "azure", "gcp"]) {
	const spec = Request.parse({
		...base,
		module: provider + "-network-v1",
		...(provider === "aws"
			? {
					iam: ["logs:PutLogEvents"],
					compute: { ami: "ami-00000000000000000", instanceType: "t3.micro" },
					dns: {
						zone: "service.example.internal",
						name: "api",
						address: "10.42.1.10",
					},
					loadBalancer: {
						certificateArn:
							"arn:aws:acm:us-west-2:000000000000:certificate/00000000-0000-0000-0000-000000000000",
						port: 443,
						healthPath: "/health",
					},
				}
			: {}),
	});
	validate(spec);
	if (evaluate(spec).length) throw Error("Fixture policy denied");
	const dir = "examples/" + provider;
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		dir + "/main.tf.json",
		JSON.stringify(renderAdapter(spec), null, 2) + "\n",
	);
	writeFileSync(dir + "/request.json", JSON.stringify(spec, null, 2) + "\n");
}
