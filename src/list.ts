/**
 * /tbox list, status, and bare help formatters.
 *
 * Provides the grouped view (smallest-toolset-wins), flat view (all
 * tools with sdk read-only rows), status aggregator, and bare help output.
 *
 * @module
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import { getFocusUnit } from "./status-slot.js";
import {
	computeCharCount,
	formatCharSplit,
	isExtensionTool,
	serializeToolDef,
} from "./chars.js";
import { getGroupNames } from "./groups.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListOptions {
	active?: boolean;
	inactive?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Push a "(no tools match)" fallback when the lines array has only the header. */
function pushNoMatchFallback(lines: string[]): void {
	if (lines.length <= 1) {
		lines.push("  (no tools match the current filter)");
		lines.push("");
	}
}

/**
 * Build a map of tool name → smallest containing toolset entry.
 *
 * "Smallest" is measured by spec.names.size — a toolset with fewer members
 * is more specific/about one thing. Only tools registered in at least one
 * toolset will appear in the map.
 */
function smallestToolsetMap(
	toolsets: readonly RegistryEntry[],
): Map<string, RegistryEntry> {
	const map = new Map<string, RegistryEntry>();
	for (const entry of toolsets) {
		for (const name of entry.spec.names) {
			const existing = map.get(name);
			if (!existing || entry.spec.names.size < existing.spec.names.size) {
				map.set(name, entry);
			}
		}
	}
	return map;
}

/** Count active extension tools and their serialized char total. */
function activeExtensionChars(
	names: Iterable<string>,
	activeSet: Set<string>,
	allToolsMap: Map<string, ToolInfo>,
): { activeCount: number; charCount: number } {
	let activeCount = 0;
	let charCount = 0;
	for (const name of names) {
		if (!activeSet.has(name)) continue;
		activeCount++;
		const tool = allToolsMap.get(name);
		if (!tool) continue;
		if (!isExtensionTool(tool)) continue;
		charCount += serializeToolDef(tool).length;
	}
	return { activeCount, charCount };
}

/** Glyphs for the enabled/active table column (✓ = on, ✗ = off). */
const ENABLED_GLYPH = "\u2713";
const DISABLED_GLYPH = "\u2717";

/** Left-align `s` in a field of width `w`, padding right with non-breaking spaces. */
function lpad(s: string, w: number): string {
	return s.padEnd(w, "\u00a0");
}

/** Right-align `s` in a field of width `w`, padding left with non-breaking spaces. */
function rpad(s: string, w: number): string {
	return s.padStart(w, "\u00a0");
}

/**
 * Format a friendly label for a tool's source group.
 */
