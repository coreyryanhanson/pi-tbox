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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import { readTboxConfig, type GroupSpec } from "../config/settings-reader.js";

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
