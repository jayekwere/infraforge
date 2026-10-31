import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "./test/browser",
	timeout: 120000,
	expect: { timeout: 30000 },
	workers: 1,
	use: {
		baseURL: "http://127.0.0.1:18082",
		headless: true,
		viewport: { width: 1512, height: 1100 },
	},
	webServer: {
		command: "node scripts/browser-server.mjs",
		url: "http://127.0.0.1:18082",
		reuseExistingServer: false,
		timeout: 20000,
	},
	reporter: "list",
});
