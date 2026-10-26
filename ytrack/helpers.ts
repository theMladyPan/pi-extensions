// YTrack helpers: harvest Duo gateway cookies from the user's main Vivaldi
// via the Chrome DevTools Protocol, then call the YouTrack REST API with
// them plus a permanent token.
//
// Requirements:
//   - Main Vivaldi running with --remote-debugging-port=<cdpPort> (default 9222)
//   - ~/.config/ytrack/config.json with { token, baseUrl, cdpPort, cookieDomain }
//
// No npm dependencies: uses Node's global fetch and WebSocket.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface YtrackConfig {
	token: string;
	baseUrl: string;
	cdpPort: number;
	cookieDomain: string;
}

const CONFIG_PATH = path.join(os.homedir(), ".config", "ytrack", "config.json");
const LOGIN_POLL_INTERVAL_MS = 3000;

export async function loadConfig(): Promise<YtrackConfig> {
	let raw: string;
	try {
		raw = await fs.readFile(CONFIG_PATH, "utf-8");
	} catch {
		throw new Error(
			`YTrack config not found at ${CONFIG_PATH}. Create it with:\n` +
				JSON.stringify({ token: "perm-...", baseUrl: "https://ytrack.swan.sk", cdpPort: 9222, cookieDomain: "ytrack.swan.sk" }, null, 2),
		);
	}
	const parsed = JSON.parse(raw) as Partial<YtrackConfig>;
	if (!parsed.token || !parsed.baseUrl || !parsed.cookieDomain) {
		throw new Error(`YTrack config at ${CONFIG_PATH} is missing token, baseUrl or cookieDomain.`);
	}
	return {
		token: parsed.token,
		baseUrl: parsed.baseUrl.replace(/\/+$/, ""),
		cdpPort: parsed.cdpPort ?? 9222,
		cookieDomain: parsed.cookieDomain,
	};
}

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol helpers
// ---------------------------------------------------------------------------

interface CdpTab {
	id: string;
	title: string;
	url: string;
	webSocketDebuggerUrl: string;
}

function cdpHttp(port: number, p: string): string {
	return `http://localhost:${port}${p}`;
}

/** Promise wrapper around Node's global WebSocket for a single request/response. */
function wsCall(url: string, message: unknown, timeoutMs = 10000): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const ws = new WebSocket(url);
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				reject(new Error(`CDP WebSocket timeout (${url.slice(0, 60)}...)`));
			}
		}, timeoutMs);

		ws.onopen = () => {
			ws.send(JSON.stringify(message));
		};
		ws.onmessage = (ev: MessageEvent) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				const data = JSON.parse(String(ev.data)) as Record<string, unknown>;
				ws.close();
				resolve(data);
			} catch (err) {
				reject(new Error(`Failed to parse CDP response: ${String(err)}`));
			}
		};
		ws.onerror = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(
				new Error(
					`Cannot connect to browser CDP at ${url.slice(0, 60)}. ` +
						"Is Vivaldi running with --remote-debugging-port? " +
						"Start it with: vivaldi --remote-debugging-port=9222",
				),
			);
		};
	});
}

async function getBrowserWsUrl(port: number): Promise<string> {
	const resp = await fetch(cdpHttp(port, "/json/version"));
	if (!resp.ok) {
		throw new Error(`Browser CDP not reachable on port ${port} (HTTP ${resp.status}). Start Vivaldi with: vivaldi --remote-debugging-port=${port}`);
	}
	const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
	if (!info.webSocketDebuggerUrl) {
		throw new Error(`Browser CDP on port ${port} did not return a webSocketDebuggerUrl.`);
	}
	return info.webSocketDebuggerUrl;
}

/** Get the Duo gateway session cookies (path=/ on the YouTrack host). */
export async function getGatewayCookies(port: number, domain: string): Promise<Record<string, string>> {
	const browserWs = await getBrowserWsUrl(port);
	const result = await wsCall(browserWs, { id: 1, method: "Storage.getCookies" });
	const cookies = (result.result as { cookies?: Array<{ domain: string; path: string; name: string; value: string }> } | undefined)?.cookies ?? [];
	const out: Record<string, string> = {};
	for (const c of cookies) {
		if (c.domain === domain && c.path === "/") {
			out[c.name] = c.value;
		}
	}
	return out;
}

export function hasDuoSession(cookies: Record<string, string>): boolean {
	return "_DUO_APER_LOCAL_" in cookies && cookies["_DUO_APER_LOCAL_"].length > 0;
}

