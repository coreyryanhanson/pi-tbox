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
 * non-declarable tools on either axis) and `extension` (togglable budget:
 * declarable extension and MCP tools).
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
 * True for exposures whose activation declares the tool to the model —
 * pi core's own `_isDeclarable` rule (`direct`/`model-only`; `codemode`/
 * `deferred` reach the model only via explicit activation or tool_search,
 * `hidden` never). Missing exposure reads as `direct`, pi's default, so
 * pre-0.99 pi degrades to declarable.
 */
export function isDeclarableTool(tool: ToolInfo): boolean {
	const exposure = (tool as { exposure?: string }).exposure ?? "direct";
	return exposure === "direct" || exposure === "model-only";
}

/**
 * True for tools tbox can toggle: declarable extension tools and declarable
 * MCP tools. The single togglability predicate for every classification site
 * (char counts, masked counts, list char totals) — non-declarable tools on
 * either axis are never togglable. See AGENTS.md for the full rule.
 */
export function isTogglableTool(tool: ToolInfo): boolean {
	return (
		(isExtensionTool(tool) && isDeclarableTool(tool)) ||
		isDeclarableMcpTool(tool)
	);
}

/**
 * True when the codemode builtin tool is in the active set (enabled via e.g.
 * `defaultTools: ["+codemode"]` or a toolset toggle).
 */
export function isCodemodeActive(pi: ExtensionAPI): boolean {
	return pi.getActiveTools().includes("codemode");
}

/**
 * Static honesty note for the char count under codemode. The count is the
 * serialized definitions of the active set; under codemode pi rewrites
 * declarations at request time (`prepareLoadout`), which tbox cannot measure:
 * mode "on" appends a codemode signature block to every declared callable's
 * description, mode "only" additionally hides active direct declarations
 * while the catalog (budgeted by `codemode.inlineBudget`, default 3000 est.
 * tokens) sits in context. No qualifier on N is sound in all modes (`≥ N`
 * holds only under "on"; under "only" the true footprint can be below N),
 * and a printed numeric range would rot silently on a pi update — so the
 * count renders plainly and the note names the bound instead of guessing it.
 *
 * The `codemode` tool itself is counted like any other builtin: an exclusion
 * would have to be applied in both accumulators or the two surfaces' `core:`
 * counts diverge, and under mode "on" every declared callable's description
 * is rewritten anyway, so excluding one tool buys no accuracy.
 */
export function codemodeNote(): string {
	return (
		"Note: codemode rewrites tool declarations at request time — the codemode " +
		"catalog is budgeted by codemode.inlineBudget (default 3000 est. tokens) " +
		"and every declared callable gains a signature line, so this count does " +
		"not measure codemode's full context footprint."
	);
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
	 * + sdk, and non-declarable tools). */
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
 * (builtin + sdk, non-declarable tools) and extension is the togglable set
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
