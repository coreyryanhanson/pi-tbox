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
	defineToolset,
	effectiveEnabled,
	forceToolsetEnabled,
	getRegisteredToolsets,
	readMergedToolsetDefaults,
	PersistKeyCollisionError,
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
const MCP_TOOLSET_PREFIX = "tbox.mcp@";

/** Namespace prefix pi puts on every MCP tool. */
const MCP_NAMESPACE_PREFIX = "mcp__";

/** UI notify callback, threaded so sync paths can surface collisions. */
export type NotifyFn = (
	message: string,
	level?: "info" | "warning" | "error",
) => void;

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
 * persist entries. Branch-aware via `effectiveEnabled` — the same resolution
 * masking's own restore uses (chat-branch entry, allowlist-aware, → settings
 * pin → packaged default), so orphan actuation and restore cannot disagree,
 * and an orphan whose chat-branch entry says off resolves off on a resumed
 * session (a branch-blind settings-only fallback would resolve it ON — the
 * one-prompt leak). During focus (allowlist mode) the allowlist array is the
 * authority: a toolset registered after focus was entered is in the array →
 * on, else → off. Used after autoRegisterBuiltinAndOrphans when the library's
 * restore handler already fired before these orphans were registered. The
 * apply itself is the library's `forceToolsetEnabled` (no persist, no
 * cascade, no intent gate) — the same non-toggle apply path focus.ts uses.
 *
 * @param pi - The extension API
 * @param ids - Toolset ids to actuate (typically the return of
 *   autoRegisterBuiltinAndOrphans)
 * @param branch - The session branch (`ctx.sessionManager.getBranch()`);
 *   required — an omitted argument would resolve exactly like an empty
 *   mirror, re-creating the branch-blind fallback this replaces.
 */
export function actuateNewToolsets(
	pi: ExtensionAPI,
	ids: string[],
	branch: readonly SessionEntry[],
): void {
	if (ids.length === 0) return;

	const defaultsSnapshot = readMergedToolsetDefaults();
	const registry = getRegisteredToolsets();

	for (const id of ids) {
		const entry = registry.find((e: RegistryEntry) => e.spec.id === id);
		if (!entry) continue;
		forceToolsetEnabled(
			pi,
			entry.spec,
			effectiveEnabled(entry.spec, branch, defaultsSnapshot).enabled,
		);
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
		persistKey: mcpToolsetPersistKey(id),
		defaultEnabled: true,
	};
}

/** The persistKey an id owns — the squat guard's authority. One format,
 * two readers (spec builder + guard), so the guard can never disagree
 * with what buildMcpToolsetSpec actually writes. */
function mcpToolsetPersistKey(id: string): string {
	return `toolset-state:${id}`;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const name of a) {
		if (!b.has(name)) return false;
	}
	return true;
}

/** Best-effort attribution: the source path of the extension behind a
 * toolset's first member tool, when the tool is still present. */
function ownerSourcePath(pi: ExtensionAPI, names: Set<string>): string | undefined {
	const tool = pi.getAllTools().find((t) => names.has(t.name));
	return tool?.sourceInfo.path;
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
	notify: NotifyFn,
): void {
	const id = mcpToolsetId(server);
	const entry = getRegisteredToolsets().find((e) => e.spec.id === id);
	let spec: ToolsetSpec;

	if (entry) {
		// Id-squatting guard: the lookup is by an id tbox itself generated, so
		// an entry found here was either defined by tbox or squatting the id.
		// tbox builds its spec deterministically, so a foreign spec's
		// persistKey cannot match. Warn-and-skip (not throw) — an error inside
		// a re-scan kills the whole pass, isolating the damage to this server
		// instead. Collision heuristic, not a lock: a squatter copying tbox's
		// hardcoded persistKey constant passes this check.
		if (entry.spec.persistKey !== mcpToolsetPersistKey(id)) {
			const owner = ownerSourcePath(pi, entry.spec.names);
			notify(
				`tbox: toolset id "${id}" is owned by another extension` +
					(owner ? ` (${owner})` : "") +
					`; skipping MCP sync for ${server}`,
				"warning",
			);
			return; // before any spec mutation or defineToolset
		}
		if (nextNames.size > 0 && !setsEqual(entry.spec.names, nextNames)) {
			entry.spec.names = nextNames;
		}
		spec = buildMcpToolsetSpec(server, entry.spec.names);
	} else {
		if (nextNames.size === 0) return; // nothing tbox can toggle — no toolset
		spec = buildMcpToolsetSpec(server, nextNames);
	}

	try {
		defineToolset(pi, spec);
	} catch (err) {
		// Name-based, never instanceof or message match: handles may come from
		// another physical copy of the library off the shared globalThis
		// registry. Covers the sibling squatting shape the same-id guard above
		// cannot see — a foreign id claiming tbox's persistKey — where the
		// cross-entry collision throw would otherwise kill the whole re-scan.
		// Every other error rethrows raw: a genuine tbox defect must stay loud.
		if ((err as { name?: string })?.name !== "PersistKeyCollisionError")
			throw err;
		const collision = err as PersistKeyCollisionError;
		notify(
			`tbox: toolset id "${spec.id}" claims the persistKey already owned ` +
				`by toolset "${collision.existingId}"; skipping MCP sync for ${server}`,
			"warning",
		);
		return;
	}

	// Branch-aware intent reconcile. actuateNewToolsets is deliberately not
	// used: its getEffectiveDefault fallback skips the chat-branch tier, so an
	// intent-off server would resolve ON here (it connected after the restore
	// ran) and stay declared until the next prompt. Intent-on needs nothing —
	// pi activates declarable tools on registration and defaultEnabled: true
	// unions them. The reconcile also closes the re-assert ordering leak: a
	// newcomer to an intent-off toolset is pi-activated before masking's
	// re-assert (which read the old member set) and is dropped here in the
	// same prompt.
	// Gated on a member actually being active: forceToolsetEnabled's disable
	// path always emits `changed`, so an ungated call would fire a spurious
	// emit (and slot re-render) on every unchanged scan of an intent-off
	// toolset whose members are already undeclared. Nothing to reconcile then.
	const activeSet = new Set(pi.getActiveTools());
	const hasActiveMember = [...spec.names].some((n) => activeSet.has(n));
	if (hasActiveMember && !effectiveEnabled(spec, branch, defaultsSnapshot).enabled) {
		forceToolsetEnabled(pi, spec, false);
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
	notify: NotifyFn = console.warn,
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
		syncOneMcpToolset(pi, server, next, branch, defaultsSnapshot, notify);
	}
}
