/**
 * MCP toolset registration and re-scan tests (Batch 2).
 *
 * Covers: per-server declared-only toolset creation, codemode-only servers
 * producing no toolset, namespace collapse, in-place membership mutation
 * with the branch-aware intent reconcile, off-intent survival across a
 * disconnect/reconnect cycle, idempotency from both hook sites,
 * foreign-toolset name subtraction, and the /reload ensureRestoreHandler
 * path.
 *
 * @module
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
	MockPI,
	readerOf,
	useTempAgentDir,
} from "./mock-pi.js";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import { asPi, BUILTIN_SOURCE, registerMcpTool } from "./fixtures.js";
import { syncMcpToolsets } from "../src/registry.js";
import tboxFactory from "../index.js";
import { actuateToolset } from "../src/groups.js";

// File-wide temp settings dirs — never touches the developer's ~/.pi.
useTempAgentDir();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Push a raw ToolInfo with no exposure field (pre-0.99 degradation shape). */
function registerMcpToolNoExposure(mock: MockPI, server: string, name: string): void {
	(mock as unknown as { _tools: ToolInfo[] })._tools.push({
		name,
		description: `${name} description`,
		parameters: undefined as never,
		namespace: { name: `mcp__${server}` },
		sourceInfo: BUILTIN_SOURCE,
	} as unknown as ToolInfo);
}

function findEntry(id: string): RegistryEntry | undefined {
	return getRegisteredToolsets().find((e: RegistryEntry) => e.spec.id === id);
}


function pinIntent(mock: MockPI, id: string, enabled: boolean): void {
	mock.appendEntry(`toolset-state:${id}`, { enabled });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	MockPI.cleanRegistry();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("syncMcpToolsets — creation", () => {
	it("creates one declared-only toolset per server", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__create_note");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__search");
		// Non-declarable: never in the toolset.
		registerMcpTool(mock, "siyuan", "mcp__siyuan__deferred_tool", "codemode");

		syncMcpToolsets(asPi(mock), []);

		const entry = findEntry("tbox.mcp@siyuan");
		expect(entry).toBeDefined();
		expect([...entry!.spec.names]).toEqual([
			"mcp__siyuan__create_note",
			"mcp__siyuan__search",
		]);
		expect(entry!.spec.label).toBe("mcp__siyuan");
		expect(entry!.spec.persistKey).toBe("toolset-state:tbox.mcp@siyuan");
		expect(entry!.spec.defaultEnabled).toBe(true);
	});

	it("creates no toolset for a codemode-only server", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "lazy", "mcp__lazy__tool", "codemode");

		syncMcpToolsets(asPi(mock), []);

		expect(findEntry("tbox.mcp@lazy")).toBeUndefined();
	});

	it("collapses servers whose namespace is shared (a-b vs a_b)", () => {
		const mock = new MockPI();
		// Upstream maps - to _, so both servers' tools carry mcp__a_b.
		mock.registerTool({
			name: "mcp__a_b__from_dash",
			description: "from a-b",
			namespace: { name: "mcp__a_b" },
			sourceInfo: BUILTIN_SOURCE,
		});
		mock.registerTool({
			name: "mcp__a_b__from_underscore",
			description: "from a_b",
			namespace: { name: "mcp__a_b" },
			sourceInfo: BUILTIN_SOURCE,
		});

		syncMcpToolsets(asPi(mock), []);

		const mcpIds = getRegisteredToolsets()
			.map((e: RegistryEntry) => e.spec.id)
			.filter((id) => id.startsWith("tbox.mcp@"));
		expect(mcpIds).toEqual(["tbox.mcp@a_b"]);
		expect([...findEntry("tbox.mcp@a_b")!.spec.names]).toEqual([
			"mcp__a_b__from_dash",
			"mcp__a_b__from_underscore",
		]);
	});

	it("treats a missing exposure as direct (pre-0.99 degradation)", () => {
		const mock = new MockPI();
		registerMcpToolNoExposure(mock, "siyuan", "mcp__siyuan__old_pi_tool");

		syncMcpToolsets(asPi(mock), []);

		expect([...findEntry("tbox.mcp@siyuan")!.spec.names]).toEqual([
			"mcp__siyuan__old_pi_tool",
		]);
	});
});

