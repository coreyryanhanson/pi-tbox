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
import { getRegisteredToolsets } from "pi-tool-masking";
import {
	readTboxConfig,
	writeGroupToConfig,
	type GroupSpec,
} from "../config/settings-reader.js";
import { forwardClosure, reverseClosure } from "./requires-graph.js";
import { getFocusUnit } from "./status-slot.js";
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
	type: "toolset";
}

// ---------------------------------------------------------------------------
// Build picker units
// ---------------------------------------------------------------------------

/**
 * Build the list of addressable units for the picker.
 *
 * One row per registered toolset:
 *  - Masked toolsets → one sealed row: "{label} (masked, N tools)"
 *  - Unmasked toolsets → one row: "{label} (N tools)"
 * No member rows.
 */
export function buildPickerUnits(): PickerUnit[] {
	const registry = getRegisteredToolsets();
	const units: PickerUnit[] = [];

	for (const entry of registry) {
		const label = entry.spec.label ?? entry.spec.id;
		if (entry.spec.masked) {
			units.push({
				id: entry.spec.id,
				label: `${label} (masked, ${entry.spec.names.size} tools)`,
				type: "toolset",
			});
		} else {
			units.push({
				id: entry.spec.id,
				label: `${label} (${entry.spec.names.size} tools)`,
				type: "toolset",
			});
		}
	}

	return units;
}

// ---------------------------------------------------------------------------
// editGroup — the Sprint 4 picker
// ---------------------------------------------------------------------------

/**
 * Open the group edit picker for a named group.
 *
 * Mounts a GroupEditorComponent via `ctx.ui.custom`.
 * The `requires` closure is auto-maintained (forward on check, reverse
 * on uncheck).
 *
 * On save, writes the curated `{toolsets}` to config.
 */
export async function editGroup(
	name: string,
	ctx: ExtensionContext,
): Promise<string> {
	if (ctx.mode !== "tui") {
		return "Group editing requires interactive mode.";
	}

	const resolved = resolveGroup(name);
	const existingGroup = "group" in resolved ? resolved.group : { toolsets: [] };

	const result = await ctx.ui.custom<{ saved: boolean }>(
		(_tui, theme, _kb, done) =>
			new GroupEditorComponent(
				{
					groupName: name,
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
): { cue: string } {
	const wasChecked = checkedToolsets.has(unit.id);
	let cue = "";

	if (wasChecked) {
		// --- Unchecking ---
		checkedToolsets.delete(unit.id);
		// Reverse closure: find dependents and uncheck them too
		const revClosure = reverseClosure([unit.id]);
		const uncheckDeps = [...revClosure].filter((id) => id !== unit.id);
		if (uncheckDeps.length > 0) {
			for (const depId of uncheckDeps) {
				checkedToolsets.delete(depId);
			}
			cue = `auto-unchecked: ${uncheckDeps.join(", ")} (they depend on ${unit.id})`;
		}
	} else {
		// --- Checking ---
		checkedToolsets.add(unit.id);
		// Forward closure: ensure transitive deps are checked
		const closure = forwardClosure(checkedToolsets);
		const newDeps = [...closure].filter((id) => !checkedToolsets.has(id));
		for (const depId of newDeps) {
			checkedToolsets.add(depId);
		}
		if (newDeps.length > 0) {
			cue = `auto-checked: ${newDeps.join(", ")} (required by selection)`;
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
	if (g.toolsets.length === 0)
		return `Group "${name}" — (empty). Use /tbox ${name} on|off.`;
	return `Group "${name}" — toolsets: ${g.toolsets.join(", ")}. Use /tbox ${name} on|off.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Actuation
// ---------------------------------------------------------------------------

/**
 * Actuate a group on or off.
 *
 * - Activates/deactivates each toolset in the group. The library's
 *   `requires` cascade pulls deps on for `on`; for `off` it
 *   reverse-cascades to dependents outside the group.
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
	// Focus guard — mutual exclusion with focus mode
	const fu = getFocusUnit();
	if (fu !== null) {
		return `Cannot ${enable ? "enable" : "disable"} a group while in focus mode (${fu}). Run /tbox focus off first.`;
	}

	const resolved = resolveGroup(name);
	if ("error" in resolved) return resolved.error;
	const group = resolved.group;

	const registry = getRegisteredToolsets();
	const byId = new Map(registry.map((e) => [e.spec.id, e]));

	// Toolsets this group directly addresses
	const targetToolsetIds = new Set<string>(group.toolsets);

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
	const movedToolsets = new Set<string>();
	for (const toolName of moved) {
		const entry = registry.find((e) => e.spec.names.has(toolName));
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
	lines.push(DRIFT_CAVEAT);

	return lines.join("\n");
}
