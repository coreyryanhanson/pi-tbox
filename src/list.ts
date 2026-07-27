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
	serializeToolDef,
	isCoreTool,
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
		if (isCoreTool(tool)) continue;
		charCount += serializeToolDef(tool).length;
	}
	return { activeCount, charCount };
}

/** Glyphs for the enabled/active table column (✓ = on, ✗ = off). */
const ENABLED_GLYPH = "\u2713";
const DISABLED_GLYPH = "\u2717";

/** Left-align `s` in a field of width `w`, padding right with non-breaking spaces. */
function lpad(s: string, w: number): string {
	return s + "\u00a0".repeat(Math.max(0, w - s.length));
}

/** Right-align `s` in a field of width `w`, padding left with non-breaking spaces. */
function rpad(s: string, w: number): string {
	return "\u00a0".repeat(Math.max(0, w - s.length)) + s;
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
			// Non-toolset group — builtins or orphan extension tools
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
			} else {
				// Orphan extension tools not in any toolset
				const { activeCount, charCount } = activeExtensionChars(
					tools.map((t) => t.name),
					activeSet,
					allToolsMap,
				);
				const inactiveCount = tools.length - activeCount;
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
 * so inactive members cost 0 chars and carry no budget signal. The only case
 * where a shown toolset has inactive members is overlap (a disabled toolset
 * whose tools stay alive via another, enabled toolset) — still 0-cost here.
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

	// Column widths (account for header labels and the Total row)
	const totalActive = stats.reduce((n, s) => n + s.activeCount, 0);
	const totalChars = stats.reduce((n, s) => n + s.charCount, 0);
	const idWidth = Math.max(
		"toolset".length,
		...stats.map((s) => s.id.length),
		"Total".length,
	);
	const activeWidth = Math.max(
		"active".length,
		...stats.map((s) => String(s.activeCount).length),
		String(totalActive).length,
	);
	const charsWidth = Math.max(
		"+chars".length,
		...stats.map((s) => `+${s.charCount}`.length),
		`+${totalChars}`.length,
	);

	const lines: string[] = [
		"Context budget (toolsets, most expensive first):\n",
		`  ${lpad("toolset", idWidth)}  ${rpad("active", activeWidth)}  ${rpad("+chars", charsWidth)}`,
		`  ${"\u2500".repeat(idWidth + activeWidth + charsWidth + 4)}`,
	];

	for (const s of stats) {
		lines.push(
			`  ${lpad(s.id, idWidth)}  ${rpad(String(s.activeCount), activeWidth)}  ${rpad(`+${s.charCount}`, charsWidth)}`,
		);
	}

	lines.push(
		`  ${lpad("Total", idWidth)}  ${rpad(String(totalActive), activeWidth)}  ${rpad(`+${totalChars}`, charsWidth)}`,
	);

	return lines.join("\n").trimEnd();
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

	const rows = filtered.map((t) => ({
		active: activeSet.has(t.name),
		tool: t.name,
		group: toolGroupLabel(t, toolToToolset),
	}));

	const activeWidth = "active".length;
	const toolWidth = Math.max("tool".length, ...rows.map((r) => r.tool.length));
	const groupWidth = Math.max(
		"group".length,
		...rows.map((r) => r.group.length),
	);

	const lines: string[] = [
		"All tools:\n",
		`  ${lpad("active", activeWidth)}  ${lpad("tool", toolWidth)}  ${lpad("group", groupWidth)}`,
		`  ${"\u2500".repeat(activeWidth + toolWidth + groupWidth + 4)}`,
	];
	for (const r of rows) {
		const glyph = r.active ? ENABLED_GLYPH : DISABLED_GLYPH;
		lines.push(
			`  ${lpad(glyph, activeWidth)}  ${lpad(r.tool, toolWidth)}  ${lpad(r.group, groupWidth)}`,
		);
	}

	return lines.join("\n").trimEnd();
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
	const unknown: string[] = [];
	for (const f of flags) {
		if (!KNOWN_LIST_FLAGS.has(f)) unknown.push(`--${f}`);
	}
	if (unknown.length > 0) {
		return `Error: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. See: /tbox list --help.`;
	}

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

	interface Row {
		id: string;
		enabled: boolean;
		members: string;
	}
	const rows: Row[] = [];

	for (const entry of toolsets) {
		const { spec } = entry;
		const isEnabled = [...spec.names].some((n) => activeSet.has(n));
		rows.push({
			id: spec.id,
			enabled: isEnabled,
			members: String(spec.names.size),
		});
	}

	// Builtins: always-on, shown as a separate group (not in the registry)
	const builtinTools = pi
		.getAllTools()
		.filter((t) => t.sourceInfo.source === "builtin");
	if (builtinTools.length > 0) {
		const activeCount = builtinTools.filter((t) =>
			activeSet.has(t.name),
		).length;
		rows.push({
			id: "pi.builtin",
			enabled: true,
			members: `${builtinTools.length} (${activeCount} active)`,
		});
	}

	const idWidth = Math.max("toolset".length, ...rows.map((r) => r.id.length));
	const enabledWidth = "enabled".length;
	const membersWidth = Math.max(
		"members".length,
		...rows.map((r) => r.members.length),
	);

	const lines: string[] = [
		"Toolset Status:\n",
		`  ${lpad("toolset", idWidth)}  ${lpad("enabled", enabledWidth)}  ${rpad("members", membersWidth)}`,
		`  ${"\u2500".repeat(idWidth + enabledWidth + membersWidth + 4)}`,
	];
	for (const r of rows) {
		const glyph = r.enabled ? ENABLED_GLYPH : DISABLED_GLYPH;
		lines.push(
			`  ${lpad(r.id, idWidth)}  ${lpad(glyph, enabledWidth)}  ${rpad(r.members, membersWidth)}`,
		);
	}

	lines.push("");
	const groupNames = getGroupNames();
	lines.push(
		groupNames.length > 0
			? `User Groups: ${groupNames.join(", ")}`
			: "User Groups: no groups defined",
	);
	const focusUnit = getFocusUnit();
	lines.push(focusUnit ? `Focus: on (${focusUnit})` : "Focus: off");
	lines.push(formatCharSplit(computeCharCount(pi)));

	return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Bare help
// ---------------------------------------------------------------------------

/**
 * Format the bare `/tbox` output: subcommands overview.
 */
export function formatBareHelp(): string {
	return (
		"Subcommands: list, status, all, focus, group, chars\n" +
		"  /tbox list [view] [filter] \u2014 run /tbox list --help for views and filters"
	);
}
