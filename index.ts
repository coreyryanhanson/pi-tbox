/**
 * pi-tbox — Cross-extension tool manager for Pi
 *
 * Registers the /tbox command, the tbox status slot, and auto-registers
 * pi.builtin + per-source orphan toolsets at load.
 *
 * @module
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	autoRegisterBuiltinAndOrphans,
	actuateNewToolsets,
	syncMcpToolsets,
	setsEqual,
} from "./src/registry.js";
import {
	wireSlot,
	render,
	clearSlot,
	rerenderSlot,
	setFocusUnit,
	setDriftProvider,
	restoreFocusUnit,
	type SlotCtx,
} from "./src/status-slot.js";
import {
	formatBareHelp,
	formatByChars,
	formatList,
	formatStatus,
	parseArgs,
	unknownFlagsError,
} from "./src/list.js";
import { isReserved } from "./src/reserved.js";
import { isDeclarableMcpTool } from "./src/mcp.js";
import { syncToolsets } from "./src/sync.js";
import {
	computeDrift,
	isDeferredChild,
	type DriftFact,
} from "pi-tool-masking";
import {
	actuateGroup,
	describeGroup,
	editGroup,
	listGroups,
	describeToolset,
	actuateToolset,
	toggleAll,
} from "./src/groups.js";
import {
	removeGroup,
	GroupsFileCorruptError,
} from "./config/settings-reader.js";
import { focusUnit, focusOff, focusRelease, soloUnit } from "./src/focus.js";
import { handleDefaults } from "./src/defaults.js";

// ---------------------------------------------------------------------------
// Drift warning — stats-command seam copy
// ---------------------------------------------------------------------------

/** Filter clause + durability suffix: one static body regardless of drift
 *  class or branch mode. The filter clause explains the permanent-drift class
 *  on first sight (a member no write can activate); the suffix states only
 *  what the design guarantees — no cause, since a single-shot check cannot
 *  observe one. */
function driftWarningMessage(facts: readonly DriftFact[]): string {
	return (
		`intent mismatch: ${facts.map((f) => f.fact).join(", ")} — run /tbox sync ` +
		"to align now; if sync reports members still inactive after the write, " +
		"your session's --tools filter may be excluding them — if you do " +
		"nothing, leaks and allowlist drift re-heal at the next turn and " +
		"force-removal at the next session start; either way, sync's " +
		"alignment holds only until the next foreign write."
	);
}

/** Stats commands that diagnose drift at the dispatch seam. Every other
 *  subcommand dispatches without the predicate run. */
const DRIFT_SEAM_COMMANDS: ReadonlySet<string> = new Set([
	"list",
	"chars",
	"status",
]);

// Post-session_start MCP connect retry: pi fires no extension event when a
// server's tools land.
const MCP_RESCAN_INTERVAL_MS = 500;
const MCP_RESCAN_BUDGET_MS = 10_000;

// ---------------------------------------------------------------------------
// Toggle-refusal seam
// ---------------------------------------------------------------------------

/**
 * Map a toggle refusal to its user-facing copy, by error name.
 *
 * Name-based, never instanceof: throwers may come from another physical
 * copy of the library off the shared globalThis registry. Returns
 * undefined for anything that is not a toggle refusal — callers rethrow.
 * Every copy is a fixed literal — the error's message is diagnostic
 * payload, never rendered or matched.
 */
function toggleRefusalMessage(
	err: unknown,
	context: string,
): string | undefined {
	const name = (err as { name?: string })?.name;
	if (name === "AllowlistModeError")
		return `${context} refused — toolset toggles do not operate while allowlist governance is active`;
	if (name === "CycleError")
		return `${context} refused — a requires cycle was detected before any write; nothing changed`;
	if (name === "ContradictionError")
		return `${context} refused — a requires dependency conflict was detected; nothing changed`;
	if (name === "CorruptModeStateError")
		return `${context} refused — the allowlist mode entry is corrupt or empty; use /tbox focus off or /tbox defaults restore to exit focus`;
	return undefined; // not a toggle refusal
}

/**
 * The one catch seam for actuation flows: domain functions throw raw;
 * refusals render here, every other error rethrows to pi's runner.
 */
