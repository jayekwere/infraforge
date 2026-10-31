import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
const results = [];
for (const provider of ["aws", "azure", "gcp"]) {
	const cwd = resolve("examples", provider);
	const binary = resolve(".tools/terraform");
	execFileSync(
		binary,
		["init", "-backend=false", "-input=false", "-no-color"],
		{ cwd, stdio: "inherit", timeout: 180000 },
	);
	const out = JSON.parse(
		execFileSync(binary, ["validate", "-json"], {
			cwd,
			encoding: "utf8",
			timeout: 60000,
		}),
	);
	results.push({
		provider,
		validation: out,
		scope:
			"provider-schema-validation-only; no plan or apply, no cloud API calls",
	});
	if (!out.valid) throw Error(JSON.stringify(out));
}
mkdirSync("docs/evidence", { recursive: true });
writeFileSync(
	"docs/evidence/adapters.json",
	JSON.stringify(
		{
			checkedAt: new Date().toISOString(),
			results,
			liveCloudValidation: false,
		},
		null,
		2,
	) + "\n",
);
console.log(
	"PASS: three cloud adapter configurations validate against pinned provider schemas",
);
