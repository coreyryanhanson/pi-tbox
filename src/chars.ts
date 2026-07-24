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
 * All active tools are counted (builtin and sdk included) because the
 * count is the honest serialized size of what the LLM sees.
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

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

/**
 * Compute the total serialized character count for all active tools.
 *
 * @param pi - The extension API
 * @returns The sum of character counts across all active tool definitions
 */
export function computeCharCount(pi: ExtensionAPI): number {
	const activeNames = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();

	let total = 0;
	for (const tool of allTools) {
		if (activeNames.has(tool.name)) {
			total += serializeToolDef(tool).length;
		}
	}
	return total;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handle `/tbox chars` — returns the serialized character count string.
 */
export function formatChars(pi: ExtensionAPI): string {
	const count = computeCharCount(pi);
	return `Serialized character count of active tools: ${count}`;
}
