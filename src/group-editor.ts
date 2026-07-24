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
import {
	buildPickerUnits,
	effectiveToolsetIds,
	autoCheckedToolsetIds,
	toggleToolsetUnit,
	toggleToolUnit,
} from "./groups.js";
import { forwardClosure } from "./requires-graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroupEditorConfig {
	groupName: string;
	devMode: boolean;
	initial: { toolsets: string[]; tools: string[] };
	onSave: (spec: { toolsets: string[]; tools: string[] }) => void;
	onCancel: () => void;
	/** Inject units for demo/testing (default: buildPickerUnits(devMode)). */
	units?: PickerUnit[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 8;
const PREFIX_CHECKED = "\u2713"; // ✓
const PREFIX_AUTO = "\u2713>"; // ✓>
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
	checkedTools: Set<string>;
	selectedIndex = 0;
	isDirty = false;
	lastCue = "";
	searchValue = "";

	private _cachedWidth: number | undefined;
	private _cachedLines: string[] | undefined;

	constructor(config: GroupEditorConfig, theme: Theme) {
		this.config = config;
		this.theme = theme;
		this.kb = getKeybindings();
		this.checkedToolsets = new Set(config.initial.toolsets);
		this.checkedTools = new Set(config.initial.tools);
		this.allUnits = config.units ?? buildPickerUnits(config.devMode);
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
				this.invalidate();
			}
			return;
		}

		// Up
		if (this.kb.matches(data, "tui.select.up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.invalidate();
			}
			return;
		}

		// Confirm (toggle focused row)
		if (this.kb.matches(data, "tui.select.confirm")) {
			const items = this.filteredItems;
			const unit = items[this.selectedIndex];
			if (!unit) return;

			const result =
				unit.type === "toolset"
					? toggleToolsetUnit(
							unit,
							this.checkedToolsets,
							this.checkedTools,
							this.config.devMode,
						)
					: toggleToolUnit(
							unit,
							this.checkedToolsets,
							this.checkedTools,
							this.config.devMode,
						);
			this.lastCue = result.cue;
			this.isDirty = true;
			this.invalidate();
			return;
		}

		// Cancel (Esc / Ctrl+C) — clear search first, then cancel
		if (this.kb.matches(data, "tui.select.cancel")) {
			if (this.searchValue) {
				this.searchValue = "";
				this.selectedIndex = 0;
				this.invalidate();
			} else {
				this.config.onCancel();
			}
			return;
		}

		// Ctrl+A — enable all (filtered set if search active)
		if (matchesKey(data, "ctrl+a")) {
			this.enableAll();
			this.isDirty = true;
			this.invalidate();
			return;
		}

		// Ctrl+X — clear all (filtered set if search active)
		if (matchesKey(data, "ctrl+x")) {
			this.clearAll();
			this.isDirty = true;
			this.invalidate();
			return;
		}

		// Ctrl+S — save
		if (matchesKey(data, "ctrl+s")) {
			this.config.onSave({
				toolsets: [...this.checkedToolsets],
				tools: [...this.checkedTools],
			});
			this.isDirty = false;
			return;
		}

		// Search input: backspace
		if (matchesKey(data, "backspace")) {
			if (this.searchValue) {
				this.searchValue = this.searchValue.slice(0, -1);
				this.selectedIndex = 0;
				this.invalidate();
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
			this.invalidate();
			return;
		}
	}

	// -----------------------------------------------------------------------
	// Bulk operations
	// -----------------------------------------------------------------------

	private enableAll(): void {
		const targets = this.filteredItems;
		for (const u of targets) {
			if (u.type === "toolset") {
				this.checkedToolsets.add(u.id);
			} else {
				this.checkedTools.add(u.id);
			}
		}
		if (!this.config.devMode) {
			const effective = effectiveToolsetIds(
				this.checkedToolsets,
				this.checkedTools,
			);
			const closure = forwardClosure(effective);
			for (const id of closure) {
				this.checkedToolsets.add(id);
			}
		}
	}

	private clearAll(): void {
		const targets = this.filteredItems;
		for (const u of targets) {
			if (u.type === "toolset") {
				this.checkedToolsets.delete(u.id);
			} else {
				this.checkedTools.delete(u.id);
			}
		}
		const activeSearch = this.searchValue.trim().length > 0;
		if (!this.config.devMode && !activeSearch) {
			// When clearing all with no filter, also remove all tools
			this.checkedTools.clear();
		}
	}

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	render(width: number): string[] {
		if (this._cachedLines && this._cachedWidth === width) {
			return this._cachedLines;
		}

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
		const autoSet: Set<string> = this.config.devMode
			? new Set()
			: autoCheckedToolsetIds(this.checkedToolsets, this.checkedTools);

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

				let checked = false;
				let isAuto = false;
				if (unit.type === "toolset") {
					if (this.checkedToolsets.has(unit.id)) {
						checked = true;
					} else if (!this.config.devMode && autoSet.has(unit.id)) {
						checked = true;
						isAuto = true;
					}
				} else {
					if (this.checkedTools.has(unit.id)) {
						checked = true;
					} else if (
						!this.config.devMode &&
						unit.toolsetId &&
						autoSet.has(unit.toolsetId)
					) {
						checked = true;
						isAuto = true;
					}
				}

				const checkMark = checked
					? isAuto
						? th.fg("dim", PREFIX_AUTO)
						: th.fg("success", PREFIX_CHECKED)
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
				`${this.checkedToolsets.size + this.checkedTools.size}/${this.allUnits.length} enabled`,
			) +
			cueLine;

		lines.push(trunc(footer));

		// ── Empty line ──
		lines.push("");

		this._cachedWidth = width;
		this._cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this._cachedWidth = undefined;
		this._cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Demo / self-check