const runToggle = (context: string, flow: () => string): string => {
	try {
		return flow();
	} catch (err) {
		const refusal = toggleRefusalMessage(err, context);
		if (refusal === undefined) throw err;
		return refusal;
	}
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Default extension factory — called by pi's loader.
 *
 * Registers:
 *   - /tbox command
 *   - tbox status slot (wired to lifecycle events)
 *   - Auto-registration of pi.builtin + per-source orphan toolsets on session_start
 */
export default function tboxFactory(pi: ExtensionAPI) {
	// --- Capture the session context so TOOLSET_EVENTS can re-render ---
	let lastCtx: SlotCtx | null = null;
	let mcpRescanTimer: ReturnType<typeof setTimeout> | undefined;
	// Parallel raw capture (the _getCtx/setFocusUnit pattern): the drift
	// predicate resolves intent through masking's effectiveEnabled, which
	// needs a branch snapshot — pi's API object carries no branch accessor,
	// and lastCtx stays typed SlotCtx ({ui} only) and is not widened.
	let rawCtx: ExtensionContext | null = null;
	let rerenderWired = false;

	const USAGE =
		"/tbox [list|status|all|focus|solo|group|chars|defaults|sync] | /tbox <group> on|off | /tbox +<toolset> on|off";
	const SYNC_USAGE =
		"Usage: /tbox sync — align the live tool set with declared toolset state.";
	const STATUS_HELP =
		"Usage: /tbox status — full status: toolsets, groups, focus, char-count split. Takes no arguments.";
	const CHARS_HELP =
		"Usage: /tbox chars — per-toolset context char counts. Takes no arguments.";

	// --- Register /tbox command handler ---
	pi.registerCommand("tbox", {
		description: "Cross-extension tool manager. Usage: " + USAGE,
		handler: async (args, ctx) => {
			// Defer gate — a deferring child gets no tbox command surface at
			// all: every governance-writing flow is reachable only through
			// this handler, so one message-producing gate covers them all,
			// including the settings-writer flows the library's defer rule
			// leaves live. Before the MCP re-scan: the child must not run it
			// (registering toolsets serves a surface the child does not
			// render), and any flow added below inherits the gate.
			if (isDeferredChild()) {
				ctx.ui.notify("tbox is governed by the parent session", "info");
				return;
			}
			// Hook 2 — the command-path MCP re-scan. Command invocations never
			// pass through before_agent_start, so a user who starts a session,
			// waits for servers to connect, and runs /tbox would otherwise see
			// the pre-MCP world until they submit a prompt. Idempotent.
			// One branch read per command: the MCP re-scan and the describe
			// surfaces below read the same branch — nothing between the reads
			// appends a SessionEntry (defineToolset is registration-only), so
			// re-reading would return the same state.
			const branch = ctx.sessionManager.getBranch();
			syncMcpToolsets(pi, branch, ctx.ui.notify);

			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(formatBareHelp(), "info");
				return;
			}

			const { command, rest, flags } = parseArgs(trimmed);

			if (!command) {
				ctx.ui.notify("Usage: " + USAGE, "info");
				return;
			}

			switch (command) {
				case "list": {
					const output = formatList(pi, trimmed);
					ctx.ui.notify(output, "info");
					break;
				}
				case "status": {
					// --help handled here so the drift seam's `--help` skip is true
					// for every stats command: help served, no diagnostics.
					if (flags.has("help")) {
						ctx.ui.notify(STATUS_HELP, "info");
						break;
					}
					const statusFlagErr = unknownFlagsError(flags, new Set(["help"]), "status");
					if (statusFlagErr !== null) {
						ctx.ui.notify(statusFlagErr, "info");
						break;
					}
					const output = formatStatus(pi, branch);
					ctx.ui.notify(output, "info");
					break;
				}
				case "all": {
					const sub = rest[1];
					if (sub === "on") {
						ctx.ui.notify(
							runToggle("/tbox all", () =>
								toggleAll(pi, true, ctx.sessionManager),
							),
							"info",
						);
					} else if (sub === "off") {
						ctx.ui.notify(
							runToggle("/tbox all", () =>
								toggleAll(pi, false, ctx.sessionManager),
							),
							"info",
						);
					} else {
						ctx.ui.notify(
							"Usage: /tbox all on | /tbox all off — enable or disable all toolsets.",
							"info",
						);
					}
					break;
				}
				case "group": {
					// /tbox group <name> [edit|remove] | /tbox group list
					const name = rest[1];
					if (!name) {
						ctx.ui.notify(
							"Usage: /tbox group <name> [edit|remove] | /tbox group list — edit or remove a group, or list all groups.",
							"info",
						);
						break;
					}
					// /tbox group list — name is "list", no second arg
					if (name === "list" && !rest[2]) {
						ctx.ui.notify(listGroups(), "info");
						break;
					}

					const sub = rest[2];

					// /tbox group list <junk> — "list" is a reserved word and
					// can never be a group name, so the trailing args are a
					// usage mistake. Show usage instead of the confusing
					// 'No group named "list"'. edit/remove still route below
					// so the reserved-name refusal path stays regression-safe.
					if (name === "list" && sub !== "edit" && sub !== "remove") {
						ctx.ui.notify(
							'Usage: /tbox group list — list all groups. "list" is a reserved word and cannot be a group name.',
							"info",
						);
						break;
					}
					if (sub === "edit") {
						ctx.ui.notify(await editGroup(name, ctx), "info");
					} else if (sub === "remove") {
						try {
							ctx.ui.notify(
								removeGroup(name)
									? `Group "${name}" removed.`
									: `No group named "${name}".`,
								"info",
							);
						} catch (err) {
							// Corrupt groups file: refuse loudly instead of
							// silently overwriting user data.
							ctx.ui.notify(
								err instanceof GroupsFileCorruptError
									? err.message
									: `Failed to remove group: ${String(err)}`,
								"error",
							);
						}
					} else {
						// Bare `/tbox group <name>` — report the group's units.
						ctx.ui.notify(describeGroup(name), "info");
					}
					break;
				}

				case "solo": {
					const target = rest[1];
					if (!target) {
						ctx.ui.notify(
							"Usage: /tbox solo <group> | /tbox solo +<toolset> — everything off, one unit on. Like focus, but no lock.",
							"info",
						);
						break;
					}
					ctx.ui.notify(
						runToggle("/tbox solo", () =>
							soloUnit(pi, target, ctx.sessionManager),
						),
						"info",
					);
					break;
				}
				case "chars": {
					// See the status case: help served means the seam's skip is true.
					if (flags.has("help")) {
						ctx.ui.notify(CHARS_HELP, "info");
						break;
					}
					const charsFlagErr = unknownFlagsError(flags, new Set(["help"]), "chars");
					if (charsFlagErr !== null) {
						ctx.ui.notify(charsFlagErr, "info");
						break;
					}
					ctx.ui.notify(formatByChars(pi), "info");
					break;
				}
				case "focus": {
					const sub = rest[1];
					if (sub === "off") {
						ctx.ui.notify(focusOff(pi, branch), "info");
					} else if (sub === "release") {
						ctx.ui.notify(
							runToggle("/tbox focus release", () =>
								focusRelease(pi, ctx.sessionManager),
							),
							"info",
						);
					} else if (sub) {
						ctx.ui.notify(
							runToggle("/tbox focus", () => focusUnit(pi, sub)),
							"info",
						);
					} else {
						ctx.ui.notify(
							"Usage: /tbox focus <group> | /tbox focus +<toolset> | /tbox focus off | /tbox focus release — focus on a group or toolset, or exit focus.",
							"info",
						);
					}
					break;
				}
				case "defaults": {
					const result = handleDefaults(pi, ctx, trimmed);
					ctx.ui.notify(result.message, result.level);
					break;
				}
				case "sync": {
					// Takes no arguments — the validating pair, like list/defaults:
					// --help first (the shared flag-rejection line's hint must stay
					// true), trailing words print usage, unknown flags are rejected.
					if (flags.has("help")) {
						ctx.ui.notify(SYNC_USAGE, "info");
						break;
					}
					if (rest.length > 1) {
						ctx.ui.notify(SYNC_USAGE, "info");
						break;
					}
					const flagErr = unknownFlagsError(flags, new Set(), "sync");
					if (flagErr !== null) {
						ctx.ui.notify(flagErr, "info");
						break;
					}
					// No checkFocusGuard — sync's desired state is derived from
					// focus itself (mode-aware effectiveEnabled), the same
					// principle that exempts focusRelease. Not a toggle flow:
					// no refusal surface, so no runToggle seam.
					const result = syncToolsets(pi, branch);
					ctx.ui.notify(result.message, result.level);
					// The no-op path writes nothing, so no changed event fires —
					// repaint here for a stale drift marker to clear, like the
					// stats seam does.
					rerenderSlot(pi);
					break;
				}
				default: {
					// `+` prefix → toolset direct toggle
					if (command.startsWith("+")) {
						const toolsetId = command.slice(1);
						const sub = rest[1];
						if (sub === "on") {
							ctx.ui.notify(
								runToggle(`/tbox +${toolsetId}`, () =>
									actuateToolset(pi, toolsetId, true, ctx.sessionManager),
								),
								"info",
							);
						} else if (sub === "off") {
							ctx.ui.notify(
								runToggle(`/tbox +${toolsetId}`, () =>
									actuateToolset(pi, toolsetId, false, ctx.sessionManager),
								),
								"info",
							);
						} else {
							ctx.ui.notify(describeToolset(toolsetId, branch), "info");
						}
						break;
					}

					// Group shorthand: `/tbox <group> on|off`. Since group
					// names exclude reserved words and `+`, the bare form
					// never collides with subcommands.
					if (isReserved(command)) {
						ctx.ui.notify(
							`Unknown subcommand: "${command}". Usage: ${USAGE}`,
							"error",
						);
						break;
					}
					const sub = rest[1];
					if (sub === "on") {
						ctx.ui.notify(
							runToggle(`/tbox ${command}`, () =>
								actuateGroup(pi, command, true, ctx.sessionManager),
							),
							"info",
						);
					} else if (sub === "off") {
						ctx.ui.notify(
							runToggle(`/tbox ${command}`, () =>
								actuateGroup(pi, command, false, ctx.sessionManager),
							),
							"info",
						);
					} else {
						ctx.ui.notify(describeGroup(command), "info");
					}
				}
			}

			// Drift seam — stats commands diagnose drift. The predicate runs
			// twice per invocation (here for the bubble, again inside the
			// repaint's provider check); help requests skip the seam — not
			// diagnostic invocations.
			if (DRIFT_SEAM_COMMANDS.has(command) && !flags.has("help")) {
				const facts = computeDrift(pi, branch);
				if (facts.length > 0) {
					ctx.ui.notify(driftWarningMessage(facts), "warning");
				}
				rerenderSlot(pi);
			}
		},
	});

	// --- Session handlers ---

	/**
	 * Bounded post-start MCP re-scan. Polls until the budget expires, re-syncing only when the
	 * declarable MCP tool-name set changed since the last sync — a name-set
	 * diff, so later-connecting servers stay covered within the window. Spawned
	 * by captureAndRender (beneath its defer gate); reuses syncMcpToolsets.
	 */
	const scheduleMcpConnectRescan = (ctx: ExtensionContext) => {
		clearTimeout(mcpRescanTimer);
		mcpRescanTimer = undefined;
		const declarableMcpNames = () => {
			const names = new Set<string>();
			for (const tool of pi.getAllTools())
				if (isDeclarableMcpTool(tool)) names.add(tool.name);
			return names;
		};
		let syncedNames = declarableMcpNames();
		const deadline = Date.now() + MCP_RESCAN_BUDGET_MS;
		const tick = () => {
			mcpRescanTimer = undefined;
			// Bare setTimeout callback — outside pi's handler error containment
			// (syncMcpToolsets rethrows raw), so swallow and keep the reschedule
			// unconditional rather than let a tick kill the poll or the process.
			try {
				const names = declarableMcpNames();
				// Change check first: an idle tick must not pay syncMcpToolsets'
				// settings-file reads — poll cost is then one getAllTools pass.
				// Baseline updates only after a successful sync, so a tick that
				// throws (before or mid-scan) is retried, not skipped, next tick.
				if (!setsEqual(names, syncedNames)) {
					syncMcpToolsets(pi, ctx.sessionManager.getBranch(), ctx.ui.notify);
					rerenderSlot(pi);
					syncedNames = names;
				}
			} catch {
				// Contained; the next tick retries (or the budget expires).
			}
			if (Date.now() < deadline)
				mcpRescanTimer = setTimeout(tick, MCP_RESCAN_INTERVAL_MS);
		};
		mcpRescanTimer = setTimeout(tick, MCP_RESCAN_INTERVAL_MS);
	};

	const captureAndRender = (ctx: ExtensionContext) => {
		// Defer gate — silent: a deferring child gets no tbox surface at all
		// (no registration, actuation, MCP sync, focus restore, slot render,
		// per-prompt re-scan), matching the library's dispatcher policy.
		if (isDeferredChild()) return;
		const branch = ctx.sessionManager.getBranch();
		const newIds = autoRegisterBuiltinAndOrphans(pi);
		actuateNewToolsets(pi, newIds, branch);
		// MCP re-scan — idempotent. At session_start servers haven't connected
		// yet, so this is usually a no-op; on session_tree (branch switch) and
		// after /reload, connected servers' toolsets are synced here, and the
		// unconditional defineToolset inside reinstalls masking's restore/re-
		// assert handlers on a fresh pi for a registry holding only MCP toolsets.
		syncMcpToolsets(pi, branch, ctx.ui.notify);
		scheduleMcpConnectRescan(ctx);
		// SAFETY: SlotCtx is a structural subset of ExtensionContext (ui + sessionManager);
		// every field SlotCtx reads exists on the real context.
		lastCtx = ctx as unknown as SlotCtx;
		rawCtx = ctx;
		restoreFocusUnit(ctx);
		render(pi, lastCtx);

		// Re-render the slot at every turn boundary so the count reflects the
		// live active set, not whatever the last TOOLSET_EVENTS fanout left.
		// Registered from session_start (not the factory body) so it runs AFTER
		// factory-registered before_agent_start reconcilers and shows the true
		// post-reconciler state, not a pre-leak snapshot.
		// ponytail: a pi-core TOOLSET_EVENTS emit on every setActiveTools call
		// would make this redundant; drop this handler if that ever ships.
		if (!rerenderWired) {
			// Hook 1 — the per-prompt MCP re-scan + slot re-render. Fires once per
			// prompt submission; mid-session MCP tool-list changes (list_changed
			// notifications) fire no extension event, so this re-scan is the only
			// observation point. Runs after masking's re-assert in the dispatch
			// order (orphan defineToolsets above register first), so the scan's
			// intent reconcile closes the one-prompt leak the re-assert misses.
			pi.on("before_agent_start", (_event, ctx) => {
				syncMcpToolsets(pi, ctx.sessionManager.getBranch(), ctx.ui.notify);
				rerenderSlot(pi);
			});
			rerenderWired = true;
		}
	};

	pi.on("session_start", (_event, ctx) => captureAndRender(ctx));
	pi.on("session_tree", (_event, ctx) => captureAndRender(ctx));

	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		clearTimeout(mcpRescanTimer);
		mcpRescanTimer = undefined;
		clearSlot(
			// SAFETY: clearSlot only touches ctx.ui.setStatus, guaranteed on ExtensionContext.
			ctx as unknown as {
				ui: { setStatus: (slot: string, text: string) => void };
			},
		);
		setFocusUnit(null);
		lastCtx = null;
		rawCtx = null;
	});

	// --- Wire slot to toolset events ---
	wireSlot(pi, () => lastCtx);

	// --- Install the slot's drift provider (the warning glyph) ---
	// Contract (freshness, totality, diagnostic-only): status-slot.ts. Site facts:
	// false before capture; each render pays one getAllTools pass + branch walk
	// (+ merged-defaults read in exclusion mode) — accepted, not memoized.
	setDriftProvider(() => {
		if (!rawCtx) return false;
		try {
			return computeDrift(pi, rawCtx.sessionManager.getBranch()).length > 0;
		} catch {
			return false;
		}
	});
}
