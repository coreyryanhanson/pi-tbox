/**
 * User groups: load from config, resolve to units, actuate on/off.
 *
 * This is the **actuation** half of point 2 (user groups). Curation UX
 * (the picker) is Sprint 4. This module ships `/tbox <group> on|off` and
 * `/tbox group <name> on|off`.
 *
 * Actuation writes per-toolset entries; editing the group later does not
 * retroact (drift, point 7 — documented in the output). The moved set is
 * computed by **diffing `getActiveTools()` before vs. after** actuation,
 * reflecting reality (including cross-extension companions the static
 * graph wouldn't predict) — not by predicting it via `reverseClosure`.
 *
 * @module
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import {
	readTboxConfig,
	writeGroupToConfig,
	type GroupSpec,
} from "../config/settings-reader.js";
import { forwardClosure, reverseClosure } from "./requires-graph.js";
import { BUILTIN_TOOLSET_ID } from "./registry.js";
import { GroupEditorComponent } from "./group-editor.js";

// ---------------------------------------------------------------------------
// Drift caveat (point 7)
// ---------------------------------------------------------------------------

const DRIFT_CAVEAT =
	"group state saved per-toolset; editing this group won't change already-saved sessions — use focus for drift-free snapshots";

// ---------------------------------------------------------------------------
// Load + resolve
// ---------------------------------------------------------------------------

/**
 * Read a named group from config, or return an error message.
 */
export function resolveGroup(
	name: string,
): { group: GroupSpec } | { error: string } {
	const { groups } = readTboxConfig();
	const group = groups[name];
	if (!group) return { error: `No group named "${name}".` };
	return { group };
}

// ---------------------------------------------------------------------------
// Picker types
// ---------------------------------------------------------------------------

/** An addressable unit shown in the picker checklist. */
export interface PickerUnit {
	id: string;
	label: string;
	type: "toolset" | "tool";
	toolsetId?: string;
}

// ---------------------------------------------------------------------------
// Build picker units
// ---------------------------------------------------------------------------

/**
 * Build the list of addressable units for the picker.
 *
 * Normal mode:
 *  - Masked toolsets → one sealed row (toolset itself)
 *  - Unmasked toolsets → one row per toolset + one row per member
 *  - Orphans → individual tool-rows under their tbox.tool@<source> toolset
 *  - pi.builtin → not shown
 *
 * Dev mode:
 *  - Masked toolsets → individual member rows (no toolset row)
 *  - Others same as normal mode (but pi.builtin still absent)
 */
export function buildPickerUnits(devMode: boolean): PickerUnit[] {
	const registry = getRegisteredToolsets();
	const units: PickerUnit[] = [];

	for (const entry of registry) {
		if (entry.spec.id === BUILTIN_TOOLSET_ID) continue;

		if (entry.spec.masked) {
			if (!devMode) {
				// Normal mode: one sealed row for the whole toolset
				const label = entry.spec.label ?? entry.spec.id;
				units.push({
					id: entry.spec.id,
					label: `${label} (masked, ${entry.spec.names.size} tools)`,
					type: "toolset",
				});
			} else {
				// Dev mode: individual member rows (no toolset row)
				for (const name of entry.spec.names) {
					units.push({
						id: name,
						label: name,
						type: "tool",
						toolsetId: entry.spec.id,
					});
				}
			}
		} else {
			// Unmasked toolset: toolset row + member tool rows
			const label = entry.spec.label ?? entry.spec.id;
			units.push({
				id: entry.spec.id,
				label: `${label} (${entry.spec.names.size} tools)`,
				type: "toolset",
			});
			for (const name of entry.spec.names) {
				units.push({
					id: name,
					label: name,
					type: "tool",
					toolsetId: entry.spec.id,
				});
			}
		}
	}

	return units;
}

// ---------------------------------------------------------------------------
// Closure helpers for the picker
// ---------------------------------------------------------------------------

/**
 * Compute the effective set of toolset IDs from the current selection.
 *
 * Includes both directly-checked toolsets and the containing toolsets of
 * cherry-picked member tools.
 */
export function effectiveToolsetIds(
	checkedToolsets: Set<string>,
	checkedTools: Set<string>,
): Set<string> {
	const ids = new Set(checkedToolsets);
	const registry = getRegisteredToolsets();
	for (const toolName of checkedTools) {
		const entry = findContainingToolset(toolName, registry);
		if (entry) ids.add(entry.spec.id);
	}
	return ids;
}

/**
 * Remove all checked tools that belong to a given toolset.
 */
function removeToolsInToolset(
	checkedTools: Set<string>,
	toolsetId: string,
): void {
	const registry = getRegisteredToolsets();
	const entry = registry.find((e) => e.spec.id === toolsetId);
	if (!entry) return;
	for (const name of entry.spec.names) {
		checkedTools.delete(name);
	}
}

/**
 * Compute the auto-checked toolset IDs: those in forwardClosure(effective)
 * but not in the user's direct selection.
 */