// ---------------------------------------------------------------------------

/**
 * Quick self-check: constructs a GroupEditorComponent with a fake unit list,
 * asserts windowed render and toggle prefix change.
 *
 * Run directly: `npx tsx src/group-editor.ts`
 */
function demo(): void {
	const fakeUnits: PickerUnit[] = [];
	for (let i = 0; i < 25; i++) {
		fakeUnits.push({
			id: `toolset-${i}`,
			label: `Toolset ${i} (${i + 1} tools)`,
			type: "toolset",
		});
	}

	// Minimal theme stub (the real Theme is expensive to construct)
	const stubTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
	} as unknown as Theme;

	const comp = new GroupEditorComponent(
		{
			groupName: "test",
			devMode: false,
			initial: { toolsets: [], tools: [] },
			units: fakeUnits,
			onSave: () => {},
			onCancel: () => {},
		},
		stubTheme,
	);

	// 1) Windowing: render(80) should have at most MAX_VISIBLE list items
	const rendered = comp.render(80);
	const itemLines = rendered.filter((l) => l.includes("○") || l.includes("✓"));
	if (itemLines.length > MAX_VISIBLE) {
		throw new Error(
			`demo FAIL: render shows ${itemLines.length} items, expected ≤ ${MAX_VISIBLE}`,
		);
	}

	// 2) Confirm flips unchecked → checked
	const down = "\x1B[B"; // tui.select.down default
	for (let i = 0; i < 3; i++) comp.handleInput(down);
	comp.handleInput("\r"); // enter = toggle
	const toggled = comp.render(80);
	const checkedLines = toggled.filter((l) => l.includes("✓"));
	if (checkedLines.length < 1) {
		throw new Error("demo FAIL: no checked items after toggle");
	}

	console.log(
		"demo OK — windowed:",
		itemLines.length,
		"items, checked:",
		checkedLines.length,
	);
}

// Run demo when executed directly
const isMain =
	process.argv[1] &&
	(process.argv[1].endsWith("group-editor.ts") ||
		process.argv[1].endsWith("group-editor.js"));
if (isMain) {
	demo();
}
