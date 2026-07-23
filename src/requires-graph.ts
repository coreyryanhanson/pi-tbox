/**
 * The one shared helper for the both-direction `requires` closure over
 * `getRegisteredToolsets()`.
 *
 * Tbox re-implements the library's private forward/reverse walks here (the
 * library does not export a graph helper; the walks live privately in
 * `_enableToolset`/`_disableDependents`). This is the **single** place the
 * closure walks live in tbox — commands and the Sprint 4 picker call this
 * helper, never an inline copy (`manager-mvp.md` §2).
 *
 * Built from `getRegisteredToolsets()` specs only — no `globalThis` access.
 *
 * @module
 */

import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Registry access
// ---------------------------------------------------------------------------

/** Snapshot of the registry as a Map<id, entry> for fast lookup. */
function registryMap(): Map<string, RegistryEntry> {
	return new Map(getRegisteredToolsets().map((e) => [e.spec.id, e]));
}

// ---------------------------------------------------------------------------
// Forward closure
// ---------------------------------------------------------------------------

/**
 * Given a set of toolset ids, return the set plus every transitive
 * `requires` target.
 *
 * Forward references (a `requires` id not in the registry) are skipped,
 * not fatal — the library skips them the same way at actuation.
 *
 * @throws Error naming the cycle path if a `requires` cycle is detected.
 */
export function forwardClosure(toolsetIds: Iterable<string>): Set<string> {
	const registry = registryMap();
	const result = new Set<string>();

	const visit = (id: string, path: string[]): void => {
		if (path.includes(id)) {
			throw new Error(
				`[tbox] requires cycle: ${[...path, id].join(" \u2192 ")}`,
			);
		}
		if (result.has(id)) return; // already closed

		result.add(id);
		const entry = registry.get(id);
		if (!entry) return; // seed not in registry — added, no deps

		const nextPath = [...path, id];
		for (const dep of entry.spec.requires ?? []) {
			// Forward reference (dep not yet registered) is skipped, not
			// fatal — the library skips it the same way at actuation.
			if (!registry.has(dep)) continue;
			visit(dep, nextPath);
		}
	};

	for (const id of toolsetIds) visit(id, []);
	return result;
}

// ---------------------------------------------------------------------------
// Reverse closure
// ---------------------------------------------------------------------------

/**
 * Given a set of toolset ids, return the set plus every toolset that
 * transitively `requires` one of them (i.e. the dependents).
 *
 * @throws Error naming the cycle path if a `requires` cycle is detected.
 */
export function reverseClosure(toolsetIds: Iterable<string>): Set<string> {
	const registry = registryMap();
	const seeds = new Set(toolsetIds);
	const result = new Set<string>(seeds);

	// Walk dependents: for each id, find every toolset whose requires
	// contains it, add them, and recurse. Cycle detection via path stack.
	const visit = (id: string, path: string[]): void => {
		for (const [depId, entry] of registry) {
			if (!entry.spec.requires?.includes(id)) continue;
			if (path.includes(depId)) {
				throw new Error(
					`[tbox] requires cycle: ${[...path, depId].join(" \u2192 ")}`,
				);
			}
			if (result.has(depId)) continue;
			result.add(depId);
			visit(depId, [...path, depId]);
		}
	};

	for (const seed of seeds) visit(seed, [seed]);
	return result;
}
