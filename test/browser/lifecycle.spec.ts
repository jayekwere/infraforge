import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
test("browser rejects unsafe ingress, corrects request, reviews real plan and approves independent teardown", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");
	async function login(letter: string) {
		await page.getByLabel("Access token").fill(letter.repeat(32));
		await page.getByRole("button", { name: "Connect / refresh" }).click();
		await expect(
			page.getByRole("button", { name: "Connect / refresh" }),
		).toBeEnabled();
	}
	await login("r");
	const spec = JSON.parse(await page.getByLabel("Request JSON").inputValue());
	spec.ingress = [{ cidr: "0.0.0.0/0", port: 22 }];
	await page.getByLabel("Request JSON").fill(JSON.stringify(spec, null, 2));
	await page.getByRole("button", { name: "Submit for planning" }).click();
	await expect(page.getByTestId("state")).toHaveText("submitted");
	await page.getByRole("button", { name: "Generate plan" }).click();
	await expect(page.getByTestId("state")).toHaveText("denied");
	await expect(page.getByText(/IF001/)).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Approve plan", exact: true }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Edit request" }).click();
	spec.ingress = [{ cidr: "10.42.1.0/24", port: 443 }];
	await page.getByLabel("Request JSON").fill(JSON.stringify(spec, null, 2));
	await page.getByRole("button", { name: "Save correction" }).click();
	await expect(page.getByTestId("state")).toHaveText("submitted");
	await page.getByRole("button", { name: "Generate plan" }).click();
	await expect(page.getByTestId("state")).toHaveText("planned");
	await expect(
		page.getByRole("cell", { name: "terraform_data.network", exact: true }),
	).toBeVisible();
	await login("a");
	await page.getByRole("button", { name: "Approve plan", exact: true }).click();
	await expect(page.getByTestId("state")).toHaveText("approved");
	await login("o");
	await page.getByRole("button", { name: "Apply approved plan" }).click();
	await expect(page.getByTestId("state")).toHaveText("applied");
	await page.getByRole("button", { name: "Check drift" }).click();
	await expect(page.getByText(/No drift detected/)).toBeVisible();
	mkdirSync("docs/screenshots", { recursive: true });
	await page.getByLabel("Access token").fill(""); // clear the displayed credential before capture
	await login("o");
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		path: "docs/screenshots/dashboard.png",
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: "docs/screenshots/mobile.png",
		fullPage: true,
	});
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await page.setViewportSize({ width: 1512, height: 1100 });
	await expect(
		page.getByRole("button", { name: "Execute teardown" }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Plan teardown" }).click();
	await expect(page.getByTestId("state")).toHaveText("destroy-planned");
	await login("a");
	await page.getByRole("button", { name: "Approve plan", exact: true }).click();
	await expect(page.getByTestId("state")).toHaveText("destroy-approved");
	await login("o");
	await page.getByRole("button", { name: "Execute teardown" }).click();
	await expect(page.getByTestId("state")).toHaveText("destroyed");
	await page.reload();
	await login("o");
	await expect(page.getByTestId("state")).toHaveText("destroyed");
	expect(errors).toEqual([]);
});
