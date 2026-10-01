/**
 * Auto-register orphan toolsets at load time.
 *
 * Scans pi.getAllTools() after all extensions have loaded (in session_start)
 * and registers per-source orphan toolsets for extension tools not
 * claimed by any other toolset.
 *
 * Builtin tools (source === "builtin") and SDK tools are never registered
 * as tbox toolsets — they're outside tbox's domain.
 *
 * Returns the set of toolset ids that were registered in this call
 * (so callers can actuate them if the library's restore handler already
 * fired before registration).
 *
 * Also hosts the MCP re-scan (syncMcpToolsets): one declared-only toolset
 * per MCP server, registered and synced in place when the server's
 * declarable tool set changes. MCP toolsets are addressed by the
 * tbox.mcp@<server> id and actuated via the branch-aware intent reconcile
 * here — never via actuateNewToolsets, whose getEffectiveDefault fallback
 * is branch-unaware.
 *
 * @module
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	applyToolsetEnabled,
	defineToolset,
	effectiveEnabled,
	getActiveAllowlist,
	getEffectiveDefault,
	getRegisteredToolsets,
	readMergedToolsetDefaults,
	TOOLSET_EVENTS,
} from "pi-tool-masking";
import type { ToolsetSpec, RegistryEntry } from "pi-tool-masking";
import { isExtensionTool } from "./chars.js";
import { isDeclarableMcpTool, isMcpTool } from "./mcp.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix for per-source orphan toolset ids: tbox.tool@<source>. */
export const ORPHAN_TOOLSET_PREFIX = "tbox.tool@";

/** Prefix for per-MCP-server toolset ids: tbox.mcp@<server>. */
export const MCP_TOOLSET_PREFIX = "tbox.mcp@";

/** Namespace prefix pi puts on every MCP tool. */
const MCP_NAMESPACE_PREFIX = "mcp__";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the version suffix from an npm source string, keeping scoped names
 * intact. Mirrors pi's parseNpmSpec: /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/
 * (incl. its .trim() of the spec after the `npm:` prefix).
 */
export function stripSourceVersion(source: string): string {
	if (!source.startsWith("npm:")) return source;
	const m = source
		.slice(4)
		.trim()
		.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	return m ? `npm:${m[1]}` : source; // unparseable → leave untouched
}

/** Build a toolset id for a given orphan source. */
export function orphanToolsetId(source: string): string {
	return `${ORPHAN_TOOLSET_PREFIX}${source}`;
}

/** Build a persist key for a given orphan source. */
function orphanPersistKey(source: string): string {
	return `toolset-state:${orphanToolsetId(source)}`;
}

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

/**
 * Classify tools by source and register orphan toolsets.
 *
 * This function is idempotent — re-running with the same tool population
 * is a no-op (the library's defineToolset is idempotent-by-content for
 * unchanged specs).
 *
 * Builtin tools and SDK tools are never registered — they are out of
 * tbox's domain.
 *
 * @param pi - The extension API
 * @returns Array of newly-registered toolset ids (empty if no new registrations)
 */
export function autoRegisterBuiltinAndOrphans(pi: ExtensionAPI): string[] {
	const newIds: string[] = [];
	const allTools = pi.getAllTools();
	const existingToolsets = getRegisteredToolsets();

	// --- Collect extension tools (not builtin, not sdk, not MCP) ---
	// MCP tools are builtin-source so isExtensionTool already excludes them;
	// the explicit !isMcpTool arm keeps that true if isExtensionTool ever
	// widens — a stray MCP tool must not become a tbox.tool@builtin orphan.
	const extensionTools = allTools.filter(
		(t) => isExtensionTool(t) && !isMcpTool(t),
	);

	// --- Find which extension tools are already claimed by a toolset ---
	const claimedByToolset = new Set<string>();
	for (const entry of existingToolsets) {
		// Skip toolsets we manage (ourselves) so orphan tools don't look
		// claimed-by-themselves when we re-register.
		if (entry.spec.id.startsWith(ORPHAN_TOOLSET_PREFIX)) continue;
		for (const name of entry.spec.names) {
			claimedByToolset.add(name);
		}
	}

	// --- Find orphan extension tools (not claimed by any toolset) ---
	const orphanTools = extensionTools.filter(
		(t) => !claimedByToolset.has(t.name),
	);

	// --- Group orphan tools by version-stripped source ---
	// Two raw sources that strip to the same id must merge into one toolset
	// (same id ⇒ must be one spec, else the library warns-and-replaces).
	const toolsBySource = new Map<string, typeof orphanTools>();
	for (const tool of orphanTools) {
		const source = stripSourceVersion(tool.sourceInfo.source);
		if (!toolsBySource.has(source)) toolsBySource.set(source, []);
		toolsBySource.get(source)!.push(tool);
	}

	// --- Register per-source orphan toolsets ---
	for (const [source, tools] of toolsBySource) {
		const names = tools.map((t) => t.name);
		// Pass description only when the source contributes exactly one tool.
		// Multi-tool sources omit description rather than misrepresent one
		// tool's description as the group's.
		const description = tools.length === 1 ? tools[0]!.description : undefined;
		const spec: ToolsetSpec = {
			id: orphanToolsetId(source),
			label: source,
			...(description === undefined ? {} : { description }),
			names: new Set(names),
			persistKey: orphanPersistKey(source),
			defaultEnabled: true,
		};
		const existing = existingToolsets.find(
			(e) => e.spec.id === orphanToolsetId(source),
		);
		if (!existing) {
			newIds.push(orphanToolsetId(source));
		}
		defineToolset(pi, spec);
	}

	return newIds;
}

