/**
 * MCP tool detection.
 *
 * Pi 0.99+ registers MCP server tools through the builtin `mcp` extension
 * with a `mcp__<server>` namespace and an `exposure` field. Tbox manages a
 * toolset per server covering only the server's *declarable* tools
 * (`exposure: "direct"` — the only exposure that gets declared to the model
 * on every request). Non-declarable MCP tools (`deferred`/`hidden` — a tool
 * never carries `codemode` exposure; pi maps that config value to
 * `deferred` at the tool level) are reachable through codemode/`tool_search`
 * and are managed by pi's `/mcp` surface, not by tbox.
 *
 * `exposure` is read defensively as a plain string so this code also runs on
 * pre-0.99 pi where the field doesn't exist (a missing exposure is treated as
 * `direct`, pi's default). A missing `namespace` means "not an MCP tool" —
 * pi sets `namespace` on every MCP tool it registers.
 *
 * @module
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** The three shared MCP resource tools: registered without a namespace, so
 * structural detection cannot see them and no per-server owner exists. The
 * names are pi's upstream constants. */
const MCP_RESOURCE_TOOLS = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

/** True for any per-server MCP tool (`mcp__*` namespace), declarable or not. */
export function isMcpTool(tool: ToolInfo): boolean {
	return tool.namespace?.name.startsWith("mcp__") === true;
}

/**
 * True for MCP tools tbox can meaningfully manage: declared to the model on
 * every request, activatable, and deactivatable — except when pi's
 * --tools allowlist keeps an MCP tool registered but unactivatable
 * (pi exposes no activatability query, so tbox cannot see that gate).
 * This is the single source of truth for MCP
 * membership and classification — every MCP decision site goes through it.
 */
export function isDeclarableMcpTool(tool: ToolInfo): boolean {
	if (!isMcpTool(tool)) return false;
	const exposure = (tool as { exposure?: string }).exposure ?? "direct";
	return exposure === "direct";
}

/** True for the shared MCP resource tools (no namespace, no per-server owner). */
export function isMcpResourceTool(tool: ToolInfo): boolean {
	return MCP_RESOURCE_TOOLS.has(tool.name);
}
