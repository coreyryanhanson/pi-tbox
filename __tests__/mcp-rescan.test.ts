/**
 * Post-session_start MCP connect re-scan tests.
 *
 * The builtin mcp extension connects servers asynchronously after
 * session_start and pi fires no event when the tools land, so tbox polls:
 * a bounded re-scan after captureAndRender registers the MCP toolsets and
 * repaints the slot once the tools appear. Covers: registration on connect,
 * slot repaint, budget expiry, session_shutdown cancellation, no duplicate
 * timers on re-capture, the unchanged-set no-op, and multi-server coverage
 * (the poll keeps ticking after the first server's sync).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockPI, useTempAgentDir } from "./mock-pi.js";
import { asPi, registerMcpTool } from "./fixtures.js";
import tboxFactory from "../index.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

// File-wide temp settings dirs — never touches the developer's ~/.pi.
useTempAgentDir();

function findEntry(id: string): RegistryEntry | undefined {
	return getRegisteredToolsets().find((e: RegistryEntry) => e.spec.id === id);
}

beforeEach(() => {
	MockPI.cleanRegistry();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("post-start MCP connect re-scan", () => {
	it("registers the toolset and repaints the slot once the server connects", async () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");

		// Servers not connected yet: no toolset at capture time.
		expect(findEntry("tbox.mcp@siyuan")).toBeUndefined();
		const statusCountAtCapture = mock.getStatusRecords().length;

		// The server connects between the ticks.
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		await vi.advanceTimersByTimeAsync(500);

		expect(findEntry("tbox.mcp@siyuan")).toBeDefined();
		expect([...findEntry("tbox.mcp@siyuan")!.spec.names]).toEqual([
			"mcp__siyuan__t1",
		]);
		// Exactly one repaint after the registration (intent-on registration
		// fires no TOOLSET_EVENTS fanout, so the poll must repaint itself;
		// a second repaint would mean a stray second tick).
		expect(mock.getStatusRecords().length).toBe(statusCountAtCapture + 1);
	});

	it("waits across ticks for a slow connection", async () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");

		await vi.advanceTimersByTimeAsync(1_500);
		expect(findEntry("tbox.mcp@siyuan")).toBeUndefined();

		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		await vi.advanceTimersByTimeAsync(500);
		expect(findEntry("tbox.mcp@siyuan")).toBeDefined();
	});

	it("stops scanning when the budget expires", async () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");

		// Budget is 10s: run past it, then connect — no scan may fire anymore.
		// (vi.useFakeTimers mocks Date too, so the tick's Date.now() deadline
		// advances with advanceTimersByTimeAsync.)
		await vi.advanceTimersByTimeAsync(11_000);
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(findEntry("tbox.mcp@siyuan")).toBeUndefined();
	});

	it("session_shutdown cancels the pending scan", async () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");
		mock.fireLifecycleEvent("session_shutdown");

		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(findEntry("tbox.mcp@siyuan")).toBeUndefined();
	});

	it("does not stack a second scan on a re-capture (session_tree)", async () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");
		mock.fireLifecycleEvent("session_tree");

		const baselineAfterTree = mock.getStatusRecords().length;
		expect(baselineAfterTree).toBeGreaterThan(0);

		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		await vi.advanceTimersByTimeAsync(500);

		// The only observable effect of the re-capture's clearTimeout: exactly
		// one live tick synced-and-repainted. A second (uncleared) timer would
		// also see a changed name set and repaint again.
		expect(mock.getStatusRecords().length).toBe(baselineAfterTree + 1);

		// One scan registered it exactly once (defineToolset is
		// idempotent-by-content, so duplicates would be silent — the
		// assertion pins the single-entry shape anyway).
		const entries = getRegisteredToolsets().filter((e: RegistryEntry) =>
			e.spec.id.startsWith("tbox.mcp@"),
		);
		expect(entries).toHaveLength(1);
		expect([...entries[0]!.spec.names]).toEqual(["mcp__siyuan__t1"]);
	});

	it("does not re-sync when the declarable set is unchanged since capture", async () => {
		const mock = new MockPI();
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");

		// captureAndRender's own synchronous scan registered it — no tick needed.
		expect(findEntry("tbox.mcp@siyuan")).toBeDefined();
		const statusCountAtCapture = mock.getStatusRecords().length;

		// The poll runs, but the name-set diff never changes — no repaint.
		await vi.advanceTimersByTimeAsync(11_000);
		expect(mock.getStatusRecords().length).toBe(statusCountAtCapture);
	});

	it("keeps polling for a second server that connects after the first", async () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");

		registerMcpTool(mock, "fast", "mcp__fast__t1");
		await vi.advanceTimersByTimeAsync(500);
		expect(findEntry("tbox.mcp@fast")).toBeDefined();

		// The first server's sync must not stop the poll.
		registerMcpTool(mock, "slow", "mcp__slow__t1");
		await vi.advanceTimersByTimeAsync(500);
		expect(findEntry("tbox.mcp@slow")).toBeDefined();
	});

	it("survives a throwing tick and keeps polling", async () => {
		const mock = new MockPI();
		tboxFactory(asPi(mock));
		mock.fireLifecycleEvent("session_start");

		// A bare setTimeout callback sits outside pi's handler error
		// containment, so a throwing tick must be contained — and the poll
		// must survive it.
		registerMcpTool(mock, "siyuan", "mcp__siyuan__t1");
		const spy = vi.spyOn(mock, "getAllTools").mockImplementation(() => {
			throw new Error("boom");
		});
		await vi.advanceTimersByTimeAsync(500);
		expect(findEntry("tbox.mcp@siyuan")).toBeUndefined();

		// The next tick retries once the failure is gone.
		spy.mockRestore();
		await vi.advanceTimersByTimeAsync(500);
		expect(findEntry("tbox.mcp@siyuan")).toBeDefined();
	});
});
