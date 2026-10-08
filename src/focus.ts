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
	clearAllToolsetEntries,
	forceToolsetEnabled,
	getEffectiveDefault,
	getRegisteredToolsets,
	readBranchModeState,
	readMergedToolsetDefaults,
	setDefaultResolutionMode,
	toggleBatch,
	type BranchReader,
} from "pi-tool-masking";
import { forwardClosure } from "./requires-graph.js";
import { resolveGroup, checkFocusGuard } from "./groups.js";
import {
	setFocusUnit,
	getFocusUnit,
	rerenderSlot,
	persistFocusUnit,
} from "./status-slot.js";

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
 * 3. Live-actuates each registered toolset via `forceToolsetEnabled` (the
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
	// fanout (emitted synchronously inside forceToolsetEnabled) renders the
	// focus glyph, not a one-frame-stale count glyph. The final rerenderSlot
	// covers the no-event edge case (re-focus on an identical allowlist).
	setFocusUnit(resolved.label);
	persistFocusUnit(pi, resolved.label);

	setDefaultResolutionMode(pi, "allowlist", ids);
	const allow = new Set(ids);
	for (const { spec } of getRegisteredToolsets()) {
		forceToolsetEnabled(pi, spec, allow.has(spec.id));
	}

	rerenderSlot(pi);

	return `Focus on "${resolved.label}" — allowlist of ${ids.length} toolset${ids.length === 1 ? "" : "s"}.`;
}

/**
 * Solo on a single unit — the lockless cousin of focus.
 *
 * One `toggleBatch` over the closure partition: enable ops for every
 * registered id in the unit's transitive `requires` closure (what
 * `resolveFocusUnit` returns), disable ops for every other registered
 * id. The partition is disjoint over a transitive closure, so the batch
 * is coherent by construction (an enabled id's deps are always inside
 * the enabled set) — no two-phase disable-all-then-enable, no persisted
 * intermediate state. Unregistered seeds in the closure are dropped
 * (the batch throws a plain `Error` on an explicit unregistered op).
 *
 * Refused while focus is active (own guard, checked before unit
 * resolution so focus is the first thing reported) — exit focus first,
 * like every other actuation path.
 *
 * @returns A human-readable result or error message.
 */
export function soloUnit(
	pi: ExtensionAPI,
	input: string,
	sessionManager: BranchReader,
): string {
	const guard = checkFocusGuard(true, "solo");
	if (guard !== null) return guard;

	const resolved = resolveFocusUnit(input);
	if (!resolved.ok) return resolved.error;

	const registered = new Set(
		getRegisteredToolsets().map((e) => e.spec.id),
	);
	const unitSet = new Set(resolved.toolsetIds);
	const ops = [
		...[...unitSet]
			.filter((id) => registered.has(id))
			.map((id) => ({ id, desired: true })),
		...[...registered]
			.filter((id) => !unitSet.has(id))
			.map((id) => ({ id, desired: false })),
	];
	toggleBatch(pi, sessionManager, ops);

	const n = resolved.toolsetIds.length;
	return `Solo on "${resolved.label}" — ${n} toolset${n === 1 ? "" : "s"} (+ requires deps) on, everything else off.`;
}

/**
 * Exit focus to effective defaults — the shared mechanism behind `focus off`
 * and `/tbox defaults restore` (shared tombstone + apply mechanism, one
 * message per surface).
 *
 * Durable via tombstone: stale per-toolset branch entries (e.g. pre-focus
 * manual toggles) are cleared with `clearAllToolsetEntries`, so a later
 * /reload lands at the same defaults the live apply produced.
 * `forceToolsetEnabled` is the no-cascade apply path — applying a
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
	// fanout (emitted synchronously inside forceToolsetEnabled) renders the
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
		forceToolsetEnabled(pi, spec, getEffectiveDefault(spec, snapshot));
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
	return `Focus off — ${count} toolset${count === 1 ? "" : "s"} restored to effective defaults.`;
}

/**
 * Thrown by {@link focusRelease} — see its doc for why a corrupt or empty
 * allowlist mode entry refuses up-front.
 *
 * Name-matched by the dispatch seam (`err?.name`, never `instanceof` —
 * throwers may come from another physical copy of this module), so the
 * constructor sets `name` explicitly. The message is diagnostic payload
 * only — the seam renders its own fixed refusal copy.
 */
class CorruptModeStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CorruptModeStateError";
	}
}

/**
 * Exit focus by **retaining the live selection**.
 *
 * Switches to exclusion mode first, then flushes the allowlist selection
 * through the library's planner (`toggleBatch`): enable ops for allowlist
 * members, disable ops for every other registered id — the same partition
 * as `soloUnit`. The batch is delta-based: only ids whose pre-call tier
 * resolution disagreed with the desired value (or whose tools were
 * force-added within the turn — the repair arm) get per-toolset branch
 * entries; tier-consistent ids keep falling through the tier chain, so a
 * later settings pin applies instead of being silently overridden by a
 * stale entry. Every registered id is actuated (a no-op when its loadout
 * already matches), so what you see is what you keep — a later /reload
 * re-resolves the same selection.
 *
 * Refusal contract. The mode flip and focus-unit clear precede
 * the batch because `toggleBatch` refuses under allowlist governance, so
 * a planner refusal — `ContradictionError` for a non-closure-complete
 * allowlist, `CycleError` for a dormant `requires` cycle — is caught and
 * compensated: best-effort restore of the pre-release mode entry and
 * unit (only when non-null), original error rethrown raw, refusal copy
 * at the dispatch seam. Planner refusals are pre-write throws, so
 * resolved state is exactly the pre-release state; a mid-execute write
 * failure is not rewound — the catch is deliberately name-agnostic.
 * Either way the append-only branch holds more entries than before. A
 * corrupt or empty allowlist mode entry refuses up-front with
 * {@link CorruptModeStateError}, before any mutation: an empty allowlist
 * is unrepresentable through any sanctioned writer
 * (`setDefaultResolutionMode` refuses an empty array at write time), so
 * a release over one could never be compensated — and the fail-fast is
 * what keeps the seam's "nothing changed" copy honest (without it the
 * flip succeeds, the batch can refuse, and the compensation itself is
 * refused). The check sits after the mode guard because exclusion mode
 * reports `allowlist: []` too.
 *
 * Guarded on the branch mode state — the same shared branch read the
 * library's restore and resolver use — never on an in-memory mirror: a
 * foreign extension that enters allowlist mode mid-session is seen live
 * and released deliberately (release is an explicitly commanded
 * teardown; a user who types it while any allowlist is active wants the
 * clean slate it performs).
 *
 * Note: unlike `focusOff`, this writes no tombstone (see
 * `applyEffectiveDefaults` for the stale-entry clearing it does).
 */
export function focusRelease(
	pi: ExtensionAPI,
	sessionManager: BranchReader,
): string {
	const { mode, allowlist } = readBranchModeState(sessionManager.getBranch());
	if (mode !== "allowlist") {
		return `Focus is not active. Nothing to release.`;
	}
	// Corrupt/empty allowlist — refuse up-front (see doc for why this
	// can't be compensated and sits after the mode guard).
	if (allowlist.length === 0) {
		throw new CorruptModeStateError(
			"allowlist mode entry is corrupt or empty",
		);
	}

	// Flip the mode BEFORE the flush — toggleBatch refuses under allowlist
	// governance; compensate on throw below (see doc).
	setDefaultResolutionMode(pi, "exclusion");
	const priorUnit = getFocusUnit(); // captured before the clear
	const allowSet = new Set(allowlist);
	setFocusUnit(null);
	persistFocusUnit(pi, null);
	try {
		toggleBatch(
			pi,
			sessionManager,
			getRegisteredToolsets().map(({ spec }) => ({
				id: spec.id,
				desired: allowSet.has(spec.id),
			})),
		);
	} catch (err) {
		// Compensate to net-zero, rethrow original (contract in doc);
		// best-effort — the refusal must win, never a compensation error.
		try {
			setDefaultResolutionMode(pi, "allowlist", allowlist);
			if (priorUnit !== null) {
				setFocusUnit(priorUnit);
				persistFocusUnit(pi, priorUnit);
			}
		} catch {
			// compensation failure is subordinate to the original refusal
		}
		throw err;
	}
	rerenderSlot(pi);

	return `Focus released — selection retained, focus guard lifted.`;
}
