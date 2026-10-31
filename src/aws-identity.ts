import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { Credentials } from "./aws.js";
try {
	let raw = "";
	for await (const c of process.stdin) {
		raw += c;
		if (raw.length > 16384) throw Error();
	}
	const value = JSON.parse(raw),
		session = Credentials.parse(value.session);
	if (value.region !== "us-west-2") throw Error();
	const client = new STSClient({
		region: value.region,
		endpoint: "https://sts.us-west-2.amazonaws.com",
		credentials: {
			accessKeyId: session.accessKeyId,
			secretAccessKey: session.secretAccessKey,
			sessionToken: session.sessionToken,
		},
		maxAttempts: 1,
	});
	const result = await client.send(new GetCallerIdentityCommand({}), {
		abortSignal: AbortSignal.timeout(10000),
	});
	process.stdout.write(
		JSON.stringify({ Account: result.Account, Arn: result.Arn }),
	);
	client.destroy();
} catch {
	process.stderr.write("AWS identity verification failed\n");
	process.exitCode = 1;
}
