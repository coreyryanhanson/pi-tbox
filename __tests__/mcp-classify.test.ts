/**
 * MCP togglable classification and the pi-managed display group (Batch 3).
 *
 * Covers: isTogglableTool gating on declarable exposure, the core/extension
 * split with MCP tools, extensionToolCounts (n masked), activeTogglableChars
 * surviving formatByChars' zero-char skip, resource tools rendering under
 * pi-managed in both views exactly once, empty pi-managed rendering nothing,
 * unloaded non-declarable tools appearing nowhere, and the tool_search
 * mid-session load case — with core: agreement between /tbox status
 * (computeCharCount) and /tbox list's footer.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockPI, branchOf } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { syncMcpToolsets } from "../src/registry.js";
import {
	computeCharCount,
	extensionToolCounts,
	isTogglableTool,
	serializeToolDef,
} from "../src/chars.js";
import {
	formatByChars,
	formatGroupedList,
	formatStatus,
} from "../src/list.js";


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUILTIN_SOURCE = {
	path: "builtin:mcp",
	source: "builtin" as const,
	scope: "user" as const,
	origin: "top-level" as const,
};

function registerMcpTool(
	mock: MockPI,
	server: string,
	name: string,
	exposure?: "codemode" | "deferred" | "direct" | "hidden",
): void {
	mock.registerTool({
		name,
		description: `${name} description`,
		namespace: { name: `mcp__${server}` },
		sourceInfo: BUILTIN_SOURCE,
		...(exposure ? { exposure } : {}),
	});
}

function registerBuiltinTool(mock: MockPI, name: string): void {
	mock.registerTool({
		name,
		description: `${name} description`,
		sourceInfo: {
			path: "builtin.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});
}

function registerResourceTool(mock: MockPI, name: string): void {
	mock.registerTool({
		name,
		description: `${name} description`,
		sourceInfo: BUILTIN_SOURCE,
	});
}

const asPi = (m: MockPI): ExtensionAPI => m as unknown as ExtensionAPI;

/** All tools active by default, like pi activating declarable MCP tools. */
function activateAll(mock: MockPI): void {
	mock.setActiveTools(mock.getAllTools().map((t) => t.name));
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** Core number from /tbox status's char line. */
function statusCore(out: string): number {
	const m = out.match(/core: (\d+) \| extension/);
	expect(m).not.toBeNull();
	return Number(m![1]);
}

/** Core number from /tbox list's footer. */
function listCore(out: string): number {
	const m = out.match(/core: (\d+) \| extension: (\d+)\)/);
	expect(m).not.toBeNull();
	return Number(m![1]);
}

beforeEach(() => {
	MockPI.cleanRegistry();
});

// ---------------------------------------------------------------------------
// isTogglableTool
// ---------------------------------------------------------------------------

