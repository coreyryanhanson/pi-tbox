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
} from "./src/registry.js";
import {
	wireSlot,
	render,
	clearSlot,
	rerenderSlot,
	setFocusUnit,
	restoreFocusUnit,
	type SlotCtx,
} from "./src/status-slot.js";
import {
	formatBareHelp,
	formatByChars,
	formatList,
	formatStatus,
	parseArgs,
} from "./src/list.js";
import { isReserved } from "./src/reserved.js";
import {
	actuateGroup,
	describeGroup,
	editGroup,
	listGroups,
	describeToolset,
	actuateToolset,
	toggleAll,
} from "./src/groups.js";
import { removeGroup } from "./config/settings-reader.js";
import { focusUnit, focusOff, focusRelease, soloUnit } from "./src/focus.js";
import { handleDefaults } from "./src/defaults.js";

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
	let rerenderWired = false;

	const USAGE =
		"/tbox [list|status|all|focus|solo|group|chars|defaults] | /tbox <group> on|off | /tbox +<toolset> on|off";

	// --- Register /tbox command handler ---
	pi.registerCommand("tbox", {
		description: "Cross-extension tool manager. Usage: " + USAGE,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(formatBareHelp(), "info");
				return;
			}

			const { command, rest } = parseArgs(trimmed);

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
					const output = formatStatus(pi);
					ctx.ui.notify(output, "info");
					break;
				}
				case "all": {
					const sub = rest[1];
					if (sub === "on") {
						ctx.ui.notify(toggleAll(pi, true), "info");
					} else if (sub === "off") {
						ctx.ui.notify(toggleAll(pi, false), "info");
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
					if (sub === "edit") {
						ctx.ui.notify(await editGroup(name, ctx), "info");
					} else if (sub === "remove") {
						ctx.ui.notify(
							removeGroup(name)
								? `Group "${name}" removed.`
								: `No group named "${name}".`,
							"info",
						);
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
							"Usage: /tbox solo <group> | /tbox solo +<toolset> — everything off, one unit on. No lock: /tbox all on undoes it.",
							"info",
						);
						break;
					}
					ctx.ui.notify(soloUnit(pi, target), "info");
					break;
				}
				case "chars": {
					ctx.ui.notify(formatByChars(pi), "info");
					break;
				}
				case "focus": {
					const sub = rest[1];
					if (sub === "off") {
						ctx.ui.notify(focusOff(pi, ctx.sessionManager.getBranch()), "info");
					} else if (sub === "release") {
						ctx.ui.notify(focusRelease(pi), "info");
					} else if (sub) {
						ctx.ui.notify(focusUnit(pi, sub), "info");
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
				default: {
					// `+` prefix → toolset direct toggle
					if (command.startsWith("+")) {
						const toolsetId = command.slice(1);
						const sub = rest[1];
						if (sub === "on") {
							ctx.ui.notify(actuateToolset(pi, toolsetId, true), "info");
						} else if (sub === "off") {
							ctx.ui.notify(actuateToolset(pi, toolsetId, false), "info");
						} else {
							ctx.ui.notify(describeToolset(pi, toolsetId), "info");
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
						ctx.ui.notify(actuateGroup(pi, command, true), "info");
					} else if (sub === "off") {
						ctx.ui.notify(actuateGroup(pi, command, false), "info");
					} else {
						ctx.ui.notify(describeGroup(command), "info");
					}
				}
			}
		},
	});

	// --- Session handlers ---

	const captureAndRender = (ctx: ExtensionContext) => {
		const newIds = autoRegisterBuiltinAndOrphans(pi);
		actuateNewToolsets(pi, newIds);
		// SAFETY: SlotCtx is a structural subset of ExtensionContext (ui + sessionManager);
		// every field SlotCtx reads exists on the real context.
		lastCtx = ctx as unknown as SlotCtx;
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
			pi.on("before_agent_start", () => rerenderSlot(pi));
			rerenderWired = true;
		}
	};

	pi.on("session_start", (_event, ctx) => captureAndRender(ctx));
	pi.on("session_tree", (_event, ctx) => captureAndRender(ctx));

	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		// SAFETY: clearSlot only touches ctx.ui.setStatus, guaranteed on ExtensionContext.
		clearSlot(
			ctx as unknown as {
				ui: { setStatus: (slot: string, text: string) => void };
			},
		);
		setFocusUnit(null);
		lastCtx = null;
	});

	// --- Wire slot to toolset events ---
	wireSlot(pi, () => lastCtx);
}
