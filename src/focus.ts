/**
 * /tbox focus — single-unit focus with inclusion mode and drift-free exit.
 *
 * Focus is **single-unit**: one group name or one toolset id —
 * but never a builtin. The resolved unit + its forward `requires`
 * closure becomes the allowlist; every other toolset is disabled. On
 * exit, **re-actuation** (not mode flip) drives every toolset back to its
 * `spec.defaultEnabled`, overwriting the focus-era entries.
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getEffectiveDefault,
	getRegisteredToolsets,
	readMergedToolsetDefaults,
	setDefaultResolutionMode,
} from "pi-tool-masking";
import { forwardClosure } from "./requires-graph.js";
import { resolveGroup } from "./groups.js";
import { setFocusUnit, rerenderSlot, persistFocusUnit } from "./status-slot.js";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

type ResolvedUnit =
	| { ok: true; toolsetIds: string[]; label: string }
	| { ok: false; error: string };

/**
 * Resolve a focus unit string to a set of toolset ids.
 *
 * Strategy:
 *   1. Builtin guard — reject the reserved id `pi.builtin`.
 *   2. `+`-prefixed input → strip the prefix and resolve as a registered
 *      toolset id only.
 *   3. Bare input → resolve as a group name only (from config).
 *   4. Neither matches → error (no silent fallback between namespaces).
 */
function resolveFocusUnit(input: string): ResolvedUnit {
	// Builtin guard — reject the reserved id "pi.builtin".
	if (input === "pi.builtin") {
		return {
			ok: false,
			error:
				"builtins are out of tbox's scope; focus on an extension toolset or group instead.",
		};
	}

	const registry = getRegisteredToolsets();

	// --- `+` prefix → toolset ---
	if (input.startsWith("+")) {
		const toolsetId = input.slice(1);
		const toolsetEntry = registry.find((e) => e.spec.id === toolsetId);
		if (!toolsetEntry) {
			return {
				ok: false,
				error: `No toolset matching "${toolsetId}".`,
			};
		}
		// Forward closure only (requires deps). The library's enable cascade
		// is forward-only (pi-tool-masking _enableToolset recurses into
		// spec.requires, never dependents). Including reverseClosure here
		// would pull dependents (e.g. web-learn for web) into the allowlist
		// and focus's enable pass would turn them on — diverging from
		// /tbox <group> on, which only enables the group's own toolsets.
		return {
			ok: true,
			toolsetIds: [...forwardClosure([toolsetId])],
			label: toolsetId,
		};
	}

	// --- Bare → group ---
	const groupResolved = resolveGroup(input);
	if ("group" in groupResolved) {
		const ids = groupResolved.group.toolsets;
		if (ids.length === 0) {
			return {
				ok: false,
				error: `Group "${input}" has no toolsets. Add toolsets via /tbox group ${input} edit, then focus.`,
			};
		}
		// Forward closure only — see the toolset branch above for why
		// reverseClosure must stay out of the allowlist. The second pass
		// disables any non-allowlisted toolset directly, so dependents
		// the user didn't select are turned off, not on.
		return {
			ok: true,
			toolsetIds: [...forwardClosure(ids)],
			label: `group:${input}`,
		};
	}

	return {
		ok: false,
		error: `No group matching "${input}". Use /tbox focus +<toolset> for a toolset.`,
	};
}

// ---------------------------------------------------------------------------
// Focus enter / exit
// ---------------------------------------------------------------------------

/**
 * Enter focus on a single unit.
 *
 * 1. Resolves the unit to an allowlist of toolset ids (+ forward requires
 *    closure, so deps the library would cascade on enable are covered).
 * 2. Sets inclusion mode so unknown toolsets default off.
 * 3. Enables every toolset in the allowlist (first pass — the library
 *    cascades forward deps naturally).
 * 4. Disables every toolset NOT in the allowlist (second pass). Dependent
 *    toolsets the user didn't select are turned off here, not pulled in.
 *
 * @returns A human-readable result or error message.
 */
