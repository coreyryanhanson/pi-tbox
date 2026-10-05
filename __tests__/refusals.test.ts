/**
 * Toggle-refusal seam tests (§4).
 *
 * The dispatch seam (runToggle + toggleRefusalMessage in index.ts) is the
 * one catch seam for actuation flows: domain functions throw raw, refusals
 * render here by error NAME (never instanceof — throwers may come from
 * another physical copy of the library off the shared globalThis registry),
 * and every other error rethrows.
 *
 * Rows:
 *   - Allowlist refusal: under allowlist governance (entered via a foreign
 *     setDefaultResolutionMode, so tbox's own focus guard passes) every
 *     actuation path's throw renders the friendly refusal at the seam, and
 *     zero branch entries are written (the throw is atomic).
 *   - Duck-typed name-catch pin: a plain object `{name:
 *     "AllowlistModeError"}` thrown from a flow renders the refusal copy —
 *     with no library class instance anywhere in the test's module graph,
 *     proving the name check survives a second physical copy.
 *   - Cycle refusal: a registrable `requires` cycle (nothing validates at
 *     defineToolset time) refuses atomically — the same cycle copy renders
 *     from all three sources (planBatch via `/tbox all`, forwardClosure via
 *     `/tbox solo`, forwardClosure via `/tbox focus`).
 *   - Seam rethrow contract: a plain Error surfaces raw rather than being
 *     rendered as a refusal.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setDefaultResolutionMode } from "pi-tool-masking";
import { setGroupsOverrideForTests, writeGroup } from "../config/settings-reader.js";
import { setFocusUnit } from "../src/status-slot.js";

const ALLOWLIST_COPY = "refused — toolset toggles do not operate while allowlist governance is active";
const CYCLE_COPY = "refused — a requires cycle was detected before any write; nothing changed";

async function setupDispatch(mock: MockPI, pi: ExtensionAPI): Promise<void> {
	const mod = await import("../index.js");
	mod.default(pi);
	mock.fireLifecycleEvent("session_start");
	mock.clearEntries();
	mock.clearUiRecords();
}

/** Two unrelated toolsets so `/tbox all` and groups have actuation targets. */
function setupToolsets(mock: MockPI): void {
	mock.registerTool({
		name: "web-fetch",
		description: "Fetch",
		sourceInfo: { path: "p.ts", source: "p", scope: "user", origin: "top-level" },
	});
	mock.registerTool({
		name: "host-call",
		description: "Host",
		sourceInfo: { path: "h.ts", source: "h", scope: "user", origin: "top-level" },
	});
	mock.defineFakeToolset({
		id: "portal.web",
		names: new Set(["web-fetch"]),
		persistKey: "toolset-state:portal.web",
		defaultEnabled: true,
	});
	mock.defineFakeToolset({
		id: "host.api",
		names: new Set(["host-call"]),
		persistKey: "toolset-state:host.api",
		defaultEnabled: true,
	});
}

/** A registrable requires cycle — nothing validates it at defineToolset. */
function setupCycle(mock: MockPI): void {
	mock.registerTool({
		name: "a-tool",
		description: "A",
		sourceInfo: { path: "a.ts", source: "a", scope: "user", origin: "top-level" },
	});
	mock.registerTool({
		name: "b-tool",
		description: "B",
		sourceInfo: { path: "b.ts", source: "b", scope: "user", origin: "top-level" },
	});
	mock.defineFakeToolset({
		id: "cycle.a",
		names: new Set(["a-tool"]),
		persistKey: "toolset-state:cycle.a",
		defaultEnabled: true,
		requires: ["cycle.b"],
	});
	mock.defineFakeToolset({
		id: "cycle.b",
		names: new Set(["b-tool"]),
		persistKey: "toolset-state:cycle.b",
		defaultEnabled: true,
		requires: ["cycle.a"],
	});
}

