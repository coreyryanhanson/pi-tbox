import { describe, it, expect, beforeEach } from "vitest";
import {
	MockPI,
	branchOf,
	pinSettingsDefaultsForTests,
	readerOf,
	setupCycle,
	useTempAgentDir,
} from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	readBranchModeState,
	type BranchReader,
	getEffectiveDefault,
	getRegisteredToolsets,
	readMergedToolsetDefaults,
	setDefaultResolutionMode,
} from "pi-tool-masking";
import {
	focusUnit,
	focusOff,
	focusRelease,
} from "../src/focus.js";
import {
	autoRegisterBuiltinAndOrphans,
	actuateNewToolsets,
} from "../src/registry.js";
import { actuateGroup, actuateToolset, toggleAll } from "../src/groups.js";
import {
	computeSlotState,
	getFocusUnit,
	setFocusUnit,
	wireSlot,
	SLOT_NAME,
	FOCUS_PERSIST_KEY,
} from "../src/status-slot.js";
import { formatStatus } from "../src/list.js";
import { setGroupsOverrideForTests } from "../config/settings-reader.js";

// File-wide temp settings dirs — never touches the developer's ~/.pi.
useTempAgentDir();

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

function enableAll(pi: ExtensionAPI, sessionManager: BranchReader): void {
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi, sessionManager);
	}
}

