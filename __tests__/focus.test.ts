import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRegisteredToolsets,
	getDefaultResolutionMode,
} from "pi-tool-masking";
import { focusUnit, focusOff } from "../src/focus.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { toggleTool, toggleAll } from "../src/toggle.js";
import { actuateGroup } from "../src/groups.js";
import {
	computeSlotState,
	getFocusUnit,
	setFocusUnit,
	wireSlot,
	SLOT_NAME,
} from "../src/status-slot.js";
import { formatStatus } from "../src/list.js";
import { setSettingsOverrideForTests } from "../config/settings-reader.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function registerTools(mock: MockPI): void {
	for (let i = 0; i < 3; i++) {
		mock.registerTool({
			name: `lens-tool-${i}`,
			description: `Lens tool ${i}`,
			sourceInfo: {
				path: "pi-lens.ts",
				source: "pi-lens",
				scope: "user",
				origin: "top-level",
			},
		});
	}
	mock.registerTool({
		name: "my-tool",
		description: "My single tool",
		sourceInfo: {
			path: "my-plugin.ts",
			source: "my-plugin",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "read",
		description: "Read files",
		sourceInfo: {
			path: "builtin.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "bash",
		description: "Run bash commands",
		sourceInfo: {
			path: "builtin.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "custom-x",
		description: "Custom SDK tool",
		sourceInfo: {
			path: "sdk.ts",
			source: "sdk",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "web-fetch",
		description: "Web fetch tool",
		sourceInfo: {
			path: "portal.ts",
			source: "portal",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "browser-navigate",
		description: "Browser navigate tool",
		sourceInfo: {
			path: "portal.ts",
			source: "portal",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "page-read",
		description: "Page read tool",
		sourceInfo: {
			path: "portal.ts",
			source: "portal",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "web-learn",
		description: "Web learn tool",
		sourceInfo: {
			path: "portal.ts",
			source: "portal",
			scope: "user",
			origin: "top-level",
		},
	});
}

function defineFakeToolsets(mock: MockPI): void {
	mock.defineFakeToolset({
		id: "portal.web",
		label: "Portal Web",
		names: new Set(["web-fetch", "browser-navigate", "page-read"]),
		persistKey: "toolset-state:portal.web",
		defaultEnabled: true,
		masked: true,
	});
	mock.defineFakeToolset({
		id: "portal.learn",
		label: "Portal Learn",
		names: new Set(["web-learn"]),
		persistKey: "toolset-state:portal.learn",
		defaultEnabled: true,
		masked: false,
		requires: ["portal.web"],
	});
}

function enableAll(pi: ExtensionAPI): void {
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi);
	}
}

function setup(pi: ExtensionAPI, mock: MockPI): void {
	registerTools(mock);
	defineFakeToolsets(mock);
	autoRegisterBuiltinAndOrphans(pi);
	enableAll(pi);
	// Reset entries written during setup so tests see only focus writes
	mock.clearEntries();
	mock.clearUiRecords();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/tbox focus", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setSettingsOverrideForTests(null);
		setFocusUnit(null);
	});

	describe("guards", () => {
		it("rejects pi.builtin toolset", () => {
			setup(pi, mock);
			const result = focusUnit(pi, "pi.builtin");
			expect(result).toContain("out of tbox's scope");
		});

		it("errors on unknown input", () => {
			setup(pi, mock);
			const result = focusUnit(pi, "nope");
			expect(result).toContain("No toolset or group matching");
		});
	});

	describe("on a toolset", () => {
		it("enables target + cascade (deps + dependents), disables others", () => {
			setup(pi, mock);

			const result = focusUnit(pi, "portal.web");

			expect(result).toContain("portal.web");
			const active = new Set(pi.getActiveTools());

			// portal.web members are active
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("browser-navigate")).toBe(true);
			expect(active.has("page-read")).toBe(true);
			// portal.learn requires portal.web — the library's enable()
			// cascades both ways, so it stays on (cascaded from portal.web)
			expect(active.has("web-learn")).toBe(true);
			// orphan tools from other sources are disabled
			expect(active.has("lens-tool-0")).toBe(false);
			expect(active.has("lens-tool-1")).toBe(false);
			expect(active.has("lens-tool-2")).toBe(false);
			expect(active.has("my-tool")).toBe(false);

			// Inclusion mode is set
			expect(getDefaultResolutionMode(pi)).toBe("inclusion");
		});

		it("writes entries for disabled toolsets", () => {
			setup(pi, mock);

			focusUnit(pi, "portal.web");

			const entries = mock.getEntries();

			// Entries were written for disabled orphan toolsets
			const disabledKeys = entries
				.filter((e) => (e.data as Record<string, unknown>)?.enabled === false)
				.map((e) => e.customType);
			expect(disabledKeys.length).toBeGreaterThan(0);
			expect(disabledKeys).toContain("toolset-state:tbox.tool@pi-lens");
			expect(disabledKeys).toContain("toolset-state:tbox.tool@my-plugin");
		});
	});

	describe("on a group", () => {
		it("focuses the group's toolsets + forward/reverse closure", () => {
			setSettingsOverrideForTests({
				tbox: {
					groups: {
						mylearn: { toolsets: ["portal.learn"] },
					},
				},
			});
			setup(pi, mock);

			const result = focusUnit(pi, "mylearn");

			expect(result).toContain("group:mylearn");
			const active = new Set(pi.getActiveTools());

			// portal.learn + portal.web (requires closure) are active
			expect(active.has("web-learn")).toBe(true);
			expect(active.has("web-fetch")).toBe(true);
			// orphans are disabled
			expect(active.has("my-tool")).toBe(false);
		});

		it("errors on empty group", () => {
			setSettingsOverrideForTests({
				tbox: {
					groups: {
						empty: { toolsets: [] },
					},
				},
			});
			setup(pi, mock);

			const result = focusUnit(pi, "empty");
			expect(result).toContain("has no toolsets");
		});
	});

	describe("slot state", () => {
		it("shows green focus glyph when allowlist is non-empty", () => {
			setup(pi, mock);

			focusUnit(pi, "portal.web");

			const state = computeSlotState(pi);
			expect(state.kind).toBe("focus");
			if (state.kind === "focus") {
				expect(state.unit).toBe("portal.web");
			}
		});
	});

	// Regression: the TOOLSET_EVENTS.changed fanout fires synchronously inside
	// focusUnit's enable/disable loop and drives render() -> setStatus. If
	// setFocusUnit lands AFTER that loop, the slot paints a one-frame-stale
	// glyph: a count glyph on focus enter, and a focus glyph on focus off.
	// This wires the slot and asserts the LAST painted status is correct.
	describe("slot glyph does not lag the actuation (regression)", () => {
		it("focus enter paints the focus glyph, not a stale count glyph", () => {
			setup(pi, mock);
			wireSlot(
				pi,
				() =>
					({
						ui: mock.createCommandContext().ui as unknown as {
							setStatus: (slot: string, text: string) => void;
							theme: { fg: (color: string, text: string) => string };
						},
					}) as any,
			);
			mock.clearUiRecords();

			focusUnit(pi, "portal.web");

			const last = mock.getLastStatus(SLOT_NAME);
			expect(last).toBeDefined();
			// green focus glyph, not the blue count glyph `● tbox n`
			expect(last!.text).toContain("focus:portal.web");
			expect(last!.text).not.toContain("tbox ");
		});

		it("focus off paints a non-focus glyph, not a stale focus glyph", () => {
			setup(pi, mock);
			wireSlot(
				pi,
				() =>
					({
						ui: mock.createCommandContext().ui as unknown as {
							setStatus: (slot: string, text: string) => void;
							theme: { fg: (color: string, text: string) => string };
						},
					}) as any,
			);
			focusUnit(pi, "portal.web");
			mock.clearUiRecords();

			focusOff(pi);

			const last = mock.getLastStatus(SLOT_NAME);
			expect(last).toBeDefined();
			expect(last!.text).not.toContain("focus:");
		});
	});

	describe("mutual exclusion with actuation commands", () => {
		it("refuses toggleTool while focused", () => {
			setup(pi, mock);
			focusUnit(pi, "portal.web");

			const msg = toggleTool(pi, "web-learn");
			expect(msg).toContain("Cannot toggle while in focus mode");
			expect(msg).toContain("/tbox focus off");
		});

		it("refuses toggleAll on/off while focused", () => {
			setup(pi, mock);
			focusUnit(pi, "portal.web");

			const msgOn = toggleAll(pi, true);
			expect(msgOn).toContain("Cannot enable all toolsets while in focus mode");
			expect(msgOn).toContain("/tbox focus off");

			const msgOff = toggleAll(pi, false);
			expect(msgOff).toContain(
				"Cannot disable all toolsets while in focus mode",
			);
			expect(msgOff).toContain("/tbox focus off");
		});

		it("refuses actuateGroup while focused", () => {
			setSettingsOverrideForTests({
				tbox: { groups: { webgroup: { toolsets: ["portal.web"] } } },
			});
			setup(pi, mock);
			focusUnit(pi, "portal.web");

			const msg = actuateGroup(pi, "webgroup", true);
			expect(msg).toContain("Cannot enable a group while in focus mode");
			expect(msg).toContain("/tbox focus off");
		});

		it("allows actuation commands after focus off", () => {
			setup(pi, mock);
			focusUnit(pi, "portal.web");
			focusOff(pi);

			// toggle should now work
			const msg = toggleTool(pi, "web-learn");
			expect(msg).toContain('Disabled "web-learn"');
		});
	});

	describe("focus off (re-actuation)", () => {
		it("restores every toolset to defaultEnabled and sets exclusion mode", () => {
			setup(pi, mock);

			// Enter focus
			focusUnit(pi, "portal.web");
			expect(getDefaultResolutionMode(pi)).toBe("inclusion");

			// Exit focus
			const result = focusOff(pi);

			expect(result).toContain("Focus off");
			expect(getDefaultResolutionMode(pi)).toBe("exclusion");
			expect(getFocusUnit()).toBeNull();

			// All extension toolsets back to defaultEnabled
			const active = new Set(pi.getActiveTools());
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("web-learn")).toBe(true);
			expect(active.has("lens-tool-0")).toBe(true);
			expect(active.has("my-tool")).toBe(true);
			// Builtins are platform-managed — not in tbox's toolset registry
		});

		it("overwrites focus-era disabled entries with default-enabled entries", () => {
			setup(pi, mock);

			focusUnit(pi, "portal.web");

			// During focus, orphan toolset was disabled (entry has enabled:false)
			const orphanKey = "toolset-state:tbox.tool@pi-lens";
			const focusDisable = mock
				.getEntries()
				.find((e) => e.customType === orphanKey);
			expect(focusDisable).toBeDefined();
			expect((focusDisable!.data as Record<string, unknown>)?.enabled).toBe(
				false,
			);

			// Clear entries so we only see focus-off writes
			mock.clearEntries();

			focusOff(pi);

			// The orphan toolset should have been re-enabled
			const exitEntries = mock.getEntries();
			const exitEnable = exitEntries.find((e) => e.customType === orphanKey);
			expect(exitEnable).toBeDefined();
			expect((exitEnable!.data as Record<string, unknown>)?.enabled).toBe(true);
		});
	});

	describe("drift-free", () => {
		it("new toolset defaults to off under focus (inclusion mode)", () => {
			setup(pi, mock);

			// Enter focus
			focusUnit(pi, "portal.web");

			// Simulate a new toolset being registered (like a freshly installed extension)
			mock.registerTool({
				name: "new-tool",
				description: "Newly installed tool",
				sourceInfo: {
					path: "new.ts",
					source: "new-plugin",
					scope: "user",
					origin: "top-level",
				},
			});
			mock.defineFakeToolset({
				id: "new-plugin",
				label: "New Plugin",
				names: new Set(["new-tool"]),
				persistKey: "toolset-state:new-plugin",
				defaultEnabled: true,
				masked: false,
			});
			autoRegisterBuiltinAndOrphans(pi);

			// Fire a restore event — under inclusion mode, unknown toolsets default off
			mock.emit("toolset:restored", {});

			// The new tool should be off (inclusion mode)
			const active = new Set(pi.getActiveTools());
			expect(active.has("new-tool")).toBe(false);
			// focus tools + cascaded stay on
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("web-learn")).toBe(true);
		});

		it("after focus off, new toolset respects defaultEnabled under exclusion", () => {
			setup(pi, mock);

			// Enter + exit focus
			focusUnit(pi, "portal.web");
			focusOff(pi);

			// Simulate a new toolset
			mock.registerTool({
				name: "new-tool",
				description: "Newly installed tool",
				sourceInfo: {
					path: "new.ts",
					source: "new-plugin",
					scope: "user",
					origin: "top-level",
				},
			});
			mock.defineFakeToolset({
				id: "new-plugin",
				label: "New Plugin",
				names: new Set(["new-tool"]),
				persistKey: "toolset-state:new-plugin",
				defaultEnabled: true,
				masked: false,
			});
			autoRegisterBuiltinAndOrphans(pi);

			// Activate the new toolset (simulating what happens at registration)
			const registry = getRegisteredToolsets();
			const newEntry = registry.find((e) => e.spec.id === "new-plugin");
			newEntry!.toolset.enable(pi);
			mock.clearEntries();

			// Fire a restore — under exclusion mode, defaultEnabled wins
			mock.emit("toolset:restored", {});

			const active = new Set(pi.getActiveTools());
			expect(active.has("new-tool")).toBe(true);
		});
	});

	describe("status command reflects focus", () => {
		it("/tbox status shows focus line when focused", () => {
			setup(pi, mock);

			focusUnit(pi, "portal.web");

			const output = formatStatus(pi);
			expect(output).toContain("Focus: on");
			expect(output).toContain("portal.web");
		});

		it("/tbox status shows focus off when not focused", () => {
			setup(pi, mock);

			const output = formatStatus(pi);
			expect(output).toContain("Focus: off");
		});
	});
});
