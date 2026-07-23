/**
 * Auto-register pi.builtin and tbox.orphans toolsets at load time.
 *
 * Scans pi.getAllTools() after all extensions have loaded (in session_start)
 * and registers:
 *   - pi.builtin: all tools with source === "builtin"
 *   - tbox.orphans: extension tools not claimed by any other toolset
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

/** Canonical toolset id for orphaned extension tools. */
export const ORPHANS_TOOLSET_ID = "tbox.orphans";

/** Persist key for the builtin toolset. */
const BUILTIN_PERSIST_KEY = "toolset-state:pi.builtin";

/** Persist key for the orphans toolset. */
const ORPHANS_PERSIST_KEY = "toolset-state:tbox.orphans";

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
		// Skip the toolsets we're about to register/update
		if (
			entry.spec.id === BUILTIN_TOOLSET_ID ||
			entry.spec.id === ORPHANS_TOOLSET_ID
		) {
			continue;
		}
		for (const name of entry.spec.names) {
			claimedByToolset.add(name);
		}
	}

	// --- Find orphan extension tools (not claimed by any toolset) ---
	const orphanTools = extensionTools.filter(
		(t) => !claimedByToolset.has(t.name),
	);
	const orphanNames = orphanTools.map((t) => t.name);

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

	// --- Register tbox.orphans ---
	if (orphanNames.length > 0) {
		const orphansSpec: ToolsetSpec = {
			id: ORPHANS_TOOLSET_ID,
			label: "Orphaned Tools",
			description: "Extension tools not claimed by any other toolset.",
			names: new Set(orphanNames),
			persistKey: ORPHANS_PERSIST_KEY,
			defaultEnabled: true,
			masked: false,
		};
		defineToolset(pi, orphansSpec);
	}
}
