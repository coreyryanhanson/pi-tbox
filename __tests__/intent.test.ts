/**
 * Intent vs observation per use site (Batch 4).
 *
 * Masking 2.0.0's inert-toolset contract splits "the toolset is on" into
 * persisted intent (`effectiveEnabled`) and observation (`isEnabled()`); the
 * two diverge when the toolset's members are hidden (or an MCP server has not
 * connected). Covers: the toggle guard honoring "off" on an intent-on inert
 * toolset, toggleAll persisting off on intent-on inert toolsets and skipping
 * already-intent-on inert toolsets, the describeToolset/formatStatus state
 * reads showing intent, and defaults save capturing intent — never a
 * mid-session isEnabled() snapshot.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRegisteredToolsets,
	readToolsetDefaults,
} from "pi-tool-masking";import { actuateToolset, describeToolset, toggleAll } from "../src/groups.js";
import { formatStatus } from "../src/list.js";
import { handleDefaults } from "../src/defaults.js";
import { setFocusUnit } from "../src/status-slot.js";

const BUILTIN_SOURCE = {
	path: "builtin.ts",
	source: "builtin" as const,
	scope: "user" as const,
	origin: "top-level" as const,
};

const ID = "tbox.mcp@srv";
const KEY = "toolset-state:tbox.mcp@srv";

/** An inert toolset: its only member is registered hidden-exposure, so it
 *  can never be active — observation is permanently off while intent
 *  resolves through the normal tier chain. */
function setupInertToolset(
	mock: MockPI,
	defaultEnabled: boolean,
): void {
	mock.registerTool({
		name: "mcp__srv__t1",
		description: "hidden tool",
		exposure: "hidden",
		sourceInfo: BUILTIN_SOURCE,
	});
	mock.defineFakeToolset({
		id: ID,
		names: new Set(["mcp__srv__t1"]),
		persistKey: KEY,
		defaultEnabled,
	});
	// Seed the restore handler's view of the toolset (what a fresh session
	// does at session_start), then clear the entries it wrote so each test
	// starts from the packaged default.
	mock.fireLifecycleEvent("session_start");
	mock.clearEntries();
}

/** Snapshot of the mock's session branch (for intent reads). */
function branchOf(mock: MockPI) {
	return mock.createCommandContext().sessionManager.getBranch();
}

/** Replace the mock's whole active list (what a clobbering caller does). */
function setActiveToolsForMock(mock: MockPI, tools: string[]): void {
	(mock as unknown as { setActiveTools: (t: string[]) => void }).setActiveTools(
		tools,
	);
}

/** Last branch entry data for a persistKey (null when tombstoned/absent). */
function lastEntryData(mock: MockPI, key: string): { enabled: boolean } | null {
	const entries = branchOf(mock).filter(
		(e) => e.type === "custom" && (e as { customType?: string }).customType === key,
	);
	const last = entries[entries.length - 1] as
		| { data?: { enabled?: boolean } }
		| undefined;
	return (last?.data?.enabled as boolean | undefined) === undefined
		? null
		: { enabled: last!.data!.enabled! };
}