// ---------------------------------------------------------------------------
// Membership changes
// ---------------------------------------------------------------------------

describe("syncMcpToolsets — membership changes", () => {
	it("mutates entry.spec.names in place when the declarable set changes", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t2");
		syncMcpToolsets(asPi(mock), []);

		// t1 gone (re-registered hidden), t3 appeared.
		(mock as unknown as { _tools: ToolInfo[] })._tools.length = 0;
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t2");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t3");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1", "hidden");
		syncMcpToolsets(asPi(mock), []);

		expect([...findEntry("tbox.mcp@siyuan")!.spec.names]).toEqual([
			"mcp__siyuan__t2",
			"mcp__siyuan__t3",
		]);
	});

	it("drops a newcomer from the active set in the same prompt when intent is off", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		pinIntent(mock, "tbox.mcp@siyuan", false);
		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		// New tool arrives; pi re-activates it on registration (direct tools
		// are activated regardless of masking's older re-assert read).
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t2");
		mock.setActiveTools(["mcp__siyuan__t1", "mcp__siyuan__t2"]);

		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		// t1 and t2 are both members of the intent-off toolset: the reconcile
		// drops the newcomer (and the stale t1) from the active set this prompt.
		expect(mock.getActiveTools()).toEqual([]);
	});

	it("leaves active tools alone when intent is on", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		pinIntent(mock, "tbox.mcp@siyuan", true);
		mock.setActiveTools(["mcp__siyuan__t1"]);

		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		expect(mock.getActiveTools()).toContain("mcp__siyuan__t1");
	});

	it("creates a new toolset applied off in the same prompt when intent is off", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		pinIntent(mock, "tbox.mcp@siyuan", false);
		mock.setActiveTools(["mcp__siyuan__t1"]);

		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		expect(findEntry("tbox.mcp@siyuan")).toBeDefined();
		expect(mock.getActiveTools()).not.toContain("mcp__siyuan__t1");
	});

	it("keeps hidden members instead of emptying a drained-to-zero toolset", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t2");
		syncMcpToolsets(asPi(mock), []);

		// Server drops/disables: tools re-registered hidden.
		(mock as unknown as { _tools: ToolInfo[] })._tools.length = 0;
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1", "hidden");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t2", "hidden");
		syncMcpToolsets(asPi(mock), []);

		// Entry stays live with its (hidden) members: a scan never visits a
		// server with zero declarable tools, so membership is never drained.
		// A toggle issued while disconnected persists off via the delta gate.
		expect(findEntry("tbox.mcp@siyuan")!.spec.names).toEqual(
			new Set(["mcp__siyuan__t1", "mcp__siyuan__t2"]),
		);
	});

	it("keeps drained members' off intent when the tools return", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		pinIntent(mock, "tbox.mcp@siyuan", false);
		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		// Drain to zero.
		(mock as unknown as { _tools: ToolInfo[] })._tools.length = 0;
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1", "hidden");
		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		// Server reconnects: tools return and pi re-activates them.
		(mock as unknown as { _tools: ToolInfo[] })._tools.length = 0;
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		mock.setActiveTools(["mcp__siyuan__t1"]);
		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		expect(mock.getActiveTools()).not.toContain("mcp__siyuan__t1");
	});
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("syncMcpToolsets — idempotency", () => {
	it("an unchanged re-scan performs no mutation and no warn-and-replace", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t2");
		syncMcpToolsets(asPi(mock), []);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		syncMcpToolsets(asPi(mock), []);
		syncMcpToolsets(asPi(mock), []);

		expect(warn).not.toHaveBeenCalled();
		expect([...findEntry("tbox.mcp@siyuan")!.spec.names]).toEqual([
			"mcp__siyuan__t1",
			"mcp__siyuan__t2",
		]);
	});

	it("emits no spurious changed event on an unchanged re-scan of an intent-off toolset", () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		pinIntent(mock, "tbox.mcp@siyuan", false);
		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());
		expect(mock.getActiveTools()).toEqual([]); // reconcile applied the off

		const events: unknown[] = [];
		mock.events.on("toolset:changed", (data: unknown) => events.push(data));
		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		// Members already undeclared: nothing to reconcile, no emit.
		expect(events).toEqual([]);
	});

	it("is idempotent from the per-prompt hook (before_agent_start)", () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");

		// Server connects after session_start.
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		mock.fireLifecycleEvent("before_agent_start");
		mock.fireLifecycleEvent("before_agent_start");

		expect([...findEntry("tbox.mcp@siyuan")!.spec.names]).toEqual([
			"mcp__siyuan__t1",
		]);
	});

	it("resolves toolsets and toggles from the command path with no prompt", () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");

		// Server connects; user runs /tbox list without submitting a prompt.
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		mock.dispatchCommand("list");
		expect(mock.getLastNotify()!.message).toContain("tbox.mcp@siyuan");

		// The toggle command resolves the freshly-registered toolset.
		const output = actuateToolset(
			asPi(mock),
			"tbox.mcp@siyuan",
			false,
			readerOf(mock),
		);
		expect(output).toContain("tbox.mcp@siyuan");
	});
});

