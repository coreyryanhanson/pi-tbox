/**
 * User groups + toolset actuation: load from config, resolve to units,
 * actuate on/off.
 *
 * Ships:
 *   - `/tbox <group> on|off` — actuate a named group (bare shorthand).
 *   - `/tbox +<toolset> on|off` — actuate a single toolset directly.
 *   - Group management: edit (picker), remove, list, describe.
 *
 * Actuation writes per-toolset entries; editing the group later does not
 * retroact (drift — documented in the output). The moved set is
 * computed by **diffing `getActiveTools()` before vs. after** actuation,
 * reflecting reality (including cross-extension companions the static
 * graph wouldn't predict) — not by predicting it via `reverseClosure`.
 *
 * @module
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	effectiveEnabled,
	getRegisteredToolsets,
	readMergedToolsetDefaults,
} from "pi-tool-masking";
import {
	readGroups,
	writeGroup,
	type GroupSpec,
	GroupsFileCorruptError,
} from "../config/settings-reader.js";
import { forwardClosure, reverseClosure } from "./requires-graph.js";
import { isReserved } from "./reserved.js";
import { getFocusUnit } from "./status-slot.js";
import { GroupEditorComponent } from "./group-editor.js";

// ---------------------------------------------------------------------------
// Drift caveat
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
	const groups = readGroups();
	const group = groups[name];
	if (!group)
		return {
			error: `No group named "${name}". Create one with: /tbox group ${name} edit`,
		};
	return { group };
}

// ---------------------------------------------------------------------------
// Picker types
// ---------------------------------------------------------------------------

/** An addressable unit shown in the picker checklist. */
export interface PickerUnit {
	id: string;
	label: string;
}

// ---------------------------------------------------------------------------
// Build picker units
// ---------------------------------------------------------------------------

/**
 * Build the list of addressable units for the picker.
 *
 * One row per registered toolset.
 */
export function buildPickerUnits(): PickerUnit[] {
	const registry = getRegisteredToolsets();
	const units: PickerUnit[] = [];

	for (const entry of registry) {
		const label = entry.spec.label ?? entry.spec.id;
		units.push({
			id: entry.spec.id,
			label: `${label} (${entry.spec.names.size} tools)`,
		});
	}

	return units;
}

// ---------------------------------------------------------------------------
// editGroup — the group edit picker
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
	if (isReserved(name) || name.includes("+")) {
		return `"${name}" is not a valid group name (reserved word or "+").`;
	}
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
						try {
							writeGroup(name, spec);
							done({ saved: true });
							return true;
						} catch (err) {
							// Corrupt groups file: refuse loudly instead of
							// silently overwriting user data. Keep the picker
							// open so the curated selection isn't lost; Esc is
							// the user's explicit exit.
							ctx.ui.notify(
								err instanceof GroupsFileCorruptError
									? err.message
									: `Failed to save group "${name}": ${String(err)}`,
								"error",
							);
							return false;
						}
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
	return Object.keys(readGroups()).sort((a, b) => a.localeCompare(b));
}

/**
 * List all groups with their toolsets (for `/tbox group list`).
 */
