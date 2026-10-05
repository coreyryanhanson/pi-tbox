import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toggleAll } from "../src/groups.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { getRegisteredToolsets } from "pi-tool-masking";


/** The mock's branch reader — masking 2.0.0's required toggle parameter. */
function readerOf(mock: MockPI) {
	return mock.createCommandContext().sessionManager;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupRichMock(mock: MockPI, pi: ExtensionAPI): void {
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
	mock.registerTool({
		name: "bash",
		description: "Bash",
		sourceInfo: {
			path: "builtin.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});

	// SDK — in no toolset
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

	// Extension tools
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
		name: "web-learn",
		description: "Learn",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "orphan-tool",
		description: "Orphan",
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
		names: new Set(["web-fetch"]),
		persistKey: "toolset-state:portal.web",
		defaultEnabled: true,
	});
	mock.defineFakeToolset({
		id: "portal.learn",
		names: new Set(["web-learn"]),
		persistKey: "toolset-state:portal.learn",
		defaultEnabled: true,
	});

	// Auto-register per-source orphan toolsets
	// (builtins are not registered as a tbox toolset — they are
	// platform-managed and always active)
	autoRegisterBuiltinAndOrphans(pi);

	// Enable all registered toolsets
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi, mock.createCommandContext().sessionManager);
	}

	// Simulate the real Pi platform: builtins are always active.
	pi.setActiveTools(["read", "bash"]);
}

// ---------------------------------------------------------------------------
// toggleAll
// ---------------------------------------------------------------------------

describe("toggleAll", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("all on enables every registered toolset", () => {
		setupRichMock(mock, pi);

		// Disable everything first
		toggleAll(pi, false, readerOf(mock));

		// Now enable all
		const msg = toggleAll(pi, true, readerOf(mock));
		expect(msg).toContain("Enabled");

		// Extension tools are active
		const active = mock.getActiveTools();
		expect(active).toContain("web-fetch");
		expect(active).toContain("web-learn");
		expect(active).toContain("orphan-tool");
		// Builtins are platform-managed — always active regardless of toggleAll
		expect(active).toContain("read");
		expect(active).toContain("bash");
	});

	it("all off disables every non-builtin toolset", () => {
		setupRichMock(mock, pi);

		const msg = toggleAll(pi, false, readerOf(mock));
		expect(msg).toContain("Disabled");

		// Builtins remain active (platform-managed, not in tbox)
		const active = mock.getActiveTools();
		expect(active).toContain("read");
		expect(active).toContain("bash");

		// Non-builtins disabled
		expect(active).not.toContain("web-fetch");
		expect(active).not.toContain("web-learn");
		expect(active).not.toContain("orphan-tool");
	});

	it("sdk tool's presence unchanged by all off", () => {
		setupRichMock(mock, pi);

		// SDK tool was never enabled by any toolset — it's in no toolset.
		// It shouldn't appear in active tools.
		const before = mock.getActiveTools();
		expect(before).not.toContain("custom-x");

		toggleAll(pi, false, readerOf(mock));

		const after = mock.getActiveTools();
		expect(after).not.toContain("custom-x");
	});

	it("all off leaves builtins untouched (not in registry)", () => {
		setupRichMock(mock, pi);

		toggleAll(pi, false, readerOf(mock));

		// Builtins are platform-managed — not in tbox's registry.
		// toggleAll can only affect registered toolsets.
		const active = mock.getActiveTools();
		expect(active).toContain("read");
		expect(active).toContain("bash");
		expect(active).not.toContain("web-fetch");
		expect(active).not.toContain("web-learn");
		expect(active).not.toContain("orphan-tool");
	});

	it("requires pair: one entry per toolset, count 2 not 3", () => {
		// The batch planner resolves the requires closure into one final
		// state per id and emits each changed toolset exactly once — a
		// duplicate entry for the dependency is unrepresentable.
		mock.defineFakeToolset({
			id: "portal.web",
			names: new Set(["web-fetch"]),
			persistKey: "toolset-state:portal.web",
			defaultEnabled: true,
		});
		mock.defineFakeToolset({
			id: "portal.learn",
			names: new Set(["web-learn"]),
			persistKey: "toolset-state:portal.learn",
			defaultEnabled: true,
			requires: ["portal.web"],
		});

		const msgOff = toggleAll(pi, false, readerOf(mock));
		expect(msgOff).toContain("Disabled 2 toolsets.");
		const offWeb = mock.getEntries("toolset-state:portal.web");
		const offLearn = mock.getEntries("toolset-state:portal.learn");
		expect(offWeb).toHaveLength(1);
		expect(offLearn).toHaveLength(1);

		const msgOn = toggleAll(pi, true, readerOf(mock));
		expect(msgOn).toContain("Enabled 2 toolsets.");
		// Still exactly one entry per toolset for the on pass.
		expect(mock.getEntries("toolset-state:portal.web")).toHaveLength(2);
		expect(mock.getEntries("toolset-state:portal.learn")).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Integration: all via dispatchCommand
// ---------------------------------------------------------------------------

describe("all via dispatchCommand", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;

		setupRichMock(mock, pi);

		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();
	});

	it("dispatches all on and enables all", async () => {
		// Disable all first
		toggleAll(pi, false, readerOf(mock));
		mock.clearUiRecords();

		await mock.dispatchCommand("all on");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Enabled");
		expect(notify!.level).toBe("info");
	});

	it("dispatches all off and disables non-builtin", async () => {
		await mock.dispatchCommand("all off");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Disabled");
		expect(notify!.level).toBe("info");
	});

	it("shows usage for bare all", async () => {
		await mock.dispatchCommand("all");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Usage");
	});
});
