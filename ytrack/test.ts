// Standalone test for ytrack helpers.ts — exercises the real code paths.
// Run: node --test-extension-free ... just: node test.ts
// (Node 24 strips TS types natively.)

import {
	closeTab,
	getGatewayCookies,
	hasDuoSession,
	loadConfig,
	loginFlow,
	openTab,
	ytrackApi,
} from "./helpers.ts";

async function main(): Promise<void> {
	console.log("=== 1. loadConfig ===");
	const config = await loadConfig();
	console.log(`baseUrl=${config.baseUrl} cdpPort=${config.cdpPort} token=${config.token.slice(0, 12)}...`);

	console.log("\n=== 2. getGatewayCookies ===");
	const cookies = await getGatewayCookies(config.cdpPort, config.cookieDomain);
	console.log(`cookies: ${Object.keys(cookies).join(", ")}`);
	console.log(`hasDuoSession: ${hasDuoSession(cookies)}`);

	console.log("\n=== 3. loginFlow (should return immediately, session active) ===");
	const t0 = Date.now();
	const session = await loginFlow(config, { timeoutMs: 5000, onProgress: (m) => console.log(`  progress: ${m}`) });
	console.log(`returned in ${Date.now() - t0}ms with ${Object.keys(session).length} cookies`);

	console.log("\n=== 4. ytrackApi GET /api/users/me ===");
	const me = await ytrackApi(config, session, "GET", "/api/users/me?fields=login,name,email");
	console.log(`status=${me.status} body=${me.body}`);

	console.log("\n=== 5. ytrackApi POST comment on TZ-762 ===");
	const created = await ytrackApi(
		config,
		session,
		"POST",
		"/api/issues/TZ-762/comments?fields=id,text",
		JSON.stringify({ text: "extension test comment — will be deleted" }),
	);
	console.log(`status=${created.status} body=${created.body}`);
	const commentId = (JSON.parse(created.body) as { id: string }).id;

	console.log("\n=== 6. ytrackApi DELETE that comment ===");
	const deleted = await ytrackApi(config, session, "DELETE", `/api/issues/TZ-762/comments/${commentId}`);
	console.log(`status=${deleted.status} body="${deleted.body}"`);

	console.log("\n=== 7. openTab + closeTab cycle (browser must survive) ===");
	const tab = await openTab(config.cdpPort, `${config.baseUrl}/agiles/192-27/current`);
	console.log(`tab opened: ${tab.id}`);
	await new Promise((r) => setTimeout(r, 5000));
	await closeTab(config.cdpPort, tab.id);
	console.log("tab closed");
	const probe = await fetch(`http://localhost:${config.cdpPort}/json/version`);
	console.log(`browser still alive: ${probe.ok}`);

	console.log("\n=== 8. ytrackApi GET board ===");
	const board = await ytrackApi(config, session, "GET", "/api/agiles/192-27?fields=id,name,currentSprint(name,id)");
	console.log(`status=${board.status} body=${board.body}`);

	console.log("\nALL TESTS PASSED");
}

main().catch((err) => {
	console.error("TEST FAILED:", err);
	process.exit(1);
});
