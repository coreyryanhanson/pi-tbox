/**
 * pi-tbox — Cross-extension tool manager for Pi
 *
 * Registers the /tbox command, the tbox status slot, and auto-registers
 * pi.builtin + tbox.orphans toolsets at load.
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
import { toggleTool, toggleAll, setDevMode, isDevMode } from "./src/toggle.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Default extension factory — called by pi's loader.
 *
 * Registers:
 *   - /tbox command
 *   - tbox status slot (wired to lifecycle events)
 *   - Auto-registration of pi.builtin + tbox.orphans on session_start
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
			"Cross-extension tool manager. Usage: /tbox [list|status|toggle|all|dev|focus|chars|group]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				const slotText = formatBareHelp(
					pi,
					ctx.ui.theme.fg as (color: string, text: string) => string,
				);
				ctx.ui.notify(slotText, "info");
				return;
			}

			const { command, rest } = parseArgs(trimmed);

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
				case "dev": {
					const sub = rest[1];
					if (sub === "on") {
						setDevMode(true);
						ctx.ui.notify(
							"Dev mode enabled. Builtin and masked-member guards are lifted.",
							"info",
						);
					} else if (sub === "off") {
						setDevMode(false);
						ctx.ui.notify(
							"Dev mode disabled. Builtin and masked-member guards are restored.",
							"info",
						);
					} else {
						ctx.ui.notify(
							`Dev mode is currently ${isDevMode() ? "on" : "off"}.`,
							"info",
						);
					}
					break;
				}
				default: {
					ctx.ui.notify(
						`Unknown subcommand: "${command}". Usage: /tbox [list|status|toggle|all|dev|focus|chars|group]`,
						"error",
					);
				}
			}
		},
	});

	// --- Session handlers ---

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Auto-register toolsets from the current tool population
		autoRegisterBuiltinAndOrphans(pi);

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
		setDevMode(false);
		lastCtx = null;
	});

	// --- Wire slot to toolset events ---
	wireSlot(pi, () => lastCtx);
}
