import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getEffectiveDefault,
	getRegisteredToolsets,
	getDefaultResolutionMode,
	readMergedToolsetDefaults,
	setSettingsOverrideForTests,
} from "pi-tool-masking";
import { focusUnit, focusOff } from "../src/focus.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { actuateGroup, actuateToolset, toggleAll } from "../src/groups.js";
import {
	computeSlotState,
	getFocusUnit,
	setFocusUnit,
	wireSlot,
	SLOT_NAME,
} from "../src/status-slot.js";
import { formatStatus } from "../src/list.js";
import { setGroupsOverrideForTests } from "../config/settings-reader.js";

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
	});
	mock.defineFakeToolset({
		id: "portal.learn",
		label: "Portal Learn",
		names: new Set(["web-learn"]),
		persistKey: "toolset-state:portal.learn",
		defaultEnabled: true,
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
		setSettingsOverrideForTests({});
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setGroupsOverrideForTests(null);
		setFocusUnit(null);
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
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
			expect(result).toContain("No group matching");
		});
	});

	describe("on a toolset", () => {
		it("enables target + forward-closure deps, disables dependents and others", () => {
			setup(pi, mock);

			const result = focusUnit(pi, "+portal.web");

			expect(result).toContain("portal.web");
			const active = new Set(pi.getActiveTools());

			// portal.web members are active
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("browser-navigate")).toBe(true);
			expect(active.has("page-read")).toBe(true);
			// portal.learn requires portal.web but is NOT in the allowlist —
			// the library's enable cascade is forward-only (deps), so focusing
			// portal.web does not pull its dependents in. The second pass
			// disables it. Matches /tbox +portal.web on behaviour.
			expect(active.has("web-learn")).toBe(false);
			// orphan tools from other sources are disabled
			expect(active.has("lens-tool-0")).toBe(false);
			expect(active.has("lens-tool-1")).toBe(false);
			expect(active.has("lens-tool-2")).toBe(false);
			expect(active.has("my-tool")).toBe(false);

			// Inclusion mode is set
			expect(getDefaultResolutionMode()).toBe("inclusion");
		});

		it("writes entries for disabled toolsets", () => {
			setup(pi, mock);

			focusUnit(pi, "+portal.web");

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
		it("focuses the group's toolsets + forward requires closure", () => {
			setGroupsOverrideForTests({
				mylearn: { toolsets: ["portal.learn"] },
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
			setGroupsOverrideForTests({
				empty: { toolsets: [] },
			});
			setup(pi, mock);

			const result = focusUnit(pi, "empty");
			expect(result).toContain("has no toolsets");
		});
	});

	describe("slot state", () => {
		it("shows green focus glyph when allowlist is non-empty", () => {
			setup(pi, mock);

			focusUnit(pi, "+portal.web");

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

			focusUnit(pi, "+portal.web");

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
			focusUnit(pi, "+portal.web");
			mock.clearUiRecords();

			focusOff(pi);

			const last = mock.getLastStatus(SLOT_NAME);
			expect(last).toBeDefined();
			expect(last!.text).not.toContain("focus:");
		});
	});

	describe("mutual exclusion with actuation commands", () => {
		it("refuses actuateToolset while focused", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");

			const msg = actuateToolset(pi, "portal.web", true);
			expect(msg).toContain("Cannot enable a toolset while in focus mode");
			expect(msg).toContain("/tbox focus off");
		});

		it("refuses toggleAll on/off while focused", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");

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
			setGroupsOverrideForTests({
				webgroup: { toolsets: ["portal.web"] },
			});
			setup(pi, mock);
			focusUnit(pi, "+portal.web");

			const msg = actuateGroup(pi, "webgroup", true);
			expect(msg).toContain("Cannot enable a group while in focus mode");
			expect(msg).toContain("/tbox focus off");
		});

		it("allows actuation commands after focus off", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");
			focusOff(pi);

			// direct toolset actuation should now work
			const msg = actuateToolset(pi, "portal.learn", false);
			expect(msg).toContain('Disabled toolset "portal.learn"');
		});
	});

	describe("focus off (re-actuation)", () => {
		it("restores every toolset to defaultEnabled and sets exclusion mode", () => {
			setup(pi, mock);

			// Enter focus
			focusUnit(pi, "+portal.web");
			expect(getDefaultResolutionMode()).toBe("inclusion");

			// Exit focus
			const result = focusOff(pi);

			expect(result).toContain("Focus off");
			expect(getDefaultResolutionMode()).toBe("exclusion");
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

			focusUnit(pi, "+portal.web");

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

		it("settings-pinned-off overrides defaultEnabled true in focusOff", () => {
			setup(pi, mock);

			// Create an independent toolset (no requires edges) with defaultEnabled: true
			mock.registerTool({
				name: "pin-off-test",
				description: "Pin off test tool",
				sourceInfo: {
					path: "test.ts",
					source: "pin-off-test",
					scope: "user",
					origin: "top-level",
				},
			});
			const key = "toolset-state:pin-off-test";
			mock.defineFakeToolset({
				id: "pin-off-test",
				names: new Set(["pin-off-test"]),
				persistKey: key,
				defaultEnabled: true,
			});

			// Enable it
			const entry = getRegisteredToolsets().find(
				(e) => e.spec.id === "pin-off-test",
			)!;
			entry.toolset.enable(pi);
			expect(pi.getActiveTools()).toContain("pin-off-test");

			// Pin it off via settings override
			setSettingsOverrideForTests({ [key]: { enabled: false } });
			expect(getEffectiveDefault(entry.spec, readMergedToolsetDefaults())).toBe(
				false,
			);

			const result = focusOff(pi);
			expect(result).toContain("Focus off");

			// Should now be off despite defaultEnabled: true
			expect(pi.getActiveTools()).not.toContain("pin-off-test");
		});

		it("settings-pinned-on overrides defaultEnabled false in focusOff", () => {
			setup(pi, mock);

			// Register a tool and define a toolset with defaultEnabled: false
			mock.registerTool({
				name: "test-pin-on",
				description: "Test tool",
				sourceInfo: {
					path: "test.ts",
					source: "test-pin-on",
					scope: "user",
					origin: "top-level",
				},
			});
			const key = "toolset-state:test-pin-on";
			mock.defineFakeToolset({
				id: "test-pin-on",
				names: new Set(["test-pin-on"]),
				persistKey: key,
				defaultEnabled: false,
			});

			// Enable it manually so it starts on
			const entry = getRegisteredToolsets().find(
				(e) => e.spec.id === "test-pin-on",
			);
			entry!.toolset.enable(pi);
			expect(pi.getActiveTools()).toContain("test-pin-on");

			// Pin it on via settings override
			setSettingsOverrideForTests({ [key]: { enabled: true } });

			const result = focusOff(pi);
			expect(result).toContain("Focus off");

			// Should stay on despite defaultEnabled: false
			expect(pi.getActiveTools()).toContain("test-pin-on");
		});
	});

	describe("drift-free", () => {
		it("new toolset defaults to off under focus (inclusion mode)", () => {
			setup(pi, mock);

			// Enter focus
			focusUnit(pi, "+portal.web");

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
			});
			autoRegisterBuiltinAndOrphans(pi);

			// Fire a restore event — under inclusion mode, unknown toolsets default off
			mock.emit("toolset:restored", {});

			// The new tool should be off (inclusion mode)
			const active = new Set(pi.getActiveTools());
			expect(active.has("new-tool")).toBe(false);
			// focus tools stay on; portal.learn was not in the allowlist so it
			// was disabled by focus and stays off on restore
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("web-learn")).toBe(false);
		});

		it("after focus off, new toolset respects defaultEnabled under exclusion", () => {
			setup(pi, mock);

			// Enter + exit focus
			focusUnit(pi, "+portal.web");
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

		it("already-enabled allowlisted toolset persists entry so it survives inclusion-mode restore", () => {
			setup(pi, mock);

			// Focus +portal.web when portal.web is already enabled. Focus
			// skips calling enable() on it, but must still persist
			// {enabled:true} so inclusion-mode restore keeps it on.
			// portal.learn (requires portal.web) is NOT in the allowlist —
			// focus disables it and persists {enabled:false}.

			// Confirm pre-state: both already enabled
			expect(new Set(pi.getActiveTools()).has("web-fetch")).toBe(true);
			expect(new Set(pi.getActiveTools()).has("web-learn")).toBe(true);

			// Clear entries so focus writes fresh ones
			mock.clearEntries();

			focusUnit(pi, "+portal.web");

			// portal.web must have a persisted {enabled:true} entry even
			// though focus didn't toggle it
			const webEntries = mock
				.getEntries()
				.filter((e) => e.customType === "toolset-state:portal.web");
			expect(webEntries.length).toBeGreaterThan(0);
			const lastWeb = webEntries[webEntries.length - 1]!.data as Record<
				string,
				unknown
			>;
			expect(lastWeb?.enabled).toBe(true);

			// Simulate restore (fresh globalThis, no in-memory mode)
			mock.emit("toolset:restored", {});

			const active = new Set(pi.getActiveTools());
			expect(active.has("web-fetch")).toBe(true);
			// portal.learn was disabled by focus and stays off on restore
			expect(active.has("web-learn")).toBe(false);
		});
	});

	describe("status command reflects focus", () => {
		it("/tbox status shows focus line when focused", () => {
			setup(pi, mock);

			focusUnit(pi, "+portal.web");

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
