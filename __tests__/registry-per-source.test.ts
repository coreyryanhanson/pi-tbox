/**
 * Sprint 3.5 — Per-source orphan toolsets acceptance tests.
 *
 * Acceptance criteria:
 *   - Multi-source population → per-source toolsets, not a catch-all
 *   - Focus granularity (pre-pinning Sprint 5's allowlist rule)
 *   - Idempotence — second call no-ops
 *   - Single-tool description pass-through
 *   - Tools from defineToolset plugins not claimed by tbox.tool@*
 *   - SDK tools still excluded
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	autoRegisterBuiltinAndOrphans,
	orphanToolsetId,
} from "../src/registry.js";
import { getRegisteredToolsets } from "pi-tool-masking";
import { setDefaultResolutionMode } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Multi-source population
// ---------------------------------------------------------------------------

describe("per-source orphan registration", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("creates one toolset per distinct source among unclaimed tools", () => {
		// pi-lens: multi-tool plugin (~15 tools but we use 3)
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

		// single-tool plugin
		mock.registerTool({
			name: "my-single-tool",
			description: "A single tool from my-plugin",
			sourceInfo: {
				path: "my-plugin.ts",
				source: "my-plugin",
				scope: "user",
				origin: "top-level",
			},
		});

		// Builtin tool (should not become an orphan toolset)
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

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();

		// Should have: tbox.tool@pi-lens + tbox.tool@my-plugin = 2
		// (builtins are not registered as a toolset)
		expect(toolsets).toHaveLength(2);

		const lensToolset = toolsets.find(
			(e) => e.spec.id === orphanToolsetId("pi-lens"),
		);
		const myPluginToolset = toolsets.find(
			(e) => e.spec.id === orphanToolsetId("my-plugin"),
		);

		expect(lensToolset).toBeDefined();
		expect(lensToolset!.spec.names.size).toBe(3);
		expect(lensToolset!.spec.defaultEnabled).toBe(true);
		expect(lensToolset!.spec.masked).toBe(false);
		// Multi-tool source: no description
		expect(lensToolset!.spec.description).toBeUndefined();

		expect(myPluginToolset).toBeDefined();
		expect(myPluginToolset!.spec.names.size).toBe(1);
		expect(myPluginToolset!.spec.defaultEnabled).toBe(true);
		expect(myPluginToolset!.spec.masked).toBe(false);
		// Single-tool source: description passed through
		expect(myPluginToolset!.spec.description).toBe(
			"A single tool from my-plugin",
		);

		// No catch-all tbox.orphans or tbox.tool
		const catchAll = toolsets.find(
			(e) => e.spec.id === "tbox.orphans" || e.spec.id === "tbox.tool",
		);
		expect(catchAll).toBeUndefined();
	});

	it("does not claim tools from defineToolset plugins", () => {
		// A plugin that calls defineToolset (like portal.web)
		mock.defineFakeToolset({
			id: "portal.web",
			names: new Set(["web-fetch", "browser-navigate"]),
			persistKey: "toolset-state:portal.web",
			defaultEnabled: true,
		});

		// Same source registers tools via defineToolset
		mock.registerTool({
			name: "web-fetch",
			description: "Fetch web pages",
			sourceInfo: {
				path: "portal.ts",
				source: "portal",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.registerTool({
			name: "browser-navigate",
			description: "Navigate browser",
			sourceInfo: {
				path: "portal.ts",
				source: "portal",
				scope: "user",
				origin: "top-level",
			},
		});

		// A different source with orphan tools
		mock.registerTool({
			name: "lens-search",
			description: "Search codebase",
			sourceInfo: {
				path: "pi-lens.ts",
				source: "pi-lens",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();

		// portal.web toolset should exist (from defineFakeToolset)
		const portalWeb = toolsets.find((e) => e.spec.id === "portal.web");
		expect(portalWeb).toBeDefined();
		expect(portalWeb!.spec.names).toContain("web-fetch");
		expect(portalWeb!.spec.names).toContain("browser-navigate");

		// Orphan toolset for pi-lens should exist
		const lensToolset = toolsets.find(
			(e) => e.spec.id === orphanToolsetId("pi-lens"),
		);
		expect(lensToolset).toBeDefined();
		expect(lensToolset!.spec.names).toEqual(new Set(["lens-search"]));

		// No orphan toolset for portal's source — its tools are claimed
		const portalOrphan = toolsets.find(
			(e) => e.spec.id === orphanToolsetId("portal"),
		);
		expect(portalOrphan).toBeUndefined();
	});

	it("excludes sdk tools from orphan toolsets", () => {
		mock.registerTool({
			name: "sdk-custom",
			description: "Custom SDK tool",
			sourceInfo: {
				path: "sdk.ts",
				source: "sdk",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		// No toolsets at all since only an SDK tool was registered
		const toolsets = getRegisteredToolsets();
		expect(toolsets).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Focus granularity (pre-pinning Sprint 5)
// ---------------------------------------------------------------------------

describe("focus granularity with per-source toolsets", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("entering focus on one tbox.tool@<source> keeps only that source active", () => {
		// Two unclaimed sources: pi-lens (3 tools) and my-plugin (1 tool)
		for (let i = 0; i < 3; i++) {
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

		autoRegisterBuiltinAndOrphans(pi);

		// Enable all registered toolsets so focus can disable
		for (const entry of getRegisteredToolsets()) {
			entry.toolset.enable(pi);
		}
		mock.clearUiRecords();

		// --- Simulate focus: allowlist = tbox.tool@pi-lens only ---
		// (Builtins are not in tbox's allowlist — they are
		// platform-managed and always stay active regardless.)

		const allowlist = new Set([orphanToolsetId("pi-lens")]);

		setDefaultResolutionMode(pi, "inclusion");

		for (const entry of getRegisteredToolsets()) {
			if (allowlist.has(entry.spec.id)) {
				entry.toolset.enable(pi);
			} else {
				entry.toolset.disable(pi);
			}
		}

		// --- Assertions ---
		const active = mock.getActiveTools();

		// pi-lens tools active
		expect(active).toContain("lens-tool-0");
		expect(active).toContain("lens-tool-1");
		expect(active).toContain("lens-tool-2");

		// my-plugin tool inactive (its toolset was disabled)
		expect(active).not.toContain("my-tool");

		// Builtins are platform-managed — outside tbox's registry.
		// (In a real Pi session they remain active independently.)

		// Cleanup
		setDefaultResolutionMode(pi, "exclusion");
	});
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe("idempotence", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("second call with same tool population writes no new registry entries", () => {
		mock.registerTool({
			name: "lens-search",
			description: "Search codebase",
			sourceInfo: {
				path: "pi-lens.ts",
				source: "pi-lens",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);
		const entriesAfterFirst = getRegisteredToolsets().length;

		// Track appendEntry calls
		const beforeCount = mock.getEntries().length;

		autoRegisterBuiltinAndOrphans(pi);
		const entriesAfterSecond = getRegisteredToolsets().length;

		// Same number of registry entries
		expect(entriesAfterSecond).toBe(entriesAfterFirst);

		// No new appendEntry calls should have been made
		expect(mock.getEntries().length).toBe(beforeCount);
	});

	it("a source that gains a tool between calls updates its names set", () => {
		mock.registerTool({
			name: "lens-search",
			description: "Search codebase",
			sourceInfo: {
				path: "pi-lens.ts",
				source: "pi-lens",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		// Add another tool from same source
		mock.registerTool({
			name: "lens-grep",
			description: "Grep codebase",
			sourceInfo: {
				path: "pi-lens.ts",
				source: "pi-lens",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		const lensToolset = toolsets.find(
			(e) => e.spec.id === orphanToolsetId("pi-lens"),
		);

		expect(lensToolset).toBeDefined();
		expect(lensToolset!.spec.names).toEqual(
			new Set(["lens-search", "lens-grep"]),
		);
		// Multi-tool now → no description
		expect(lensToolset!.spec.description).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Single-tool description pass-through
// ---------------------------------------------------------------------------

describe("single-tool description pass-through", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("passes description for single-tool sources", () => {
		mock.registerTool({
			name: "my-unique-tool",
			description: "This is my unique tool",
			sourceInfo: {
				path: "my-plugin.ts",
				source: "my-plugin",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const entry = getRegisteredToolsets().find(
			(e) => e.spec.id === orphanToolsetId("my-plugin"),
		);
		expect(entry).toBeDefined();
		expect(entry!.spec.description).toBe("This is my unique tool");
	});

	it("omits description for multi-tool sources", () => {
		mock.registerTool({
			name: "tool-a",
			description: "Tool A description",
			sourceInfo: {
				path: "multi.ts",
				source: "multi-plugin",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.registerTool({
			name: "tool-b",
			description: "Tool B description",
			sourceInfo: {
				path: "multi.ts",
				source: "multi-plugin",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const entry = getRegisteredToolsets().find(
			(e) => e.spec.id === orphanToolsetId("multi-plugin"),
		);
		expect(entry).toBeDefined();
		expect(entry!.spec.description).toBeUndefined();
	});
});
