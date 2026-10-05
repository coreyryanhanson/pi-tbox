/**
 * Shared test fixtures — only helpers used verbatim by more than one test
 * file. Per-file "rich mock" setups deliberately stay in their own files:
 * each serves that file's specific assertions.
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MockPI } from "./mock-pi.js";

/** Builtin-source ToolInfo shape shared by MCP test helpers. */
export const BUILTIN_SOURCE = {
	path: "builtin:mcp",
	source: "builtin" as const,
	scope: "user" as const,
	origin: "top-level" as const,
};

/** Register an MCP-shaped tool on a server's namespace. */
export function registerMcpTool(
	mock: MockPI,
	server: string,
	name: string,
	exposure?: "codemode" | "deferred" | "direct" | "hidden",
): void {
	mock.registerTool({
		name,
		description: `${name} description`,
		namespace: { name: `mcp__${server}` },
		sourceInfo: BUILTIN_SOURCE,
		...(exposure ? { exposure } : {}),
	});
}

export const asPi = (m: MockPI): ExtensionAPI => m as unknown as ExtensionAPI;