// ---------------------------------------------------------------------------
// Foreign toolsets
// ---------------------------------------------------------------------------

describe("syncMcpToolsets — foreign toolsets", () => {
	it("excludes a foreign toolset's claimed mcp__ name and does not throw", () => {
		const mock = new MockPI();
		mock.defineFakeToolset({
			id: "other.web",
			label: "other.web",
			names: new Set(["mcp__siyuan__t1"]),
			persistKey: "toolset-state:other.web",
		});
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t2");

		expect(() => syncMcpToolsets(asPi(mock), [])).not.toThrow();

		expect([...findEntry("tbox.mcp@siyuan")!.spec.names]).toEqual([
			"mcp__siyuan__t2",
		]);
		// The foreign toolset's names are untouched.
		expect([...findEntry("other.web")!.spec.names]).toEqual([
			"mcp__siyuan__t1",
		]);
	});

	it("leaves a foreign tbox.*-prefixed toolset byte-identical", () => {
		const mock = new MockPI();
		mock.defineFakeToolset({
			id: "tbox.other.thing",
			label: "tbox.other.thing",
			names: new Set(["mcp__siyuan__t1", "unrelated"]),
			persistKey: "toolset-state:tbox.other.thing",
		});
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t2");

		syncMcpToolsets(asPi(mock), []);

		const foreign = findEntry("tbox.other.thing")!;
		expect([...foreign.spec.names]).toEqual(["mcp__siyuan__t1", "unrelated"]);
		// The claimed name is excluded from MCP membership.
		expect([...findEntry("tbox.mcp@siyuan")!.spec.names]).toEqual([
			"mcp__siyuan__t2",
		]);
	});
});

// ---------------------------------------------------------------------------
// Id-squatting guard
// ---------------------------------------------------------------------------

describe("syncMcpToolsets — id-squatting guard", () => {
	it("same-id squat: warns and skips a foreign spec under tbox.mcp@<server> without mutating it", () => {
		const mock = new MockPI();
		// A foreign extension squats tbox's MCP id with its own persistKey and
		// claims a member tool whose sourceInfo names it.
		const squatter = mock.defineFakeToolset({
			id: "tbox.mcp@siyuan",
			label: "squatter",
			names: new Set(["mcp__siyuan__stolen"]),
			persistKey: "toolset-state:evil.siyuan",
		});
		mock.registerTool({
			name: "mcp__siyuan__stolen",
			description: "stolen",
			namespace: { name: "mcp__siyuan" },
			sourceInfo: {
				path: "evil.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		registerMcpTool(mock, "other", "mcp__other__t1");
		const notify = vi.fn();

		syncMcpToolsets(asPi(mock), [], notify);

		// Warned with attribution, squatter untouched (no names mutation, no
		// defineToolset warn-and-replace), sibling server still synced.
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]![0]).toContain("owned by another extension");
		expect(notify.mock.calls[0]![0]).toContain("evil.ts");
		expect(notify.mock.calls[0]![0]).toContain("skipping MCP sync for siyuan");
		expect(squatter.spec.names).toEqual(new Set(["mcp__siyuan__stolen"]));
		expect(squatter.spec.persistKey).toBe("toolset-state:evil.siyuan");
		expect(findEntry("tbox.mcp@other")).toBeDefined();
	});

	it("sibling shape: a foreign id claiming tbox's persistKey warns and skips instead of killing the re-scan", () => {
		const mock = new MockPI();
		mock.defineFakeToolset({
			id: "other.web",
			label: "other.web",
			names: new Set(["unrelated"]),
			// Tbox's hardcoded persistKey for server siyuan, under a foreign id:
			// the same-id guard above cannot see this shape.
			persistKey: "toolset-state:tbox.mcp@siyuan",
		});
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		registerMcpTool(mock, "other", "mcp__other__t1");
		const notify = vi.fn();

		// The cross-entry PersistKeyCollisionError from defineToolset is
		// caught by name and downgraded to a warn-and-skip; the re-scan
		// (including the sibling server) survives.
		expect(() => syncMcpToolsets(asPi(mock), [], notify)).not.toThrow();

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]![0]).toContain('"tbox.mcp@siyuan"');
		expect(notify.mock.calls[0]![0]).toContain('"other.web"');
		expect(notify.mock.calls[0]![1]).toBe("warning");
		expect(findEntry("tbox.mcp@siyuan")).toBeUndefined();
		expect(findEntry("tbox.mcp@other")).toBeDefined();
	});

	it("same-id guard attributes nothing when the member tool is absent", () => {
		const mock = new MockPI();
		mock.defineFakeToolset({
			id: "tbox.mcp@siyuan",
			label: "squatter",
			names: new Set(["mcp__siyuan__gone"]),
			persistKey: "toolset-state:evil.siyuan",
		});
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		const notify = vi.fn();

		syncMcpToolsets(asPi(mock), [], notify);

		// Message stays useful without the owner path.
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]![0]).toContain("owned by another extension");
		expect(notify.mock.calls[0]![0]).not.toContain("(");
	});
});

