import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getActiveAllowlist,
	getDefaultResolutionMode,
	getRegisteredToolsets,
	setSettingsOverrideForTests,
} from "pi-tool-masking";
import { soloUnit, focusUnit } from "../src/focus.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { computeSlotState, setFocusUnit } from "../src/status-slot.js";
import {
	setGroupsOverrideForTests,
	writeGroup,
} from "../config/settings-reader.js";

// Reuse focus.test.ts's fixture shape: two toolsets, one requiring the other.
function registerTools(mock: MockPI): void {
	for (const name of ["web-fetch", "web-learn", "lens-tool-0", "my-tool"]) {
		mock.registerTool({
			name,
			description: name,
			sourceInfo: {
				path: "x.ts",
				source: "src",
				scope: "user",
				origin: "top-level",
			},
		});
	}
}

function defineFakeToolsets(mock: MockPI): void {
	mock.defineFakeToolset({
		id: "portal.web",
		label: "Portal Web",
		names: new Set(["web-fetch"]),
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

function enableAll(pi: ExtensionAPI): void {
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi);
	}
}

function setup(pi: ExtensionAPI, mock: MockPI): void {
	registerTools(mock);
	defineFakeToolsets(mock);
	autoRegisterBuiltinAndOrphans(pi);
	enableAll(pi);
	mock.clearEntries();
	mock.clearUiRecords();
}

describe("/tbox solo", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		setSettingsOverrideForTests({});
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setGroupsOverrideForTests(null);
		setFocusUnit(null);
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
	});

	it("toolset: enables target + deps, disables everything else", () => {
		setup(pi, mock);

		const result = soloUnit(pi, "+portal.web");

		expect(result).toContain('Solo on "portal.web"');
		const active = new Set(pi.getActiveTools());
		expect(active.has("web-fetch")).toBe(true);
		// forward-only cascade: portal.learn requires portal.web, not the
		// reverse — soloing portal.web does NOT pull its dependents in
		expect(active.has("web-learn")).toBe(false);
		expect(active.has("lens-tool-0")).toBe(false);
		expect(active.has("my-tool")).toBe(false);
	});

	it("stays in exclusion mode — no allowlist, no lock", () => {
		setup(pi, mock);

		soloUnit(pi, "+portal.web");

		expect(getDefaultResolutionMode()).toBe("exclusion");
		expect(getActiveAllowlist()).toBeUndefined();
	});

	it("group: enables group toolsets (+ deps) only, others off", () => {
		setup(pi, mock);
		writeGroup("web", { toolsets: ["portal.web"] });

		const result = soloUnit(pi, "web");

		expect(result).toContain("group:web");
		const active = new Set(pi.getActiveTools());
		expect(active.has("web-fetch")).toBe(true);
		expect(active.has("web-learn")).toBe(false);
		expect(active.has("lens-tool-0")).toBe(false);
	});

	it("persists per-toolset entries so /reload replays the solo state", () => {
		setup(pi, mock);

		soloUnit(pi, "+portal.web");

		const lastFor = (key: string) => {
			const entries = mock.getEntries().filter((e) => e.customType === key);
			return entries[entries.length - 1]?.data as { enabled: boolean };
		};
		expect(lastFor("toolset-state:portal.web")).toEqual({ enabled: true });
		// dependent, not a dep — disabled by `all off`, never re-enabled
		expect(lastFor("toolset-state:portal.learn")).toEqual({ enabled: false });
		const lensKey = getRegisteredToolsets().find((e) =>
			e.spec.names.has("lens-tool-0"),
		)!.spec.persistKey;
		expect(lastFor(lensKey)).toEqual({ enabled: false });
	});

	it("refused while focus is active", () => {
		setup(pi, mock);
		focusUnit(pi, "+portal.web");

		const result = soloUnit(pi, "+portal.web");

		expect(result).toContain("focus mode");
		// focus untouched
		expect(getDefaultResolutionMode()).toBe("allowlist");
	});

	it("errors on unknown input and rejects pi.builtin", () => {
		setup(pi, mock);
		expect(soloUnit(pi, "nope")).toContain("No group matching");
		expect(soloUnit(pi, "pi.builtin")).toContain("out of tbox's scope");
	});

	it("sets no focus glyph in the status slot", () => {
		setup(pi, mock);

		soloUnit(pi, "+portal.web");

		const state = computeSlotState(pi);
		// no focus glyph — solo sets no focus unit, slot shows the plain count
		expect(state.kind === "count" || state.kind === "pristine").toBe(true);
	});
});
