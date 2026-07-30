/**
 * Restore-timing tests — fix for orphan toolsets registered in session_start.
 *
 * Verifies that orphan toolsets registered inside a session_start handler
 * (after the library's restore handler already fired) still get their
 * defaultEnabled state applied via actuateNewToolsets.
 *
 * Root cause being fixed: Node's EventEmitter does not invoke a listener
 * registered mid-emit for the current emit. autoRegisterBuiltinAndOrphans
 * runs inside the session_start handler, calls defineToolset →
 * ensureRestoreHandler → pi.on("session_start", doRestore). That restore
 * handler is added during the emit, so it never runs for this session.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	autoRegisterBuiltinAndOrphans,
	actuateNewToolsets,
	orphanToolsetId,
} from "../src/registry.js";
import { computeSlotState } from "../src/status-slot.js";
import {
	getRegisteredToolsets,
	setSettingsOverrideForTests,
} from "pi-tool-masking";
import { setFocusUnit } from "../src/status-slot.js";

describe("restore-timing: actuateNewToolsets", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		setSettingsOverrideForTests({});
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
	});

	it("actuates newly-registered orphans to defaultEnabled so they appear in getActiveTools", () => {
		// Register 3 extension tools from one source + 1 builtin
		for (let i = 0; i < 3; i++) {
			mock.registerTool({
				name: `ext-tool-${i}`,
				description: `Extension tool ${i}`,
				sourceInfo: {
					path: "my-ext.ts",
					source: "my-ext",
					scope: "user",
					origin: "top-level",
				},
			});
		}
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

		// Simulate the session_start handler sequence:
		//   1. autoRegisterBuiltinAndOrphans (registers orphan toolsets)
		//   2. actuateNewToolsets (applies defaultEnabled since restore missed them)
		const newIds = autoRegisterBuiltinAndOrphans(pi);
		actuateNewToolsets(pi, newIds);

		// All 3 extension tools should now be active (defaultEnabled: true)
		const active = mock.getActiveTools();
		expect(active).toContain("ext-tool-0");
		expect(active).toContain("ext-tool-1");
		expect(active).toContain("ext-tool-2");
		// Builtins are not registered as a toolset — they remain
		// managed by the platform and are not actuated by tbox.
	});

	it("without actuateNewToolsets, orphans stay inactive (reproduces the bug)", () => {
		for (let i = 0; i < 3; i++) {
			mock.registerTool({
				name: `ext-tool-${i}`,
				description: `Extension tool ${i}`,
				sourceInfo: {
					path: "my-ext.ts",
					source: "my-ext",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		// Only register — do NOT actuate
		autoRegisterBuiltinAndOrphans(pi);

		// Without actuation, the tools are NOT in getActiveTools
		const active = mock.getActiveTools();
		expect(active).not.toContain("ext-tool-0");
		expect(active).not.toContain("ext-tool-1");
		expect(active).not.toContain("ext-tool-2");
	});

	it("slot count reflects reality after actuation (no 'one off' bug)", () => {
		// 5 extension tools, all defaultEnabled: true
		for (let i = 0; i < 5; i++) {
			mock.registerTool({
				name: `ext-tool-${i}`,
				description: `Extension tool ${i}`,
				sourceInfo: {
					path: "my-ext.ts",
					source: "my-ext",
					scope: "user",
					origin: "top-level",
				},
			});
		}
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

		const newIds = autoRegisterBuiltinAndOrphans(pi);
		actuateNewToolsets(pi, newIds);

		// All 5 extension tools are active → slot should be pristine (n=0)
		const state = computeSlotState(pi);
		expect(state).toEqual({ kind: "pristine" });

		// Now disable one toolset manually → count should be exactly 5
		const entry = getRegisteredToolsets().find(
			(e) => e.spec.id === orphanToolsetId("my-ext"),
		)!;
		entry.toolset.disable(pi);

		const stateAfter = computeSlotState(pi);
		expect(stateAfter).toEqual({ kind: "count", n: 5 });
		// The count equals the true inactive extension count, not true-minus-one
		expect(stateAfter.kind).toBe("count");
		if (stateAfter.kind === "count") {
			expect(stateAfter.n).toBe(5);
		}
	});

	it("idempotent — re-running actuateNewToolsets on already-active tools is a no-op", () => {
		for (let i = 0; i < 3; i++) {
			mock.registerTool({
				name: `ext-tool-${i}`,
				description: `Extension tool ${i}`,
				sourceInfo: {
					path: "my-ext.ts",
					source: "my-ext",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		const newIds = autoRegisterBuiltinAndOrphans(pi);
		actuateNewToolsets(pi, newIds);

		const activeAfterFirst = [...mock.getActiveTools()].sort();
		const entriesAfterFirst = mock.getEntries().length;

		// Actuate again — should not duplicate entries or change active set
		actuateNewToolsets(pi, newIds);

		const activeAfterSecond = [...mock.getActiveTools()].sort();
		const entriesAfterSecond = mock.getEntries().length;

		expect(activeAfterSecond).toEqual(activeAfterFirst);
		expect(entriesAfterSecond).toBe(entriesAfterFirst);
	});

	it("does not re-actuate toolsets the library's restore already handled (diff guard)", () => {
		// Simulate portal: a toolset registered BEFORE session_start (restore covers it)
		mock.defineFakeToolset({
			id: "portal.web",
			names: new Set(["web-fetch", "browser-navigate"]),
			persistKey: "toolset-state:portal.web",
			defaultEnabled: true,
		});
		mock.registerTool({
			name: "web-fetch",
			description: "Fetch",
			sourceInfo: {
				path: "portal.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.registerTool({
			name: "browser-navigate",
			description: "Navigate",
			sourceInfo: {
				path: "portal.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});

		// Simulate restore having already enabled portal.web
		mock.setActiveTools(["web-fetch", "browser-navigate"]);

		// Now register orphans from a different source
		for (let i = 0; i < 2; i++) {
			mock.registerTool({
				name: `lens-tool-${i}`,
				description: `Lens ${i}`,
				sourceInfo: {
					path: "pi-lens.ts",
					source: "pi-lens",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		const newIds = autoRegisterBuiltinAndOrphans(pi);
		// portal.web should NOT be in newIds (it pre-existed)
		expect(newIds).not.toContain("portal.web");
		expect(newIds).toContain(orphanToolsetId("pi-lens"));

		actuateNewToolsets(pi, newIds);

		// Portal tools stay active (restore handled them), lens tools now active too
		const active = mock.getActiveTools();
		expect(active).toContain("web-fetch");
		expect(active).toContain("browser-navigate");
		expect(active).toContain("lens-tool-0");
		expect(active).toContain("lens-tool-1");
	});

	it("handles multiple distinct orphan sources in one call", () => {
		// 3 tools from source A, 2 from source B, 1 from source C
		for (let i = 0; i < 3; i++) {
			mock.registerTool({
				name: `a-tool-${i}`,
				description: `A tool ${i}`,
				sourceInfo: {
					path: "a.ts",
					source: "source-a",
					scope: "user",
					origin: "top-level",
				},
			});
		}
		for (let i = 0; i < 2; i++) {
			mock.registerTool({
				name: `b-tool-${i}`,
				description: `B tool ${i}`,
				sourceInfo: {
					path: "b.ts",
					source: "source-b",
					scope: "user",
					origin: "top-level",
				},
			});
		}
		mock.registerTool({
			name: "c-tool",
			description: "C tool",
			sourceInfo: {
				path: "c.ts",
				source: "source-c",
				scope: "user",
				origin: "top-level",
			},
		});

		const newIds = autoRegisterBuiltinAndOrphans(pi);
		actuateNewToolsets(pi, newIds);

		// All 6 tools should be active
		const active = mock.getActiveTools();
		expect(active).toHaveLength(6);
		expect(active).toContain("a-tool-0");
		expect(active).toContain("a-tool-1");
		expect(active).toContain("a-tool-2");
		expect(active).toContain("b-tool-0");
		expect(active).toContain("b-tool-1");
		expect(active).toContain("c-tool");
	});

	it("actuateNewToolsets with empty array is a safe no-op", () => {
		const activeBefore = mock.getActiveTools();
		actuateNewToolsets(pi, []);
		expect(mock.getActiveTools()).toEqual(activeBefore);
	});

	it("autoRegisterBuiltinAndOrphans returns ids of newly-registered toolsets", () => {
		for (let i = 0; i < 2; i++) {
			mock.registerTool({
				name: `ext-${i}`,
				description: `Ext ${i}`,
				sourceInfo: {
					path: "ext.ts",
					source: "my-source",
					scope: "user",
					origin: "top-level",
				},
			});
		}
		mock.registerTool({
			name: "read",
			description: "Read",
			sourceInfo: {
				path: "builtin.ts",
				source: "builtin",
				scope: "user",
				origin: "top-level",
			},
		});

		const newIds = autoRegisterBuiltinAndOrphans(pi);
		expect(newIds).toContain(orphanToolsetId("my-source"));
		expect(newIds).toHaveLength(1);
		// pi.builtin is not registered as a toolset.

		// Second call — no new ids (idempotent)
		const secondIds = autoRegisterBuiltinAndOrphans(pi);
		expect(secondIds).toHaveLength(0);
	});
});
