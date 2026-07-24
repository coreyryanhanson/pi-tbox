/**
 * Auto-register pi.builtin and per-source orphan toolsets at load time.
 *
 * Scans pi.getAllTools() after all extensions have loaded (in session_start)
 * and registers:
 *   - pi.builtin: all tools with source === "builtin"
 *   - tbox.tool@<source>: for each distinct source of extension tools not
 *     claimed by any other toolset
 *
 * Returns the set of toolset ids that were registered in this call
 * (so callers can actuate them if the library's restore handler already
 * fired before registration).
 *
 * sdk tools are never registered — they are out of tbox's domain.
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	defineToolset,
	getRegisteredToolsets,
	TOOLSET_EVENTS,
} from "pi-tool-masking";
import type { ToolsetSpec, RegistryEntry } from "pi-tool-masking";

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
 * Returns the set of toolset ids that were newly registered in this call.
 *
 * @param pi - The extension API
 * @returns Array of newly-registered toolset ids (empty if no new registrations)
 */
export function autoRegisterBuiltinAndOrphans(pi: ExtensionAPI): string[] {
	const newIds: string[] = [];
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
		const existing = existingToolsets.find(
			(e) => e.spec.id === BUILTIN_TOOLSET_ID,
		);
		if (!existing) {
			newIds.push(BUILTIN_TOOLSET_ID);
		}
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
		const existing = existingToolsets.find(
			(e) => e.spec.id === orphanToolsetId(source),
		);
		if (!existing) {
			newIds.push(orphanToolsetId(source));
		}
		defineToolset(pi, spec);
	}

	return newIds;
}

// ---------------------------------------------------------------------------
// Restore-timing: actuate a recently-registered toolset to default state
// ---------------------------------------------------------------------------

/**
 * Actuate a set of toolset ids to their defaultEnabled state, without
 * appending persist entries or emitting events.
 *
 * This mirrors what the library's restore handler would have done if it
 * had seen these toolsets at the time it ran. Used after
 * autoRegisterBuiltinAndOrphans when the restore handler already fired
 * before these orphans were registered.
 *
 * @param pi - The extension API
 * @param ids - Toolset ids to actuate (typically the return of
 *   autoRegisterBuiltinAndOrphans)
 */
export function actuateNewToolsets(pi: ExtensionAPI, ids: string[]): void {
	if (ids.length === 0) return;

	const allToolNames = pi.getAllTools().map((t) => t.name);
	const activeSet = new Set(pi.getActiveTools());
	let changed = false;

	for (const id of ids) {
		const entry = getRegisteredToolsets().find(
			(e: RegistryEntry) => e.spec.id === id,
		);
		if (!entry) continue;

		const enabled = entry.spec.defaultEnabled !== false;
		const registeredNames = [...entry.spec.names].filter((n) =>
			allToolNames.includes(n),
		);

		if (enabled) {
			for (const name of registeredNames) {
				if (!activeSet.has(name)) {
					activeSet.add(name);
					changed = true;
				}
			}
		} else {
			for (const name of registeredNames) {
				if (activeSet.has(name)) {
					activeSet.delete(name);
					changed = true;
				}
			}
		}
	}

	if (changed) {
		pi.setActiveTools([...activeSet]);
		// Emit so wireSlot's listener re-renders the status bar
		pi.events.emit(TOOLSET_EVENTS.changed, {
			id: "tbox.restore-timing",
			enabled: true,
		});
	}
}
