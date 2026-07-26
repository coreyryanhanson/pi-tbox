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
	setFocusUnit,
	restoreFocusUnit,
} from "./src/status-slot.js";
import {
	formatBareHelp,
	formatList,
	formatStatus,
	parseArgs,
} from "./src/list.js";
import { toggleTool, toggleAll } from "./src/toggle.js";
import { isReserved } from "./src/reserved.js";
import {
	actuateGroup,
	describeGroup,
	editGroup,
	listGroups,
	describeToolset,
	actuateToolset,
} from "./src/groups.js";
import { removeGroup } from "./config/settings-reader.js";
import { focusUnit, focusOff } from "./src/focus.js";
import { formatChars } from "./src/chars.js";

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
			"Cross-extension tool manager. Usage: /tbox [list|status|toggle|all|focus|chars|group] | /tbox <group> on|off | /tbox +<toolset> on|off",
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
					"Usage: /tbox [list|status|toggle|all|focus|chars|group] | /tbox <group> on|off | /tbox +<toolset> on|off",
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
					const result = toggleTool(pi, toolName);
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
				case "chars": {
					ctx.ui.notify(formatChars(pi), "info");
					break;
				}
				case "focus": {
					const sub = rest[1];
					if (sub === "off") {
						ctx.ui.notify(focusOff(pi), "info");
					} else if (sub) {
						ctx.ui.notify(focusUnit(pi, sub), "info");
					} else {
						ctx.ui.notify(
							"Usage: /tbox focus <group> | /tbox focus +<toolset> | /tbox focus off — focus on a group or toolset.",
							"info",
						);
					}
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
					// names are validated at creation (no reserved words,
					// no `+`), the bare form always works.
					if (isReserved(command)) {
						ctx.ui.notify(
							`Unknown subcommand: "${command}". Usage: /tbox [list|status|toggle|all|focus|chars|group] | /tbox <group> on|off | /tbox +<toolset> on|off`,
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
							`Usage: /tbox ${command} on | /tbox ${command} off.`,
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
		const newIds = autoRegisterBuiltinAndOrphans(pi);

		// Actuate any toolsets registered in this call — the library's restore
		// handler already fired before they were registered, so they'd otherwise
		// never get their defaultEnabled state applied.
		actuateNewToolsets(pi, newIds);

		// Capture ctx for TOOLSET_EVENTS re-render
		lastCtx = ctx as unknown as {
			ui: {
				setStatus: (slot: string, text: string) => void;
				theme: { fg: (color: string, text: string) => string };
			};
		};

		// Restore the focus-unit label from the branch before rendering so
		// the `● focus:<unit>` glyph repaints on resume (Fix 2 — cosmetic).
		restoreFocusUnit(
			ctx as unknown as {
				sessionManager: { getBranch: () => unknown[] };
			},
		);

		// Render the slot at the END of the capture handler (§6 fix)
		render(pi, lastCtx);
	});

	pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
		// Re-run auto-registration for the fresh branch
		const newIds = autoRegisterBuiltinAndOrphans(pi);

		// Actuate any toolsets registered in this call (restore-timing fix)
		actuateNewToolsets(pi, newIds);

		// Capture ctx for TOOLSET_EVENTS re-render
		lastCtx = ctx as unknown as {
			ui: {
				setStatus: (slot: string, text: string) => void;
				theme: { fg: (color: string, text: string) => string };
			};
		};

		// Restore the focus-unit label from the branch before rendering so
		// the `● focus:<unit>` glyph repaints on resume (Fix 2 — cosmetic).
		restoreFocusUnit(
			ctx as unknown as {
				sessionManager: { getBranch: () => unknown[] };
			},
		);

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
		lastCtx = null;
	});

	// --- Wire slot to toolset events ---
	wireSlot(pi, () => lastCtx);
}
