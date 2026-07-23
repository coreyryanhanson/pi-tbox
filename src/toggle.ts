/**
 * /tbox toggle, /tbox all, and dev mode.
 *
 * Provides:
 *   - resolveTool: find a tool by exact or prefix match
 *   - toggleTool: toggle a tool's containing toolset (with guards)
 *   - toggleAll: enable/disable every registered toolset
 *   - dev mode: read from `tbox.dev` in settings.json at session_start
 *
 * @module
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import { readTboxConfig } from "../config/settings-reader.js";

// ---------------------------------------------------------------------------
// Module-level dev-mode state (in-memory, session-scoped)
// ---------------------------------------------------------------------------

// Dev mode is a `tbox.dev` boolean in settings.json, read at session_start
// (and on /reload). There is no `/tbox dev` command — to change it, edit
// settings.json and `/reload`. This in-memory flag is what the guards
// consult; it is set from the settings read, not via a runtime command.
let _devMode = false;

// ---------------------------------------------------------------------------
// Dev mode
// ---------------------------------------------------------------------------

/** Whether dev mode is currently active in this session. */
export function isDevMode(): boolean {
	return _devMode;
}

/**
 * Read `tbox.dev` from merged settings and sync the in-memory flag.
 * Called at `session_start` (and on `/reload`, which re-evaluates the
 * module). Returns the read value.
 */
export function loadDevModeFromSettings(): boolean {
	_devMode = readTboxConfig().dev;
	return _devMode;
}

/**
 * Reset the in-memory dev-mode flag (session_shutdown). Not a settings
 * write — just clears the session-scoped flag.
 */
export function resetDevMode(): void {
	_devMode = false;
}

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a tool name input to a single ToolInfo.
 *
 * Strategy: exact match first, then prefix match. Ambiguous prefixes
 * return an error message. Unmatched inputs also return an error message.
 *
 * @returns The resolved tool, or an error message.
 */
export function resolveTool(
	pi: ExtensionAPI,
	input: string,
): { tool: ToolInfo } | { error: string } {
	const allTools = pi.getAllTools();

	// Exact match
	const exact = allTools.filter((t) => t.name === input);
	if (exact.length === 1) return { tool: exact[0]! };
	if (exact.length > 1) return { error: `Multiple tools named "${input}".` };

	// Prefix match
	const prefix = allTools.filter((t) => t.name.startsWith(input));
	if (prefix.length === 0) return { error: `No tool matching "${input}".` };
	if (prefix.length === 1) return { tool: prefix[0]! };

	// Ambiguous prefix
	const candidates = prefix.map((t) => t.name).join(", ");
	return {
		error: `Ambiguous tool "${input}". Candidates: ${candidates}`,
	};
}

// ---------------------------------------------------------------------------
// Containing-toolset lookup
// ---------------------------------------------------------------------------

/**
 * Find the RegistryEntry whose spec.names contains the given tool name,
 * or return undefined if the tool is orphaned (in no toolset).
 */
export function findContainingToolset(
	toolName: string,
): RegistryEntry | undefined {
	const toolsets = getRegisteredToolsets();
	for (const entry of toolsets) {
		if (entry.spec.names.has(toolName)) return entry;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

/**
 * Toggle a single tool's containing toolset on or off.
 *
 * Guards (normal mode):
 *   - SDK tools are always refused.
 *   - Masked toolset members are not individually toggleable.
 *   - pi.builtin is not toggleable.
 *   Dev mode lifts the masked and builtin guards.
 *
 * @returns A human-readable status or error message.
 */
export function toggleTool(
	pi: ExtensionAPI,
	input: string,
	devMode: boolean,
): string {
	const resolved = resolveTool(pi, input);
	if ("error" in resolved) return resolved.error;
	const tool = resolved.tool;

	// --- SDK guard (always enforced) ---
	if (tool.sourceInfo.source === "sdk") {
		return `Cannot toggle "${tool.name}": SDK tools are host-managed and cannot be toggled.`;
	}

	// --- Find containing toolset ---
	const entry = findContainingToolset(tool.name);

	if (!entry) {
		return `Cannot toggle "${tool.name}": no toolset contains this tool.`;
	}

	// --- Guards (normal mode) ---
	if (entry.spec.id === "pi.builtin" && !devMode) {
		return `Cannot toggle "${tool.name}": builtins are protected. Set "tbox.dev": true in settings.json and /reload to toggle builtins.`;
	}

	if (entry.spec.masked && !devMode) {
		const label = entry.spec.label ?? entry.spec.id;
		return `Cannot toggle "${tool.name}": this tool is part of the sealed group "${label}". Toggle the group, or set "tbox.dev": true in settings.json and /reload.`;
	}

	// --- Toggle ---
	const active = new Set(pi.getActiveTools());
	const currentlyActive = active.has(tool.name);

	if (currentlyActive) {
		entry.toolset.disable(pi);
		return `Disabled "${tool.name}" (via ${entry.spec.id}).`;
	}
	entry.toolset.enable(pi);
	return `Enabled "${tool.name}" (via ${entry.spec.id}).`;
}

// ---------------------------------------------------------------------------
// All on / all off
// ---------------------------------------------------------------------------

/**
 * Enable or disable every registered toolset.
 *
 * When disabling, `pi.builtin` is protected (kept enabled) in normal mode.
 * SDK tools are never touched (they are in no toolset).
 *
 * @returns A summary message.
 */
export function toggleAll(pi: ExtensionAPI, enable: boolean): string {
	const toolsets = getRegisteredToolsets();
	let changed = 0;

	for (const entry of toolsets) {
		// pi.builtin is protected when disabling
		if (!enable && entry.spec.id === "pi.builtin") continue;

		const wasEnabled = entry.toolset.isEnabled(pi);

		if (enable && !wasEnabled) {
			entry.toolset.enable(pi);
			changed++;
		} else if (!enable && wasEnabled) {
			entry.toolset.disable(pi);
			changed++;
		}
	}

	const action = enable ? "Enabled" : "Disabled";
	const noun = changed === 1 ? "toolset" : "toolsets";
	return `${action} ${changed} ${noun}.`;
}
