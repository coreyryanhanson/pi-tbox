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
	readBranchModeState,
	readMergedToolsetDefaults,
	toggleBatch,
	type BranchReader,
} from "pi-tool-masking";
import {
	readGroups,
	writeGroup,
	type GroupSpec,
	GroupsFileCorruptError,
} from "../config/settings-reader.js";
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
 * State is intent, not the live observation — an inert
 * toolset shows what the user toggled. Intent reads never touch the live
 * toolset, so no `pi`.
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

/**
 * Return an error when focus mode is active, or null if safe to proceed.
 *
 * The unit mirror is process-local; the branch mode is the authority. If a
 * foreign extension flips the resolution mode behind our back, a stale
 * mirror unit no longer means focus is active — the guard and
 * `focusRelease` (which reads the branch) must agree, so the mirror unit
 * alone is not enough to refuse.
 */
export function checkFocusGuard(
	enable: boolean,
	noun: string,
	sessionManager: BranchReader,
): string | null {
	const fu = getFocusUnit();
	if (fu === null) return null;
	if (readBranchModeState(sessionManager.getBranch()).mode !== "allowlist") {
		return null;
	}
	return `Cannot ${enable ? "enable" : "disable"} ${noun} while in focus mode (${fu}). Run /tbox focus off, focus release, or defaults restore first.`;
}

/**
 * Enable or disable every registered toolset (`/tbox all on|off`).
 *
 * Builtins and SDK tools are never in the registry, so they cannot be affected.
 *
 * One `toggleBatch` over the whole registry: the library's intent gate
 * makes redundant toggles silent no-ops (reported as `[]`), repairs
 * clobbers, and persists intent-off toggles on inert toolsets — the
 * flattened delta is the honest count, judgment fully deferred to the
 * library. Refusals (allowlist governance, requires cycles) throw raw to
 * the dispatch seam.
 *
 * @returns A summary message counting only what changed.
 */
export function toggleAll(
	pi: ExtensionAPI,
	enable: boolean,
	sessionManager: BranchReader,
): string {
	const guard = checkFocusGuard(enable, "all toolsets", sessionManager);
	if (guard !== null) return guard;

	const ops = getRegisteredToolsets().map((entry) => ({
		id: entry.spec.id,
		desired: enable,
	}));
	const changed = toggleBatch(pi, sessionManager, ops);

	const action = enable ? "Enabled" : "Disabled";
	const noun = changed.length === 1 ? "toolset" : "toolsets";
	return `${action} ${changed.length} ${noun}.`;
}

/**
 * Actuate a single toolset on or off (for `/tbox +<toolset> on|off`).
 *
 * Unconditional single-op wrapper: the library's delta gate skips
 * same-value toggles (returning `[]`), repairs a clobbered loadout, and
 * persists intent-off toggles on inert toolsets — so "already
 * enabled/disabled" renders from `[]` and any non-empty delta means the
 * state changed or was repaired. No intent pre-gate: gating here would
 * forfeit the repair arm and duplicate library logic.
 *
 * @returns A human-readable result, or an error if the toolset doesn't exist
 *          or focus mode is active.
 */
export function actuateToolset(
	pi: ExtensionAPI,
	id: string,
	enable: boolean,
	sessionManager: BranchReader,
): string {
	const guard = checkFocusGuard(enable, "a toolset", sessionManager);
	if (guard !== null) return guard;

	const registry = getRegisteredToolsets();
	const entry = registry.find((e) => e.spec.id === id);
	if (!entry) return `No toolset "${id}".`;

	const changed = enable
		? entry.toolset.enable(pi, sessionManager)
		: entry.toolset.disable(pi, sessionManager);
	if (changed.length === 0) {
		return enable
			? `Toolset "${id}" is already enabled.`
			: `Toolset "${id}" is already disabled.`;
	}
	return `${enable ? "Enabled" : "Disabled"} toolset "${id}".`;
}

// ---------------------------------------------------------------------------
// Actuation
// ---------------------------------------------------------------------------

/**
 * Actuate a group on or off.
 *
 * - Activates/deactivates each registered toolset in the group via one
 *   `toggleBatch` — the library's `requires` cascade pulls deps on for
 *   `on`; for `off` it reverse-cascades to dependents outside the group.
 *   Unregistered ids are skipped upstream of the batch (an explicit op
 *   naming one would throw a plain `Error` at planning).
 *
 * The moved set is computed by diffing `getActiveTools()` before vs. after,
 * so it reflects what the library actually did (including cascaded
 * non-members) rather than a static-graph prediction. This display
 * computation cannot be reproduced from the `ToggleResult[]` delta (which
 * reports per-toolset changes, not moved tools), so it stays.
 *
 * @returns A human-readable summary, including the drift caveat.
 */
export function actuateGroup(
	pi: ExtensionAPI,
	name: string,
	enable: boolean,
	sessionManager: BranchReader,
): string {
	const guard = checkFocusGuard(enable, "a group", sessionManager);
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

	const ops = [...targetToolsetIds]
		.filter((id) => byId.has(id))
		.map((id) => ({ id, desired: enable }));
	toggleBatch(pi, sessionManager, ops);

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
