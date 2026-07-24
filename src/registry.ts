/**
 * Auto-register pi.builtin and per-source orphan toolsets at load time.
 *
 * Scans pi.getAllTools() after all extensions have loaded (in session_start)
 * and registers:
 *   - pi.builtin: all tools with source === "builtin"
 *   - tbox.tool@<source>: for each distinct source of extension tools not
 *     claimed by any other toolset
 *
 * sdk tools are never registered — they are out of tbox's domain.
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineToolset, getRegisteredToolsets } from "pi-tool-masking";
import type { ToolsetSpec } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical toolset id for builtin tools (point-3 protected toolset). */
export const BUILTIN_TOOLSET_ID = "pi.builtin";

/** Prefix for per-source orphan toolset ids: tbox.tool@<source>. */
export const ORPHAN_TOOLSET_PREFIX = "tbox.tool@";

/** Persist key for the builtin toolset. */
const BUILTIN_PERSIST_KEY = "toolset-state:pi.builtin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a toolset id for a given orphan source. */
export function orphanToolsetId(source: string): string {
	return `${ORPHAN_TOOLSET_PREFIX}${source}`;
}

/** Build a persist key for a given orphan source. */
function orphanPersistKey(source: string): string {
	return `toolset-state:tbox.tool@${source}`;
}

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

/**
 * Classify tools by source and register the appropriate toolsets.
 *
 * This function is idempotent — re-running with the same tool population
 * is a no-op (the library's defineToolset is idempotent-by-content for
 * unchanged specs).
 *
 * @param pi - The extension API
 */
export function autoRegisterBuiltinAndOrphans(pi: ExtensionAPI): void {
	const allTools = pi.getAllTools();
	const existingToolsets = getRegisteredToolsets();

	// --- Collect builtin tools ---
	const builtinTools = allTools.filter(
		(t) => t.sourceInfo.source === "builtin",
	);
	const builtinNames = builtinTools.map((t) => t.name);

	// --- Collect extension tools (not builtin, not sdk) ---
	const extensionTools = allTools.filter(
		(t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk",
	);

	// --- Find which extension tools are already claimed by a toolset ---
	const claimedByToolset = new Set<string>();
	for (const entry of existingToolsets) {
		// Skip toolsets we manage (ourselves) so orphan tools don't look
		// claimed-by-themselves when we re-register.
		if (entry.spec.id.startsWith(ORPHAN_TOOLSET_PREFIX)) continue;
		if (entry.spec.id === BUILTIN_TOOLSET_ID) continue;
		for (const name of entry.spec.names) {
			claimedByToolset.add(name);
		}
	}

	// --- Find orphan extension tools (not claimed by any toolset) ---
	const orphanTools = extensionTools.filter(
		(t) => !claimedByToolset.has(t.name),
	);

	// --- Group orphan tools by sourceInfo.source ---
	const toolsBySource = new Map<string, typeof orphanTools>();
	for (const tool of orphanTools) {
		const source = tool.sourceInfo.source;
		if (!toolsBySource.has(source)) toolsBySource.set(source, []);
		toolsBySource.get(source)!.push(tool);
	}

	// --- Register pi.builtin ---
	if (builtinNames.length > 0) {
		const builtinSpec: ToolsetSpec = {
			id: BUILTIN_TOOLSET_ID,
			label: "Pi Builtins",
			description: "Core Pi tools that are always available.",
			names: new Set(builtinNames),
			persistKey: BUILTIN_PERSIST_KEY,
			defaultEnabled: true,
			masked: false,
		};
		defineToolset(pi, builtinSpec);
	}

	// --- Register per-source orphan toolsets ---
	for (const [source, tools] of toolsBySource) {
		const names = tools.map((t) => t.name);
		// Pass description only when the source contributes exactly one tool.
		// Multi-tool sources omit description rather than misrepresent one
		// tool's description as the group's.
		const description = tools.length === 1 ? tools[0]!.description : undefined;
		const spec: ToolsetSpec = {
			id: orphanToolsetId(source),
			label: source,
			...(description !== undefined ? { description } : {}),
			names: new Set(names),
			persistKey: orphanPersistKey(source),
			defaultEnabled: true,
			masked: false,
		};
		defineToolset(pi, spec);
	}
}