// ---------------------------------------------------------------------------
// /reload — restore handler reinstall through a fresh pi
// ---------------------------------------------------------------------------

describe("syncMcpToolsets — /reload path", () => {
	it("re-installs masking's restore/re-assert and re-applies intent-off on a fresh pi", () => {
		// Session 1: toolset created and toggled off.
		const first = new MockPI();
		registerMcpTool(first, "siyuan", "mcp__siyuan__t1");
		pinIntent(first, "tbox.mcp@siyuan", false);
		syncMcpToolsets(asPi(first), first.createContext().sessionManager.getBranch());
		expect(findEntry("tbox.mcp@siyuan")).toBeDefined();

		// /reload: fresh pi, same process-global registry; the persisted
		// branch entry (intent off) survives the reload in the session file.
		const second = new MockPI();
		registerMcpTool(second, "siyuan", "mcp__siyuan__t1");
		pinIntent(second, "tbox.mcp@siyuan", false);
		// pi re-activates declarable tools on registration.
		second.setActiveTools(["mcp__siyuan__t1"]);
		expect(second.handlerCount("before_agent_start")).toBe(0);

		syncMcpToolsets(asPi(second), second.createContext().sessionManager.getBranch());

		// defineToolset's ensureRestoreHandler ran on the fresh pi…
		expect(second.handlerCount("before_agent_start")).toBe(1);
		// …and the intent-off reconcile removed the re-activated declaration.
		expect(second.getActiveTools()).not.toContain("mcp__siyuan__t1");
	});

	it("reaches the same reconcile outcome regardless of handler order", () => {
		// Zero-extension-toolset case: masking's re-assert is installed only
		// via defineToolset, so with a registry holding only MCP toolsets the
		// re-assert can run after tbox's scan. Outcome must be identical —
		// covered by the create-path reconcile assertions above, which hold
		// whether or not any other toolset exists. Mirror it with an orphan
		// toolset present so the re-assert ordering exists.
		const mock = new MockPI();
		mock.registerTool({
			name: "web-fetch",
			description: "extension tool",
			sourceInfo: {
				path: "portal.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.defineFakeToolset({
			id: "tbox.tool@npm:portal",
			label: "tbox.tool@npm:portal",
			names: new Set(["web-fetch"]),
			persistKey: "toolset-state:tbox.tool@npm:portal",
		});
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		pinIntent(mock, "tbox.mcp@siyuan", false);
		mock.setActiveTools(["mcp__siyuan__t1", "web-fetch"]);

		syncMcpToolsets(asPi(mock), mock.createContext().sessionManager.getBranch());

		expect(mock.getActiveTools()).toEqual(["web-fetch"]);
	});
});