export function autoCheckedToolsetIds(
	checkedToolsets: Set<string>,
	checkedTools: Set<string>,
): Set<string> {
	const effective = effectiveToolsetIds(checkedToolsets, checkedTools);
	const closure = forwardClosure(effective);
	// Auto = in closure but not directly checked
	return new Set([...closure].filter((id) => !effective.has(id)));
}

// ---------------------------------------------------------------------------
// editGroup — the Sprint 4 picker
// ---------------------------------------------------------------------------

/**
 * Open the group edit picker for a named group.
 *
 * Mounts a GroupEditorComponent via `ctx.ui.custom`.
 * In normal mode, the `requires` closure is auto-maintained
 * (forward on check, reverse on uncheck). In dev mode, raw toggling
 * (the library still resolves `requires` at actuation, but the picker
 * does not pre-apply it).
 *
 * On save, writes the curated `{toolsets, tools}` to config.
 */
export async function editGroup(
	name: string,
	ctx: ExtensionContext,
	devMode: boolean,
): Promise<string> {
	if (ctx.mode !== "tui") {
		return "Group editing requires interactive mode.";
	}

	const resolved = resolveGroup(name);
	const existingGroup =
		"group" in resolved ? resolved.group : { toolsets: [], tools: [] };

	const result = await ctx.ui.custom<{ saved: boolean }>(
		(_tui, theme, _kb, done) =>
			new GroupEditorComponent(
				{
					groupName: name,
					devMode,
					initial: existingGroup,
					onSave: (spec) => {
						writeGroupToConfig(name, spec);
						done({ saved: true });
					},
					onCancel: () => done({ saved: false }),
				},
				theme,
			),
	);

	return result?.saved
		? `Group "${name}" saved.`
		: `Group "${name}" edit cancelled.`;
}

// ---------------------------------------------------------------------------
// Toggle helpers
// ---------------------------------------------------------------------------

export function toggleToolsetUnit(
	unit: PickerUnit,
	checkedToolsets: Set<string>,
	checkedTools: Set<string>,
	devMode: boolean,
): { cue: string } {
	const wasChecked = checkedToolsets.has(unit.id);
	let cue = "";

	if (wasChecked) {
		// --- Unchecking ---
		checkedToolsets.delete(unit.id);

		if (!devMode) {
			// Reverse closure: find dependents and uncheck them too
			const revClosure = reverseClosure([unit.id]);
			const uncheckDeps = [...revClosure].filter((id) => id !== unit.id);
			if (uncheckDeps.length > 0) {
				for (const depId of uncheckDeps) {
					checkedToolsets.delete(depId);
					removeToolsInToolset(checkedTools, depId);
				}
				cue = `auto-unchecked: ${uncheckDeps.join(", ")} (they depend on ${unit.id})`;
			}
		}
	} else {
		// --- Checking ---
		checkedToolsets.add(unit.id);

		if (!devMode) {
			// Forward closure: ensure transitive deps are checked
			const effective = effectiveToolsetIds(checkedToolsets, checkedTools);
			const closure = forwardClosure(effective);
			const newDeps = [...closure].filter((id) => !checkedToolsets.has(id));
			for (const depId of newDeps) {
				checkedToolsets.add(depId);
			}
			if (newDeps.length > 0) {
				cue = `auto-checked: ${newDeps.join(", ")} (required by selection)`;
			}
		}
	}
	return { cue };
}

export function toggleToolUnit(
	unit: PickerUnit,
	checkedToolsets: Set<string>,
	checkedTools: Set<string>,
	devMode: boolean,
): { cue: string } {
	const wasChecked = checkedTools.has(unit.id);
	const toolsetId = unit.toolsetId;
	let cue = "";

	if (wasChecked) {
		// --- Unchecking ---
		checkedTools.delete(unit.id);

		if (!devMode && toolsetId) {
			// If no other tools from this toolset remain checked, apply
			// reverse closure from the toolset.
			const registry = getRegisteredToolsets();
			const entry = registry.find((e) => e.spec.id === toolsetId);
			if (entry) {
				const stillChecked = [...entry.spec.names].filter((n) =>
					checkedTools.has(n),
				);
				if (stillChecked.length === 0) {
					checkedToolsets.delete(toolsetId);
					const revClosure = reverseClosure([toolsetId]);
					const uncheckDeps = [...revClosure].filter((id) => id !== toolsetId);
					for (const depId of uncheckDeps) {
						checkedToolsets.delete(depId);
						removeToolsInToolset(checkedTools, depId);
					}
					if (uncheckDeps.length > 0) {
						cue = `auto-unchecked: ${uncheckDeps.join(", ")} (they depend on ${toolsetId})`;
					}
				}
			}
		}
	} else {
		// --- Checking ---
		checkedTools.add(unit.id);

		if (!devMode && toolsetId) {
			// Forward closure from the containing toolset
			const effective = effectiveToolsetIds(checkedToolsets, checkedTools);
			const closure = forwardClosure(effective);
			const newDeps = [...closure].filter((id) => !checkedToolsets.has(id));
			for (const depId of newDeps) {
				checkedToolsets.add(depId);
			}
			if (newDeps.length > 0) {
				cue = `auto-checked: ${newDeps.join(", ")} (required by selection)`;
			}
		}
	}
	return { cue };
}