// ---------------------------------------------------------------------------
// Restore-timing: actuate a recently-registered toolset to default state
// ---------------------------------------------------------------------------

/**
 * Actuate a set of toolset ids to their desired state, without appending
 * persist entries or emitting events.
 *
 * During focus (allowlist mode) the allowlist array is the authority: a
 * toolset registered after focus was entered is in the array → on, else
 * → off. Outside focus, each toolset falls back to its settings-aware
 * default (`getEffectiveDefault`). This mirrors what the library's restore
 * handler would have done if it had seen these toolsets at the time it ran.
 * Used after autoRegisterBuiltinAndOrphans when the restore handler already
 * fired before these orphans were registered.
 *
 * @param pi - The extension API
 * @param ids - Toolset ids to actuate (typically the return of
 *   autoRegisterBuiltinAndOrphans)
 */
export function actuateNewToolsets(pi: ExtensionAPI, ids: string[]): void {
	if (ids.length === 0) return;

	const allow = getActiveAllowlist();
	const defaultsSnapshot = readMergedToolsetDefaults();
	const registry = getRegisteredToolsets();
	const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
	const activeSet = new Set(pi.getActiveTools());
	let changed = false;

	const wantEnabled = (spec: ToolsetSpec): boolean => {
		if (allow !== undefined) return allow.includes(spec.id);
		return getEffectiveDefault(spec, defaultsSnapshot);
	};

	for (const id of ids) {
		const entry = registry.find((e: RegistryEntry) => e.spec.id === id);
		if (!entry) continue;

		const enabled = wantEnabled(entry.spec);
		const registeredNames = [...entry.spec.names].filter((n) =>
			allToolNames.has(n),
		);

		if (enabled) {
			for (const name of registeredNames) {
				if (!activeSet.has(name)) {
					activeSet.add(name);
					changed = true;
				}
			}
		} else {
			for (const name of registeredNames) {
				if (activeSet.has(name)) {
					activeSet.delete(name);
					changed = true;
				}
			}
		}
	}

	if (changed) {
		pi.setActiveTools([...activeSet]);
		// Emit so wireSlot's listener re-renders the status bar
		// ponytail: payload satisfies ToolsetChangedEvent's shape, but this is a
		// re-render tick for wireSlot — id matches no sibling filter and enabled is
		// not truthful (pass can enable and disable). Per-toolset emits only if a
		// listener ever needs tbox restore states.
		pi.events.emit(TOOLSET_EVENTS.changed, {
			id: "tbox.restore-timing",
			enabled: true,
		});
	}
}

// ---------------------------------------------------------------------------
// MCP re-scan — one declared-only toolset per MCP server
// ---------------------------------------------------------------------------

/** Build a toolset id for an MCP server namespace (minus the mcp__ prefix). */
function mcpToolsetId(server: string): string {
	return `${MCP_TOOLSET_PREFIX}${server}`;
}

/**
 * Deterministic spec builder for an MCP toolset — no `description`, so a
 * re-scan rebuilding the spec yields a deep-equal object and the library's
 * defineToolset takes its idempotent branch (no warn-and-replace, no
 * re-actuation) while still re-running ensureRestoreHandler (/reload safety).
 */
function buildMcpToolsetSpec(server: string, names: Set<string>): ToolsetSpec {
	const id = mcpToolsetId(server);
	return {
		id,
		label: `${MCP_NAMESPACE_PREFIX}${server}`,
		names: new Set(names),
		persistKey: `toolset-state:${id}`,
		defaultEnabled: true,
	};
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const name of a) {
		if (!b.has(name)) return false;
	}
	return true;
}

/**
 * Sync one MCP server's toolset into the registry.
 *
 * New server → defineToolset. Existing server → mutate the live registry
 * entry's spec.names in place (masking 2.0.0's membership-change contract —
 * there is no setMembers method), delta-gated so an unchanged scan performs
 * no write, then call defineToolset unconditionally: the spec is built from
 * the entry's post-gate member set, so it is deep-equal in every case and
 * the call always takes the idempotent branch — which still re-runs
 * ensureRestoreHandler, keeping masking's restore/re-assert installed after
 * /reload even in a registry holding only MCP toolsets.
 *
 * A scan finding zero declarable members for an existing toolset never
 * empties it: the write is skipped and the (now hidden) members stay in
 * spec.names, which keeps masking's witness gate making a toggle issued
 * while the server is disconnected a persisting off.
 */