export function listGroups(): string {
	const all = readGroups();
	const names = Object.keys(all);
	if (names.length === 0) return "No groups configured.";
	return names
		.sort((a, b) => a.localeCompare(b))
		.map((n) => {
			const toolsets = all[n]!.toolsets;
			return `  ${n} — ${toolsets.length > 0 ? toolsets.join(", ") : "(empty)"}`;
		})
		.join("\n");
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

/**
 * Describe a toolset by id (for `/tbox +<toolset>` with no action).
 * Returns an error line if the toolset is not registered.
 *
 * State is the persisted **intent** (`effectiveEnabled`), not the live
 * `isEnabled()` observation — an inert toolset (members hidden or an MCP
 * server not yet connected) shows its persisted state, which is what the
 * user toggled. Intent reads never touch the live toolset, so no `pi`.
 */
export function describeToolset(
	id: string,
	branch: readonly SessionEntry[],
): string {
	const registry = getRegisteredToolsets();
	const entry = registry.find((e) => e.spec.id === id);
	if (!entry) return `No toolset "${id}".`;
	const state =
		effectiveEnabled(entry.spec, branch, readMergedToolsetDefaults()).enabled
			? "enabled"
			: "disabled";
	const toolList = [...entry.spec.names].join(", ");
	return `Toolset "${id}" — ${entry.spec.names.size} tool${entry.spec.names.size === 1 ? "" : "s"} (${toolList}). State: ${state}.`;
}

/** Return an error when focus mode is active, or null if safe to proceed. */
export function checkFocusGuard(enable: boolean, noun: string): string | null {
	const fu = getFocusUnit();
	if (fu === null) return null;
	return `Cannot ${enable ? "enable" : "disable"} ${noun} while in focus mode (${fu}). Run /tbox focus off, focus release, or defaults restore first.`;
}

/**
 * Enable or disable every registered toolset (`/tbox all on|off`).
 *
 * Builtins and SDK tools are never in the registry, so they cannot be affected.
 *
 * @returns A summary message.
 */
export function toggleAll(
	pi: ExtensionAPI,
	enable: boolean,
	branch: readonly SessionEntry[],
): string {
	const guard = checkFocusGuard(enable, "all toolsets");
	if (guard !== null) return guard;

	// One snapshot per command — each intent read must not re-read the
	// settings files, and the actuatable scan must not re-run, per toolset.
	const snapshot = readMergedToolsetDefaults();
	const toolsets = getRegisteredToolsets();
	// Actuatable = registered and not hidden-exposure (mirrors the library's
	// internal scan: pi's setActiveTools silently drops hidden names, so a
	// toolset whose members are all hidden is inert — enable() over it only
	// re-appends a duplicate branch entry).
	const actuatable = new Set<string>();
	for (const tool of pi.getAllTools()) {
		if ((tool as { exposure?: string }).exposure === "hidden") continue;
		actuatable.add(tool.name);
	}
	const activeSet = new Set(pi.getActiveTools());
	let changed = 0;

	for (const entry of toolsets) {
		const names = [...entry.spec.names];
		// Persist-direction correctness comes from intent; whether a library
		// call can change anything comes from observation. Both are needed:
		// the library's witness gates make enable()/disable() silent no-ops
		// at the extremes, so gating on either read alone strands state
		// (intent-only skips the repair of a clobbered active set;
		// observation-only drops the off on an intent-on inert toolset).
		const intent = effectiveEnabled(entry.spec, branch, snapshot).enabled;
		const anyActive = names.some((n) => activeSet.has(n));

		if (enable) {
			// Skip exactly what enable() cannot improve: its only real write
			// is adding members ∩ actuatable ∩ ¬active. When every name is
			// already active or not actuatable (hidden, or absent because the
			// MCP server is disconnected), that set is empty and enable()
			// could only re-append a duplicate same-value branch entry —
			// which is why the skip requires intent-on. Covers fully-active,
			// fully-inert, and mixed (one member active, one hidden)
			// toolsets; a clobbered toolset still has an actuatable inactive
			// member and is repaired.
			const nothingToAdd = names.every(
				(n) => activeSet.has(n) || !actuatable.has(n),
			);
			if (intent && nothingToAdd) continue;
			entry.toolset.enable(pi);
			changed++;
		} else {
			// Intent-on always gets the off (persisting it, even when inert —
			// the witnessed-off gate would drop it if we skipped on observation
			// alone). Keep an observation arm for residue: an intent-off
			// toolset with a still-active member (mid-dispatch re-activation,
			// another extension's setActiveTools) must still get its member
			// removed. Skip only when intent and observation agree nothing is
			// on.
			if (!intent && !anyActive) continue;
			entry.toolset.disable(pi);
			changed++;
		}
	}

	const action = enable ? "Enabled" : "Disabled";
	const noun = changed === 1 ? "toolset" : "toolsets";
	return `${action} ${changed} ${noun}.`;
}

/**
 * Actuate a single toolset on or off (for `/tbox +<toolset> on|off`).
 *
 * @returns A human-readable result, or an error if the toolset doesn't exist
 *          or focus mode is active.
 */
export function actuateToolset(
	pi: ExtensionAPI,
	id: string,
	enable: boolean,
	branch: readonly SessionEntry[],
): string {
	const guard = checkFocusGuard(enable, "a toolset");
	if (guard !== null) return guard;

	const registry = getRegisteredToolsets();
	const entry = registry.find((e) => e.spec.id === id);
	if (!entry) return `No toolset "${id}".`;

	// Toggle gating reads persisted intent: an intent-on inert toolset
	// (members hidden / MCP server disconnected) must still accept "off".
	const enabled = effectiveEnabled(
		entry.spec,
		branch,
		readMergedToolsetDefaults(),
	).enabled;

	if (enable) {
		if (enabled) {
			return `Toolset "${id}" is already enabled.`;
		}
		entry.toolset.enable(pi);
		return `Enabled toolset "${id}".`;
	}
	if (!enabled) {
		return `Toolset "${id}" is already disabled.`;
	}
	entry.toolset.disable(pi);
	return `Disabled toolset "${id}".`;
}

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
	const guard = checkFocusGuard(enable, "a group");
	if (guard !== null) return guard;

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

	// Skipped: toolsets named in the group but not currently registered
	// (e.g. provider extension uninstalled after the group was saved).
	const missing = [...targetToolsetIds].filter((id) => !byId.has(id));

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
		`${action} group "${name}" — ${moved.length} tool${moved.length === 1 ? "" : "s"} moved.`,
	];
	if (cascaded.length > 0) {
		lines.push(
			`Cascaded (moved by library, not in group): ${cascaded.join(", ")}`,
		);
	}
	if (missing.length > 0) {
		lines.push(`Not registered (skipped): ${missing.join(", ")}`);
	}
	lines.push(DRIFT_CAVEAT);

	return lines.join("\n");
}
