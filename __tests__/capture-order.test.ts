/**
 * Capture-order tests — verify render-ordering correctness.
 *
 * Root cause: The library can emit TOOLSET_EVENTS.restored/changed from
 * within a sibling extension's session_start handler. If tbox's wireSlot
 * listener fires before lastCtx is captured, it would render a stale slot
 * (or no-op if lastCtx is null).
 *
 * Capture ctx at the top of the handler, but call render() at
 * the END — so the first paint always lands on post-restore state regardless
 * of handler registration order.
 *
 * Tests simulate both orderings:
 *   1. Tbox handler registered BEFORE sibling → tbox renders first, then
 *      sibling fires events (wireSlot re-renders)
 *   2. Tbox handler registered AFTER sibling → sibling fires events while
 *      lastCtx is still null (no-op), then tbox renders at end (correct)
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRegisteredToolsets,
	type RegistryEntry,
	TOOLSET_EVENTS,
} from "pi-tool-masking";
import { setFocusUnit } from "../src/status-slot.js";
import tboxFactory from "../index.js";

describe("capture-order — render ordering", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	/**
	 * Simulate a sibling extension that registers tools, declares a toolset,
	 * and emits TOOLSET_EVENTS.restored within its session_start handler.
	 */
	function addSiblingThatEmitsRestored(): void {
		// Register sibling extension's tools and toolset
		mock.registerTool({
			name: "sibling-tool",
			description: "Sibling tool",
			sourceInfo: {
				path: "sibling.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.defineFakeToolset({
			id: "sibling.ext",
			names: new Set(["sibling-tool"]),
			persistKey: "toolset-state:sibling.ext",
			defaultEnabled: true,
		});
	}

	/**
	 * Simulate a sibling extension whose session_start handler emits
	 * TOOLSET_EVENTS.restored (e.g. the library's own restore).
	 */
	function emitRestoredFromHandler(): void {
		// The handler fires TOOLSET_EVENTS.restored
		mock.on("session_start", (_event: unknown, _ctx: unknown) => {
			mock.emit(TOOLSET_EVENTS.restored, {
				id: "sibling.restore",
				enabled: true,
			});
		});
	}

	it("tbox handler registered before sibling: slot is correct on first paint", () => {
		addSiblingThatEmitsRestored();

		// Register tbox FIRST, then sibling's emitter handler
		tboxFactory(pi);
		emitRestoredFromHandler();

		// Fire session_start
		mock.fireLifecycleEvent("session_start");

		// The slot should have been painted. Since all tools are active
		// (defaultEnabled: true), the state should be pristine or count.
		const status = mock.getLastStatus("tbox");
		expect(status).toBeDefined();
		expect(status!.text).toBeTruthy();

		// Verify sibling's toolset is registered
		const ids = getRegisteredToolsets().map((e: RegistryEntry) => e.spec.id);
		expect(ids).toContain("sibling.ext");
	});

	it("sibling handler registered before tbox: slot is correct on first paint", () => {
		addSiblingThatEmitsRestored();

		// Register sibling's emitter handler FIRST, then tbox
		emitRestoredFromHandler();
		tboxFactory(pi);

		// Fire session_start
		mock.fireLifecycleEvent("session_start");

		// Slot should be painted correctly
		const status = mock.getLastStatus("tbox");
		expect(status).toBeDefined();
		expect(status!.text).toBeTruthy();

		// Verify sibling's toolset is registered
		const ids = getRegisteredToolsets().map((e: RegistryEntry) => e.spec.id);
		expect(ids).toContain("sibling.ext");
	});

	it("multiple TOOLSET_EVENTS.restored emissions don't crash", () => {
		addSiblingThatEmitsRestored();

		// Both handlers emit restored
		emitRestoredFromHandler();
		tboxFactory(pi);

		// Also wire another direct emitter
		mock.events.on(TOOLSET_EVENTS.restored, () => {
			// just a no-op listener
		});

		expect(() => {
			mock.fireLifecycleEvent("session_start");
		}).not.toThrow();

		const status = mock.getLastStatus("tbox");
		expect(status).toBeDefined();
	});

	it("slot reflects post-restore state, not a stale pre-restore snapshot", () => {
		// Register some tools that will be disabled by a sibling
		mock.registerTool({
			name: "tool-a",
			description: "Tool A",
			sourceInfo: {
				path: "a.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.defineFakeToolset({
			id: "other.set",
			names: new Set(["tool-a"]),
			persistKey: "toolset-state:other.set",
			defaultEnabled: true,
		});

		// Before session_start, active tools are empty
		expect(mock.getActiveTools()).toHaveLength(0);

		// Sibling handler fires restored and also acts as the "restore"
		// by enabling the tools
		mock.on("session_start", (_event: unknown, _ctx: unknown) => {
			// Simulate the library's restore: enable the toolset
			const entry = getRegisteredToolsets().find(
				(e: RegistryEntry) => e.spec.id === "other.set",
			);
			if (entry) {
				entry.toolset.enable(mock as unknown as ExtensionAPI);
			}
			// Then emit restored
			mock.emit(TOOLSET_EVENTS.restored, {
				id: "other.restore",
				enabled: true,
			});
		});

		tboxFactory(pi);

		mock.fireLifecycleEvent("session_start");

		// After session_start, tool-a should be active (restore handled it)
		const active = mock.getActiveTools();
		expect(active).toContain("tool-a");

		// Slot should reflect the active state (pristine since all active)
		const status = mock.getLastStatus("tbox");
		expect(status).toBeDefined();
		// Should not show a count (pristine) because all are active
		// It could be "○ tbox" (pristine)
		expect(status!.text).toContain("○");
	});

	it("render at end of handler catches sibling's restored event correctly", () => {
		addSiblingThatEmitsRestored();

		// Sibling handler enables its tools and emits restored
		mock.on("session_start", (_event: unknown, _ctx: unknown) => {
			// Enable sibling tools via the toolset
			const entry = getRegisteredToolsets().find(
				(e: RegistryEntry) => e.spec.id === "sibling.ext",
			);
			if (entry) {
				entry.toolset.enable(mock as unknown as ExtensionAPI);
			}
			mock.emit(TOOLSET_EVENTS.restored, {
				id: "sibling.restore",
				enabled: true,
			});
		});

		// Register tbox BEFORE sibling emitter
		tboxFactory(pi);

		// Also register an orphan tool so tbox has something to register
		mock.registerTool({
			name: "orphan-x",
			description: "Orphan X",
			sourceInfo: {
				path: "x.ts",
				source: "ext-plugin",
				scope: "user",
				origin: "top-level",
			},
		});

		mock.fireLifecycleEvent("session_start");

		// Both sibling-tool and orphan-x should be active
		const active = mock.getActiveTools();
		expect(active).toContain("sibling-tool");
		expect(active).toContain("orphan-x");

		// Slot should be painted correctly
		const status = mock.getLastStatus("tbox");
		expect(status).toBeDefined();
		expect(status!.text).toBeTruthy();
	});
});
