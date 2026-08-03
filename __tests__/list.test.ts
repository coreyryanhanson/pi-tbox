import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatList,
	formatStatus,
	formatBareHelp,
	formatGroupedList,
	formatFlatList,
	formatByChars,
} from "../src/list.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { setFocusUnit } from "../src/status-slot.js";
import { setGroupsOverrideForTests } from "../config/settings-reader.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set up a standard multi-extension tool population for integration tests.
 * Builtins: read, bash
 * SDK: custom-x
 * portal.web (3 members): web-fetch, browser-navigate, page-read
 * portal.learn (1 member, requires portal.web): web-learn
 * Orphan: orphan-tool
 *
 * After setup, call enableToolsets() to simulate tools being active.
 */
function registerTools(mock: MockPI): void {
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
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "browser-navigate",
		description: "Browser navigate tool",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "page-read",
		description: "Page read tool",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "web-learn",
		description: "Web learn tool",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
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

function enableAllToolsets(pi: ExtensionAPI): void {
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi);
	}
}

function setupRichMock(mock: MockPI, pi: ExtensionAPI): void {
	registerTools(mock);
	defineFakeToolsets(mock);
	autoRegisterBuiltinAndOrphans(pi);
	enableAllToolsets(pi);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatGroupedList", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	it("shows smallest-toolset-wins with no duplication", () => {
		// big = {a, b, c} (size 3), small = {d} (size 1) — disjoint names per
		// pi-tool-masking@1.1.0 name-overlap guard
		for (const name of ["a", "b", "c", "d"]) {
			mock.registerTool({
				name,
				description: `Tool ${name}`,
				sourceInfo: {
					path: "ext.ts",
					source: "extension",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		mock.defineFakeToolset({
			id: "big",
			names: new Set(["a", "b", "c"]),
			persistKey: "toolset-state:big",
		});
		mock.defineFakeToolset({
			id: "small",
			names: new Set(["d"]),
			persistKey: "toolset-state:small",
		});

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatGroupedList(pi);

		// Sections are ordered by group insertion
		const bigIdx = output.indexOf("big (0 active, 3 inactive, +0 chars)");
		const smallIdx = output.indexOf("small (0 active, 1 inactive, +0 chars)");

		expect(bigIdx).toBeGreaterThanOrEqual(0);
		expect(smallIdx).toBeGreaterThanOrEqual(0);

		// Everything between big and small is the big section
		const bigSection = output.slice(bigIdx, smallIdx);
		expect(bigSection).toContain("a");
		expect(bigSection).toContain("b");
		expect(bigSection).toContain("c");
		expect(bigSection).not.toContain("d");

		// Everything from small onward is the small section
		const smallSection = output.slice(smallIdx);
		expect(smallSection).toContain("d");
	});

	it("shows toolset members as individual rows", () => {
		for (const name of ["web-fetch", "browser-navigate", "page-read"]) {
			mock.registerTool({
				name,
				description: `Tool ${name}`,
				sourceInfo: {
					path: "portal.ts",
					source: "extension",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		mock.defineFakeToolset({
			id: "portal.web",
			label: "Portal Web",
			names: new Set(["web-fetch", "browser-navigate", "page-read"]),
			persistKey: "toolset-state:portal.web",
			defaultEnabled: true,
		});

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatGroupedList(pi);

		expect(output).toContain("portal.web");
		expect(output).toContain("web-fetch");
		expect(output).toContain("browser-navigate");
		expect(output).toContain("page-read");
	});

	it("shows single-member toolset as a row", () => {
		mock.registerTool({
			name: "web-learn",
			description: "Web learn",
			sourceInfo: {
				path: "portal.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});

		mock.defineFakeToolset({
			id: "portal.learn",
			label: "Portal Learn",
			names: new Set(["web-learn"]),
			persistKey: "toolset-state:portal.learn",
			defaultEnabled: true,
		});

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatGroupedList(pi);

		expect(output).toContain("portal.learn");
		expect(output).toContain("web-learn");
	});

	it("routes orphan extension tools under their toolset id", () => {
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

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatGroupedList(pi);

		// The label from registry.ts is the source string ("extension")
		expect(output).toContain(
			"tbox.tool@extension (0 active, 1 inactive, +0 chars)",
		);
		expect(output).toContain("orphan-tool");
	});

	it("excludes sdk tools from grouped view entirely", () => {
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

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatGroupedList(pi);

		expect(output).not.toContain("custom-x");
	});

	it("filters by active tools only", () => {
		for (const name of ["tool-a", "tool-b"]) {
			mock.registerTool({
				name,
				description: `Tool ${name}`,
				sourceInfo: {
					path: "ext.ts",
					source: "extension",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		autoRegisterBuiltinAndOrphans(pi);
		mock.setActiveTools(["tool-a"]);

		const output = formatGroupedList(pi, { active: true });

		expect(output).toContain("tool-a");
		expect(output).not.toContain("tool-b");
	});

	it("filters by inactive tools only", () => {
		for (const name of ["tool-a", "tool-b"]) {
			mock.registerTool({
				name,
				description: `Tool ${name}`,
				sourceInfo: {
					path: "ext.ts",
					source: "extension",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		autoRegisterBuiltinAndOrphans(pi);
		mock.setActiveTools(["tool-a"]);

		const output = formatGroupedList(pi, { inactive: true });

		expect(output).toContain("tool-b");
		expect(output).not.toContain("tool-a");
	});
});

describe("formatFlatList", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	it("shows sdk tools as read-only rows", () => {
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

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatFlatList(pi);

		expect(output).toContain("custom-x");
		expect(output).toContain("host-managed");
		// Tabular header + glyph column; trailing (inactive) marker is gone
		expect(output).toMatch(/active\s+tool\s+group/);
		expect(output).not.toContain("(inactive)");
	});

	it("shows builtin tools normally", () => {
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

		const output = formatFlatList(pi);

		expect(output).toContain("read");
	});

	it("filters by active tools", () => {
		for (const name of ["tool-a", "tool-b"]) {
			mock.registerTool({
				name,
				description: `Tool ${name}`,
				sourceInfo: {
					path: "ext.ts",
					source: "extension",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		autoRegisterBuiltinAndOrphans(pi);
		mock.setActiveTools(["tool-a"]);

		const output = formatFlatList(pi, { active: true });

		expect(output).toContain("tool-a");
		expect(output).not.toContain("tool-b");
		// Active row carries the checkmark glyph
		expect(output).toContain("\u2713");
	});

	it("filters by inactive tools", () => {
		for (const name of ["tool-a", "tool-b"]) {
			mock.registerTool({
				name,
				description: `Tool ${name}`,
				sourceInfo: {
					path: "ext.ts",
					source: "extension",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		autoRegisterBuiltinAndOrphans(pi);
		mock.setActiveTools(["tool-a"]);

		const output = formatFlatList(pi, { inactive: true });

		expect(output).toContain("tool-b");
		expect(output).not.toContain("tool-a");
	});
});

describe("formatByChars", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	it("shows toolsets sorted by char count descending", () => {
		setupRichMock(mock, pi);

		const output = formatByChars(pi);

		// Header
		expect(output).toMatch(
			/^Context budget \(toolsets, most expensive first\):/,
		);

		// All three extension toolsets present
		expect(output).toContain("portal.web");
		expect(output).toContain("portal.learn");
		expect(output).toContain("tbox.tool@extension");

		// Builtins excluded
		expect(output).not.toContain("pi.builtin");

		// Sorted by char count descending (portal.web > portal.learn > tbox.tool@extension)
		const webIdx = output.indexOf("portal.web");
		const learnIdx = output.indexOf("portal.learn");
		const orphanIdx = output.indexOf("tbox.tool@extension");
		expect(webIdx).toBeGreaterThan(0);
		expect(learnIdx).toBeGreaterThan(webIdx);
		expect(orphanIdx).toBeGreaterThan(learnIdx);

		// Tabular header present
		expect(output).toMatch(/toolset\s+active\s+\+chars/);

		// Footer present with matching total (no inactive column)
		expect(output).toMatch(/Total\s+5\s+\+722/);
		expect(output).not.toMatch(/inactive/);
	});

	it("excludes builtins from chars view", () => {
		setupRichMock(mock, pi);

		const output = formatByChars(pi);

		expect(output).not.toContain("pi.builtin");
		expect(output).not.toContain("core");
	});

	it("shows empty message when no tools match", () => {
		// No tools registered
		const output = formatByChars(pi);

		expect(output).toContain(
			"No toolsets are consuming context budget right now.",
		);
	});
});

describe("formatList (dispatch)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	it("returns grouped view by default", () => {
		const output = formatList(pi, "list");
		expect(output).toContain("Tools by group");
	});

	it("returns flat view with --flat flag", () => {
		const output = formatList(pi, "list --flat");
		expect(output).toContain("All tools");
	});

	it("errors when --active and --inactive are combined", () => {
		const output = formatList(pi, "list --active --inactive");
		expect(output).toContain("Error");
		expect(output).toContain("--active");
		expect(output).toContain("--inactive");
		expect(output).toContain("See: /tbox list --help.");
	});

	it("handles combined --flat --inactive flags", () => {
		for (const name of ["tool-a", "tool-b"]) {
			mock.registerTool({
				name,
				description: `Tool ${name}`,
				sourceInfo: {
					path: "ext.ts",
					source: "extension",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		autoRegisterBuiltinAndOrphans(pi);
		mock.setActiveTools(["tool-a"]);

		const output = formatList(pi, "list --flat --inactive");
		expect(output).toContain("All tools");
		expect(output).toContain("tool-b");
		expect(output).not.toContain("tool-a");
	});

	it("errors when unknown flag --grouped is used", () => {
		const output = formatList(pi, "list --grouped");
		expect(output).toContain("Error");
		expect(output).toContain("unknown flag");
		expect(output).toContain("--grouped");
		expect(output).toContain("See: /tbox list --help.");
	});

	it("--help returns the help text", () => {
		const output = formatList(pi, "list --help");
		expect(output).toContain("/tbox list [view] [filter]");
		expect(output).toContain("--flat");
		expect(output).toContain("--active");
		expect(output).toContain("--inactive");
	});

	it("unknown flag returns error with --help pointer", () => {
		const output = formatList(pi, "list --foo");
		expect(output).toContain("Error");
		expect(output).toContain("--foo");
		expect(output).toContain("See: /tbox list --help.");
	});

	it("multiple unknown flags uses plural", () => {
		const output = formatList(pi, "list --foo --bar");
		expect(output).toContain("Error");
		expect(output).toContain("unknown flags");
		expect(output).toContain("--foo, --bar");
		expect(output).toContain("See: /tbox list --help.");
	});
});

describe("formatBareHelp", () => {
	it("lists available subcommands", () => {
		const output = formatBareHelp();

		expect(output).toContain("list");
		expect(output).toContain("status");
	});
});

describe("formatStatus", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
		setGroupsOverrideForTests(null);
	});

	it("prints a line per subsystem", () => {
		setupRichMock(mock, pi);

		const output = formatStatus(pi);

		expect(output).toContain("portal.web");
		expect(output).toContain("portal.learn");
		expect(output).toContain("tbox.tool@extension");

		// Builtins are shown separately (not in the registry)
		expect(output).toContain("pi.builtin");

		expect(output).toContain("User Groups:");
		expect(output).toContain("Focus: off");
	});

	it("shows toolset state via ✓/✗ glyphs", () => {
		setupRichMock(mock, pi);

		const output = formatStatus(pi);
		// Tabular header and ✓ glyph for enabled toolsets (all enabled here)
		expect(output).toMatch(/toolset\s+enabled\s+members/);
		expect(output).toContain("\u2713");
		expect(output).not.toContain("disabled");
	});

	it("shows ✗ for a disabled toolset", () => {
		setupRichMock(mock, pi);

		// Disable one toolset so its row carries the ✗ glyph
		const registry = getRegisteredToolsets();
		const learnEntry = registry.find(
			(e: RegistryEntry) => e.spec.id === "portal.learn",
		)!;
		learnEntry.toolset.disable(pi);

		const output = formatStatus(pi);
		expect(output).toContain("\u2717");
	});

	it("does not expose builtins as a toggleable toolset", () => {
		setupRichMock(mock, pi);

		const output = formatStatus(pi);
		expect(output).not.toContain("protected");
	});
});

describe("end-to-end via dispatchCommand", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);

		// Dynamic import for ESM compatibility
		const mod = await import("../index.js");
		mod.default(pi);
	});

	it("bare /tbox notifies slot text and help", async () => {
		// Fire session_start to trigger auto-registration and slot render
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		await mock.dispatchCommand("");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("tbox");
		expect(notify!.message).toContain("list");
	});

	it("/tbox list --flat shows all tools", async () => {
		mock.fireLifecycleEvent("session_start");
		mock.registerTool({
			name: "tool-a",
			description: "Tool A",
			sourceInfo: {
				path: "ext.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);
		mock.clearUiRecords();

		await mock.dispatchCommand("list --flat");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("All tools");
	});

	it("/tbox status includes all subsystem lines", async () => {
		// Fire session_start first so lastCtx is available for event handlers
		mock.fireLifecycleEvent("session_start");
		setupRichMock(mock, pi);
		mock.clearUiRecords();

		await mock.dispatchCommand("status");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Toolset Status");
		expect(notify!.message).toContain("User Groups:");
		expect(notify!.message).toContain("Focus:");
	});

	it("non-reserved unknown name shows creation hint when group doesn't exist", async () => {
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		// Non-reserved names are group shorthand. If the group
		// doesn't exist, describeGroup emits a creation hint instead of
		// a bare usage pointer.
		await mock.dispatchCommand("unknown-sub");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain('No group named "unknown-sub"');
		expect(notify!.message).toContain("Create one with:");
	});

	it("/tbox <unknown-group> on → no-group error (not 'Unknown subcommand')", async () => {
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		await mock.dispatchCommand("unknown-sub on");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain('No group named "unknown-sub"');
	});
});
