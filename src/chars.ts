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
 * Returns a split: `core` (builtin + sdk, non-togglable floor) and
 * `extension` (extension tools, togglable budget).
 *
 * @module
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/** Returns true if the tool is an extension tool (not builtin, not sdk). */
export function isExtensionTool(tool: ToolInfo): boolean {
	return (
		tool.sourceInfo.source !== "builtin" && tool.sourceInfo.source !== "sdk"
	);
}

/** Returns true if the tool is a core tool (builtin or sdk). */
export function isCoreTool(tool: ToolInfo): boolean {
	return (
		tool.sourceInfo.source === "builtin" || tool.sourceInfo.source === "sdk"
	);
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
	/** Active builtin + sdk tool char count — non-togglable floor. */
	core: number;
	/** Active extension tool char count — togglable budget. */
	extension: number;
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

/**
 * Compute the serialized character count split into core and extension buckets.
 *
 * @param pi - The extension API
 * @returns `{ core, extension }` where core is builtin+sdk and extension is extension
 */
export function computeCharCount(pi: ExtensionAPI): CharCountSplit {
	const activeNames = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();

	const result: CharCountSplit = { core: 0, extension: 0 };

	for (const tool of allTools) {
		if (!activeNames.has(tool.name)) continue;
		const len = serializeToolDef(tool).length;
		if (isCoreTool(tool)) {
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