export function focusUnit(pi: ExtensionAPI, input: string): string {
	const resolved = resolveFocusUnit(input);
	if (!resolved.ok) return resolved.error;

	const allowlist = new Set(resolved.toolsetIds);

	const registry = getRegisteredToolsets();

	// Set the focus unit BEFORE actuating so the TOOLSET_EVENTS.changed
	// fanout (emitted synchronously inside enable()/disable()) renders the
	// focus glyph, not a one-frame-stale count glyph. The final rerenderSlot
	// covers the no-event edge case (re-focus on an identical allowlist).
	setFocusUnit(resolved.label);
	persistFocusUnit(pi, resolved.label);

	// Set inclusion mode before actuating
	setDefaultResolutionMode(pi, "inclusion");

	// ponytail: two-pass approach relies on synchronous enable(). If the
	// library ever adds async enable/disable, the disable pass would race
	// the cascade — guard with a flush/tick before the second pass.
	// First pass: enable allowlist members (library cascades forward deps).
	// For toolsets already in the desired state, still persist the entry so
	// that inclusion-mode restore can find it and doesn't default them off.
	let enabled = 0;

	for (const entry of registry) {
		if (!allowlist.has(entry.spec.id)) continue;

		if (!entry.toolset.isEnabled(pi)) {
			entry.toolset.enable(pi);
			enabled++;
		} else {
			// Already enabled — persist the entry so restore in inclusion
			// mode doesn't silently default this allowlisted toolset off.
			pi.appendEntry(entry.spec.persistKey, { enabled: true });
		}
	}

	// Second pass: disable non-allowlist toolsets. The library's enable()
	// cascade is forward-only (requires), so dependents are never pulled in
	// by the first pass — a pre-enabled dependent is still on and gets
	// disabled here. disable() won't cascade back up a requires edge.
	let disabled = 0;

	for (const entry of registry) {
		const id = entry.spec.id;
		if (allowlist.has(id)) continue;

		if (entry.toolset.isEnabled(pi)) {
			entry.toolset.disable(pi);
			disabled++;
		}
	}

	rerenderSlot(pi);

	return `Focus on "${resolved.label}" — ${enabled} enabled, ${disabled} disabled.`;
}

/**
 * Exit focus via **re-actuation, not mode flip**.
 *
 * For every registered toolset, drives it back to its effective default
 * (settings tier first, then `spec.defaultEnabled`), overwriting the
 * focus-era entries. Then restores exclusion mode so unknown toolsets
 * default on again.
 *
 * Documented: "Restore defaults" means each toolset returns to its
 * effective default — the library never remembers pre-focus state.
 */
export function focusOff(pi: ExtensionAPI): string {
	const registry = getRegisteredToolsets();

	// Clear the focus unit BEFORE re-actuating so the TOOLSET_EVENTS.changed
	// fanout (emitted synchronously inside enable()/disable()) renders the
	// post-focus glyph, not a one-frame-stale focus glyph.
	setFocusUnit(null);
	persistFocusUnit(pi, null);

	// ponytail: focus-era overwrite is destructive — pre-focus manual toggles
	// are lost. The MVP confirms this: "the library never remembers pre-focus
	// state." Add a pre-focus snapshot + restore if users report this as a bug.
	let restored = 0;

	const defaultsSnapshot = readMergedToolsetDefaults();

	for (const entry of registry) {
		const wantsEnabled = getEffectiveDefault(entry.spec, defaultsSnapshot);

		if (wantsEnabled && !entry.toolset.isEnabled(pi)) {
			entry.toolset.enable(pi);
			restored++;
		} else if (!wantsEnabled && entry.toolset.isEnabled(pi)) {
			entry.toolset.disable(pi);
			restored++;
		}
		// Already in the correct state — skip (no entry written)
	}

	setDefaultResolutionMode(pi, "exclusion");
	rerenderSlot(pi);

	return `Focus off — ${restored} toolset${restored !== 1 ? "s" : ""} restored to default.`;
}
