/**
 * /tbox chars — serialized character counter for the active tool set.
 *
 * Computes the total JSON-serialized character count of every enabled
 * tool's full definition: name, description, parameters (JSON schema),
 * promptGuidelines, and sourceInfo.
 *
 * The serialization shape is deterministic: `JSON.stringify` of
 * `{name, description, parameters, promptGuidelines, sourceInfo}`
 * per tool, summed. This is the contract — the shape is an impl detail.
 *
 * Returns a split: `fixed` (builtin + sdk, non-togglable floor) and
 * `tools` (extension tools, togglable budget).
 *
 * @module
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

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
function serializeToolDef(tool: ToolInfo): string {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines,
		sourceInfo: tool.sourceInfo,
	});
}

/** Result of computeCharCount: fixed (untoggleable) vs tools (togglable). */
export interface CharCountSplit {
	/** Active builtin + sdk tool char count — non-togglable floor. */
	fixed: number;
	/** Active extension tool char count — togglable budget. */
	tools: number;
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

/**
 * Compute the serialized character count split into fixed and tools buckets.
 *
 * @param pi - The extension API
 * @returns `{ fixed, tools }` where fixed is builtin+sdk and tools is extension
 */
export function computeCharCount(pi: ExtensionAPI): CharCountSplit {
	const activeNames = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();

	const result: CharCountSplit = { fixed: 0, tools: 0 };

	for (const tool of allTools) {
		if (!activeNames.has(tool.name)) continue;
		const len = serializeToolDef(tool).length;
		if (
			tool.sourceInfo.source === "builtin" ||
			tool.sourceInfo.source === "sdk"
		) {
			result.fixed += len;
		} else {
			result.tools += len;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Format a CharCountSplit into the shared one-line display used by both
 * `/tbox chars` and the `/tbox status` char line.
 */
export function formatCharSplit({ fixed, tools }: CharCountSplit): string {
	const total = fixed + tools;
	return `Char count \u2014 fixed: ${fixed} | tools: ${tools} (total: ${total})`;
}

/**
 * Handle `/tbox chars` — returns the serialized character count split.
 */
export function formatChars(pi: ExtensionAPI): string {
	return formatCharSplit(computeCharCount(pi));
}