/** All configured group names (for status listing). */
export function getGroupNames(): string[] {
	return Object.keys(readTboxConfig().groups);
}

/**
 * Describe a named group's units (for `/tbox group <name>` with no action).
 * Returns an error line if the group does not exist.
 */
export function describeGroup(name: string): string {
	const resolved = resolveGroup(name);
	if ("error" in resolved) return resolved.error;
	const g = resolved.group;
	const parts: string[] = [];
	if (g.toolsets.length > 0) parts.push(`toolsets: ${g.toolsets.join(", ")}`);
	if (g.tools.length > 0) parts.push(`tools: ${g.tools.join(", ")}`);
	if (parts.length === 0) parts.push("(empty)");
	return `Group "${name}" — ${parts.join("; ")}. Use /tbox ${name} on|off.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the toolset that contains a given tool name (first match). */
function findContainingToolset(
	toolName: string,
	registry: readonly RegistryEntry[],
): RegistryEntry | undefined {
	return registry.find((e) => e.spec.names.has(toolName));
}

// ---------------------------------------------------------------------------
// Actuation
// ---------------------------------------------------------------------------

/**
 * Actuate a group on or off.
 *
 * - Toolset members: `enable`/`disable` each (the library's `requires`
 *   cascade pulls deps on for `on`; for `off` it reverse-cascades to
 *   dependents outside the group).
 * - Individual tool members: toggle their containing toolset (there is no
 *   per-tool persist primitive — toggling a single tool always goes via
 *   its toolset).
 *
 * The moved set is computed by diffing `getActiveTools()` before vs. after,
 * so it reflects what the library actually did (including cascaded
 * non-members) rather than a static-graph prediction.
 *
 * @returns A human-readable summary, including the drift caveat.
 */
export function actuateGroup(
	pi: ExtensionAPI,
	name: string,
	enable: boolean,
): string {
	const resolved = resolveGroup(name);
	if ("error" in resolved) return resolved.error;
	const group = resolved.group;

	const registry = getRegisteredToolsets();
	const byId = new Map(registry.map((e) => [e.spec.id, e]));

	// Toolsets this group directly addresses (toolset members + the
	// containing toolsets of individual tool members).
	const targetToolsetIds = new Set<string>(group.toolsets);
	for (const toolName of group.tools) {
		const entry = findContainingToolset(toolName, registry);
		if (entry) targetToolsetIds.add(entry.spec.id);
		// An individual tool with no containing toolset cannot be actuated
		// via the persist primitive — surfaced in the summary below.
	}

	if (targetToolsetIds.size === 0) {
		return `Group "${name}" has no actuable toolsets.\n${DRIFT_CAVEAT}`;
	}

	const before = new Set(pi.getActiveTools());

	for (const id of targetToolsetIds) {
		const entry = byId.get(id);
		if (!entry) continue;
		if (enable) entry.toolset.enable(pi);
		else entry.toolset.disable(pi);
	}

	const after = new Set(pi.getActiveTools());

	// Diff: which tools moved (added on enable, removed on disable).
	const moved = enable
		? [...after].filter((n) => !before.has(n))
		: [...before].filter((n) => !after.has(n));

	// Which toolsets own the moved tools — to surface cascaded non-members.
	// `targetToolsetIds` is the group's direct footprint, so anything outside
	// it that moved was cascaded by the library (e.g. portal.learn when only
	// portal.web is in the group).
	const movedToolsets = new Set<string>();
	for (const toolName of moved) {
		const entry = findContainingToolset(toolName, registry);
		if (entry) movedToolsets.add(entry.spec.id);
	}

	const cascaded = [...movedToolsets].filter((id) => !targetToolsetIds.has(id));

	// Build summary
	const action = enable ? "Enabled" : "Disabled";
	const lines: string[] = [
		`${action} group "${name}" — ${moved.length} tool${moved.length !== 1 ? "s" : ""} moved.`,
	];
	if (cascaded.length > 0) {
		lines.push(
			`Cascaded (moved by library, not in group): ${cascaded.join(", ")}`,
		);
	}
	// Surface any individual tool members that had no containing toolset.
	const orphanToolMembers = group.tools.filter(
		(t) => !findContainingToolset(t, registry),
	);
	if (orphanToolMembers.length > 0) {
		lines.push(
			`Not actuated (no containing toolset): ${orphanToolMembers.join(", ")}`,
		);
	}
	lines.push(DRIFT_CAVEAT);

	return lines.join("\n");
}