describe("isTogglableTool", () => {
	it("accepts extension tools and declarable (direct) MCP tools", () => {
		const mock = new MockPI();
		mock.registerTool({
			name: "ext-tool",
			description: "",
			sourceInfo: {
				path: "ext.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		registerMcpTool(mock, "srv", "mcp__srv__tool", "direct");
		registerMcpTool(mock, "srv", "mcp__srv__noexposure"); // pre-0.99 default
		const tools = new Map(mock.getAllTools().map((t) => [t.name, t]));
		expect(isTogglableTool(tools.get("ext-tool")!)).toBe(true);
		expect(isTogglableTool(tools.get("mcp__srv__tool")!)).toBe(true);
		expect(isTogglableTool(tools.get("mcp__srv__noexposure")!)).toBe(true);
	});

	it("rejects non-declarable MCP tools, resource tools, and builtin/sdk", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "srv", "mcp__srv__cm", "codemode");
		registerMcpTool(mock, "srv", "mcp__srv__df", "deferred");
		registerMcpTool(mock, "srv", "mcp__srv__hd", "hidden");
		registerResourceTool(mock, "list_mcp_resources");
		registerBuiltinTool(mock, "read");
		mock.registerTool({
			name: "sdk-tool",
			description: "",
			sourceInfo: {
				path: "sdk.ts",
				source: "sdk",
				scope: "user",
				origin: "top-level",
			},
		});
		const tools = new Map(mock.getAllTools().map((t) => [t.name, t]));
		for (const name of [
			"mcp__srv__cm",
			"mcp__srv__df",
			"mcp__srv__hd",
			"list_mcp_resources",
			"read",
			"sdk-tool",
		]) {
			expect(isTogglableTool(tools.get(name)!)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Char-count buckets
// ---------------------------------------------------------------------------

describe("char-count classification with MCP tools", () => {
	it("books an active declarable MCP tool to extension, not core", () => {
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		registerMcpTool(mock, "srv", "mcp__srv__tool");
		activateAll(mock);

		const split = computeCharCount(asPi(mock));
		const mcpChars = serializeToolDef(
			mock.getAllTools().find((t) => t.name === "mcp__srv__tool")!,
		).length;
		expect(split.extension).toBe(mcpChars);
		expect(split.core).toBe(
			serializeToolDef(mock.getAllTools()[0]!).length,
		);
	});

	it("books an active non-declarable MCP tool (tool_search-loaded) to core", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "srv", "mcp__srv__deferred_tool", "deferred");
		// tool_search's setActiveTools flips it into the active set mid-session;
		// its exposure field never changes.
		mock.setActiveTools(["mcp__srv__deferred_tool"]);

		const split = computeCharCount(asPi(mock));
		expect(split.core).toBeGreaterThan(0);
		expect(split.extension).toBe(0);
	});

	it("counts non-declarable tools in neither n masked nor any bucket", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "srv", "mcp__srv__tool", "codemode");
		registerMcpTool(mock, "srv", "mcp__srv__tool2", "hidden");

		const counts = extensionToolCounts(asPi(mock));
		expect(counts.total).toBe(0);
		expect(counts.active).toBe(0);

		// Even when pi activates them, they are not togglable budget —
		// but they are declared context, so they book to core.
		mock.setActiveTools(["mcp__srv__tool", "mcp__srv__tool2"]);
		const split = computeCharCount(asPi(mock));
		expect(split.extension).toBe(0);
		expect(split.core).toBeGreaterThan(0);
	});
});

describe("extensionToolCounts with MCP tools", () => {
	it("an all-MCP toolset toggled off raises n masked", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "srv", "mcp__srv__a");
		registerMcpTool(mock, "srv", "mcp__srv__b");
		syncMcpToolsets(asPi(mock), []);

		// All active: nothing masked.
		activateAll(mock);
		expect(extensionToolCounts(asPi(mock))).toEqual({ total: 2, active: 2 });

		// Toggled off: undeclared, and the slot must not stay pristine.
		mock.setActiveTools([]);
		const counts = extensionToolCounts(asPi(mock));
		expect(counts.total).toBe(2);
		expect(counts.active).toBe(0);
		expect(counts.total - counts.active).toBe(2); // n masked
	});
});

// ---------------------------------------------------------------------------
// Grouped view
// ---------------------------------------------------------------------------

describe("formatGroupedList with MCP tools", () => {
	it("renders claimed MCP tools in their toolset row, not pi.builtin", () => {
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		registerMcpTool(mock, "srv", "mcp__srv__a");
		registerMcpTool(mock, "srv", "mcp__srv__b", "codemode");
		activateAll(mock);
		syncMcpToolsets(asPi(mock), []);

		const out = formatGroupedList(asPi(mock));
		expect(out).toContain("tbox.mcp@srv (1 active, 0 inactive, +153 chars)");
		expect(out).toContain("mcp__srv__a");
		// The codemode tool is active but no toolset claims it.
		expect(out).toContain("pi-managed (1 active");
		expect(out).toContain("mcp__srv__b\n");
		// pi.builtin must list only the real builtin, and no MCP tool is
		// double-listed: each mcp__* name renders exactly once overall.
		expect(out).toContain("pi.builtin (1 active, +138 chars, core)");
		expect(out).toContain("    read\n");
		expect(countOccurrences(out, "mcp__srv__a")).toBe(1);
		expect(countOccurrences(out, "mcp__srv__b")).toBe(1);
		// Chars: toolset in extension bucket, pi-managed in core.
		expect(out).toMatch(/extension: [1-9]/);
		expect(out).toMatch(/core: [1-9]/);
	});

	it("keeps core: in agreement with /tbox status", () => {
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		registerBuiltinTool(mock, "bash");
		registerMcpTool(mock, "srv", "mcp__srv__a");
		registerResourceTool(mock, "list_mcp_resources");
		// Active sdk tools render no row but are booked to core by
		// computeCharCount — the footer must include them too.
		mock.registerTool({
			name: "sdk-x",
			description: "host custom tool",
			sourceInfo: {
				path: "host.ts",
				source: "sdk",
				scope: "user",
				origin: "top-level",
			},
		});
		activateAll(mock);
		syncMcpToolsets(asPi(mock), []);

		expect(listCore(formatGroupedList(asPi(mock)))).toBe(
			statusCore(formatStatus(asPi(mock), branchOf(mock))),
		);
	});

	it("books an active unclaimed declarable MCP tool to extension, agreeing with /tbox status", () => {
		// Reachable when a server's toolset registration is skipped (e.g. the
		// id-squat guard): pi activates the tool but no toolset claims it.
		// The display group is pi-managed, but the char bucket follows
		// togglability, so it must agree with computeCharCount (extension).
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		registerMcpTool(mock, "srv", "mcp__srv__a");
		activateAll(mock);
		// No syncMcpToolsets — nothing claims mcp__srv__a.

		const out = formatGroupedList(asPi(mock));
		expect(out).toContain("pi-managed (1 active");
		expect(listCore(out)).toBe(
			statusCore(formatStatus(asPi(mock), branchOf(mock))),
		);
		// The tool is togglable, so it must land in the extension bucket
		// (the builtin read is the only core tool).
		expect(out).toMatch(/extension: [1-9]/);
		expect(listCore(out)).toBeGreaterThan(0);
	});

	it("renders the shared resource tools under pi-managed, active with chars", () => {
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		registerResourceTool(mock, "list_mcp_resources");
		registerResourceTool(mock, "read_mcp_resource");
		activateAll(mock);

		const out = formatGroupedList(asPi(mock));
		expect(out).toContain("pi-managed (2 active");
		expect(out).toContain("list_mcp_resources\n");
		expect(out).toContain("read_mcp_resource\n");
		// Their chars are booked to core, never to a toolset row.
		const managedSection = out.split("pi-managed")[1] ?? "";
		expect(managedSection).not.toContain("tbox.mcp@");
	});

	it("renders an inactive resource tool as name (inactive) at zero chars", () => {
		const mock = new MockPI();
		registerResourceTool(mock, "list_mcp_resources");
		registerResourceTool(mock, "read_mcp_resource");
		// One loaded mid-session by tool_search, one not.
		mock.setActiveTools(["list_mcp_resources"]);

		const out = formatGroupedList(asPi(mock));
		expect(out).toContain("pi-managed (1 active");
		expect(out).toContain("read_mcp_resource (inactive)");
		expect(out).not.toContain("read_mcp_resource\n");
	});

	it("renders no pi-managed header when it would be empty", () => {
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		registerMcpTool(mock, "srv", "mcp__srv__a");
		activateAll(mock);
		syncMcpToolsets(asPi(mock), []);

		const out = formatGroupedList(asPi(mock));
		expect(out).not.toContain("pi-managed");
	});

	it("shows an inactive unclaimed MCP tool nowhere", () => {
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		registerMcpTool(mock, "srv", "mcp__srv__loaded", "deferred");
		registerMcpTool(mock, "srv", "mcp__srv__unloaded", "codemode");
		mock.setActiveTools(["read", "mcp__srv__loaded"]);

		const out = formatGroupedList(asPi(mock));
		expect(out).toContain("pi-managed (1 active");
		expect(out).toContain("mcp__srv__loaded\n");
		expect(out).not.toContain("mcp__srv__unloaded");
	});

	it("routes a tool_search-loaded deferred MCP tool to pi-managed with core chars", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "srv", "mcp__srv__deferred_tool", "deferred");
		mock.setActiveTools(["mcp__srv__deferred_tool"]);
		// No toolset was ever created for the codemode-default server.

		const out = formatGroupedList(asPi(mock));
		expect(out).toContain("pi-managed (1 active");
		expect(out).toContain("mcp__srv__deferred_tool\n");
		expect(listCore(out)).toBe(
			statusCore(formatStatus(asPi(mock), branchOf(mock))),
		);
	});
});