function toolGroupLabel(
	t: ToolInfo,
	toolToToolset: Map<string, RegistryEntry>,
): string {
	if (t.sourceInfo.source === "sdk") return "sdk, host-managed";

	const entry = toolToToolset.get(t.name);
	if (!entry) {
		// fallback to source name if not in any toolset
		return t.sourceInfo.source;
	}
	return entry.spec.id;
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

interface ColSpec {
	label: string;
	align?: "left" | "right";
}

/**
 * Render a simple table with header, separator, and optional footer row.
 */
function renderTable(
	title: string,
	cols: ColSpec[],
	rows: string[][],
	footer?: string[],
): string {
	const widths = cols.map((col, i) => {
		const dataWidths = rows.map((r) => (r[i] ?? "").length);
		if (footer?.[i]) dataWidths.push(footer[i].length);
		return Math.max(col.label.length, ...dataWidths);
	});

	const lines: string[] = [title + "\n"];

	// Header
	const hdr = cols
		.map((col, i) => {
			const pad = col.align === "right" ? rpad : lpad;
			return `  ${pad(col.label, widths[i]!)}`;
		})
		.join("");
	lines.push(hdr);

	// Separator
	const sepWidth = widths.reduce((a, b) => a + b, 0) + (cols.length - 1) * 2;
	lines.push(`  ${"\u2500".repeat(sepWidth)}`);

	// Body rows
	for (const row of rows) {
		const parts = row.map((val, i) => {
			const pad = cols[i]!.align === "right" ? rpad : lpad;
			return `  ${pad(val, widths[i]!)}`;
		});
		lines.push(parts.join(""));
	}

	// Footer row
	if (footer) {
		const parts = footer.map((val, i) => {
			const pad = cols[i]!.align === "right" ? rpad : lpad;
			return `  ${pad(val, widths[i]!)}`;
		});
		lines.push(parts.join(""));
	}

	return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Grouped view
// ---------------------------------------------------------------------------

/**
 * Format the grouped list view (default).
 *
 * Each tool appears exactly once under its smallest containing toolset.
 * SDK tools are excluded from the grouped view entirely.
 *
 * @param pi  - The extension API
 * @param options  - Optional filters
 */
export function formatGroupedList(
	pi: ExtensionAPI,
	options?: ListOptions,
): string {
	const allTools = pi.getAllTools();
	const toolsets = getRegisteredToolsets();
	const activeSet = new Set(pi.getActiveTools());
	const toolToToolset = smallestToolsetMap(toolsets);
	const allToolsMap = new Map(allTools.map((t) => [t.name, t]));

	// Filter: exclude sdk + apply active/inactive
	let filtered = allTools.filter((t) => t.sourceInfo.source !== "sdk");
	if (options?.active) {
		filtered = filtered.filter((t) => activeSet.has(t.name));
	}
	if (options?.inactive) {
		filtered = filtered.filter((t) => !activeSet.has(t.name));
	}

	// Group filtered tools by their smallest toolset id
	const groups = new Map<string, ToolInfo[]>();
	for (const t of filtered) {
		const entry = toolToToolset.get(t.name);
		const gid = entry?.spec.id ?? t.sourceInfo.source;
		if (!groups.has(gid)) groups.set(gid, []);
		groups.get(gid)!.push(t);
	}

	// Build lines
	const lines: string[] = ["Tools by group:\n"];

	// Accumulators for footer summary
	let totalActive = 0;
	let totalInactive = 0;
	let totalCoreChars = 0;
	let totalExtChars = 0;

	for (const [gid, tools] of groups) {
		const entry = toolsets.find((e: RegistryEntry) => e.spec.id === gid);
		if (!entry) {
			// Non-toolset group — builtins only (orphan extension tools
			// are auto-registered as tbox.tool@<source> toolsets by
			// autoRegisterBuiltinAndOrphans before this point).
			if (tools[0]?.sourceInfo.source === "builtin") {
				// Deliberate builtin branch: always-on, non-togglable
				let activeCount = 0;
				let charCount = 0;
				for (const t of tools) {
					if (!activeSet.has(t.name)) continue;
					activeCount++;
					charCount += serializeToolDef(t).length;
				}
				totalActive += activeCount;
				totalCoreChars += charCount;
				lines.push(
					`  pi.builtin (${activeCount} active, +${charCount} chars, core)`,
				);
				for (const t of tools) {
					const status = activeSet.has(t.name) ? "" : " (inactive)";
					lines.push(`    ${t.name}${status}`);
				}
			}
			lines.push("");
			continue;
		}

		// header reflects full toolset state; filter controls row visibility only
		const { activeCount, charCount } = activeExtensionChars(
			entry.spec.names,
			activeSet,
			allToolsMap,
		);
		const inactiveCount = entry.spec.names.size - activeCount;
		totalActive += activeCount;
		totalInactive += inactiveCount;
		totalExtChars += charCount;

		lines.push(
			`  ${gid} (${activeCount} active, ${inactiveCount} inactive, +${charCount} chars)`,
		);
		for (const t of tools) {
			const status = activeSet.has(t.name) ? "" : " (inactive)";
			lines.push(`    ${t.name}${status}`);
		}
		lines.push("");
	}

	// Footer summary line
	if (lines.length > 1) {
		lines.push(
			`Total: ${totalActive} active, ${totalInactive} inactive, +${totalCoreChars + totalExtChars} chars (core: ${totalCoreChars} | extension: ${totalExtChars})`,
		);
		lines.push("");
	}

	pushNoMatchFallback(lines);

	return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Chars view (budgeting)
// ---------------------------------------------------------------------------

/**
 * Format the chars budgeting view.
 *
 * Tabular view of toolsets (no tool rows) sorted by +chars descending.
 * Excludes builtins and zero-charge toolsets (no active members).
 *
 * Inactive counts are intentionally omitted: toolsets toggle all-or-nothing,
 * so inactive members cost 0 chars and carry no budget signal. Overlap is
 * impossible — defineToolset rejects two toolsets claiming the same tool name
 * — so an active tool always belongs to its own (enabled) toolset.
 */
export function formatByChars(pi: ExtensionAPI): string {
	const allTools = pi.getAllTools();
	const toolsets = getRegisteredToolsets();
	const activeSet = new Set(pi.getActiveTools());
	const allToolsMap = new Map(allTools.map((t) => [t.name, t]));

	interface ToolsetStats {
		id: string;
		activeCount: number;
		charCount: number;
	}

	const stats: ToolsetStats[] = [];

	for (const entry of toolsets) {
		const { activeCount, charCount } = activeExtensionChars(
			entry.spec.names,
			activeSet,
			allToolsMap,
		);

		// Skip toolsets with no active members — zero budget, no saving to find here
		if (charCount === 0) continue;

		stats.push({ id: entry.spec.id, activeCount, charCount });
	}

	// Sort by charCount descending
	stats.sort((a, b) => b.charCount - a.charCount);

	if (stats.length === 0) {
		return "Context budget (toolsets, most expensive first):\n\n  No toolsets are consuming context budget right now.";
	}

	const totalActive = stats.reduce((n, s) => n + s.activeCount, 0);
	const totalChars = stats.reduce((n, s) => n + s.charCount, 0);

	const cols: ColSpec[] = [
		{ label: "toolset" },
		{ label: "active", align: "right" },
		{ label: "+chars", align: "right" },
	];

	const tableRows = stats.map((s) => [
		s.id,
		String(s.activeCount),
		`+${s.charCount}`,
	]);
	const footer = ["Total", String(totalActive), `+${totalChars}`];

	return renderTable(
		"Context budget (toolsets, most expensive first):",
		cols,
		tableRows,
		footer,
	);
}

// ---------------------------------------------------------------------------
// Flat view
// ---------------------------------------------------------------------------

/**
 * Format the flat list view.
 *
 * Every tool is a row in a three-column table: an `active` column
 * (✓/✗), the tool name, and its source-group label. SDK tools are
 * labelled "sdk, host-managed". The glyph column is always present
 * even under --active/--inactive filters (where it is uniform) for
 * layout consistency.
 *
 * @param pi  - The extension API
 * @param options  - Optional filters
 */
export function formatFlatList(
	pi: ExtensionAPI,
	options?: ListOptions,
): string {
	const allTools = pi.getAllTools();
	const toolsets = getRegisteredToolsets();
	const activeSet = new Set(pi.getActiveTools());
	const toolToToolset = smallestToolsetMap(toolsets);

	// Apply filters
	let filtered = allTools;
	if (options?.active) {
		filtered = filtered.filter((t) => activeSet.has(t.name));
	}
	if (options?.inactive) {
		filtered = filtered.filter((t) => !activeSet.has(t.name));
	}

	if (filtered.length === 0) {
		return "All tools:\n\n  (no tools match the current filter)";
	}

	const cols: ColSpec[] = [
		{ label: "active" },
		{ label: "tool" },
		{ label: "group" },
	];

	const tableRows = filtered.map((t) => {
		const glyph = activeSet.has(t.name) ? ENABLED_GLYPH : DISABLED_GLYPH;
		return [glyph, t.name, toolGroupLabel(t, toolToToolset)];
	});

	return renderTable("All tools:", cols, tableRows);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const LIST_HELP = `\
/tbox list [view] [filter]

Views (mutually exclusive):
  (default)   grouped by toolset
  --flat      one row per tool

Filters (mutually exclusive):
  --active    show only active tools
  --inactive  show only inactive tools`;

const KNOWN_LIST_FLAGS = new Set(["flat", "active", "inactive", "help"]);

/**
 * Return an "unknown flag" error line, or null when every flag is known.
 * Shared by /tbox list and /tbox defaults — help handling stays at the
 * call site (each surface returns its own output type).
 */
export function unknownFlagsError(
	flags: ReadonlySet<string>,
	known: ReadonlySet<string>,
	cmd: string,
): string | null {
	const unknown = [...flags].filter((f) => !known.has(f));
	if (unknown.length === 0) return null;
	return `Error: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown
		.map((f) => `--${f}`)
		.join(", ")}. See: /tbox ${cmd} --help.`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

interface ParsedArgs {
	command: string | undefined;
	flags: Set<string>;
	rest: string[];
}

/**
 * Parse a command argument string into its components.
 */
export function parseArgs(input: string): ParsedArgs {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	const flags = new Set<string>();
	const rest: string[] = [];

	for (const part of parts) {
		if (part.startsWith("--")) {
			flags.add(part.slice(2));
		} else {
			rest.push(part);
		}
	}

	return {
		command: rest[0],
		flags,
		rest,
	};
}

/**
 * Format output for `/tbox list [args]`.
 */
export function formatList(pi: ExtensionAPI, args: string): string {
	const { flags } = parseArgs(args);

	// --help before any other checks
	if (flags.has("help")) {
		return LIST_HELP;
	}

	// Reject unknown flags
	const unknownErr = unknownFlagsError(flags, KNOWN_LIST_FLAGS, "list");
	if (unknownErr !== null) return unknownErr;

	// Error if both --active and --inactive
	if (flags.has("active") && flags.has("inactive")) {
		return "Error: --active and --inactive cannot be used together. See: /tbox list --help.";
	}

	const options: ListOptions = {
		active: flags.has("active"),
		inactive: flags.has("inactive"),
	};
	if (flags.has("flat")) {
		return formatFlatList(pi, options);
	}
	return formatGroupedList(pi, options);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Format the full status output for `/tbox status`.
 *
 * Toolsets and the builtin floor are rendered as a three-column table:
 * toolset id, an `enabled` column (✓/✗), and a members count. The
 * builtin row carries its active count inside the members cell
 * (`N (M active)`) since it is non-togglable. Trailing User Groups /
 * Focus / Char-count lines are unaffected.
 *
 * @param pi - The extension API
 */
export function formatStatus(pi: ExtensionAPI): string {
	const toolsets = getRegisteredToolsets();
	const activeSet = new Set(pi.getActiveTools());

	const cols: ColSpec[] = [
		{ label: "toolset" },
		{ label: "enabled" },
		{ label: "members", align: "right" },
	];

	const tableRows: string[][] = [];

	for (const entry of toolsets) {
		const { spec } = entry;
		const isEnabled = [...spec.names].some((n) => activeSet.has(n));
		const glyph = isEnabled ? ENABLED_GLYPH : DISABLED_GLYPH;
		tableRows.push([spec.id, glyph, String(spec.names.size)]);
	}

	// Builtins: always-on, shown as a separate group (not in the registry)
	const builtinTools = pi
		.getAllTools()
		.filter((t) => t.sourceInfo.source === "builtin");
	if (builtinTools.length > 0) {
		const activeCount = builtinTools.filter((t) => activeSet.has(t.name)).length;
		tableRows.push([
			"pi.builtin",
			ENABLED_GLYPH,
			`${builtinTools.length} (${activeCount} active)`,
		]);
	}

	const table = renderTable("Toolset Status:", cols, tableRows);

	const groupNames = getGroupNames();
	const groupLine =
		groupNames.length > 0
			? `User Groups: ${groupNames.join(", ")}`
			: "User Groups: no groups defined";
	const focusUnit = getFocusUnit();
	const focusLine = focusUnit ? `Focus: on (${focusUnit})` : "Focus: off";

	return [table, "", groupLine, focusLine, formatCharSplit(computeCharCount(pi))]
		.join("\n")
		.trimEnd();
}

// ---------------------------------------------------------------------------
// Bare help
// ---------------------------------------------------------------------------

/**
 * Format the bare `/tbox` output: subcommands overview.
 */
export function formatBareHelp(): string {
	return (
		"Subcommands: list, status, all, focus, solo, group, chars, defaults\n" +
		"  /tbox solo <group>|+<toolset> \u2014 everything off, one unit on (focus without the lock)\n" +
		"  /tbox list [view] [filter] \u2014 run /tbox list --help for views and filters\n" +
		"  /tbox defaults [save|show|clear|restore] \u2014 run /tbox defaults --help for details"
	);
}
