import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	MockPI,
	branchOf,
	readerOf,
	useTempAgentDir,
} from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	readBranchModeState,
	type BranchReader,
	getRegisteredToolsets,
} from "pi-tool-masking";
import { soloUnit, focusUnit } from "../src/focus.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { computeSlotState, setFocusUnit } from "../src/status-slot.js";
import {
	setGroupsOverrideForTests,
	writeGroup,
} from "../config/settings-reader.js";

// File-wide temp settings dirs — never touches the developer's ~/.pi.
useTempAgentDir();

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

function enableAll(pi: ExtensionAPI, sessionManager: BranchReader): void {
	for (const entry of getRegisteredToolsets()) {
		entry.toolset.enable(pi, sessionManager);
	}
}

function setup(pi: ExtensionAPI, mock: MockPI): void {
	registerTools(mock);
	defineFakeToolsets(mock);
	autoRegisterBuiltinAndOrphans(pi);
	enableAll(pi, readerOf(mock));
	mock.clearEntries();
	mock.clearUiRecords();
}


describe("/tbox solo", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		// Keep writeGroup() off the real ~/.pi/agent/pi-tbox/groups.json —
		// an empty override routes all writes to memory, never disk.
		setGroupsOverrideForTests({});
		setFocusUnit(null);
	});

	afterEach(() => {
		setGroupsOverrideForTests(null);
	});

	it("toolset: enables target + deps, disables everything else", () => {
		setup(pi, mock);

		const result = soloUnit(pi, "+portal.web", readerOf(mock));

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

		soloUnit(pi, "+portal.web", readerOf(mock));

		expect(readBranchModeState(branchOf(mock)).mode).toBe("exclusion");
	});

	it("group: enables group toolsets (+ deps) only, others off", () => {
		setup(pi, mock);
		writeGroup("web", { toolsets: ["portal.web"] }); // goes to the override, not disk

		const result = soloUnit(pi, "web", readerOf(mock));

		expect(result).toContain("group:web");
		const active = new Set(pi.getActiveTools());
		expect(active.has("web-fetch")).toBe(true);
		expect(active.has("web-learn")).toBe(false);
		expect(active.has("lens-tool-0")).toBe(false);
	});

	it("multi-toolset group: every registered member is enabled, not one root", () => {
		// The ops come from every registered id in resolved.toolsetIds —
		// a single-root-op form would enable only one member of a
		// multi-toolset solo unit.
		setup(pi, mock);
		mock.defineFakeToolset({
			id: "portal.chat",
			names: new Set(["chat-send"]),
			persistKey: "toolset-state:portal.chat",
			defaultEnabled: true,
		});
		mock.registerTool({
			name: "chat-send",
			description: "Chat send",
			sourceInfo: {
				path: "x.ts",
				source: "src",
				scope: "user",
				origin: "top-level",
			},
		});
		writeGroup("pair", { toolsets: ["portal.web", "portal.chat"] }); // no requires between them

		soloUnit(pi, "pair", readerOf(mock));

		const active = new Set(pi.getActiveTools());
		expect(active.has("web-fetch")).toBe(true);
		expect(active.has("chat-send")).toBe(true);
		// Everything else still off
		expect(active.has("web-learn")).toBe(false);
		expect(active.has("lens-tool-0")).toBe(false);
	});

	it("unregistered group member is dropped from the ops, not a batch throw", () => {
		// forwardClosure adds unregistered seeds to toolsetIds; the batch
		// throws a plain Error on an explicit unregistered op, so the
		// registered filter must drop them (the old byId.get(id)?. tolerance).
		setup(pi, mock);
		writeGroup("mixed", { toolsets: ["portal.web", "ghost.tool"] });

		const result = soloUnit(pi, "mixed", readerOf(mock));

		expect(result).toContain("group:mixed");
		expect(mock.getActiveTools()).toContain("web-fetch");
	});

	it("persists per-toolset entries so /reload replays the solo state", () => {
		setup(pi, mock);

		// Start from intent-off so the solo's enable is a real delta —
		// a toggle matching the resolved default is a silent no-op now.
		getRegisteredToolsets()
			.find((e) => e.spec.id === "portal.web")!
			.toolset.disable(pi, readerOf(mock));

		soloUnit(pi, "+portal.web", readerOf(mock));

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

		const result = soloUnit(pi, "+portal.web", readerOf(mock));

		expect(result).toContain("focus mode");
		// focus untouched
		expect(readBranchModeState(branchOf(mock)).mode).toBe("allowlist");
	});

	it("errors on unknown input and rejects pi.builtin", () => {
		setup(pi, mock);
		expect(soloUnit(pi, "nope", readerOf(mock))).toContain("No group matching");
		expect(soloUnit(pi, "pi.builtin", readerOf(mock))).toContain("out of tbox's scope");
	});

	it("sets no focus glyph in the status slot", () => {
		setup(pi, mock);

		soloUnit(pi, "+portal.web", readerOf(mock));

		const state = computeSlotState(pi);
		// no focus glyph — solo sets no focus unit, slot shows the plain count
		expect(state.kind === "count" || state.kind === "pristine").toBe(true);
	});
});