describe("allowlist refusal at the dispatch seam", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
		setGroupsOverrideForTests({});
		setupToolsets(mock);
		await setupDispatch(mock, pi);
	});

	afterEach(() => setGroupsOverrideForTests(null));

	it("/tbox all on renders the friendly refusal and writes nothing", async () => {
		// Foreign allowlist — entered via setDefaultResolutionMode, never
		// touching tbox's focus mirror, so checkFocusGuard passes and the
		// batch's own throw is what must render at the seam.
		setDefaultResolutionMode(pi, "allowlist", ["portal.web"]);
		mock.clearUiRecords();
		const entriesBefore = mock.getEntries().length;

		await mock.dispatchCommand("all on");

		const notify = mock.getLastNotify();
		expect(notify!.message).toBe(`/tbox all ${ALLOWLIST_COPY}`);
		expect(notify!.level).toBe("info");
		// Atomic: the throw precedes every write.
		expect(mock.getEntries().length).toBe(entriesBefore);
	});

	it("/tbox +<toolset> on propagates to the seam", async () => {
		setDefaultResolutionMode(pi, "allowlist", ["portal.web"]);
		mock.clearUiRecords();

		await mock.dispatchCommand("+portal.web on");

		expect(mock.getLastNotify()!.message).toBe(`/tbox +portal.web ${ALLOWLIST_COPY}`);
	});

	it("/tbox <group> on propagates to the seam", async () => {
		setDefaultResolutionMode(pi, "allowlist", ["portal.web"]);
		writeGroup("webgroup", { toolsets: ["portal.web"] });
		mock.clearUiRecords();

		await mock.dispatchCommand("webgroup on");

		expect(mock.getLastNotify()!.message).toBe(`/tbox webgroup ${ALLOWLIST_COPY}`);
	});

	it("/tbox solo propagates to the seam", async () => {
		setDefaultResolutionMode(pi, "allowlist", ["portal.web"]);
		mock.clearUiRecords();

		await mock.dispatchCommand("solo +portal.web");

		expect(mock.getLastNotify()!.message).toBe(`/tbox solo ${ALLOWLIST_COPY}`);
	});

	it("the name-based catch survives a duck-typed refusal (no library class)", async () => {
		// Throw a plain object from inside a flow — no AllowlistModeError
		// instance exists anywhere in this test's module graph. If the seam
		// used instanceof, this would rethrow and fail the command.
		(
			mock as unknown as { getActiveTools: () => never }
		).getActiveTools = (() => {
			throw { name: "AllowlistModeError" };
		}) as () => never;
		writeGroup("webgroup", { toolsets: ["portal.web"] });

		await mock.dispatchCommand("webgroup on");

		expect(mock.getLastNotify()!.message).toBe(
			`/tbox webgroup ${ALLOWLIST_COPY}`,
		);
	});

	it("a plain Error rethrows raw — the seam renders refusals only", async () => {
		(
			mock as unknown as { getActiveTools: () => never }
		).getActiveTools = (() => {
			throw new Error("boom");
		}) as () => never;
		writeGroup("webgroup", { toolsets: ["portal.web"] });

		// The seam must not swallow a genuine defect into refusal copy.
		await expect(mock.dispatchCommand("webgroup on")).rejects.toThrow("boom");
	});
});

describe("cycle refusal at the dispatch seam", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
		setGroupsOverrideForTests({});
		setupCycle(mock);
		await setupDispatch(mock, pi);
	});

	afterEach(() => setGroupsOverrideForTests(null));

	it("/tbox all refuses the whole command atomically (planBatch source)", async () => {
		mock.clearUiRecords();

		await mock.dispatchCommand("all on");

		expect(mock.getLastNotify()!.message).toBe(`/tbox all ${CYCLE_COPY}`);
		// Nothing was applied — the planner refuses before any write.
		expect(mock.getEntries()).toHaveLength(0);
	});

	it("/tbox solo renders the same copy (forwardClosure source)", async () => {
		mock.clearUiRecords();

		await mock.dispatchCommand("solo +cycle.a");

		expect(mock.getLastNotify()!.message).toBe(`/tbox solo ${CYCLE_COPY}`);
		expect(mock.getEntries()).toHaveLength(0);
	});

	it("/tbox focus renders the same copy (forwardClosure source)", async () => {
		mock.clearUiRecords();

		await mock.dispatchCommand("focus +cycle.a");

		expect(mock.getLastNotify()!.message).toBe(`/tbox focus ${CYCLE_COPY}`);
		expect(mock.getEntries()).toHaveLength(0);
	});
});
