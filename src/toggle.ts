/**
 * /tbox toggle and /tbox all.
 *
 * Provides:
 *   - resolveTool: find a tool by exact or prefix match
 *   - toggleTool: toggle a tool's containing toolset (with guards)
 *   - toggleAll: enable/disable every registered toolset
 *
 * @module
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

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
 * Guards (always enforced):
 *   - SDK tools are always refused.
 *   - Masked toolset members are not individually toggleable.
 *   - pi.builtin is not toggleable.
 *
 * @returns A human-readable status or error message.
 */
export function toggleTool(pi: ExtensionAPI, input: string): string {
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

	// --- Guards (always enforced) ---
	if (entry.spec.id === "pi.builtin") {
		return `Cannot toggle "${tool.name}": builtins are protected. tbox does not manage pi's core tools.`;
	}

	if (entry.spec.masked) {
		const label = entry.spec.label ?? entry.spec.id;
		return `Cannot toggle "${tool.name}": this tool is part of the sealed group "${label}". Toggle the group instead.`;
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
