/**
 * Tbox status slot — the 4-state slot that shows tbox's current state.
 *
 * States:
 *   - Pristine: `○ tbox` (dim) — no tools excluded, not in focus
 *   - Count: `● tbox n masked` (blue) — n extension tools excluded
 *   - Focus: `● focus:<unit> (n)` (green) — focused on a unit, n active extension tools
 *   - Focus empty: `● focus:∅` (red) — focused on an empty allowlist
 *
 * A fifth state covers foreign allowlist governance (branch in allowlist
 * mode without tbox's mirror — see `setFocusModeProvider`).
 *
 * On top of these states, intent-vs-live drift (masking's computeDrift
 * via an injected provider — see `setDriftProvider`) recolors the leading
 * glyph in the `warning` theme color: the glyph shape still carries the
 * state, the color carries the drift signal. Focus-empty keeps its `error`
 * red — error outranks warning — the bubble still reports the drift.
 *
 * @module
 */

import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { lastCustomEntry, TOOLSET_EVENTS } from "pi-tool-masking";
import { extensionToolCounts } from "./chars.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The minimal UI context needed by slot rendering functions. */
export interface SlotCtx {
	ui: {
		setStatus: (slot: string, text: string) => void;
		theme: { fg: (color: string, text: string) => string };
	};
}

/** The 4 possible slot states. */
type SlotState =
	| { kind: "pristine" }
	| { kind: "count"; n: number }
	| { kind: "focus"; unit: string; count: number }
	| { kind: "focus-unlabeled"; count: number }
	| { kind: "focus-empty" };

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The current focus unit (null = not in focus). */
let _focusUnit: string | null = null;

/**
 * The drift provider — installed by index.ts over the captured extension
 * context (the predicate needs a branch snapshot, which pi's API object does
 * not carry). Consulted fresh on every render: no render path computes or
 * carries drift data, so a repair command's own `changed` repaint re-runs the
 * check and clears the marker in the same breath that reported "aligned".
 * Null (or a false return) renders no marker — unset means "not checked
 * here". Presentation-only: this module never imports masking; index.ts
 * builds the closure.
 */
let _driftProvider: (() => boolean) | null = null;

/**
 * The focus-mode provider — installed by index.ts over the captured extension
 * context (the branch mode read needs a branch snapshot, which pi's API
 * object does not carry). Returns true while the branch is in allowlist mode,
 * regardless of who entered it. Consulted fresh on every render; null (or a
 * false return) means "no foreign governance observed" — the mirror alone
 * still drives the focus display. Presentation-only: this module never
 * imports masking; index.ts builds the closure.
 */
let _focusModeProvider: (() => boolean) | null = null;

/** The slot name used for tbox's status bar entry. */
export const SLOT_NAME = "tbox";

/** Durable key for the focus-unit label. */
export const FOCUS_PERSIST_KEY = "tbox-focus-state";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Compute the current slot state based on focus and excluded count.
 *
 * Focus is displayed when either signal says so: the mirror (the unit label
 * for every tbox-driven flow) or the branch mode (a foreign masking consumer
 * can enter allowlist mode without ever touching the mirror — the guard
 * refuses on the branch, so the display must not claim "no governance").
 */
export function computeSlotState(pi: ExtensionAPI): SlotState {
	const { active, total } = extensionToolCounts(pi);

	if (_focusUnit !== null || (_focusModeProvider?.() ?? false)) {
		if (active === 0) {
			return { kind: "focus-empty" };
		}
		if (_focusUnit !== null) {
			return {
				kind: "focus",
				unit: _focusUnit,
				count: active,
			};
		}
		return { kind: "focus-unlabeled", count: active };
	}

	// Excluded = all extension tools minus active extension tools.
	const excluded = total - active;
	if (excluded === 0) {
		return { kind: "pristine" };
	}
	return { kind: "count", n: excluded };
}

/**
 * The leading glyph and trailing text of a slot state, separated so drift
 * can recolor the glyph without touching the state text.
 */
function baseSlotParts(state: SlotState): {
	glyph: string;
	glyphColor: string;
	rest: string;
} {
	switch (state.kind) {
		case "pristine":
			return { glyph: "○", glyphColor: "dim", rest: " tbox" };
		case "count":
			return { glyph: "●", glyphColor: "accent", rest: ` tbox ${state.n} masked` };
		case "focus":
			return { glyph: "●", glyphColor: "success", rest: ` focus:${state.unit} (${state.count})` };
		case "focus-unlabeled":
			return { glyph: "●", glyphColor: "success", rest: ` focus (${state.count})` };
		case "focus-empty":
			return { glyph: "●", glyphColor: "error", rest: " focus:∅" };
		default:
			// Unreachable — SlotState is an exhaustive union; satisfies the
			// switch-without-default rule.
			throw new Error(`unhandled slot state: ${JSON.stringify(state)}`);
	}
}

/**
 * Render the slot text and color for a given state.
 * @param drift - recolors the leading glyph in the warning color on top of
 *   whatever state is active (see the module header); focus-empty keeps its
 *   `error` red — error outranks warning, and the stats commands' warning
 *   bubble still reports the drift for that state.
 */
