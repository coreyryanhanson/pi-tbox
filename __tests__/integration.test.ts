/**
 * Integration test — multi-extension end-to-end.
 *
 * Stands up a realistic registry with:
 *   - portal.web + portal.learn (requires web)
 *   - host.api + search.web
 *   - Two unclaimed-source plugins (pi-lens, notes-plugin)
 *   - builtins + sdk
 *
 * Retains the tests that need this realistic multi-extension population or
 * the dispatch seam and have no dedicated-suite home elsewhere: the grouped
 * list view across all extensions, actuation edge cases, the mid-focus
 * drift contract (both arms), and the /tbox dispatch regressions.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	MockPI,
	branchOf,
	pinSettingsDefaultsForTests,
	readerOf,
} from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	readBranchModeState,
	getRegisteredToolsets,
	setSettingsOverrideForTests,
} from "pi-tool-masking";
import {
	autoRegisterBuiltinAndOrphans,
	actuateNewToolsets,
} from "../src/registry.js";
import { setFocusUnit } from "../src/status-slot.js";
import { actuateGroup } from "../src/groups.js";
import { focusUnit } from "../src/focus.js";
import { formatList } from "../src/list.js";
import {
	writeGroup,
	readGroups,
	removeGroup,
	setGroupsOverrideForTests,
} from "../config/settings-reader.js";


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a realistic multi-extension tool population in the mock. */
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
	actuateNewToolsets(pi, newIds, branchOf(mock));

	// --- Enable all registered toolsets (simulate the library's restore) ---
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi, readerOf(mock));
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
		pinSettingsDefaultsForTests();
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

	afterEach(() => {
		setSettingsOverrideForTests(null);
		setGroupsOverrideForTests(null);
	});

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

	it("actuateGroup on an empty group returns a graceful message", () => {
		writeGroup("empty-group", { toolsets: [] });
		const msg = actuateGroup(pi, "empty-group", true, readerOf(mock));
		expect(msg).toContain("no actuable toolsets");
	});

	// Mid-focus drift: both arms (allowlisted newcomer on, unlisted off).
	it("during focus, a newly-registered toolset in the allowlist comes on; one not in it is off", () => {
		// Focus on a group that forward-references a not-yet-registered
		// toolset, so the allowlist includes it before it exists.
		writeGroup("fwd-group", { toolsets: ["host.api", "future.tool"] });
		focusUnit(pi, "fwd-group");
		expect(readBranchModeState(branchOf(mock)).allowlist).toEqual(["host.api", "future.tool"]);

		// Register the forward-referenced toolset now (mid-focus install).
		mock.registerTool({
			name: "future-tool",
			description: "Future tool",
			sourceInfo: {
				path: "future.ts",
				source: "future-plugin",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.defineFakeToolset({
			id: "future.tool",
			names: new Set(["future-tool"]),
			persistKey: "toolset-state:future.tool",
			defaultEnabled: true,
		});
		actuateNewToolsets(pi, ["future.tool"], branchOf(mock));
		expect(pi.getActiveTools()).toContain("future-tool");

		// A toolset NOT in the allowlist lands off.
		mock.registerTool({
			name: "later-tool",
			description: "Later tool",
			sourceInfo: {
				path: "later.ts",
				source: "later-plugin",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.defineFakeToolset({
			id: "later-plugin",
			names: new Set(["later-tool"]),
			persistKey: "toolset-state:later-plugin",
			defaultEnabled: true,
		});
		actuateNewToolsets(pi, ["later-plugin"], branchOf(mock));
		expect(pi.getActiveTools()).not.toContain("later-tool");
	});

	// -----------------------------------------------------------------------
	// Group management via dispatchCommand (end-to-end through the handler)
	// -----------------------------------------------------------------------

	it("dispatchCommand routes bare /tbox to formatBareHelp", async () => {
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

	it("dispatchCommand group list shows groups", async () => {
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

	it("/tbox group list <extra> shows usage, not a group lookup", async () => {
		// "list" is reserved, so trailing args are a usage mistake — show
		// usage rather than 'No group named "list"'.
		writeGroup("test-group", { toolsets: ["portal.web"] });

		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		await mock.dispatchCommand("group list oops");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Usage: /tbox group list");
		expect(notify!.message).not.toContain('No group named "list"');
	});

	it("dispatchCommand /tbox chars renders budget view", async () => {
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

	it("bare /tbox restore is reserved, not a group lookup", async () => {
		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		const activeBefore = new Set(pi.getActiveTools());
		await mock.dispatchCommand("restore");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain('Unknown subcommand: "restore"');
		expect(notify!.message).not.toContain("No group");
		expect(new Set(pi.getActiveTools())).toEqual(activeBefore);
	});

	it("/tbox group <reserved> edit refuses early without opening the picker", async () => {
		// Regression: `/tbox group list edit` used to reach editGroup("list"),
		// which opened the picker and then threw inside the save callback when
		// writeGroup rejected the reserved name.
		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");

		for (const name of ["list", "status", "+portal.web"]) {
			mock.clearUiRecords();
			// Queue a plausible picker interaction; if the picker ever opens,
			// the drain loop hits the onSave TypeError and the dispatch rejects.
			mock.setCustomKeySequence([mock.keyFor("ctrl+s")]);
			await mock.dispatchCommand(`group ${name} edit`);

			const notify = mock.getLastNotify();
			expect(notify).toBeDefined();
			expect(notify!.message).toContain(`"${name}" is not a valid group name`);
			expect(notify!.message).not.toContain("saved");
			expect(notify!.message).not.toContain("cancelled");
		}
	});
});