/** Open a new tab in the user's main browser and navigate it to url. */
export async function openTab(port: number, url: string): Promise<CdpTab> {
	const resp = await fetch(cdpHttp(port, `/json/new`), { method: "PUT" });
	if (!resp.ok) {
		throw new Error(`Failed to open tab via CDP (HTTP ${resp.status}).`);
	}
	const tab = (await resp.json()) as CdpTab;
	// Vivaldi often ignores the ?url= parameter, so navigate explicitly.
	await wsCall(tab.webSocketDebuggerUrl, { id: 1, method: "Page.navigate", params: { url } });
	return tab;
}

/** Close a single tab (target) without touching the rest of the browser. */
export async function closeTab(port: number, tabId: string): Promise<void> {
	const browserWs = await getBrowserWsUrl(port);
	await wsCall(browserWs, { id: 1, method: "Target.closeTarget", params: { targetId: tabId } });
}

export interface LoginFlowOptions {
	timeoutMs?: number;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

/**
 * Ensure a Duo gateway session exists.
 * - If the browser already has one, return it immediately (no window opened).
 * - Otherwise open a YouTrack tab in the user's main Vivaldi, wait for them
 *   to log in manually (Keycloak + Duo), then close the tab.
 */
export async function loginFlow(config: YtrackConfig, opts: LoginFlowOptions = {}): Promise<Record<string, string>> {
	const timeoutMs = opts.timeoutMs ?? 240_000;
	const start = Date.now();

	// Already logged in? Done without opening anything.
	const existing = await getGatewayCookies(config.cdpPort, config.cookieDomain);
	if (hasDuoSession(existing)) {
		opts.onProgress?.("Duo session already active in browser — no login needed.");
		return existing;
	}

	opts.onProgress?.(`Opening YouTrack login tab in your browser — please log in (Keycloak + Duo). Timeout: ${Math.round(timeoutMs / 1000)}s.`);
	const tab = await openTab(config.cdpPort, `${config.baseUrl}/`);

	try {
		while (Date.now() - start < timeoutMs) {
			if (opts.signal?.aborted) {
				throw new Error("Login flow aborted.");
			}
			await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS));
			const cookies = await getGatewayCookies(config.cdpPort, config.cookieDomain);
			if (hasDuoSession(cookies)) {
				opts.onProgress?.(`Login detected after ${Math.round((Date.now() - start) / 1000)}s.`);
				return cookies;
			}
			const elapsed = Math.round((Date.now() - start) / 1000);
			opts.onProgress?.(`Waiting for login... (${elapsed}s)`);
		}
		throw new Error(`Login timed out after ${Math.round(timeoutMs / 1000)}s. Try the login action again.`);
	} finally {
		await closeTab(config.cdpPort, tab.id).catch(() => {
			/* tab already closed */
		});
	}
}

// ---------------------------------------------------------------------------
// YouTrack REST API
// ---------------------------------------------------------------------------

export interface ApiResult {
	status: number;
	ok: boolean;
	body: string;
}

/** Call the YouTrack REST API with gateway cookies + permanent token. */
export async function ytrackApi(
	config: YtrackConfig,
	cookies: Record<string, string>,
	method: string,
	apiPath: string,
	bodyJson?: string,
): Promise<ApiResult> {
	if (!apiPath.startsWith("/")) {
		throw new Error(`path must start with "/", got: ${apiPath}`);
	}

	const cookieHeader = Object.entries(cookies)
		.map(([k, v]) => `${k}=${v}`)
		.join("; ");

	const headers: Record<string, string> = {
		Cookie: cookieHeader,
		Authorization: `Bearer ${config.token}`,
		Accept: "application/json",
	};
	if (bodyJson !== undefined) {
		JSON.parse(bodyJson); // validate early with a clear error
		headers["Content-Type"] = "application/json";
	}

	const resp = await fetch(`${config.baseUrl}${apiPath}`, {
		method,
		headers,
		body: bodyJson,
	});

	const text = await resp.text();
	if (resp.status === 303) {
		throw new Error(
			"Duo gateway returned 303 (session expired or missing). Re-run with the login flow — the user needs to log in again in their browser.",
		);
	}
	if (resp.status === 401) {
		throw new Error("YouTrack returned 401 Unauthorized — the permanent token in the config is invalid or revoked.");
	}
	return { status: resp.status, ok: resp.ok, body: text };
}
