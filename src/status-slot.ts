/**
 * Tbox status slot — the 4-state slot that shows tbox's current state.
 *
 * States:
 *   - Pristine: `○ tbox` (dim) — no tools excluded, not in focus
 *   - Count: `● tbox n masked` (blue) — n extension tools excluded
 *   - Focus: `● focus:<unit> (n)` (green) — focused on a unit, n active extension tools
 *   - Focus empty: `● focus:∅` (red) — focused on an empty allowlist
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOLSET_EVENTS } from "pi-tool-masking";
import { isExtensionTool } from "./chars.js";

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
	| { kind: "focus-empty" };

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The current focus unit (null = not in focus). */
let _focusUnit: string | null = null;

/** The slot name used for tbox's status bar entry. */
export const SLOT_NAME = "tbox";

/** Durable key for the focus-unit label (§13.2 — manager intent persists). */
export const FOCUS_PERSIST_KEY = "tbox-focus-state";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Compute the excluded count: extension tools (not builtin, not sdk)
 * that are not currently active.
 */
function computeExcludedCount(pi: ExtensionAPI): number {
	const allTools = pi.getAllTools();
	const activeTools = new Set(pi.getActiveTools());

	return allTools.filter((t) => isExtensionTool(t) && !activeTools.has(t.name))
		.length;
}

/**
 * Compute the current slot state based on focus and excluded count.
 */
export function computeSlotState(pi: ExtensionAPI): SlotState {
	if (_focusUnit !== null) {
		const allTools = pi.getAllTools();
		const activeTools = new Set(pi.getActiveTools());
		const activeExtensionTools = allTools.filter(
			(t) => isExtensionTool(t) && activeTools.has(t.name),
		);

		if (activeExtensionTools.length === 0) {
			return { kind: "focus-empty" };
		}
		return {
			kind: "focus",
			unit: _focusUnit,
			count: activeExtensionTools.length,
		};
	}

	const n = computeExcludedCount(pi);
	if (n === 0) {
		return { kind: "pristine" };
	}
	return { kind: "count", n };
}

/**
 * Render the slot text and color for a given state.
 */
export function renderSlotText(
	state: SlotState,
	fg: (color: string, text: string) => string,
): string {
	switch (state.kind) {
		case "pristine":
			return `${fg("dim", "○")} tbox`;
		case "count":
			return `${fg("accent", "●")} tbox ${state.n} masked`;
		case "focus":
			return `${fg("success", "●")} focus:${state.unit} (${state.count})`;
		case "focus-empty":
			return `${fg("error", "●")} focus:∅`;
	}
}

/**
 * Render the current slot state to the status bar.
 */
export function render(pi: ExtensionAPI, ctx: SlotCtx): void {
	const state = computeSlotState(pi);
	// Bind: Theme.fg reads `this.fgColors`; passing it unbound loses `this`.
	const text = renderSlotText(state, ctx.ui.theme.fg.bind(ctx.ui.theme));
	ctx.ui.setStatus(SLOT_NAME, text);
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
 * `● focus:<unit>` glyph repaints on resume. No-op if no entry exists.
 */
export function restoreFocusUnit(ctx: {
	sessionManager: { getBranch: () => unknown[] };
}): void {
	const branch = ctx.sessionManager.getBranch();
	const entries = branch.filter(
		(b: any) =>
			b.customType === FOCUS_PERSIST_KEY && b.data && "unit" in b.data,
	);
	if (entries.length > 0) {
		_focusUnit = (entries[entries.length - 1] as any).data.unit;
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
 * The render() call is at the END of the capture handler (§6 fix).
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
