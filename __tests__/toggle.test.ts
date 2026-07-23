import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toggleTool, resolveTool } from "../src/toggle.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { getRegisteredToolsets } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal tool population for toggle tests. */
function setupToggleFixture(mock: MockPI, pi: ExtensionAPI): void {
	// Builtins
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

	// SDK
	mock.registerTool({
		name: "custom-x",
		description: "SDK tool",
		sourceInfo: {
			path: "sdk.ts",
			source: "sdk",
			scope: "user",
			origin: "top-level",
		},
	});

	// portal.web — masked, 3 members
	mock.registerTool({
		name: "web-fetch",
		description: "Fetch web pages",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "browser-navigate",
		description: "Navigate browser",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "page-read",
		description: "Read page",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});

	// portal.learn — unmasked, 1 member, requires portal.web
	mock.registerTool({
		name: "web-learn",
		description: "Learn from web",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});

	// Orphan
	mock.registerTool({
		name: "orphan-tool",
		description: "Orphaned tool",
		sourceInfo: {
			path: "ext.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});

	// Fake toolsets
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

	// Auto-register tbox.orphans + pi.builtin
	autoRegisterBuiltinAndOrphans(pi);

	// Enable all toolsets so they start active
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi);
	}
}

// ---------------------------------------------------------------------------
// resolveTool
// ---------------------------------------------------------------------------

describe("resolveTool", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("finds an exact match by name", () => {
		mock.registerTool({
			name: "web-fetch",
			description: "Fetch",
			sourceInfo: {
				path: "p.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		const result = resolveTool(pi, "web-fetch");
		expect("tool" in result).toBe(true);
		if ("tool" in result) expect(result.tool.name).toBe("web-fetch");
	});

	it("finds a prefix match when unique", () => {
		mock.registerTool({
			name: "web-fetch",
			description: "Fetch",
			sourceInfo: {
				path: "p.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		const result = resolveTool(pi, "web-fetch");
		if ("tool" in result) expect(result.tool.name).toBe("web-fetch");
	});

	it("returns error when no tool matches", () => {
		const result = resolveTool(pi, "nonexistent");
		expect("error" in result).toBe(true);
		if ("error" in result) expect(result.error).toContain("No tool");
	});

	it("returns error on ambiguous prefix", () => {
		mock.registerTool({
			name: "web-fetch",
			description: "Fetch",
			sourceInfo: {
				path: "p.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.registerTool({
			name: "web-learn",
			description: "Learn",
			sourceInfo: {
				path: "p.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		const result = resolveTool(pi, "web");
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("Ambiguous");
			expect(result.error).toContain("web-fetch");
			expect(result.error).toContain("web-learn");
		}
	});
});

// ---------------------------------------------------------------------------
// toggleTool
// ---------------------------------------------------------------------------

describe("toggleTool", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("toggles an unmasked tool's containing toolset on/off", () => {
		setupToggleFixture(mock, pi);

		// Start: all active → toggle web-learn (in portal.learn, unmasked) → disable
		const msg1 = toggleTool(pi, "web-learn", false);
		expect(msg1).toContain('Disabled "web-learn"');
		expect(mock.getActiveTools()).not.toContain("web-learn");

		// Toggle again → re-enable
		const msg2 = toggleTool(pi, "web-learn", false);
		expect(msg2).toContain('Enabled "web-learn"');
		expect(mock.getActiveTools()).toContain("web-learn");
	});

	it("refuses sdk tools", () => {
		setupToggleFixture(mock, pi);
		const msg = toggleTool(pi, "custom-x", false);
		expect(msg).toContain("Cannot toggle");
		expect(msg).toContain("SDK tools are host-managed");
	});

	it("refuses sdk tools even in dev mode", () => {
		setupToggleFixture(mock, pi);
		const msg = toggleTool(pi, "custom-x", true);
		expect(msg).toContain("Cannot toggle");
		expect(msg).toContain("SDK tools are host-managed");
	});

	it("refuses masked member toggle in normal mode", () => {
		setupToggleFixture(mock, pi);
		const msg = toggleTool(pi, "web-fetch", false);
		expect(msg).toContain("Cannot toggle");
		expect(msg).toContain("sealed group");
		expect(msg).toContain("Portal Web");
	});

	it("allows masked member toggle in dev mode", () => {
		setupToggleFixture(mock, pi);

		const msg1 = toggleTool(pi, "web-fetch", true);
		expect(msg1).toContain('Disabled "web-fetch"');
		expect(mock.getActiveTools()).not.toContain("web-fetch");

		const msg2 = toggleTool(pi, "web-fetch", true);
		expect(msg2).toContain('Enabled "web-fetch"');
		expect(mock.getActiveTools()).toContain("web-fetch");
	});

	it("refuses builtin toggle in normal mode", () => {
		setupToggleFixture(mock, pi);
		const msg = toggleTool(pi, "read", false);
		expect(msg).toContain("Cannot toggle");
		expect(msg).toContain("builtins are protected");
	});

	it("allows builtin toggle in dev mode", () => {
		setupToggleFixture(mock, pi);
		const msg = toggleTool(pi, "read", true);
		// read is in pi.builtin, which is enabled → should disable
		expect(msg).toContain('Disabled "read"');
	});

	it("toggles an orphan tool via tbox.orphans", () => {
		setupToggleFixture(mock, pi);
		// orphan-tool is in tbox.orphans, enabled by default
		const msg1 = toggleTool(pi, "orphan-tool", false);
		expect(msg1).toContain('Disabled "orphan-tool"');
		expect(msg1).toContain("tbox.orphans");

		const msg2 = toggleTool(pi, "orphan-tool", false);
		expect(msg2).toContain('Enabled "orphan-tool"');
		expect(msg2).toContain("tbox.orphans");
	});

	it("returns error for nonexistent tool", () => {
		setupToggleFixture(mock, pi);
		const msg = toggleTool(pi, "nonexistent", false);
		expect(msg).toContain("No tool");
	});

	it("returns error for ambiguous prefix", () => {
		setupToggleFixture(mock, pi);
		const msg = toggleTool(pi, "web", false);
		expect(msg).toContain("Ambiguous");
	});
});

// ---------------------------------------------------------------------------
// Integration: toggle via dispatchCommand
// ---------------------------------------------------------------------------

describe("toggle via dispatchCommand", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;

		setupToggleFixture(mock, pi);

		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();
	});

	it("dispatches toggle command and notifies result", async () => {
		await mock.dispatchCommand("toggle web-learn");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain('Disabled "web-learn"');
	});

	it("notifies error for sdk tool", async () => {
		await mock.dispatchCommand("toggle custom-x");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.level).toBe("error");
		expect(notify!.message).toContain("SDK tools are host-managed");
	});

	it("notifies error for masked member in normal mode", async () => {
		await mock.dispatchCommand("toggle web-fetch");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.level).toBe("error");
		expect(notify!.message).toContain("sealed group");
	});

	it("notifies error for builtin in normal mode", async () => {
		await mock.dispatchCommand("toggle read");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.level).toBe("error");
		expect(notify!.message).toContain("builtins are protected");
	});

	it("shows usage when no tool argument given", async () => {
		await mock.dispatchCommand("toggle");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Usage");
	});

	it("notifies error for nonexistent tool", async () => {
		await mock.dispatchCommand("toggle nope");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.level).toBe("error");
		expect(notify!.message).toContain("No tool");
	});

	it("notifies error for ambiguous prefix via dispatch", async () => {
		await mock.dispatchCommand("toggle web");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.level).toBe("error");
		expect(notify!.message).toContain("Ambiguous");
	});
});
