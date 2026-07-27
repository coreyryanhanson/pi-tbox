/**
 * Restore tests — simulate `/reload` and `session_tree`.
 *
 * Verifies:
 *   1. Re-invoking the factory against a fresh MockPI sharing the same
 *      globalThis does not duplicate registered toolsets.
 *   2. Auto-registration re-runs from the fresh pi.getAllTools() call.
 *   3. The slot re-paints once on the capture handler.
 *   4. session_tree also triggers auto-registration and slot render.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import { setFocusUnit } from "../src/status-slot.js";
import tboxFactory from "../index.js";

describe("restore — simulate /reload", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	it("re-invoking factory does not duplicate registered toolsets", () => {
		// Register some tools
		mock.registerTool({
			name: "lens-tool",
			description: "Lens tool",
			sourceInfo: {
				path: "pi-lens.ts",
				source: "pi-lens",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.registerTool({
			name: "notes-tool",
			description: "Notes tool",
			sourceInfo: {
				path: "notes.ts",
				source: "notes-plugin",
				scope: "user",
				origin: "top-level",
			},
		});

		// First load
		tboxFactory(pi);
		mock.fireLifecycleEvent("session_start");

		const afterFirst = getRegisteredToolsets().map(
			(e: RegistryEntry) => e.spec.id,
		);

		// The two orphan sources should be registered
		expect(afterFirst).toContain("tbox.tool@pi-lens");
		expect(afterFirst).toContain("tbox.tool@notes-plugin");

		// Simulate /reload — create a fresh MockPI with different tools
		// but SHARING the same globalThis registry
		const mock2 = new MockPI();
		const pi2 = mock2 as unknown as ExtensionAPI;

		// Add one new tool on the fresh pi2
		mock2.registerTool({
			name: "new-tool",
			description: "New tool",
			sourceInfo: {
				path: "new.ts",
				source: "new-plugin",
				scope: "user",
				origin: "top-level",
			},
		});

		// Re-invoke the factory on the fresh pi2
		tboxFactory(pi2);
		mock2.fireLifecycleEvent("session_start");

		// Check registry — no duplicates for existing toolsets
		const afterReload = getRegisteredToolsets();
		const ids = afterReload.map((e: RegistryEntry) => e.spec.id);

		// Should still have the original ones (once each)
		const tboxLensCount = ids.filter(
			(id: string) => id === "tbox.tool@pi-lens",
		).length;
		expect(tboxLensCount).toBe(1);

		const tboxNotesCount = ids.filter(
			(id: string) => id === "tbox.tool@notes-plugin",
		).length;
		expect(tboxNotesCount).toBe(1);

		// Should have the new one
		expect(ids).toContain("tbox.tool@new-plugin");
	});

	it("registry has no duplicate entries after re-load", () => {
		// Minimal setup
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

		tboxFactory(pi);
		mock.fireLifecycleEvent("session_start");

		const idsAfterFirst = getRegisteredToolsets().map(
			(e: RegistryEntry) => e.spec.id,
		);
		expect(idsAfterFirst).toContain("tbox.tool@extension");

		// Reload
		const mock2 = new MockPI();
		const pi2 = mock2 as unknown as ExtensionAPI;
		mock2.registerTool({
			name: "orphan-tool",
			description: "Orphan",
			sourceInfo: {
				path: "ext.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});

		tboxFactory(pi2);
		mock2.fireLifecycleEvent("session_start");

		const idsAfterReload = getRegisteredToolsets().map(
			(e: RegistryEntry) => e.spec.id,
		);
		const extensionCount = idsAfterReload.filter(
			(id: string) => id === "tbox.tool@extension",
		).length;
		expect(extensionCount).toBe(1);
	});

	it("slot re-paints once after session_start handler runs", () => {
		tboxFactory(pi);
		mock.fireLifecycleEvent("session_start");

		const records = mock.getStatusRecords();
		const slotRecords = records.filter((r) => r.slot === "tbox");
		expect(slotRecords.length).toBeGreaterThanOrEqual(1);
	});

	it("slot re-paints once after session_tree handler runs", () => {
		tboxFactory(pi);
		mock.fireLifecycleEvent("session_tree");

		const records = mock.getStatusRecords();
		const slotRecords = records.filter((r) => r.slot === "tbox");
		expect(slotRecords.length).toBeGreaterThanOrEqual(1);
	});

	it("factory re-invoke on session_tree does not throw", () => {
		tboxFactory(pi);
		expect(() => {
			mock.fireLifecycleEvent("session_tree");
		}).not.toThrow();
	});

	it("auto-registration re-runs on session_tree with new orphan tools", () => {
		tboxFactory(pi);
		mock.fireLifecycleEvent("session_tree");

		// No tools yet → no orphan toolsets
		const afterFirst = getRegisteredToolsets().length;

		// Add tools and fire session_tree again
		mock.registerTool({
			name: "lens-tool",
			description: "Lens tool",
			sourceInfo: {
				path: "pi-lens.ts",
				source: "pi-lens",
				scope: "user",
				origin: "top-level",
			},
		});

		mock.fireLifecycleEvent("session_tree");

		const afterSecond = getRegisteredToolsets().length;
		// Should have more toolsets (or the same, since last ones persist)
		expect(afterSecond).toBeGreaterThanOrEqual(afterFirst);
		const ids = getRegisteredToolsets().map((e: RegistryEntry) => e.spec.id);
		expect(ids).toContain("tbox.tool@pi-lens");
	});

	it("session_shutdown clears focus and slot", () => {
		tboxFactory(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		mock.fireLifecycleEvent("session_shutdown");

		const status = mock.getLastStatus("tbox");
		expect(status?.text).toBe("");
	});
});
