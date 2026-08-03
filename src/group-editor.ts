/**
 * GroupEditorComponent — a windowed, searchable, keyboard-driven TUI
 * component for editing a tbox tool group.
 *
 * Mounted via `ctx.ui.custom<T>(factory)` on the `/tbox group <name> edit`
 * path. Mirrors the shape of pi's internal `ScopedModelsSelectorComponent`
 * using only public `@earendil-works/pi-tui` primitives.
 *
 * @module
 */

import {
	matchesKey,
	getKeybindings,
	fuzzyFilter,
	truncateToWidth,
	type KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PickerUnit } from "./groups.js";
import { buildPickerUnits, toggleToolsetUnit } from "./groups.js";
import { forwardClosure, reverseClosure } from "./requires-graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroupEditorConfig {
	groupName: string;
	initial: { toolsets: string[] };
	onSave: (spec: { toolsets: string[] }) => void;
	onCancel: () => void;
	/** Inject units for demo/testing (default: buildPickerUnits()). */
	units?: PickerUnit[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 8;
const PREFIX_CHECKED = "\u2713"; // ✓
const PREFIX_UNCHECKED = "\u25CB"; // ○

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Windowed, searchable group-editor picker.
 *
 * Keyboard shortcuts (all remappable via user keybindings):
 *   ↑/↓        — navigate
 *   Enter      — toggle focused row
 *   Ctrl+A     — enable all (filtered set if search active)
 *   Ctrl+X     — clear all (filtered set if search active)
 *   Ctrl+S     — persist to config
 *   Esc/Ctrl+C — cancel (first clears search if non-empty)
 */
export class GroupEditorComponent {
	private config: GroupEditorConfig;
	private theme: Theme;
	private kb: KeybindingsManager;

	allUnits: PickerUnit[];
	checkedToolsets: Set<string>;
	selectedIndex = 0;
	isDirty = false;
	lastCue = "";
	searchValue = "";

	constructor(config: GroupEditorConfig, theme: Theme) {
		this.config = config;
		this.theme = theme;
		this.kb = getKeybindings();
		this.checkedToolsets = new Set(config.initial.toolsets);
		this.allUnits = config.units ?? buildPickerUnits();
	}

	/** The filtered subset of allUnits based on the current search query. */
	get filteredItems(): PickerUnit[] {
		const q = this.searchValue.trim();
		if (!q) return this.allUnits;
		return fuzzyFilter(this.allUnits, q, (u) => u.label);
	}

	// -----------------------------------------------------------------------
	// Input handling
	// -----------------------------------------------------------------------

	handleInput(data: string): void {
		// Down
		if (this.kb.matches(data, "tui.select.down")) {
			const max = this.filteredItems.length - 1;
			if (this.selectedIndex < max) {
				this.selectedIndex++;
			}
			return;
		}

		// Up
		if (this.kb.matches(data, "tui.select.up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
			}
			return;
		}

		// Confirm (toggle focused row)
		if (this.kb.matches(data, "tui.select.confirm")) {
			const items = this.filteredItems;
			const unit = items[this.selectedIndex];
			if (!unit) return;

			const result = toggleToolsetUnit(unit, this.checkedToolsets);
			this.lastCue = result.cue;
			this.isDirty = true;
			return;
		}

		// Cancel (Esc / Ctrl+C) — clear search first, then cancel
		if (this.kb.matches(data, "tui.select.cancel")) {
			if (this.searchValue) {
				this.searchValue = "";
				this.selectedIndex = 0;
			} else {
				this.config.onCancel();
			}
			return;
		}

		// Ctrl+A — enable all (filtered set if search active)
		if (matchesKey(data, "ctrl+a")) {
			this.enableAll();
			this.isDirty = true;
			return;
		}

		// Ctrl+X — clear all (filtered set if search active)
		if (matchesKey(data, "ctrl+x")) {
			this.clearAll();
			this.isDirty = true;
			return;
		}

		// Ctrl+S — save
		if (matchesKey(data, "ctrl+s")) {
			this.config.onSave({
				toolsets: [...this.checkedToolsets],
			});
			this.isDirty = false;
			return;
		}

		// Search input: backspace
		if (matchesKey(data, "backspace")) {
			if (this.searchValue) {
				this.searchValue = this.searchValue.slice(0, -1);
				this.selectedIndex = 0;
			}
			return;
		}

		// Search input: printable character (single char)
		if (
			data.length === 1 &&
			data.charCodeAt(0) >= 0x20 &&
			data.charCodeAt(0) <= 0x7e
		) {
			this.searchValue += data;
			this.selectedIndex = 0;
			return;
		}
	}

	// -----------------------------------------------------------------------
	// Bulk operations
	// -----------------------------------------------------------------------

	private enableAll(): void {
		this.lastCue = ""; // previous per-toggle cascade cue is stale after bulk op
		const targets = this.filteredItems;
		for (const u of targets) {
			this.checkedToolsets.add(u.id);
		}
		const closure = forwardClosure(this.checkedToolsets);
		for (const id of closure) {
			this.checkedToolsets.add(id);
		}
	}

	private clearAll(): void {
		this.lastCue = ""; // previous per-toggle cascade cue is stale after bulk op
		// Reverse-closure (which includes its seeds) unchecks the visible items
		// plus any hidden dependents, so a saved group never retains a check on
		// a toolset whose required dep is unchecked. Matches single-item uncheck
		// in toggleToolsetUnit.
		const deleted = this.filteredItems.map((u) => u.id);
		for (const id of reverseClosure(deleted)) {
			this.checkedToolsets.delete(id);
		}
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const trunc = (s: string) => truncateToWidth(s, width);

		// ── Empty line ──
		lines.push("");

		// ── Header: session-only note ──
		lines.push(
			trunc(th.fg("dim", "Session-only.  Ctrl+S to save to settings.")),
		);

		// ── Empty line ──
		lines.push("");

		// ── Search input ──
		const searchPrompt = th.fg("muted", "/") + " ";
		const searchText = this.searchValue;
		const cursor = " ";
		lines.push(trunc(searchPrompt + searchText + cursor));

		// ── Empty line ──
		lines.push("");

		// ── List ──
		const items = this.filteredItems;
		const total = items.length;

		if (total === 0) {
			lines.push(trunc("  " + th.fg("dim", "(no items match)")));
		} else {
			// Windowed slice centered on selection
			let start = Math.max(0, this.selectedIndex - Math.floor(MAX_VISIBLE / 2));
			const end = Math.min(total, start + MAX_VISIBLE);
			if (end - start < MAX_VISIBLE && start > 0) {
				start = Math.max(0, end - MAX_VISIBLE);
			}
			const slice = items.slice(start, end);

			for (const unit of slice) {
				const isSelected = unit === items[this.selectedIndex];
				const selMark = isSelected ? th.fg("accent", "\u2192 ") : "  ";
				const checked = this.checkedToolsets.has(unit.id);
				const checkMark = checked
					? th.fg("success", PREFIX_CHECKED)
					: th.fg("dim", PREFIX_UNCHECKED);

				const labelStyle = isSelected
					? th.fg("text", unit.label)
					: th.fg("muted", unit.label);
				const line = selMark + checkMark + " " + labelStyle;
				lines.push(trunc(line));
			}

			// Scroll indicator
			if (total > MAX_VISIBLE) {
				const scrollInfo = `(${this.selectedIndex + 1}/${total})`;
				lines.push(trunc(th.fg("dim", "  " + scrollInfo)));
			}
		}

		// ── Empty line ──
		lines.push("");

		// ── Footer ──
		const dirtyMark = this.isDirty ? th.fg("warning", " (unsaved)") : "";
		const cueLine = this.lastCue ? " " + th.fg("dim", this.lastCue) : "";

		const footer =
			th.fg("dim", "Enter toggle") +
			th.fg("muted", " \u00B7 ") +
			th.fg("dim", "Ctrl+A all") +
			th.fg("muted", " \u00B7 ") +
			th.fg("dim", "Ctrl+X clear") +
			th.fg("muted", " \u00B7 ") +
			th.fg("dim", "Ctrl+S save") +
			dirtyMark +
			th.fg("muted", " \u00B7 ") +
			th.fg(
				"dim",
				`${this.checkedToolsets.size}/${this.allUnits.length} enabled`,
			) +
			cueLine;

		lines.push(trunc(footer));

		// ── Empty line ──
		lines.push("");

		return lines;
	}

	/** Required by Component interface; no rendering state to invalidate here. */
	invalidate(): void {
		/* no-op */
	}
}
