import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatList,
	formatStatus,
	formatBareHelp,
	formatGroupedList,
	formatFlatList,
} from "../src/list.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { setFocusUnit } from "../src/status-slot.js";
import { setSettingsOverrideForTests } from "../config/settings-reader.js";
import { getRegisteredToolsets } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fg(color: string, text: string): string {
	return `<${color}>${text}</${color}>`;
}

/**
 * Set up a standard multi-extension tool population for integration tests.
 * Builtins: read, bash
 * SDK: custom-x
 * portal.web (masked, 3 members): web-fetch, browser-navigate, page-read
 * portal.learn (unmasked, 1 member, requires portal.web): web-learn
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
		// big = {a, b, c, web-learn} (size 4), small = {web-learn} (size 1)
		for (const name of ["a", "b", "c", "web-learn"]) {
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
			names: new Set(["a", "b", "c", "web-learn"]),
			persistKey: "toolset-state:big",
		});
		mock.defineFakeToolset({
			id: "small",
			names: new Set(["web-learn"]),
			persistKey: "toolset-state:small",
		});

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatGroupedList(pi);

		// Sections are ordered by group insertion
		const bigIdx = output.indexOf("big (4 tools)");
		const smallIdx = output.indexOf("small (1 tool)");

		expect(bigIdx).toBeGreaterThanOrEqual(0);
		expect(smallIdx).toBeGreaterThanOrEqual(0);

		// Everything between big and small is the big section
		const bigSection = output.slice(bigIdx, smallIdx);
		expect(bigSection).toContain("a");
		expect(bigSection).toContain("b");
		expect(bigSection).toContain("c");
		expect(bigSection).not.toContain("web-learn");

		// Everything from small onward is the small section
		const smallSection = output.slice(smallIdx);
		expect(smallSection).toContain("web-learn");
	});

	it("shows masked toolset as one row with members suppressed", () => {
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
			masked: true,
		});

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatGroupedList(pi);

		expect(output).toContain("Portal Web");
		expect(output).toContain("(masked");
		expect(output).toContain("members hidden");

		// Individual member names should NOT appear
		expect(output).not.toContain("web-fetch");
		expect(output).not.toContain("browser-navigate");
		expect(output).not.toContain("page-read");
	});

	it("shows unmasked toolset members as individual rows", () => {
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
			masked: false,
		});

		autoRegisterBuiltinAndOrphans(pi);

		const output = formatGroupedList(pi);

		expect(output).toContain("Portal Learn");
		expect(output).toContain("web-learn");
	});

	it("routes orphan extension tools under their source label", () => {
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
		expect(output).toContain("extension (1 tool)");
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
});

describe("formatBareHelp", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	it("includes the current slot text", () => {
		const output = formatBareHelp(pi, fg);

		expect(output).toContain("<dim>○</dim> tbox");
	});

	it("lists available subcommands", () => {
		const output = formatBareHelp(pi, fg);

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
		setSettingsOverrideForTests(null);
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

	it("shows toolset state (enabled/disabled)", () => {
		setupRichMock(mock, pi);

		const output = formatStatus(pi);
		expect(output).toContain("enabled");
	});

	it("shows masked flag on masked toolsets", () => {
		setupRichMock(mock, pi);

		const output = formatStatus(pi);
		expect(output).toContain("masked");
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

	it("non-reserved unknown name is treated as a group shorthand (usage pointer)", async () => {
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		// Sprint 3: non-reserved names are group shorthand, not errors.
		await mock.dispatchCommand("unknown-sub");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Usage");
		expect(notify!.message).toContain("unknown-sub on");
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
