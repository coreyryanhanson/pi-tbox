/**
 * /tbox focus — single-unit focus with inclusion mode and drift-free exit.
 *
 * Focus is **single-unit**: one group name, one toolset id, or one tool
 * name — but never a builtin. The resolved unit + its forward `requires`
 * closure AND reverse `dependents` closure (matching the library's
 * bi-directional enable cascade) becomes the allowlist; every other
 * toolset is disabled. On exit,
 * **re-actuation** (not mode flip) drives every toolset back to its
 * `spec.defaultEnabled`, overwriting the focus-era entries.
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRegisteredToolsets,
	setDefaultResolutionMode,
} from "pi-tool-masking";
import { forwardClosure, reverseClosure } from "./requires-graph.js";
import { resolveGroup } from "./groups.js";
import { BUILTIN_TOOLSET_ID } from "./registry.js";
import { setFocusUnit } from "./status-slot.js";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

type ResolvedUnit =
	| { ok: true; toolsetIds: string[]; label: string }
	| { ok: false; error: string };

/**
 * Resolve a focus unit string to a set of toolset ids.
 *
 * Strategy:
 *   1. Builtin guard — reject if it's a builtin tool or `pi.builtin`.
 *   2. Try as a group name (from config).
 *   3. Try as a registered toolset id.
 *   4. Try as a tool name → find its containing toolset.
 *   5. Fallback error.
 */
function resolveFocusUnit(pi: ExtensionAPI, input: string): ResolvedUnit {
	// --- Builtin guard ---
	if (input === BUILTIN_TOOLSET_ID) {
		return {
			ok: false,
			error:
				"builtins are out of tbox's scope; focus on an extension toolset or group instead.",
		};
	}

	const allTools = pi.getAllTools();
	const registry = getRegisteredToolsets();

	// Check if input matches a builtin tool name
	const builtinTool = allTools.find(
		(t) => t.name === input && t.sourceInfo.source === "builtin",
	);
	if (builtinTool) {
		return {
			ok: false,
			error:
				"builtins are out of tbox's scope; focus on an extension toolset or group instead.",
		};
	}

	// --- Try as a group name ---
	const groupResolved = resolveGroup(input);
	if ("group" in groupResolved) {
		const ids = groupResolved.group.toolsets;
		if (ids.length === 0) {
			return {
				ok: false,
				error: `Group "${input}" has no toolsets. Add toolsets via /tbox group ${input} edit, then focus.`,
			};
		}
		// Expand group toolsets + both-direction closure so the library's
		// enable cascade (which goes both ways) matches the allowlist.
		const union = new Set([...forwardClosure(ids), ...reverseClosure(ids)]);
		return { ok: true, toolsetIds: [...union], label: `group:${input}` };
	}

	// --- Try as a registered toolset id ---
	const toolsetEntry = registry.find((e) => e.spec.id === input);
	if (toolsetEntry) {
		const union = new Set([
			...forwardClosure([input]),
			...reverseClosure([input]),
		]);
		return { ok: true, toolsetIds: [...union], label: input };
	}

	// --- Try as a tool name ---
	const tool = allTools.find((t) => t.name === input);
	if (tool) {
		// SDK tool guard
		if (tool.sourceInfo.source === "sdk") {
			return {
				ok: false,
				error: `Cannot focus on "${input}": SDK tools are host-managed and out of tbox's scope.`,
			};
		}

		const containing = registry.find((e) => e.spec.names.has(input));
		if (!containing) {
			return {
				ok: false,
				error: `Cannot focus on "${input}": no toolset contains this tool.`,
			};
		}

		const union = new Set([
			...forwardClosure([containing.spec.id]),
			...reverseClosure([containing.spec.id]),
		]);
		return {
			ok: true,
			toolsetIds: [...union],
			label: containing.spec.id,
		};
	}

	// --- Prefix-match fallback for tool names (to match toggle's behavior) ---
	const prefixMatches = allTools.filter((t) => t.name.startsWith(input));
	if (prefixMatches.length > 1) {
		const candidates = prefixMatches.map((t) => t.name).join(", ");
		return {
			ok: false,
			error: `Ambiguous "${input}". Candidates: ${candidates}`,
		};
	}
	if (prefixMatches.length === 1) {
		// Recurse with the full name — re-runs builtin/sdk guards and
		// closure logic without duplicating them here.
		return resolveFocusUnit(pi, prefixMatches[0]!.name);
	}

	return {
		ok: false,
		error: `No toolset, group, or tool matching "${input}".`,
	};
}

