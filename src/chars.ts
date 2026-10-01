/**
 * Character-count module — computes the serialized character count
 * of the active tool set for the `/tbox status` char line.
 *
 * Computes the total JSON-serialized character count of every enabled
 * tool's full definition: name, description, parameters (JSON schema),
 * promptGuidelines, and sourceInfo.
 *
 * The serialization shape is deterministic: `JSON.stringify` of
 * `{name, description, parameters, promptGuidelines, sourceInfo}`
 * per tool, summed. This is the contract — the shape is an impl detail.
 *
 * Returns a split: `core` (non-togglable floor: builtin + sdk tools and
 * non-declarable MCP tools) and `extension` (togglable budget: extension
 * tools and declarable MCP tools).
 *
 * @module
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { isDeclarableMcpTool } from "./mcp.js";

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/** Returns true if the tool is an extension tool (not builtin, not sdk). */
export function isExtensionTool(tool: ToolInfo): boolean {
	return (
		tool.sourceInfo.source !== "builtin" && tool.sourceInfo.source !== "sdk"
	);
}

/**
 * True for tools tbox can toggle: extension tools and declarable MCP tools.
 * The single togglability predicate for every classification site (char
 * counts, masked counts, list char totals). MCP tools are ordinary
 * declarable tools despite their builtin source; non-declarable MCP tools
 * (`codemode`/`deferred`/`hidden`) are never togglable — counting them
 * would inflate `n masked` and the char buckets with tools tbox did not
 * mask. Not used by the registry scan: `isExtensionTool` keeps its narrow
 * meaning there so MCP tools don't become bogus orphan toolsets.
 */
export function isTogglableTool(tool: ToolInfo): boolean {
	return isExtensionTool(tool) || isDeclarableMcpTool(tool);
}

/** Counts of all togglable tools and active togglable tools (single pass). */
export function extensionToolCounts(pi: ExtensionAPI): {
	total: number;
	active: number;
} {
	const active = new Set(pi.getActiveTools());
	let total = 0;
	let activeCount = 0;
	for (const t of pi.getAllTools()) {
		if (!isTogglableTool(t)) continue;
		total++;
		if (active.has(t.name)) activeCount++;
	}
	return { total, active: activeCount };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a single tool's definition for character counting.
 *
 * Fields: `name`, `description`, `parameters`, `promptGuidelines`, `sourceInfo`.
 *
 * The object keys are in a fixed order so the JSON output is deterministic
 * across runs with the same tool population.
 */
export function serializeToolDef(tool: ToolInfo): string {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines,
		sourceInfo: tool.sourceInfo,
	});
}

/** Result of computeCharCount: core (untoggleable) vs extension (togglable). */
export interface CharCountSplit {
	/** Active non-togglable tool char count — non-togglable floor (builtin
	 * + sdk, and non-declarable MCP tools). */
	core: number;
	/** Active togglable tool char count — togglable budget. */
	extension: number;
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

/**
 * Compute the serialized character count split into core and extension buckets.
 *
 * @param pi - The extension API
 * @returns `{ core, extension }` where core is the non-togglable floor
 * (builtin + sdk, non-declarable MCP) and extension is the togglable set
 */
export function computeCharCount(pi: ExtensionAPI): CharCountSplit {
	const activeNames = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();

	const result: CharCountSplit = { core: 0, extension: 0 };

	for (const tool of allTools) {
		if (!activeNames.has(tool.name)) continue;
		const len = serializeToolDef(tool).length;
		if (!isTogglableTool(tool)) {
			result.core += len;
		} else {
			result.extension += len;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Format a CharCountSplit into the one-line display for the `/tbox status` char line.
 */
export function formatCharSplit({ core, extension }: CharCountSplit): string {
	const total = core + extension;
	return `Char count \u2014 core: ${core} | extension: ${extension} (total: ${total})`;
}
