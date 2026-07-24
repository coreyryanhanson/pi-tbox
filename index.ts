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
import { autoRegisterBuiltinAndOrphans } from "./src/registry.js";
import {
	wireSlot,
	render,
	clearSlot,
	setFocusUnit,
} from "./src/status-slot.js";
import {
	formatBareHelp,
	formatList,
	formatStatus,
	parseArgs,
} from "./src/list.js";
import {
	toggleTool,
	toggleAll,
	loadDevModeFromSettings,
	resetDevMode,
	isDevMode,
} from "./src/toggle.js";
import { isReserved } from "./src/reserved.js";
import { actuateGroup, describeGroup, editGroup } from "./src/groups.js";

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
	let lastCtx: {
		ui: {
			setStatus: (slot: string, text: string) => void;
			theme: { fg: (color: string, text: string) => string };
		};
	} | null = null;

	// --- Register /tbox command handler ---
	pi.registerCommand("tbox", {
		description:
			"Cross-extension tool manager. Usage: /tbox [list|status|toggle|all|focus|chars|group] | /tbox <group> on|off",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				// Bind: Theme.fg reads `this.fgColors`; passing it unbound loses `this`.
				const slotText = formatBareHelp(
					pi,
					ctx.ui.theme.fg.bind(ctx.ui.theme) as (
						color: string,
						text: string,
					) => string,
				);
				ctx.ui.notify(slotText, "info");
				return;
			}

			const { command, rest } = parseArgs(trimmed);

			if (!command) {
				ctx.ui.notify(
					"Usage: /tbox [list|status|toggle|all|focus|chars|group] | /tbox <group> on|off",
					"info",
				);
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
				case "toggle": {
					const toolName = rest[1];
					if (!toolName) {
						ctx.ui.notify(
							"Usage: /tbox toggle <tool> — toggle a tool's containing toolset on/off.",
							"info",
						);
						break;
					}
					const dev = isDevMode();
					const result = toggleTool(pi, toolName, dev);
					const isErr =
						result.startsWith("Cannot") ||
						result.startsWith("Ambiguous") ||
						result.startsWith("No tool") ||
						result.startsWith("Multiple");
					ctx.ui.notify(result, isErr ? "error" : "info");
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
					// /tbox group <name> [on|off|edit]
					const name = rest[1];
					if (!name) {
						ctx.ui.notify(
							"Usage: /tbox group <name> [on|off|edit] — actuate or edit a named group.",
							"info",
						);
						break;
					}
					const sub = rest[2];
					if (sub === "on") {
						ctx.ui.notify(actuateGroup(pi, name, true), "info");
					} else if (sub === "off") {
						ctx.ui.notify(actuateGroup(pi, name, false), "info");
					} else if (sub === "edit") {
						ctx.ui.notify(await editGroup(name, ctx, isDevMode()), "info");
					} else {
						// Bare `/tbox group <name>` — report the group's units.
						ctx.ui.notify(describeGroup(name), "info");
					}
					break;
				}
				case "focus":
				case "chars": {
					// Reserved for Sprint 5 / Sprint 6. Because the name is
					// reserved, a group with this name is only reachable via
					// the explicit `/tbox group <name> on` form — point at it.
					ctx.ui.notify(
						`/tbox ${command} ships in a later sprint. If you meant a group named "${command}", use /tbox group ${command} on.`,
						"info",
					);
					break;
				}
				default: {
					// Group shorthand: `/tbox <name> on|off` where <name> is
					// NOT reserved. Reserved names dispatch to their
					// subcommand above; a group named e.g. `focus` is only
					// reachable via `/tbox group focus on`.
					if (isReserved(command)) {
						ctx.ui.notify(
							`Unknown subcommand: "${command}". Usage: /tbox [list|status|toggle|all|focus|chars|group] | /tbox <group> on|off`,
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
						ctx.ui.notify(
							`Usage: /tbox ${command} on | /tbox ${command} off — or /tbox group ${command} [on|off|edit].`,
							"info",
						);
					}
				}
			}
		},
	});

	// --- Session handlers ---

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Auto-register toolsets from the current tool population
		autoRegisterBuiltinAndOrphans(pi);

		// Read dev mode from `tbox.dev` in settings.json (re-read on /reload).
		// No /tbox dev command — edit settings.json and /reload to change.
		loadDevModeFromSettings();

		// Capture ctx for TOOLSET_EVENTS re-render
		lastCtx = ctx as unknown as {
			ui: {
				setStatus: (slot: string, text: string) => void;
				theme: { fg: (color: string, text: string) => string };
			};
		};

		// Render the slot at the END of the capture handler (§6 fix)
		render(pi, lastCtx);
	});

	pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
		// Re-run auto-registration for the fresh branch
		autoRegisterBuiltinAndOrphans(pi);

		// Re-read dev mode for the fresh branch
		loadDevModeFromSettings();

		// Capture ctx for TOOLSET_EVENTS re-render
		lastCtx = ctx as unknown as {
			ui: {
				setStatus: (slot: string, text: string) => void;
				theme: { fg: (color: string, text: string) => string };
			};
		};

		// Render the slot at the END of the capture handler (§6 fix)
		render(pi, lastCtx);
	});

	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		clearSlot(
			ctx as unknown as {
				ui: { setStatus: (slot: string, text: string) => void };
			},
		);
		setFocusUnit(null);
		resetDevMode();
		lastCtx = null;
	});

	// --- Wire slot to toolset events ---
	wireSlot(pi, () => lastCtx);
}
