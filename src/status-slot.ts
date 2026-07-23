/**
 * Tbox status slot — the 4-state slot that shows tbox's current state.
 *
 * States:
 *   - Pristine: `○ tbox` (dim) — no tools excluded, not in focus
 *   - Count: `● tbox n` (blue) — n extension tools excluded
 *   - Focus: `● focus:<unit>` (green) — focused on a unit
 *   - Focus empty: `● focus:∅` (red) — focused on an empty allowlist
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOLSET_EVENTS } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The 4 possible slot states. */
export type SlotState =
	| { kind: "pristine" }
	| { kind: "count"; n: number }
	| { kind: "focus"; unit: string }
	| { kind: "focus-empty" };

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The current focus unit (null = not in focus). */
let _focusUnit: string | null = null;

/** The slot name used for tbox's status bar entry. */
export const SLOT_NAME = "tbox";

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

	return allTools.filter(
		(t) =>
			t.sourceInfo.source !== "builtin" &&
			t.sourceInfo.source !== "sdk" &&
			!activeTools.has(t.name),
	).length;
}

/**
 * Compute the current slot state based on focus and excluded count.
 */
export function computeSlotState(pi: ExtensionAPI): SlotState {
	if (_focusUnit !== null) {
		// Check if the focus allowlist is empty by looking at the count
		// of enabled tools (if no extension tools are enabled, it's empty)
		const allTools = pi.getAllTools();
		const activeTools = new Set(pi.getActiveTools());
		const hasActiveNonBuiltin = allTools.some(
			(t) =>
				t.sourceInfo.source !== "builtin" &&
				t.sourceInfo.source !== "sdk" &&
				activeTools.has(t.name),
		);

		if (!hasActiveNonBuiltin) {
			return { kind: "focus-empty" };
		}
		return { kind: "focus", unit: _focusUnit };
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
			return `${fg("accent", "●")} tbox ${state.n}`;
		case "focus":
			return `${fg("success", "●")} focus:${state.unit}`;
		case "focus-empty":
			return `${fg("error", "●")} focus:∅`;
	}
}

/**
 * Render the current slot state to the status bar.
 */
export function render(
	pi: ExtensionAPI,
	ctx: {
		ui: {
			setStatus: (slot: string, text: string) => void;
			theme: { fg: (color: string, text: string) => string };
		};
	},
): void {
	const state = computeSlotState(pi);
	const text = renderSlotText(state, ctx.ui.theme.fg);
	ctx.ui.setStatus(SLOT_NAME, text);
}

// ---------------------------------------------------------------------------
// Focus management
// ---------------------------------------------------------------------------

/**
 * Set the focus unit (called by focus.ts when entering focus).
 */
export function setFocusUnit(unit: string | null): void {
	_focusUnit = unit;
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
export function wireSlot(
	pi: ExtensionAPI,
	getCtx: () => {
		ui: {
			setStatus: (slot: string, text: string) => void;
			theme: { fg: (color: string, text: string) => string };
		};
	} | null,
): void {
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
