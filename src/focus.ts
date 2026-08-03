/**
 * /tbox focus — single-unit focus in allowlist mode, with three exits.
 *
 * Focus is **single-unit**: one group name or one toolset id — but never
 * a builtin. Focus uses **allowlist mode**: the resolved unit + its forward
 * `requires` closure becomes a finite allowlist array stored in the branch
 * mode entry. The library's restore handler applies "in array → on, else →
 * off" across all registered toolsets, including future installs. The array
 * is the authority — focus-enter writes no per-toolset entries. Exits:
 * `focus off` restores effective defaults; `focus release` retains the live
 * selection; `/tbox defaults restore` also ends focus while applying
 * settings (the mechanism lives in `applyEffectiveDefaults`).
 *
 * @module
 */

import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	applyToolsetEnabled,
	clearAllToolsetEntries,
	getActiveAllowlist,
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
		// reverseClosure must stay out of the allowlist. The disable pass
		// turns any non-allowlisted toolset off directly, so dependents the
		// user didn't select are off, not on.
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
 * 2. Persists the allowlist as the branch mode entry (allowlist mode) —
 *    the array is the authority: the library's restore handler applies
 *    "in array → on, else → off", including toolsets registered later.
 * 3. Live-actuates each registered toolset via `applyToolsetEnabled` (the
 *    no-cascade apply path). Non-toolset tools are preserved automatically:
 *    each call is a per-spec delta (enable = union(current, spec.names),
 *    disable = current \ spec.names), so only the spec's own names move.
 *
 * @returns A human-readable result or error message.
 */
export function focusUnit(pi: ExtensionAPI, input: string): string {
	const resolved = resolveFocusUnit(input);
	if (!resolved.ok) return resolved.error;

	const ids = resolved.toolsetIds;

	// Set the focus unit BEFORE actuating so the TOOLSET_EVENTS.changed
	// fanout (emitted synchronously inside applyToolsetEnabled) renders the
	// focus glyph, not a one-frame-stale count glyph. The final rerenderSlot
	// covers the no-event edge case (re-focus on an identical allowlist).
	setFocusUnit(resolved.label);
	persistFocusUnit(pi, resolved.label);

	setDefaultResolutionMode(pi, "allowlist", ids);
	const allow = new Set(ids);
	for (const { spec } of getRegisteredToolsets()) {
		applyToolsetEnabled(pi, spec, allow.has(spec.id));
	}

	rerenderSlot(pi);

	return `Focus on "${resolved.label}" — allowlist of ${ids.length} toolset${ids.length !== 1 ? "s" : ""}.`;
}

/**
 * Exit focus to effective defaults — the shared mechanism behind `focus off`
 * and `/tbox defaults restore` (shared tombstone + apply mechanism, one
 * message per surface).
 *
 * Durable via tombstone: stale per-toolset branch entries (e.g. pre-focus
 * manual toggles) are cleared with `clearAllToolsetEntries`, so a later
 * /reload lands at the same defaults the live apply produced.
 * `applyToolsetEnabled` is the no-cascade apply path — applying a
 * dependent toolset ON cannot surprise-re-enable a pinned-off dependency.
 *
 * Documented: "Restore defaults" means each toolset returns to its
 * effective default — the library never remembers pre-focus state.
 *
 * @returns The number of registered toolsets actuated.
 */
export function applyEffectiveDefaults(
	pi: ExtensionAPI,
	branch: readonly SessionEntry[],
): number {
	// Clear the focus unit BEFORE re-actuating so the TOOLSET_EVENTS.changed
	// fanout (emitted synchronously inside applyToolsetEnabled) renders the
	// post-focus glyph, not a one-frame-stale focus glyph.
	setFocusUnit(null);
	persistFocusUnit(pi, null);

	// Tombstone stale per-toolset branch entries (dedup'd) so /reload after
	// off falls through to settings → exclusion floor → defaultEnabled,
	// matching the live apply below.
	clearAllToolsetEntries(pi, branch);

	const snapshot = readMergedToolsetDefaults();
	const toolsets = getRegisteredToolsets();
	for (const { spec } of toolsets) {
		applyToolsetEnabled(pi, spec, getEffectiveDefault(spec, snapshot));
	}

	setDefaultResolutionMode(pi, "exclusion");
	rerenderSlot(pi);

	return toolsets.length;
}

/**
 * Exit focus by restoring every toolset to its effective default
 * (settings tier first, then `spec.defaultEnabled`).
 */
export function focusOff(
	pi: ExtensionAPI,
	branch: readonly SessionEntry[],
): string {
	const count = applyEffectiveDefaults(pi, branch);
	return `Focus off — ${count} toolset${count !== 1 ? "s" : ""} restored to effective defaults.`;
}

/**
 * Exit focus by **retaining the live selection**.
 *
 * Flushes the allowlist selection to per-toolset branch entries
 * (`{enabled: true}` for allowlist members, `{enabled: false}` for the
 * rest), then switches to exclusion mode. Live state is untouched — what
 * you see is what you keep; a later /reload replays the flushed entries.
 *
 * Guarded: with no active focus, `getActiveAllowlist()` is `undefined` —
 * return a hint instead of flushing `{enabled:false}` for every toolset.
 *
 * Note: unlike `focusOff`, this takes no `branch` — no tombstone, so no
 * stale-entry clearing (see `applyEffectiveDefaults`). The branch is only
 * needed by the shared exit-to-defaults path.
 */
export function focusRelease(pi: ExtensionAPI): string {
	const allow = getActiveAllowlist();
	if (!allow) {
		return `Focus is not active — nothing to release. Use /tbox focus <group>|+<toolset> first.`;
	}

	setFocusUnit(null);
	persistFocusUnit(pi, null);

	// ponytail: each release flushes N per-toolset entries; focus cycles
	// accumulate branch entries over a long session. Upgrade path: a
	// pi-core compact-toolset-entries op, out of scope.
	const allowSet = new Set(allow);
	for (const { spec } of getRegisteredToolsets()) {
		pi.appendEntry(spec.persistKey, { enabled: allowSet.has(spec.id) });
	}
	setDefaultResolutionMode(pi, "exclusion");
	rerenderSlot(pi);

	return `Focus released — selection retained, focus guard lifted.`;
}
