/**
 * Integration test — multi-extension end-to-end.
 *
 * Stands up a realistic registry with:
 *   - portal.web + portal.learn (requires web)
 *   - host.api + search.web
 *   - Two unclaimed-source plugins (pi-lens, notes-plugin)
 *   - builtins + sdk
 *
 * Then drives the full /tbox surface through dispatchCommand and the
 * actuation API.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import {
	autoRegisterBuiltinAndOrphans,
	actuateNewToolsets,
} from "../src/registry.js";
import { setFocusUnit, computeSlotState } from "../src/status-slot.js";
import { actuateGroup, actuateToolset, toggleAll } from "../src/groups.js";
import { focusUnit, focusOff } from "../src/focus.js";
import { formatList, formatStatus } from "../src/list.js";
import { computeCharCount, formatCharSplit } from "../src/chars.js";
import {
	writeGroup,
	readGroups,
	removeGroup,
	setGroupsOverrideForTests,
} from "../config/settings-reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a realistic multi-extension tool population in the mock.
 *
 * Returns the pi API reference so callers can add more tools/toolsets.
 */
function buildRealisticPopulation(mock: MockPI, pi: ExtensionAPI): void {
	// --- Builtins (always-on, platform-managed) ---
	mock.registerTool({
		name: "read",
		description: "Read files from disk",
		sourceInfo: {
			path: "builtin.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "bash",
		description: "Execute shell commands",
		sourceInfo: {
			path: "builtin.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "edit",
		description: "Edit files",
		sourceInfo: {
			path: "builtin.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});

	// --- SDK tool (host-managed, never in a toolset) ---
	mock.registerTool({
		name: "custom-x",
		description: "SDK custom tool",
		sourceInfo: {
			path: "sdk-loader.ts",
			source: "sdk",
			scope: "user",
			origin: "top-level",
		},
	});

	// --- portal.web (toolset: web-fetch) ---
	mock.registerTool({
		name: "web-fetch",
		description: "Fetch URLs from the web",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});

	// --- portal.learn (requires portal.web, toolset: web-learn) ---
	mock.registerTool({
		name: "web-learn",
		description: "Learn from web content",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});

	// --- host.api (toolset: host-api-read, host-api-write) ---
	mock.registerTool({
		name: "host-api-read",
		description: "Read host API data",
		sourceInfo: {
			path: "host.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "host-api-write",
		description: "Write host API data",
		sourceInfo: {
			path: "host.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});

	// --- search.web (toolset: search-tool) ---
	mock.registerTool({
		name: "search-tool",
		description: "Search the web",
		sourceInfo: {
			path: "search.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});

	// --- pi-lens orphan tools (unclaimed source A) ---
	mock.registerTool({
		name: "lens-diagnostic",
		description: "Run diagnostics",
		sourceInfo: {
			path: "pi-lens.ts",
			source: "pi-lens",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "lens-rule",
		description: "Manage rules",
		sourceInfo: {
			path: "pi-lens.ts",
			source: "pi-lens",
			scope: "user",
			origin: "top-level",
		},
	});

	// --- notes-plugin orphan tool (unclaimed source B, single tool → has description) ---
	mock.registerTool({
		name: "note-take",
		description: "Take notes quickly",
		sourceInfo: {
			path: "notes.ts",
			source: "notes-plugin",
			scope: "user",
			origin: "top-level",
		},
	});

	// --- Declare fake toolsets (simulating sibling extensions) ---
	mock.defineFakeToolset({
		id: "portal.web",
		names: new Set(["web-fetch"]),
		persistKey: "toolset-state:portal.web",
		defaultEnabled: true,
	});
	mock.defineFakeToolset({
		id: "portal.learn",
		names: new Set(["web-learn"]),
		requires: ["portal.web"],
		persistKey: "toolset-state:portal.learn",
		defaultEnabled: true,
	});
	mock.defineFakeToolset({
		id: "host.api",
		names: new Set(["host-api-read", "host-api-write"]),
		persistKey: "toolset-state:host.api",
		defaultEnabled: true,
	});
	mock.defineFakeToolset({
		id: "search.web",
		names: new Set(["search-tool"]),
		persistKey: "toolset-state:search.web",
		defaultEnabled: true,
	});

	// --- Auto-register per-source orphan toolsets ---
	const newIds = autoRegisterBuiltinAndOrphans(pi);
	actuateNewToolsets(pi, newIds);

	// --- Enable all registered toolsets (simulate the library's restore) ---
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi);
	}

	// Builtins are always active (platform-managed)
	mock.setActiveTools([
		"read",
		"bash",
		"edit",
		"web-fetch",
		"web-learn",
		"host-api-read",
		"host-api-write",
		"search-tool",
		"lens-diagnostic",
		"lens-rule",
		"note-take",
	]);
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("integration — multi-extension registry", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);

		// ponytail: route group reads/writes through the in-memory override
		// so this suite never touches the real ~/.pi/agent/pi-tbox/groups.json
		// (which holds the user's actual groups). The cleanup loop below then
		// operates on the override, not production disk.
		setGroupsOverrideForTests({});
		const existing = readGroups();
		for (const name of Object.keys(existing)) {
			removeGroup(name);
		}

		buildRealisticPopulation(mock, pi);
	});

	afterEach(() => setGroupsOverrideForTests(null));

	// -----------------------------------------------------------------------
	// list (grouped default)
	// -----------------------------------------------------------------------

	it("list default grouped view shows all tools under correct toolset groups", () => {
		const output = formatList(pi, "list");

		// portal.web shows its tool
		expect(output).toContain("portal.web");
		expect(output).toContain("web-fetch");
		// portal.learn shows its tool
		expect(output).toContain("portal.learn");
		expect(output).toContain("web-learn");
		// host.api shows its tools
		expect(output).toContain("host.api");
		expect(output).toContain("host-api-read");
		expect(output).toContain("host-api-write");
		// search.web shows its tool
		expect(output).toContain("search.web");
		expect(output).toContain("search-tool");
		// orphans appear under their toolset id (which is what users type)
		expect(output).toContain("tbox.tool@pi-lens");
		expect(output).toContain("lens-diagnostic");
		expect(output).toContain("lens-rule");
		expect(output).toContain("tbox.tool@notes-plugin");
		expect(output).toContain("note-take");
		// SDK tools do NOT appear in grouped view
		expect(output).not.toContain("custom-x");
		// Builtins appear in grouped view
		expect(output).toContain("pi.builtin");
	});

	it("list --flat shows sdk tools as read-only", () => {
		const output = formatList(pi, "list --flat");

		expect(output).toContain("custom-x");
		expect(output).toContain("sdk, host-managed");
	});

	it("list --active filters to active tools only", () => {
		// All tools active by default in the fixture
		const output = formatList(pi, "list --active");
		expect(output).toContain("web-fetch");
		expect(output).not.toContain("(inactive)");

		// Disable one toolset
		const registry = getRegisteredToolsets();
		const learnEntry = registry.find(
			(e: RegistryEntry) => e.spec.id === "portal.learn",
		)!;
		learnEntry.toolset.disable(pi);

		const outputAfter = formatList(pi, "list --active");
		expect(outputAfter).not.toContain("web-learn");
	});

	it("list --inactive shows only inactive tools", () => {
		const output = formatList(pi, "list --inactive");
		// All tools active by default in fixture — no inactive
		expect(output).toContain("(no tools match the current filter)");

		// Disable one toolset
		const registry = getRegisteredToolsets();
		const learnEntry = registry.find(
			(e: RegistryEntry) => e.spec.id === "portal.learn",
		)!;
		learnEntry.toolset.disable(pi);

		const outputAfter = formatList(pi, "list --inactive");
		expect(outputAfter).toContain("web-learn");
		expect(outputAfter).toContain("(inactive)");
	});

	// -----------------------------------------------------------------------
	// Group definition + actuation with cascade
	// -----------------------------------------------------------------------

	it("defines a group via writeGroup, actuateGroup on cascades deps", () => {
		writeGroup("my-group", { toolsets: ["portal.learn"] });

		const msg = actuateGroup(pi, "my-group", true);
		expect(msg).toContain("Enabled group");

		// portal.web should be cascaded on (required by portal.learn)
		const active = mock.getActiveTools();
		expect(active).toContain("web-fetch");
		expect(active).toContain("web-learn");
	});

	it("actuateGroup off reverse-cascades dependents", () => {
		writeGroup("my-group", { toolsets: ["portal.web"] });

		// First make sure all is on
		toggleAll(pi, true);
		mock.setActiveTools([
			"read",
			"bash",
			"edit",
			"web-fetch",
			"web-learn",
			"host-api-read",
			"host-api-write",
			"search-tool",
			"lens-diagnostic",
			"lens-rule",
			"note-take",
		]);

		// Disable portal.web — portal.learn (which requires it) should cascade off
		const msg = actuateGroup(pi, "my-group", false);
		expect(msg).toContain("Disabled group");

		const active = mock.getActiveTools();
		// portal.web is disabled
		// portal.learn is disabled by cascade (requires portal.web)
		expect(active).not.toContain("web-fetch");
	});

	it("actuateGroup reports cascaded non-members in the message", () => {
		writeGroup("my-group", { toolsets: ["portal.learn"] });

		// First disable all to create a clean slate
		toggleAll(pi, false);
		mock.setActiveTools(["read", "bash", "edit"]);

		const msg = actuateGroup(pi, "my-group", true);
		expect(msg).toContain("Cascaded");
		expect(msg).toContain("portal.web");
		// portal.learn should be enabled (it's in the group)
		const active = mock.getActiveTools();
		expect(active).toContain("web-learn");
		expect(active).toContain("web-fetch");
	});

	it("actuateGroup on an empty group returns a graceful message", () => {
		writeGroup("empty-group", { toolsets: [] });
		const msg = actuateGroup(pi, "empty-group", true);
		expect(msg).toContain("no actuable toolsets");
	});

	// -----------------------------------------------------------------------
	// Direct toolset toggle (+ prefix)
	// -----------------------------------------------------------------------

	it("+<non-existent> returns error", () => {
		const msg = actuateToolset(pi, "nonexistent.toolset", true);
		expect(msg).toContain('No toolset "nonexistent.toolset"');
	});

	it("+<toolset> on enables just that toolset", () => {
		// Disable all first
		toggleAll(pi, false);
		mock.setActiveTools(["read", "bash", "edit"]);

		const msg = actuateToolset(pi, "host.api", true);
		expect(msg).toContain("Enabled");

		const active = mock.getActiveTools();
		expect(active).toContain("host-api-read");
		expect(active).toContain("host-api-write");
	});

	it("+<toolset> off disables just that toolset", () => {
		const msg = actuateToolset(pi, "host.api", false);
		expect(msg).toContain("Disabled");

		const active = mock.getActiveTools();
		expect(active).not.toContain("host-api-read");
		expect(active).not.toContain("host-api-write");
	});

	// -----------------------------------------------------------------------
	// all on/off
	// -----------------------------------------------------------------------

	it("all on enables every registered toolset", () => {
		// Disable all first
		toggleAll(pi, false);
		mock.setActiveTools(["read", "bash", "edit"]);

		const msg = toggleAll(pi, true);
		expect(msg).toContain("Enabled");

		const active = mock.getActiveTools();
		expect(active).toContain("web-fetch");
		expect(active).toContain("web-learn");
		expect(active).toContain("host-api-read");
		expect(active).toContain("search-tool");
		expect(active).toContain("lens-diagnostic");
		expect(active).toContain("note-take");
		// Builtins always active
		expect(active).toContain("read");
		expect(active).toContain("bash");
	});

	it("all off disables every non-builtin toolset; builtins and sdk untouched", () => {
		const msg = toggleAll(pi, false);
		expect(msg).toContain("Disabled");

		const active = mock.getActiveTools();
		// Builtins remain
		expect(active).toContain("read");
		expect(active).toContain("bash");
		expect(active).toContain("edit");
		// SDK still not in active (never was — it's in no toolset)
		expect(active).not.toContain("custom-x");
		// Extension tools disabled
		expect(active).not.toContain("web-fetch");
		expect(active).not.toContain("web-learn");
		expect(active).not.toContain("host-api-read");
		expect(active).not.toContain("search-tool");
		expect(active).not.toContain("lens-diagnostic");
		expect(active).not.toContain("note-take");
	});

	// -----------------------------------------------------------------------
	// Focus
	// -----------------------------------------------------------------------

	it("focus host.api enters inclusion mode with only host.api (+ closure) on", () => {
		const msg = focusUnit(pi, "+host.api");
		expect(msg).toContain("Focus on");

		const active = mock.getActiveTools();
		// host.api tools are on
		expect(active).toContain("host-api-read");
		expect(active).toContain("host-api-write");

		// Other extension tools are off
		expect(active).not.toContain("web-fetch");
		expect(active).not.toContain("web-learn");
		expect(active).not.toContain("search-tool");
		expect(active).not.toContain("lens-diagnostic");
		expect(active).not.toContain("note-take");

		// Builtins always active
		expect(active).toContain("read");
		expect(active).toContain("bash");
	});

	it("focus on a group keeps the group + forward requires closure on", () => {
		writeGroup("web-group", { toolsets: ["portal.learn"] });

		const msg = focusUnit(pi, "web-group");
		expect(msg).toContain("Focus on");

		const active = mock.getActiveTools();
		// portal.learn members on
		expect(active).toContain("web-learn");
		// portal.web cascaded on (required by portal.learn)
		expect(active).toContain("web-fetch");
		// Other extension tools off
		expect(active).not.toContain("host-api-read");
		expect(active).not.toContain("search-tool");
	});

	it("focus off restores all toolsets to defaultEnabled", () => {
		// Enter focus
		focusUnit(pi, "+host.api");
		// Exit focus
		const msg = focusOff(pi);
		expect(msg).toContain("Focus off");

		const active = mock.getActiveTools();
		// All extension tools back to defaultEnabled (true for our fixture)
		expect(active).toContain("web-fetch");
		expect(active).toContain("web-learn");
		expect(active).toContain("host-api-read");
		expect(active).toContain("host-api-write");
		expect(active).toContain("search-tool");
		expect(active).toContain("lens-diagnostic");
		expect(active).toContain("note-take");
	});

	it("focus on pi.builtin errors", () => {
		const msg = focusUnit(pi, "pi.builtin");
		expect(msg).toContain("out of tbox's scope");
	});

	it("actuation is refused while in focus mode", () => {
		focusUnit(pi, "+host.api");

		const toggleMsg = actuateToolset(pi, "portal.web", true);
		expect(toggleMsg).toContain("focus mode");

		const allMsg = toggleAll(pi, true);
		expect(allMsg).toContain("focus mode");

		const groupMsg = actuateGroup(pi, "my-group", true);
		expect(groupMsg).toContain("focus mode");
	});

	// -----------------------------------------------------------------------
	// Slot state
	// -----------------------------------------------------------------------

	it("slot state is pristine when all extension tools are active (n=0)", () => {
		const state = computeSlotState(pi);
		expect(state).toEqual({ kind: "pristine" });
	});

	it("slot shows count when extension tools are excluded", () => {
		// Disable one toolset
		const registry = getRegisteredToolsets();
		const hostEntry = registry.find(
			(e: RegistryEntry) => e.spec.id === "host.api",
		)!;
		hostEntry.toolset.disable(pi);

		const state = computeSlotState(pi);
		expect(state.kind).toBe("count");
		if (state.kind === "count") {
			expect(state.n).toBeGreaterThan(0);
		}
	});

	it("slot shows focus state during focus", () => {
		focusUnit(pi, "+host.api");

		const state = computeSlotState(pi);
		expect(state.kind).toBe("focus");
		if (state.kind === "focus") {
			expect(state.unit).toContain("host.api");
			expect(state.count).toBeGreaterThan(0);
		}
	});

	it("focus on an empty group errors gracefully", () => {
		writeGroup("empty-group", { toolsets: [] });
		const msg = focusUnit(pi, "empty-group");
		expect(msg).toContain("no toolsets");
	});

	// -----------------------------------------------------------------------
	// Char count
	// -----------------------------------------------------------------------

	it("chars is deterministic across two calls in the same state", () => {
		const first = computeCharCount(pi);
		const second = computeCharCount(pi);
		expect(first).toEqual(second);
		expect(first.core).toBeGreaterThan(0);
		expect(first.extension).toBeGreaterThan(0);
	});

	it("formatCharSplit includes core, extension, and total", () => {
		const split = computeCharCount(pi);
		const line = formatCharSplit(split);
		expect(line).toContain("core:");
		expect(line).toContain("extension:");
		expect(line).toContain("total:");
		expect(line).toContain(String(split.core + split.extension));
	});

	// -----------------------------------------------------------------------
	// Status
	// -----------------------------------------------------------------------

	it("formatStatus includes all sections", () => {
		const output = formatStatus(pi);
		expect(output).toContain("Toolset Status");
		expect(output).toContain("portal.web");
		expect(output).toContain("portal.learn");
		expect(output).toContain("host.api");
		expect(output).toContain("search.web");
		expect(output).toContain("pi.builtin");
		expect(output).toContain("User Groups");
		expect(output).toContain("Focus:");
		expect(output).toContain("Char count");
	});

	// -----------------------------------------------------------------------
	// Group management via dispatchCommand (end-to-end through the handler)
	// -----------------------------------------------------------------------

	it("bikeshed: dispatchCommand routes bare /tbox to formatBareHelp", async () => {
		// Load the factory (which registers the command) on top of our fixture
		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		await mock.dispatchCommand("");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Subcommands");
	});

	it("bikeshed: dispatchCommand group list shows groups", async () => {
		writeGroup("test-group", { toolsets: ["portal.web"] });

		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		await mock.dispatchCommand("group list");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("test-group");
	});

	it("bikeshed: dispatchCommand /tbox chars renders budget view", async () => {
		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		await mock.dispatchCommand("chars");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toMatch(
			/^Context budget \(toolsets, most expensive first\):/,
		);
	});

	// -----------------------------------------------------------------------
	// Per-source orphan toolset shape
	// -----------------------------------------------------------------------

	it("per-source orphan toolsets exist for each unclaimed source", () => {
		const registry = getRegisteredToolsets();
		const ids = registry.map((e: RegistryEntry) => e.spec.id);

		expect(ids).toContain("tbox.tool@pi-lens");
		expect(ids).toContain("tbox.tool@notes-plugin");
	});

	it("single-tool orphan source gets description passed through", () => {
		const registry = getRegisteredToolsets();
		const notesEntry = registry.find(
			(e: RegistryEntry) => e.spec.id === "tbox.tool@notes-plugin",
		);
		expect(notesEntry).toBeDefined();
		// Single tool → description should be present
		expect(notesEntry!.spec.description).toBe("Take notes quickly");
	});

	it("multi-tool orphan source has no description", () => {
		const registry = getRegisteredToolsets();
		const lensEntry = registry.find(
			(e: RegistryEntry) => e.spec.id === "tbox.tool@pi-lens",
		);
		expect(lensEntry).toBeDefined();
		// Multi-tool → no description
		expect(lensEntry!.spec.description).toBeUndefined();
	});
});