function setup(pi: ExtensionAPI, mock: MockPI): void {
	registerTools(mock);
	defineFakeToolsets(mock);
	autoRegisterBuiltinAndOrphans(pi);
	enableAll(pi, readerOf(mock));
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
		setGroupsOverrideForTests(null);
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
			expect(result).toContain("No group matching");
		});
	});

	describe("on a toolset", () => {
		it("enables target + forward-closure deps, disables dependents and others", () => {
			setup(pi, mock);

			const result = focusUnit(pi, "+portal.web");

			expect(result).toContain("portal.web");
			expect(result).toContain("— allowlist of 1 toolset.");
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

			// Allowlist mode is set with the forward-closure-resolved ids
			expect(readBranchModeState(readerOf(mock).getBranch()).mode).toBe("allowlist");
			expect(readBranchModeState(readerOf(mock).getBranch()).allowlist).toEqual(["portal.web"]);
		});

		it("writes no per-toolset entries during enter — the allowlist array is the authority", () => {
			setup(pi, mock);

			focusUnit(pi, "+portal.web");

			// The allowlist lives in the branch mode entry, not in
			// per-toolset entries (no {enabled:false} pins for the disabled).
			const entries = mock.getEntries();
			expect(
				entries.filter((e) => e.customType.startsWith("toolset-state:")),
			).toHaveLength(0);

			// The authority is the mode entry's allowlist array.
			expect(readBranchModeState(readerOf(mock).getBranch()).mode).toBe("allowlist");
			expect(readBranchModeState(readerOf(mock).getBranch()).allowlist).toEqual(["portal.web"]);
		});

		it("preserves non-toolset tools (not owned by any toolset)", () => {
			setup(pi, mock);

			// Seed a non-toolset tool (the sdk tool) into the active set
			mock.setActiveTools([...pi.getActiveTools(), "custom-x"]);
			expect(pi.getActiveTools()).toContain("custom-x");

			focusUnit(pi, "+portal.web");

			const active = new Set(pi.getActiveTools());
			// forceToolsetEnabled is a per-spec delta — only each spec's own
			// names move, so tools outside the registry survive focus.
			expect(active.has("custom-x")).toBe(true);
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("web-learn")).toBe(false);
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
			expect(readBranchModeState(readerOf(mock).getBranch()).allowlist).toEqual(["portal.learn", "portal.web"]);
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

			focusOff(pi, branchOf(mock));

			const last = mock.getLastStatus(SLOT_NAME);
			expect(last).toBeDefined();
			expect(last!.text).not.toContain("focus:");
		});
	});

	describe("mutual exclusion with actuation commands", () => {
		it("refuses actuateToolset while focused", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");

			const msg = actuateToolset(pi, "portal.web", true, readerOf(mock));
			expect(msg).toContain("Cannot enable a toolset while in focus mode");
			expect(msg).toContain("/tbox focus off");
		});

		it("refuses toggleAll on/off while focused", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");

			const msgOn = toggleAll(pi, true, readerOf(mock));
			expect(msgOn).toContain("Cannot enable all toolsets while in focus mode");
			expect(msgOn).toContain("/tbox focus off");

			const msgOff = toggleAll(pi, false, readerOf(mock));
			expect(msgOff).toContain("Cannot disable all toolsets while in focus mode");
			expect(msgOff).toContain("/tbox focus off");
		});

		it("refuses actuateGroup while focused", () => {
			setGroupsOverrideForTests({
				webgroup: { toolsets: ["portal.web"] },
			});
			setup(pi, mock);
			focusUnit(pi, "+portal.web");

			const msg = actuateGroup(pi, "webgroup", true, readerOf(mock));
			expect(msg).toContain("Cannot enable a group while in focus mode");
			expect(msg).toContain("/tbox focus off");
		});

		it("allows actuation commands after focus off", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");
			focusOff(pi, branchOf(mock));

			// direct toolset actuation should now work
			const msg = actuateToolset(pi, "portal.learn", false, readerOf(mock));
			expect(msg).toContain('Disabled toolset "portal.learn"');
		});
	});

	describe("focus off (re-actuation)", () => {
		it("restores every toolset to defaultEnabled and sets exclusion mode", () => {
			setup(pi, mock);

			// Enter focus
			focusUnit(pi, "+portal.web");
			expect(readBranchModeState(readerOf(mock).getBranch()).mode).toBe("allowlist");

			// Exit focus
			const result = focusOff(pi, branchOf(mock));

			expect(result).toContain("Focus off");
			expect(readBranchModeState(readerOf(mock).getBranch()).mode).toBe("exclusion");
			expect(getFocusUnit()).toBeNull();

			// All extension toolsets back to defaultEnabled
			const active = new Set(pi.getActiveTools());
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("web-learn")).toBe(true);
			expect(active.has("lens-tool-0")).toBe(true);
			expect(active.has("my-tool")).toBe(true);
			// Builtins are platform-managed — not in tbox's toolset registry
		});

		it("focusOff must re-actuate — a bare mode flip leaves stale pre-focus entries live", () => {
			setup(pi, mock);

			// Pre-focus manual toggle: disable the pi-lens orphan toolset.
			// This writes a {enabled:false} branch entry that survives into
			// focus (allowlist enter writes no per-toolset entries).
			const orphanEntry = getRegisteredToolsets().find(
				(e) => e.spec.id === "tbox.tool@pi-lens",
			)!;
			orphanEntry.toolset.disable(pi, readerOf(mock));

			focusUnit(pi, "+portal.web");
			expect(orphanEntry.toolset.isEnabled(pi)).toBe(false);

			// The BUGGY path: flip the mode only — no tombstone, no
			// re-actuation.
			setDefaultResolutionMode(pi, "exclusion");

			// /reload replays the branch: the stale {enabled:false} entry
			// wins over the exclusion floor, so the orphan stays off even
			// though its effective default is on. Meanwhile a toolset with
			// no entry (portal.web) comes back on — proving restore ran and
			// the difference is the stale entry.
			mock.fireLifecycleEvent("session_start");
			expect(orphanEntry.toolset.isEnabled(pi)).toBe(false);
			expect(pi.getActiveTools()).toContain("web-fetch");

			// The CORRECT path: focusOff tombstones the stale entry and
			// re-actuates every toolset to getEffectiveDefault — the orphan
			// comes back on, and /reload now lands at the default too.
			focusOff(pi, branchOf(mock));
			expect(orphanEntry.toolset.isEnabled(pi)).toBe(true);

			mock.fireLifecycleEvent("session_start");
			expect(orphanEntry.toolset.isEnabled(pi)).toBe(true);
		});

		it("focusOff does not cascade a pinned-off dependency back on", () => {
			setup(pi, mock);

			// portal.learn requires portal.web (defaults: both on). Pin the
			// dependency off — focusOff must apply the dependent ON without
			// cascading the pin away (forceToolsetEnabled is the no-cascade
			// path; the old enable()-based loop re-enabled the dep via the
			// forward requires cascade).
			pinSettingsDefaultsForTests({
				"toolset-state:portal.web": { enabled: false },
			});

			focusOff(pi, branchOf(mock));

			expect(pi.getActiveTools()).not.toContain("web-fetch");
			expect(pi.getActiveTools()).toContain("web-learn");
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
			entry.toolset.enable(pi, readerOf(mock));
			expect(pi.getActiveTools()).toContain("pin-off-test");

			// Pin it off via a settings pin
			pinSettingsDefaultsForTests({ [key]: { enabled: false } });
			expect(getEffectiveDefault(entry.spec, readMergedToolsetDefaults())).toBe(
				false,
			);

			const result = focusOff(pi, branchOf(mock));
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
			entry!.toolset.enable(pi, readerOf(mock));
			expect(pi.getActiveTools()).toContain("test-pin-on");

			// Pin it on via a settings pin
			pinSettingsDefaultsForTests({ [key]: { enabled: true } });

			const result = focusOff(pi, branchOf(mock));
			expect(result).toContain("Focus off");

			// Should stay on despite defaultEnabled: false
			expect(pi.getActiveTools()).toContain("test-pin-on");
		});
	});

	describe("drift-free", () => {
		it("new toolset defaults to off under focus (allowlist mode)", () => {
			setup(pi, mock);

			// Enter focus
			focusUnit(pi, "+portal.web");

			// Simulate a new toolset being registered (like a freshly installed
			// extension) mid-focus. The allowlist array is the authority: it was
			// fixed at focus-enter, so the new toolset is not in it → off.
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
			actuateNewToolsets(pi, ["new-plugin"], readerOf(mock).getBranch());

			// The new tool should be off — not in the allowlist
			const active = new Set(pi.getActiveTools());
			expect(active.has("new-tool")).toBe(false);
			// focus tools stay on; portal.learn was not in the allowlist so
			// it is off too
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("web-learn")).toBe(false);
		});

		it("after focus off, new toolset respects defaultEnabled under exclusion", () => {
			setup(pi, mock);

			// Enter + exit focus
			focusUnit(pi, "+portal.web");
			focusOff(pi, branchOf(mock));

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
			newEntry!.toolset.enable(pi, readerOf(mock));
			mock.clearEntries();

			// Fire a restore — under exclusion mode, defaultEnabled wins
			mock.fireLifecycleEvent("session_start");

			const active = new Set(pi.getActiveTools());
			expect(active.has("new-tool")).toBe(true);
		});
	});

	describe("focus release (retain live set)", () => {
		/** Release's delta shape: the tier-consistent member writes no
		 *  entry; every drifting non-member gets {enabled:false}. */
		function expectReleaseEntries(memberId: string): void {
			// Delta gate: entries exist only where the pre-release tier
			// resolution disagreed with the selection. The member's tier
			// (portal.web: default on) already resolves on → no entry
			// (no stale pin — a later settings pin applies); every
			// non-member defaults on → drifts to off → {enabled:false}.
			// A /reload re-resolves the same selection either way.
			const entries = mock.getEntries();
			for (const entry of getRegisteredToolsets()) {
				const last = entries
					.filter((e) => e.customType === entry.spec.persistKey)
					.at(-1);
				if (entry.spec.id === memberId) {
					expect(last).toBeUndefined();
				} else {
					expect(last).toBeDefined();
					const enabled = (last!.data as Record<string, unknown> | null)?.enabled;
					expect(enabled).toBe(false);
				}
			}
		}

		it("writes drifted ids to per-toolset entries and keeps live state", () => {
			setup(pi, mock);

			focusUnit(pi, "+portal.web");

			const result = focusRelease(pi, readerOf(mock));

			expect(result).toContain("Focus released");
			expect(readBranchModeState(readerOf(mock).getBranch()).mode).toBe("exclusion");
			expect(getFocusUnit()).toBeNull();

			// Live state unchanged from the focus era
			const active = new Set(pi.getActiveTools());
			expect(active.has("web-fetch")).toBe(true);
			expect(active.has("web-learn")).toBe(false);
			expect(active.has("lens-tool-0")).toBe(false);

			expectReleaseEntries("portal.web");

			// /reload replays the flushed entries — the selection survives
			mock.fireLifecycleEvent("session_start");
			const reloaded = new Set(pi.getActiveTools());
			expect(reloaded.has("web-fetch")).toBe(true);
			expect(reloaded.has("web-learn")).toBe(false);
			expect(reloaded.has("lens-tool-0")).toBe(false);
		});

		it("foreign allowlist governance is released deliberately (teardown, not no-op)", () => {
			// A foreign extension enters allowlist mode mid-session via
			// setDefaultResolutionMode — never touching tbox's focus mirror.
			// The old restore-time mirror would no-op the release by
			// staleness; the live branch read sees the mode and release
			// proceeds: an explicitly commanded teardown ends the foreign
			// governance and flushes a clean slate.
			setup(pi, mock);
			setDefaultResolutionMode(pi, "allowlist", ["portal.web"]);
			expect(getFocusUnit()).toBeNull(); // foreign — tbox's mirror untouched

			const result = focusRelease(pi, readerOf(mock));

			expect(result).toContain("Focus released");
			expect(readBranchModeState(readerOf(mock).getBranch()).mode).toBe(
				"exclusion",
			);
			expectReleaseEntries("portal.web");
			// A /reload lands at the flushed selection.
			mock.fireLifecycleEvent("session_start");
			const reloaded = new Set(pi.getActiveTools());
			expect(reloaded.has("web-fetch")).toBe(true);
			expect(reloaded.has("web-learn")).toBe(false);
		});

		it("without active focus returns the hint and mutates nothing", () => {
			setup(pi, mock);
			mock.clearEntries();

			const result = focusRelease(pi, readerOf(mock));

			expect(result).toBe(
				"Focus is not active. Nothing to release.",
			);
			// No per-toolset entries written, mode unchanged, nothing disabled
			expect(mock.getEntries()).toHaveLength(0);
			expect(readBranchModeState(readerOf(mock).getBranch()).mode).toBe("exclusion");
			expect(pi.getActiveTools()).toContain("web-fetch");
			expect(pi.getActiveTools()).toContain("web-learn");
		});
	});

	// The planner-path release contract: refusals compensate (resolved state
	// is exactly the pre-release state), the corrupt-entry class refuses
	// up-front before any mutation, and release carries the planner's
	// delta/repair/emit semantics instead of the old raw full-partition
	// appendEntry flush.
	describe("focus release via the planner — refusals and compensation", () => {
		function lastEntryFor(key: string) {
			return mock.getEntries().filter((e) => e.customType === key).at(-1);
		}

		/** Refusal compensation contract: the pre-release allowlist mode
		 *  entry is re-appended and no per-toolset entries were written. */
		function expectCompensatedTo(allowlist: string[]): void {
			expect(lastEntryFor("toolset-resolution-mode")?.data).toEqual({
				mode: "allowlist",
				allowlist,
			});
			expect(
				mock
					.getEntries()
					.filter((e) => e.customType.startsWith("toolset-state:")),
			).toHaveLength(0);
		}

		function collectChanged(): { id: string; enabled: boolean }[] {
			const changed: { id: string; enabled: boolean }[] = [];
			mock.events.on("toolset:changed", (data: unknown) =>
				changed.push(data as { id: string; enabled: boolean }),
			);
			return changed;
		}

		/** Catch and return the thrown error's name (seam-matching shape). */
		function catchName(flow: () => unknown): string | undefined {
			try {
				flow();
			} catch (err) {
				return (err as { name?: string })?.name;
			}
			return undefined;
		}

		it("strips tools force-added to non-member toolsets within the turn", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");

			// A foreign extension force-adds one tool per non-member toolset
			// within the turn — the release batch must strip them all.
			mock.setActiveTools([
				...pi.getActiveTools(),
				"web-learn",
				"lens-tool-0",
				"my-tool",
			]);

			focusRelease(pi, readerOf(mock));

			// Every force-added tool gone, the member untouched.
			const final = new Set(pi.getActiveTools());
			expect(final.has("web-learn")).toBe(false);
			expect(final.has("lens-tool-0")).toBe(false);
			expect(final.has("my-tool")).toBe(false);
			expect(final.has("web-fetch")).toBe(true);
		});

		it("repair arm: a tier-consistent id whose tools were force-removed still gets its entry", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");

			// Force-remove the member's own tool within the turn. portal.web's
			// tier already resolves on (no drift), but the loadout writes — so
			// the batch persists {enabled:true}, making the correction durable
			// (a later settings pin cannot silently un-retain the selection).
			mock.setActiveTools(pi.getActiveTools().filter((n) => n !== "web-fetch"));
			expect(pi.getActiveTools()).not.toContain("web-fetch");

			focusRelease(pi, readerOf(mock));

			const last = lastEntryFor("toolset-state:portal.web");
			expect(last).toBeDefined();
			expect((last!.data as Record<string, unknown>).enabled).toBe(true);

			// /reload replays the repair-arm entry — the member comes back on.
			mock.fireLifecycleEvent("session_start");
			expect(pi.getActiveTools()).toContain("web-fetch");
		});

		it("emits toolset:changed per drifted toolset and stays silent for already-correct ones", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.web");
			const changed = collectChanged();

			focusRelease(pi, readerOf(mock));

			// portal.web is tier-consistent → silent; every drifting non-member
			// emits once, in the planner's write order.
			expect(changed.map((e) => e.id)).toEqual([
				"portal.learn",
				"tbox.tool@pi-lens",
				"tbox.tool@my-plugin",
			]);
			for (const e of changed) expect(e.enabled).toBe(false);
		});

		it("a non-closure-complete foreign allowlist refuses with ContradictionError and compensates", () => {
			setup(pi, mock);
			// portal.learn requires portal.web, which is not in the list — the
			// resolved intent is incoherent, so the planner refuses pre-write.
			setDefaultResolutionMode(pi, "allowlist", ["portal.learn"]);
			const changed = collectChanged();

			expect(
				catchName(() => focusRelease(pi, readerOf(mock))),
			).toBe("ContradictionError");

			// Compensated at resolved-state level (the branch is append-only,
			// so entry-count identity is not the contract).
			expectCompensatedTo(["portal.learn"]);
			// Live tools untouched — release actuates only on success.
			const active = pi.getActiveTools();
			expect(active).toContain("web-fetch");
			expect(active).toContain("web-learn");
			expect(active).toContain("lens-tool-0");
			// No changed fanout during the failed release.
			expect(changed).toHaveLength(0);
			// Foreign focus: tbox's unit is null at resolved-state level (the
			// uncompensated persistFocusUnit(pi, null) append remains — the
			// branch is append-only, a null unit cannot be un-written).
			expect(getFocusUnit()).toBeNull();
		});

		it("a dependency registered after focus-enter makes release refuse (late-registration arm)", () => {
			setup(pi, mock);
			focusUnit(pi, "+portal.learn");
			expect(getFocusUnit()).toBe("portal.learn");

			// portal.learn's dependency registers after focus-enter and is
			// therefore not in the allowlist — same contradiction class as a
			// hand-edited non-closure-complete list.
			mock.registerTool({
				name: "late-base",
				description: "Late base",
				sourceInfo: {
					path: "late.ts",
					source: "late",
					scope: "user",
					origin: "top-level",
				},
			});
			mock.defineFakeToolset({
				id: "late.base",
				names: new Set(["late-base"]),
				persistKey: "toolset-state:late.base",
				defaultEnabled: true,
			});
			const learnEntry = getRegisteredToolsets().find(
				(e) => e.spec.id === "portal.learn",
			)!;
			learnEntry.spec.requires = ["late.base"];

			expect(
				catchName(() => focusRelease(pi, readerOf(mock))),
			).toBe("ContradictionError");

			// tbox-owned focus: the unit is restored too (entry-level, since a
			// non-null unit is representable through persistFocusUnit).
			expect(getFocusUnit()).toBe("portal.learn");
			expect(lastEntryFor(FOCUS_PERSIST_KEY)?.data).toEqual({
				unit: "portal.learn",
			});
			expectCompensatedTo(["portal.learn", "portal.web"]);
		});

		it("a dormant requires cycle among registered non-members refuses with CycleError", () => {
			setup(pi, mock);
			setupCycle(mock);
			// focus-enter refuses only cycles inside the unit's closure — an
			// unrelated cycle stays dormant until a toggle traverses it.
			focusUnit(pi, "+portal.web");
			const changed = collectChanged();

			// The disable branch walks dependents of every non-member, so the
			// dormant cycle surfaces even though the allowlist is unrelated.
			expect(catchName(() => focusRelease(pi, readerOf(mock)))).toBe(
				"CycleError",
			);

			// Same compensated-state pinning as the contradiction case.
			expectCompensatedTo(["portal.web"]);
			expect(changed).toHaveLength(0);
		});

		// Hand-edited corruption, both shapes: an empty array and a missing
		// array (the branch read fails closed to {allowlist: []}). No
		// sanctioned writer can produce an empty allowlist
		// (setDefaultResolutionMode refuses empty at write time), so this
		// state could never be compensated — that is why release refuses
		// instead. The literal key is masking's private MODE_PERSIST_KEY
		// (pi-tool-masking index.ts; unexported), hardcoded here — a rename
		// stops reading as the mode entry, release sees exclusion mode, and
		// these tests fail rather than passing vacuously.
		it.each([
			["an empty allowlist array", { mode: "allowlist", allowlist: [] }],
			["a missing allowlist array", { mode: "allowlist" }],
		])(
			"a corrupt mode entry (%s) refuses up-front — before any mutation",
			(_name, data) => {
				setup(pi, mock);
				setFocusUnit("portal.web");
				pi.appendEntry("toolset-resolution-mode", data);
				const entriesBefore = mock.getEntries().length;
				const changed = collectChanged();

				expect(catchName(() => focusRelease(pi, readerOf(mock)))).toBe(
					"CorruptModeStateError",
				);

				// Nothing to compensate: zero entries appended, focus unit not
				// cleared, live tools untouched, no changed fanout.
				expect(mock.getEntries().length).toBe(entriesBefore);
				expect(getFocusUnit()).toBe("portal.web");
				expect(changed).toHaveLength(0);
				expect(pi.getActiveTools()).toContain("web-fetch");
			},
		);

		it("an unregistered dependency is lenient — release succeeds without an op for it", () => {
			setup(pi, mock);
			mock.registerTool({
				name: "lonely-tool",
				description: "Lonely",
				sourceInfo: {
					path: "lonely.ts",
					source: "lonely",
					scope: "user",
					origin: "top-level",
				},
			});
			mock.defineFakeToolset({
				id: "lonely",
				names: new Set(["lonely-tool"]),
				persistKey: "toolset-state:lonely",
				defaultEnabled: true,
				requires: ["ghost.base"], // never registered
			});
			setDefaultResolutionMode(pi, "allowlist", ["lonely"]);

			const result = focusRelease(pi, readerOf(mock));

			expect(result).toContain("Focus released");
			expect(readBranchModeState(readerOf(mock).getBranch()).mode).toBe(
				"exclusion",
			);
			// lonely is tier-consistent → no entry, no loadout write; it stays on.
			expect(pi.getActiveTools()).toContain("lonely-tool");
			expect(lastEntryFor("toolset-state:lonely")).toBeUndefined();
		});
	});

	describe("status command reflects focus", () => {
		it("/tbox status shows focus line when focused", () => {
			setup(pi, mock);

			focusUnit(pi, "+portal.web");

			const output = formatStatus(pi, branchOf(mock));
			expect(output).toContain("Focus: on");
			expect(output).toContain("portal.web");
		});

		it("/tbox status shows focus off when not focused", () => {
			setup(pi, mock);

			const output = formatStatus(pi, branchOf(mock));
			expect(output).toContain("Focus: off");
		});
	});
});