function syncOneMcpToolset(
	pi: ExtensionAPI,
	server: string,
	nextNames: Set<string>,
	branch: readonly SessionEntry[],
	defaultsSnapshot: ReturnType<typeof readMergedToolsetDefaults>,
): void {
	const id = mcpToolsetId(server);
	const entry = getRegisteredToolsets().find((e) => e.spec.id === id);
	let spec: ToolsetSpec;

	if (entry) {
		// Tripwire: the lookup is by an id tbox itself generated, so this can
		// only fire if a future change broadens the lookup into a registry-wide
		// scan. Fail loudly rather than mutate a foreign declared toolset.
		if (
			!entry.spec.id.startsWith(MCP_TOOLSET_PREFIX) &&
			!entry.spec.id.startsWith(ORPHAN_TOOLSET_PREFIX)
		) {
			throw new Error(
				`[tbox] refusing to mutate foreign toolset "${entry.spec.id}"`,
			);
		}
		if (nextNames.size > 0 && !setsEqual(entry.spec.names, nextNames)) {
			entry.spec.names = nextNames;
		}
		spec = buildMcpToolsetSpec(server, entry.spec.names);
	} else {
		if (nextNames.size === 0) return; // nothing tbox can toggle — no toolset
		spec = buildMcpToolsetSpec(server, nextNames);
	}

	defineToolset(pi, spec);

	// Branch-aware intent reconcile. actuateNewToolsets is deliberately not
	// used: its getEffectiveDefault fallback skips the chat-branch tier, so an
	// intent-off server would resolve ON here (it connected after the restore
	// ran) and stay declared until the next prompt. Intent-on needs nothing —
	// pi activates declarable tools on registration and defaultEnabled: true
	// unions them. The reconcile also closes the re-assert ordering leak: a
	// newcomer to an intent-off toolset is pi-activated before masking's
	// re-assert (which read the old member set) and is dropped here in the
	// same prompt.
	// Gated on a member actually being active: applyToolsetEnabled's disable
	// path always emits `changed`, so an ungated call would fire a spurious
	// emit (and slot re-render) on every unchanged scan of an intent-off
	// toolset whose members are already undeclared. Nothing to reconcile then.
	const activeSet = new Set(pi.getActiveTools());
	const hasActiveMember = [...spec.names].some((n) => activeSet.has(n));
	if (hasActiveMember && !effectiveEnabled(spec, branch, defaultsSnapshot).enabled) {
		applyToolsetEnabled(pi, spec, false);
	}
}

/**
 * Re-scan MCP servers and sync their toolsets: create, update membership,
 * and reconcile intent. Idempotent and cheap — safe to call from every
 * /tbox command and every before_agent_start.
 *
 * MCP servers connect asynchronously after session_start, so this must run
 * after the fact: hook 1 is the per-prompt before_agent_start re-render,
 * hook 2 the top of the /tbox command dispatch. Mid-session tool-list
 * changes (notifications/tools/list_changed) fire no extension event, so
 * re-scanning is the only observation point.
 *
 * Membership = the server's tools passing isDeclarableMcpTool (exposure
 * "direct"), minus names already claimed by other registered toolsets —
 * excluding the MCP toolsets themselves. The subtraction is self-excluding
 * by construction: an mcp__ tool can only ever be claimed by its own
 * server's toolset, so including MCP toolsets in the claimed set would
 * empty `next` on every re-scan, the delta gate would never fire, and
 * membership would freeze in whatever state it first drained to.
 *
 * Servers whose names differ only by - and _ share one namespace upstream
 * (mcpNamespace maps - to _) and hence one toolset id — a toggle hits both.
 */
export function syncMcpToolsets(
	pi: ExtensionAPI,
	branch: readonly SessionEntry[],
): void {
	const defaultsSnapshot = readMergedToolsetDefaults();
	const registry = getRegisteredToolsets();

	// Names claimed by toolsets other than the MCP ones being scanned, so the
	// library's name-overlap guard (a throw at registration) can never fire at
	// scan time. A name dropped this way stays pi-declared but ungrouped.
	const claimedElsewhere = new Set<string>();
	for (const entry of registry) {
		if (entry.spec.id.startsWith(MCP_TOOLSET_PREFIX)) continue;
		for (const name of entry.spec.names) claimedElsewhere.add(name);
	}

	const byServer = new Map<string, Set<string>>();
	for (const tool of pi.getAllTools()) {
		if (!isDeclarableMcpTool(tool)) continue;
		const namespace = tool.namespace;
		if (!namespace) continue;
		const server = namespace.name.slice(MCP_NAMESPACE_PREFIX.length);
		let names = byServer.get(server);
		if (!names) {
			names = new Set<string>();
			byServer.set(server, names);
		}
		names.add(tool.name);
	}

	for (const [server, names] of byServer) {
		const next = new Set<string>();
		for (const name of names) {
			if (!claimedElsewhere.has(name)) next.add(name);
		}
		syncOneMcpToolset(pi, server, next, branch, defaultsSnapshot);
	}
}