describe("intent vs observation (inert toolset)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	it("actuateToolset honors off on an intent-on inert toolset", () => {
		setupInertToolset(mock, true);

		// Observation says off; the old observation-gated guard answered
		// "already disabled" and dropped the toggle entirely.
		const output = actuateToolset(pi, ID, false, branchOf(mock));
		expect(output).toContain("Disabled");
		expect(lastEntryData(mock, KEY)).toEqual({ enabled: false });
	});

	it("actuateToolset guard still refuses redundant toggles by intent", () => {
		setupInertToolset(mock, true);

		expect(actuateToolset(pi, ID, true, branchOf(mock))).toContain(
			"already enabled",
		);
		actuateToolset(pi, ID, false, branchOf(mock));
		expect(actuateToolset(pi, ID, false, branchOf(mock))).toContain(
			"already disabled",
		);
	});

	it("toggleAll all off persists off on an intent-on inert toolset", () => {
		setupInertToolset(mock, true);

		toggleAll(pi, false, branchOf(mock));
		expect(lastEntryData(mock, KEY)).toEqual({ enabled: false });
	});

	it("toggleAll all on skips an already-intent-on inert toolset", () => {
		setupInertToolset(mock, true);

		const entriesBefore = branchOf(mock).length;
		toggleAll(pi, true, branchOf(mock));
		// No duplicate {enabled:true} entry appended for the inert toolset.
		expect(branchOf(mock).length).toBe(entriesBefore);
	});

	it("toggleAll all on skips fully-active toolsets without entry spam", () => {
		setupInertToolset(mock, true);
		// A second, live toolset: intent-on and fully active.
		mock.registerTool({
			name: "mcp__live__t1",
			description: "live tool",
			sourceInfo: BUILTIN_SOURCE,
		});
		mock.defineFakeToolset({
			id: "tbox.mcp@live",
			names: new Set(["mcp__live__t1"]),
			persistKey: "toolset-state:tbox.mcp@live",
			defaultEnabled: true,
		});
		mock.fireLifecycleEvent("session_start");
		mock.clearEntries();
		setActiveToolsForMock(mock, ["mcp__live__t1"]);

		const entriesBefore = branchOf(mock).length;
		const msg = toggleAll(pi, true, branchOf(mock));
		expect(msg).toContain("Enabled 0");
		expect(branchOf(mock).length).toBe(entriesBefore);
	});

	it("toggleAll all off removes a stray active member of an intent-off toolset", () => {
		setupInertToolset(mock, true);
		actuateToolset(pi, ID, false, branchOf(mock));
		// Residue: intent is off but a member is still active (mid-dispatch
		// re-activation, another extension's setActiveTools).
		setActiveToolsForMock(mock, ["mcp__srv__t1"]);

		const msg = toggleAll(pi, false, branchOf(mock));
		expect(msg).toContain("Disabled 1");
		expect(pi.getActiveTools()).not.toContain("mcp__srv__t1");
	});

	it("toggleAll all off skips intent-off inactive toolsets without entry spam", () => {
		setupInertToolset(mock, true);
		actuateToolset(pi, ID, false, branchOf(mock));

		const entriesBefore = branchOf(mock).length;
		const msg = toggleAll(pi, false, branchOf(mock));
		expect(msg).toContain("Disabled 0");
		expect(branchOf(mock).length).toBe(entriesBefore);
	});

	it("toggleAll all on skips a mixed toolset (active member + hidden member)", () => {
		// A hidden member can never be active, so masking's witnessed-on gate
		// never fires for this shape — enable() would re-append a duplicate
		// entry on every all on.
		mock.registerTool({
			name: "mcp__mix__live",
			description: "live",
			sourceInfo: BUILTIN_SOURCE,
		});
		mock.registerTool({
			name: "mcp__mix__hidden",
			description: "hidden",
			exposure: "hidden",
			sourceInfo: BUILTIN_SOURCE,
		});
		mock.defineFakeToolset({
			id: "tbox.mcp@mix",
			names: new Set(["mcp__mix__live", "mcp__mix__hidden"]),
			persistKey: "toolset-state:tbox.mcp@mix",
			defaultEnabled: true,
		});
		mock.fireLifecycleEvent("session_start");
		mock.clearEntries();
		setActiveToolsForMock(mock, ["mcp__mix__live"]);

		const entriesBefore = branchOf(mock).length;
		const msg = toggleAll(pi, true, branchOf(mock));
		expect(msg).toContain("Enabled 0");
		expect(branchOf(mock).length).toBe(entriesBefore);
	});

	it("toggleAll all on skips an intent-on disconnected (absent) toolset", () => {
		// Members absent from the registry (server disconnected), intent-on
		// via the packaged default: enable() would only re-append a duplicate
		// same-value entry (witnessed-on cannot fire — 0 registered ≠ 1
		// names), so it must be skipped.
		mock.defineFakeToolset({
			id: "tbox.mcp@ghost",
			names: new Set(["mcp__ghost__t1"]),
			persistKey: "toolset-state:tbox.mcp@ghost",
			defaultEnabled: true,
		});

		const entriesBefore = branchOf(mock).length;
		const msg = toggleAll(pi, true, branchOf(mock));
		expect(msg).toContain("Enabled 0");
		expect(branchOf(mock).length).toBe(entriesBefore);
	});

	it("toggleAll all on persists on-intent for an intent-off disconnected toolset", () => {
		// The plan's disconnected-toggle contract, on-direction: a toggle
		// issued while the server is disconnected must be recorded and hold
		// when the tools return. Intent-off (packaged default false) means
		// the call must NOT be skipped even though nothing is actuatable.
		mock.defineFakeToolset({
			id: "tbox.mcp@ghost",
			names: new Set(["mcp__ghost__t1"]),
			persistKey: "toolset-state:tbox.mcp@ghost",
			defaultEnabled: false,
		});

		const entriesBefore = branchOf(mock).length;
		toggleAll(pi, true, branchOf(mock));
		// Library persists: witnessed-on gate cannot fire (0 registered ≠ 1
		// names), so appendEntry({enabled:true}) lands despite no loadout
		// write being possible.
		expect(branchOf(mock).length).toBe(entriesBefore + 1);
	});

	it("describeToolset shows persisted intent, not the empty observation", () => {
		setupInertToolset(mock, true);

		// Observation is off (hidden member can never be active); intent is on.
		expect(describeToolset(ID, branchOf(mock))).toContain(
			"State: enabled",
		);
		actuateToolset(pi, ID, false, branchOf(mock));
		expect(describeToolset(ID, branchOf(mock))).toContain(
			"State: disabled",
		);
	});

	it("formatStatus glyph shows persisted intent", () => {
		setupInertToolset(mock, true);

		expect(formatStatus(pi, branchOf(mock))).toMatch(
			/tbox\.mcp@srv\s+\u2713/,
		);
		actuateToolset(pi, ID, false, branchOf(mock));
		expect(formatStatus(pi, branchOf(mock))).toContain("\u2717");
	});
});

describe("defaults save captures intent, not observation", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;
	let tmpHome: string;
	let oldCwd: string;
	let oldAgentDir: string | undefined;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);

		tmpHome = mkdtempSync(join(tmpdir(), "tbox-intent-"));
		oldCwd = process.cwd();
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tmpHome, ".pi", "agent");
		process.chdir(tmpHome);
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		mkdirSync(join(tmpHome, ".pi"), { recursive: true });
		writeFileSync(join(tmpHome, ".pi", "agent", "settings.json"), "{}\n");
		writeFileSync(join(tmpHome, ".pi", "settings.json"), "{}\n");
	});

	afterEach(() => {
		process.chdir(oldCwd);
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("pins intent-on for an inert toolset whose isEnabled() is false", () => {
		setupInertToolset(mock, true);

		handleDefaults(pi, mock.createCommandContext(), "defaults save");

		const pins = readToolsetDefaults("project");
		expect(pins[KEY]).toEqual({ enabled: true });
	});

	it("pins off for an intent-off toolset (also inert)", () => {
		setupInertToolset(mock, true);
		actuateToolset(pi, ID, false, branchOf(mock));

		handleDefaults(pi, mock.createCommandContext(), "defaults save");

		const pins = readToolsetDefaults("project");
		expect(pins[KEY]).toEqual({ enabled: false });
	});
});
