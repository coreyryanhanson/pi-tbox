/**
 * Negative test: mode-flip-only exit leaves disabled toolsets stuck off.
 *
 * This is a regression guard against a future "simpler" refactor that
 * flips inclusion→exclusion without re-actuation. The `ExtensionAPI`
 * exposes only `appendEntry`, no `removeEntry`/clear — so an entry
 * always wins regardless of mode (design.md §4.5). The only correct
 * exit path is to overwrite every focus-era entry by re-actuating each
 * toolset to its `spec.defaultEnabled`.
 *
 * This test documents *why* the re-actuation path is mandatory.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRegisteredToolsets,
	getDefaultResolutionMode,
	setDefaultResolutionMode,
} from "pi-tool-masking";
import { focusUnit, focusOff } from "../src/focus.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";

// ---------------------------------------------------------------------------
// Fixture: builtin + portal.web + one orphan source
// ---------------------------------------------------------------------------

function setup(pi: ExtensionAPI, mock: MockPI): void {
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
		name: "orphan-tool",
		description: "Orphaned tool",
		sourceInfo: {
			path: "ext.ts",
			source: "orphan-source",
			scope: "user",
			origin: "top-level",
		},
	});

	mock.defineFakeToolset({
		id: "portal.web",
		label: "Portal Web",
		names: new Set(["web-fetch"]),
		persistKey: "toolset-state:portal.web",
		defaultEnabled: true,
	});

	autoRegisterBuiltinAndOrphans(pi);

	// Enable all — writes entries for each toolset
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi);
	}
	mock.clearUiRecords();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mode-flip-only exit (the anti-pattern)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("flipping to exclusion without re-actuation leaves disabled toolsets stuck off", () => {
		setup(pi, mock);

		// --- Enter focus on portal.web ---
		focusUnit(pi, "portal.web");
		expect(getDefaultResolutionMode()).toBe("inclusion");
		expect(new Set(pi.getActiveTools()).has("web-fetch")).toBe(true);

		// The orphan toolset (tbox.tool@orphan-source) was disabled during focus,
		// writing an entry with { enabled: false }.

		// --- The BUGGY path: flip mode only, don't re-actuate ---
		setDefaultResolutionMode(pi, "exclusion");
		// Note: we did NOT call focusOff() — just flipped the mode bit.

		// --- Now simulate what would happen if the library restored ---
		// The persisted entry { enabled: false } still exists. appendEntry
		// has no delete — the entry wins over the mode fallback.
		mock.emit("toolset:restored", {});

		// The orphan tool is still disabled because the entry wins
		// over exclusion mode (design.md §4.5).
		const orphanEntry = getRegisteredToolsets().find(
			(e) => e.spec.id === "tbox.tool@orphan-source",
		);
		expect(orphanEntry).toBeDefined();
		expect(orphanEntry!.toolset.isEnabled(pi)).toBe(false);

		// focused tools are fine
		expect(new Set(pi.getActiveTools()).has("web-fetch")).toBe(true);

		// Now demonstrate the CORRECT fix: drive it back to defaultEnabled
		orphanEntry!.toolset.enable(pi);
		expect(orphanEntry!.toolset.isEnabled(pi)).toBe(true);
	});

	it("proper re-actuation (focusOff) overwrites the focus-era entries", () => {
		setup(pi, mock);

		const orphanKey = "toolset-state:tbox.tool@orphan-source";

		// Enter focus — the orphan toolset gets disabled
		focusUnit(pi, "portal.web");

		const focusDisable = [...mock.getEntries()]
			.reverse()
			.find((e) => e.customType === orphanKey);
		expect(focusDisable).toBeDefined();
		expect((focusDisable!.data as Record<string, unknown>)?.enabled).toBe(
			false,
		);

		// Clear entries so we see only the exit writes
		mock.clearEntries();

		// Proper exit: re-actuation
		focusOff(pi);

		// The orphan toolset should have been re-enabled
		const exitEnable = mock
			.getEntries()
			.find((e) => e.customType === orphanKey);
		expect(exitEnable).toBeDefined();
		expect((exitEnable!.data as Record<string, unknown>)?.enabled).toBe(true);

		// All extension tools are back on (builtins are always active)
		const active = new Set(pi.getActiveTools());
		expect(active.has("orphan-tool")).toBe(true);
		expect(active.has("web-fetch")).toBe(true);
	});
});