export function renderSlotText(
	state: SlotState,
	fg: (color: string, text: string) => string,
	drift = false,
): string {
	const { glyph, glyphColor, rest } = baseSlotParts(state);
	const color = drift && glyphColor !== "error" ? "warning" : glyphColor;
	return `${fg(color, glyph)}${rest}`;
}

/**
 * Render the current slot state to the status bar.
 */
export function render(pi: ExtensionAPI, ctx: SlotCtx): void {
	const state = computeSlotState(pi);
	// Fresh check per render — the provider is re-invoked, never cached, so
	// every render path (hook 1, event fanout, rerenderSlot) gets a current
	// verdict by construction. No provider installed = no marker.
	const drift = _driftProvider?.() ?? false;
	// Bind: Theme.fg reads `this.fgColors`; passing it unbound loses `this`.
	const text = renderSlotText(state, ctx.ui.theme.fg.bind(ctx.ui.theme), drift);
	ctx.ui.setStatus(SLOT_NAME, text);
}

/**
 * Install the drift provider (or `null` to unset — renders no marker).
 * Called once from the factory body, like `wireSlot`. The provider itself
 * must be total (never throw) — a diagnostic that crashes the status bar is
 * worse than none.
 */
export function setDriftProvider(provider: (() => boolean) | null): void {
	_driftProvider = provider;
}

/**
 * Install the focus-mode provider (or `null` to unset — display ignores
 * branch mode). Called once from the factory body, like `setDriftProvider`.
 * The provider itself must be total (never throw).
 */
export function setFocusModeProvider(provider: (() => boolean) | null): void {
	_focusModeProvider = provider;
}

// ---------------------------------------------------------------------------
// Focus management
// ---------------------------------------------------------------------------

/**
 * Set the focus unit (in-memory only). Called by focus.ts when entering/
 * exiting focus; pair with `persistFocusUnit` to make the label durable.
 */
export function setFocusUnit(unit: string | null): void {
	_focusUnit = unit;
}

/**
 * Persist the focus-unit label to the session branch so it survives
 * quit/resume (Fix 2 — cosmetic slot glyph). `{ unit: null }` on exit.
 */
export function persistFocusUnit(pi: ExtensionAPI, unit: string | null): void {
	pi.appendEntry(FOCUS_PERSIST_KEY, { unit });
}

/**
 * Restore the focus-unit label from the session branch. Call from the
 * session_start/session_tree capture handler before `render()` so the
 * `● focus:<unit>` glyph repaints on resume. Absence of an entry is itself
 * a focus fact: a branch with no entry resets the label, so navigating
 * /tree to a leaf created before focus (in-process session_tree) clears
 * the stale glyph and lifts the guard instead of leaving focus half-on.
 */
export function restoreFocusUnit(ctx: {
	sessionManager: { getBranch: () => SessionEntry[] };
}): void {
	const last = lastCustomEntry<{ unit: string | null }>(
		ctx.sessionManager.getBranch(),
		FOCUS_PERSIST_KEY,
	);
	if (last?.data && "unit" in last.data) {
		_focusUnit = last.data.unit;
	} else {
		_focusUnit = null;
	}
}

/**
 * Get the current focus unit (null = not in focus).
 */
export function getFocusUnit(): string | null {
	return _focusUnit;
}

// ---------------------------------------------------------------------------
// Slot wiring
// ---------------------------------------------------------------------------

/**
 * Wire the status slot to lifecycle events and toolset changes.
 *
 * Call this from the factory's session_start handler.
 * The render() call is at the END of the capture handler.
 *
 * Guard: the onChange handler checks that the context is captured before
 * rendering — during session_start the library's restore handler fires
 * TOOLSET_EVENTS before the tbox handler sets lastCtx.
 */
/** Module-level ref to the wired getCtx so non-event callers can repaint. */
let _getCtx: (() => SlotCtx | null) | null = null;

/**
 * Repaint the slot now from the wired context (no-op if unwired or
 * ctx not yet captured). Use after mutating slot-affecting state outside
 * a TOOLSET_EVENTS fanout (e.g. focus enter/exit) so the glyph never lags
 * a frame behind the actuation that produced it.
 */
export function rerenderSlot(pi: ExtensionAPI): void {
	const ctx = _getCtx?.();
	if (ctx) render(pi, ctx);
}

export function wireSlot(pi: ExtensionAPI, getCtx: () => SlotCtx | null): void {
	_getCtx = getCtx;
	// Re-render on toolset changes
	const onChange = () => {
		const ctx = getCtx();
		if (ctx) render(pi, ctx);
	};
	pi.events.on(TOOLSET_EVENTS.changed, onChange);
	pi.events.on(TOOLSET_EVENTS.restored, onChange);
}

/**
 * Clear the slot on session shutdown.
 */
export function clearSlot(ctx: {
	ui: { setStatus: (slot: string, text: string) => void };
}): void {
	ctx.ui.setStatus(SLOT_NAME, "");
}
