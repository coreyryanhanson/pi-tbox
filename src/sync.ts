/**
 * /tbox sync — align the live tool set with declared toolset state.
 *
 * A projector, not a governance flow: for each toolset masking's
 * `computeDrift` flags, one `forceToolsetEnabled` call with the tier-resolved
 * desired state (`effectiveEnabled` — branch entry → settings pin → packaged
 * default; mode-aware, so under focus the desired state IS the focus list).
 * No state writes, no cascade, no coherence validation — incoherent declared
 * state is projected faithfully, exactly as masking's restore does at boot.
 *
 * The projector verifies its own write: `setActiveTools` is not a contract
 * (pi's `_applyToolLoadout` silently drops names it refuses to activate), so
 * success is claimed only from post-apply observation — a write pi silently
 * drops is reported as a residual, not a success.
 *
 * No refusal surface: under allowlist it enforces the list rather than
 * refusing, and over a corrupt (empty) allowlist entry it fail-closes to the
 * same empty-list enforcement masking's per-turn re-assert performs — the
 * reply names the corruption instead of presenting the empty list as intent.
 *
 * Exempt from `checkFocusGuard` by the shared principle: a command may act
 * under focus only when its desired state is derived from focus itself —
 * sync's desired state resolves through mode-aware `effectiveEnabled`, so it
 * has no will of its own.
 *
 * @module
 */

import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	computeDrift,
	effectiveEnabled,
	forceToolsetEnabled,
	getActuatableNames,
	getRegisteredToolsets,
	readBranchModeState,
	readMergedToolsetDefaults,
	type ToolsetSpec,
} from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Reply copy
// ---------------------------------------------------------------------------

/** Possibility-only cause hint — never a diagnosis; */
const RESIDUAL_HINT = "possibly not activatable under your --tools filter";

/** Replaces the aligned claim — never present the empty list as intent; */
const CORRUPT_MODE_REPLY =
	"mode entry is corrupt — focus list is empty, which no command can " +
	"produce; enforced as empty; repair with /tbox focus off or /tbox " +
	"defaults restore, then re-run sync";

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Message + notify level (the `DefaultsResult` pattern); corrupt-mode rides
 *  `warning`, ordinary replies `info`. */
interface SyncResult {
	message: string;
	level: "info" | "warning";
}

/**
 * Align the live tool set with declared toolset state.
 *
 * Predicate-first: only toolsets `computeDrift` flagged reach the write, so
 * `forceToolsetEnabled`'s always-emit behavior emits exactly where there is
 * a real delta and clean toolsets produce no write and no event. Persists
 * nothing — `getEntries()` is unchanged by a sync run.
 *
 * @param pi     - The extension API
 * @param branch - Chat branch snapshot (read once; already read by the
 *   dispatcher — the predicate, the intent resolution, and the mode read all
 *   see the same snapshot)
 * @returns the result: the no-op, aligned with per-toolset deltas, or a
 *   residual report at `info`; the corrupt-mode corruption report at
 *   `warning`
 */
export function syncToolsets(
	pi: ExtensionAPI,
	branch: readonly SessionEntry[],
): SyncResult {
	const facts = computeDrift(pi, branch);
	const { mode, allowlist } = readBranchModeState(branch);
	// Corrupt empty allowlist is still corruption with zero drift — see
	// CORRUPT_MODE_REPLY; checked before the no-op early return so it is
	// never presented as intent.
	const corruptMode = mode === "allowlist" && allowlist.length === 0;
	const corruptReply: SyncResult = {
		message: CORRUPT_MODE_REPLY,
		level: "warning",
	};
	if (facts.length === 0) {
		return corruptMode
			? corruptReply
			: { message: "Already in the desired state.", level: "info" };
	}

	const specById = new Map<string, ToolsetSpec>(
		getRegisteredToolsets().map((e) => [e.spec.id, e.spec]),
	);
	// Under allowlist mode the settings tier is never consulted — the focus
	// list is the desired state — so skip the disk read, like computeDrift does.
	const defaults = mode === "allowlist" ? {} : readMergedToolsetDefaults();
	const actuatable = getActuatableNames(pi);
	const before = new Set(pi.getActiveTools());

	interface Write {
		id: string;
		members: string[];
		written: number;
		desired: boolean;
	}

	// Write pass — one forceToolsetEnabled per drifted toolset. `written` is
	// the delta the apply attempts: actuatable members not yet active (intent
	// on) or active members stripped (intent off). Members are disjoint across
	// toolsets (defineToolset rejects a shared name), so each write only
	// touches its own spec's names and the pre-loop snapshot stays valid.
	const writes: Write[] = [];
	for (const fact of facts) {
		const spec = specById.get(fact.id);
		if (!spec) continue; // unreachable in-process; the registry cannot change mid-loop
		const { enabled } = effectiveEnabled(spec, branch, defaults);
		if (enabled) {
			const members = [...spec.names].filter((n) => actuatable.has(n));
			forceToolsetEnabled(pi, spec, true);
			writes.push({
				id: spec.id,
				members,
				written: members.filter((n) => !before.has(n)).length,
				desired: true,
			});
		} else {
			const members = [...spec.names].filter((n) => before.has(n));
			forceToolsetEnabled(pi, spec, false);
			writes.push({
				id: spec.id,
				members,
				written: members.length,
				desired: false,
			});
		}
	}

	// The corruption report replaces the verify verdict — see CORRUPT_MODE_REPLY.
	if (corruptMode) return corruptReply;

	// Verify pass — one post-apply observation for all writes, compared per
	// drifted toolset against what the apply should have produced. Success is
	// claimed from observation, never from the write calls or emitted events —
	// pi silently drops names it refuses to activate.
	const after = new Set(pi.getActiveTools());
	const segments: string[] = [];
	let residual = false;
	for (const w of writes) {
		if (w.desired) {
			const stillInactive = w.members.filter((n) => !after.has(n)).length;
			residual ||= stillInactive > 0;
			segments.push(
				stillInactive === 0
					? `+${w.id}: re-added ${w.written}`
					: `+${w.id}: wrote ${w.written}, ${stillInactive} still inactive after the write (${RESIDUAL_HINT})`,
			);
		} else {
			// actuateRemove filters raw spec.names out in one write — removal
			// cannot be refused (unlike activation), so no residual arm here.
			segments.push(`+${w.id}: stripped ${w.written}`);
		}
	}

	const deltas = segments.join("; ");
	// A global alignment claim only when every drifted toolset converged; a
	// residual segment speaks for itself and must not ride under "aligned".
	if (residual) return { message: deltas, level: "info" };
	return {
		message:
			mode === "allowlist"
				? `aligned to the active focus list: ${deltas}`
				: `aligned: ${deltas}`,
		level: "info",
	};
}