// ---------------------------------------------------------------------------
// Focus enter / exit
// ---------------------------------------------------------------------------

/**
 * Enter focus on a single unit.
 *
 * 1. Resolves the unit to an allowlist of toolset ids (+ forward requires
 *    + reverse dependents closure, so the library's bi-directional enable
 *    cascade matches the allowlist).
 * 2. Seeds `pi.builtin` into the allowlist (drift fix).
 * 3. Sets inclusion mode so unknown toolsets default off.
 * 4. Enables every toolset in the allowlist (first pass — the library
 *    cascades deps + dependents naturally).
 * 5. Disables every toolset NOT in the allowlist and NOT cascaded by the
 *    library (second pass — pi.builtin is never disabled).
 *
 * @returns A human-readable result or error message.
 */
export function focusUnit(pi: ExtensionAPI, input: string): string {
	const resolved = resolveFocusUnit(pi, input);
	if (!resolved.ok) return resolved.error;

	const allowlist = new Set(resolved.toolsetIds);

	// Seed pi.builtin into the allowlist so newly shipped builtins survive
	// focus (§13.2 drift fix — one line, tbox-owned)
	allowlist.add(BUILTIN_TOOLSET_ID);

	const registry = getRegisteredToolsets();

	// Set inclusion mode before actuating
	setDefaultResolutionMode(pi, "inclusion");

	// ponytail: two-pass approach relies on synchronous enable(). If the
	// library ever adds async enable/disable, the disable pass would race
	// the cascade — guard with a flush/tick before the second pass.
	// First pass: enable allowlist members (library cascades deps + dependents)
	let enabled = 0;

	for (const entry of registry) {
		if (allowlist.has(entry.spec.id) && !entry.toolset.isEnabled(pi)) {
			entry.toolset.enable(pi);
			enabled++;
		}
	}

	// Second pass: disable non-allowlist toolsets that aren't cascaded.
	// The library's enable() cascades both forward (requires) and reverse
	// (dependents). After the enable pass, any toolset that's now enabled
	// but NOT in the allowlist was pulled in by the cascade — skip it.
	// Only disable toolsets that are still NOT in the allowlist and are
	// currently enabled exclusively from pre-focus state.
	let disabled = 0;

	for (const entry of registry) {
		const id = entry.spec.id;
		if (allowlist.has(id)) continue;
		if (id === BUILTIN_TOOLSET_ID) continue;

		if (entry.toolset.isEnabled(pi)) {
			entry.toolset.disable(pi);
			disabled++;
		}
	}

	setFocusUnit(resolved.label);

	return `Focus on "${resolved.label}" — ${enabled} enabled, ${disabled} disabled.`;
}

/**
 * Exit focus via **re-actuation, not mode flip**.
 *
 * For every registered toolset, drives it back to `spec.defaultEnabled`,
 * overwriting the focus-era entries. Then restores exclusion mode so
 * unknown toolsets default on again.
 *
 * Documented: "Restore defaults" means each toolset returns to
 * `spec.defaultEnabled` — the library never remembers pre-focus state.
 */
export function focusOff(pi: ExtensionAPI): string {
	const registry = getRegisteredToolsets();

	// ponytail: focus-era overwrite is destructive — pre-focus manual toggles
	// are lost. The MVP confirms this: "the library never remembers pre-focus
	// state." Add a pre-focus snapshot + restore if users report this as a bug.
	let restored = 0;

	for (const entry of registry) {
		const wantsEnabled = entry.spec.defaultEnabled ?? true;

		if (wantsEnabled && !entry.toolset.isEnabled(pi)) {
			entry.toolset.enable(pi);
			restored++;
		} else if (!wantsEnabled && entry.toolset.isEnabled(pi)) {
			entry.toolset.disable(pi);
			restored++;
		}
		// Already in the correct state — skip (no entry written)
	}

	setDefaultResolutionMode(pi, "exclusion");
	setFocusUnit(null);

	return `Focus off — ${restored} toolset${restored !== 1 ? "s" : ""} restored to default.`;
}