// ---------------------------------------------------------------------------
// Chars view
// ---------------------------------------------------------------------------

describe("formatByChars with MCP tools", () => {
	it("keeps a fully-active MCP toolset past the zero-char skip", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "srv", "mcp__srv__a");
		registerMcpTool(mock, "srv", "mcp__srv__b");
		syncMcpToolsets(asPi(mock), []);
		activateAll(mock);

		const out = formatByChars(asPi(mock));
		expect(out).toContain("tbox.mcp@srv");
		expect(out).toMatch(/\+[\d]+/);
	});
});

// ---------------------------------------------------------------------------
// Status view
// ---------------------------------------------------------------------------

describe("formatStatus with MCP tools", () => {
	it("lists MCP tools under their toolset and resource tools under pi-managed, exactly once", () => {
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		registerMcpTool(mock, "srv", "mcp__srv__a");
		registerMcpTool(mock, "srv", "mcp__srv__b", "codemode");
		registerResourceTool(mock, "list_mcp_resources");
		registerResourceTool(mock, "read_mcp_resource");
		activateAll(mock);
		syncMcpToolsets(asPi(mock), []);

		const out = formatStatus(asPi(mock), branchOf(mock));
		// Each resource tool appears exactly once across /tbox list (names
		// rendered); /tbox status shows counts, so assert the row math.
		const listOut = formatGroupedList(asPi(mock));
		for (const name of ["list_mcp_resources", "read_mcp_resource"]) {
			expect(countOccurrences(listOut, name)).toBe(1);
		}
		// pi.builtin excludes per-server MCP tools and resource tools.
		const builtinRow = out.match(/pi\.builtin\s+✓\s+(\d+)/)![1];
		expect(builtinRow).toBe("1"); // just "read"
		// The toolset row carries the per-server tools.
		expect(out).toMatch(/tbox\.mcp@srv\s+✓\s+1/);
		// pi-managed: 2 resource tools + 1 active unclaimed codemode tool.
		expect(out).toMatch(/pi-managed\s+✓\s+3 \(3 active\)/);
	});

	it("renders no pi-managed row when empty", () => {
		const mock = new MockPI();
		registerBuiltinTool(mock, "read");
		activateAll(mock);

		const out = formatStatus(asPi(mock), branchOf(mock));
		expect(out).not.toContain("pi-managed");
	});

	it("keeps inactive resource tools out of n masked", () => {
		const mock = new MockPI();
		registerResourceTool(mock, "list_mcp_resources");
		registerMcpTool(mock, "srv", "mcp__srv__a", "deferred");

		const counts = extensionToolCounts(asPi(mock));
		expect(counts.total).toBe(0);
		expect(counts.active).toBe(0);
	});
});
