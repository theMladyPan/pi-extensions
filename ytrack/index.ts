// YTrack tool: access and modify YouTrack issues behind a Duo 2FA gateway.
//
// How it works:
//   The YouTrack host sits behind a Cisco Duo gateway that blocks all API
//   traffic without a browser session. This tool harvests the Duo session
//   cookies from the user's main Vivaldi (via the Chrome DevTools Protocol)
//   and combines them with a permanent YouTrack API token.
//
// Setup (one-time):
//   1. ~/.config/ytrack/config.json  (chmod 600) with the permanent token
//   2. Main Vivaldi started with: vivaldi --remote-debugging-port=9222
//      (add the flag to the desktop launcher so it survives restarts)
//
// When the Duo session expires, the login action opens a YouTrack tab in
// the user's browser for a manual login (Keycloak + Duo), then closes it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	getGatewayCookies,
	hasDuoSession,
	loadConfig,
	loginFlow,
	ytrackApi,
	type ApiResult,
} from "./helpers.ts";

const MAX_RESPONSE_CHARS = 30_000;

const YtrackParameters = Type.Object(
	{
		action: Type.Union([Type.Literal("status"), Type.Literal("login"), Type.Literal("api")], {
			description:
				"status: health check (CDP, session, token, API test). " +
				"login: open YouTrack login tab in the user's browser, wait for manual Duo login, close the tab. " +
				"api: call the YouTrack REST API (needs method + path).",
		}),
		method: Type.Optional(
			Type.Union(
				[Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE")],
				{
					description: "HTTP method for the api action. Default: GET.",
				},
			),
		),
		path: Type.Optional(
			Type.String({
				description:
					"YouTrack REST path for the api action, e.g. /api/issues/TZ-762?fields=id,summary,customFields(name,value(name)) or /api/issues?query=project: tZdravie&max=20",
			}),
		),
		body: Type.Optional(
			Type.String({
				description: "JSON-encoded request body for POST/PUT/PATCH, e.g. {\"text\":\"comment\"} passed as a string.",
			}),
		),
		login: Type.Optional(
			Type.Boolean({
				description:
					"For the api action: if the Duo session is missing/expired, open a login tab for the user instead of failing (default true).",
			}),
		),
	},
	{ additionalProperties: false },
);

function truncate(text: string): string {
	if (text.length <= MAX_RESPONSE_CHARS) return text;
	return `${text.slice(0, MAX_RESPONSE_CHARS)}\n... (truncated, ${text.length} chars total)`;
}

function prettyJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

function formatApiResult(result: ApiResult): string {
	if (!result.body.trim()) {
		return `HTTP ${result.status} (no body)`;
	}
	return `HTTP ${result.status}\n${truncate(prettyJson(result.body))}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ytrack",
		label: "YouTrack",
		description:
			"Access and modify YouTrack issues behind the Duo 2FA gateway. " +
			"Reads/writes go through the YouTrack REST API using Duo session cookies from the user's main Vivaldi plus a permanent token. " +
			"Actions: status (health check), login (manual Duo re-login via browser tab), api (arbitrary REST call: get/list/update/comment on issues, boards, sprints, users, admin).",
		parameters: YtrackParameters,
		async execute(_toolCallId, params, signal, onUpdate) {
			const update = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

			try {
				const config = await loadConfig();

				// ------------------------------------------------------------------
				// status
				// ------------------------------------------------------------------
				if (params.action === "status") {
					const lines: string[] = [];
					lines.push(`Config: OK (baseUrl=${config.baseUrl}, cdpPort=${config.cdpPort})`);

					let cookies: Record<string, string> = {};
					try {
						cookies = await getGatewayCookies(config.cdpPort, config.cookieDomain);
						lines.push(`Browser CDP: reachable. Cookies: ${Object.keys(cookies).join(", ") || "none"}`);
					} catch (err) {
						lines.push(`Browser CDP: FAILED — ${err instanceof Error ? err.message : String(err)}`);
						lines.push("Fix: start Vivaldi with --remote-debugging-port=9222");
						return { content: [{ type: "text", text: lines.join("\n") }], details: { ok: false } };
					}

					lines.push(`Duo session: ${hasDuoSession(cookies) ? "ACTIVE" : "MISSING (run login action)"}`);

					if (hasDuoSession(cookies)) {
						const result = await ytrackApi(config, cookies, "GET", "/api/users/me?fields=login,name,email");
						lines.push(`API test: ${formatApiResult(result)}`);
					}
					return { content: [{ type: "text", text: lines.join("\n") }], details: { ok: true } };
				}

				// ------------------------------------------------------------------
				// login
				// ------------------------------------------------------------------
				if (params.action === "login") {
					const cookies = await loginFlow(config, {
						timeoutMs: 240_000,
						onProgress: update,
						signal: signal ?? undefined,
					});
					const result = await ytrackApi(config, cookies, "GET", "/api/users/me?fields=login,name,email");
					return {
						content: [{ type: "text", text: `Login complete.\n${formatApiResult(result)}` }],
						details: { ok: result.ok },
					};
				}

				// ------------------------------------------------------------------
				// api
				// ------------------------------------------------------------------
				if (params.action === "api") {
					if (!params.path) {
						throw new Error("The api action requires a path, e.g. /api/issues/TZ-762?fields=id,summary");
					}
					const method = (params.method ?? "GET").toUpperCase();

					let cookies = await getGatewayCookies(config.cdpPort, config.cookieDomain);
					if (!hasDuoSession(cookies)) {
						if (params.login === false) {
							throw new Error("No Duo session in browser. Run the login action first (or omit login:false).");
						}
						update("No Duo session — opening login tab in your browser. Please log in (Keycloak + Duo)...");
						cookies = await loginFlow(config, {
							timeoutMs: 240_000,
							onProgress: update,
							signal: signal ?? undefined,
						});
					}

					const result = await ytrackApi(config, cookies, method, params.path, params.body);
					return {
						content: [{ type: "text", text: formatApiResult(result) }],
						details: { ok: result.ok, status: result.status, method, path: params.path },
					};
				}

				throw new Error(`Unknown action: ${params.action}`);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `YTrack error: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});
}
