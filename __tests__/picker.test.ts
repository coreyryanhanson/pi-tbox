/**
 * Sprint 4 — Group editing picker UX.
 *
 * Tests the GroupEditorComponent: option-list content, requires-closure
 * auto-maintenance, config save, re-open with saved state, cancel, and
 * windowing.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets } from "pi-tool-masking";
import { setSettingsOverrideForTests } from "../config/settings-reader.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { GroupEditorComponent } from "../src/group-editor.js";
import type { GroupEditorConfig } from "../src/group-editor.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildPickerUnits } from "../src/groups.js";

// ---------------------------------------------------------------------------
// Theme stub
// ---------------------------------------------------------------------------

const stubTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const KEY = {
	up: "\x1B[A",
	down: "\x1B[B",
	enter: "\r",
	escape: "\x1B",
	save: "\x13", // ctrl+s
};

// ---------------------------------------------------------------------------
// Fixture: a realistic multi-extension registry
// ---------------------------------------------------------------------------

function setupRichRegistry(mock: MockPI, pi: ExtensionAPI): void {
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
		name: "bash",
		description: "Bash",
		sourceInfo: {
			path: "builtin.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "custom-x",
		description: "SDK tool",
		sourceInfo: {
			path: "sdk.ts",
			source: "sdk",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "web-fetch",
		description: "Fetch web pages",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "browser-navigate",
		description: "Navigate browser",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "page-read",
		description: "Read page",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "web-learn",
		description: "Learn from web",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "host-call",
		description: "Host API call",
		sourceInfo: {
			path: "host.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "ext-a-tool",
		description: "Extension A tool",
		sourceInfo: {
			path: "ext-a.ts",
			source: "ext-a",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "ext-b-tool",
		description: "Extension B tool",
		sourceInfo: {
			path: "ext-b.ts",
			source: "ext-b",
			scope: "user",
			origin: "top-level",
		},
	});

	mock.defineFakeToolset({
		id: "portal.web",
		label: "Portal Web",
		names: new Set(["web-fetch", "browser-navigate", "page-read"]),
		persistKey: "toolset-state:portal.web",
		defaultEnabled: true,
		masked: true,
	});
	mock.defineFakeToolset({
		id: "portal.learn",
		label: "Portal Learn",
		names: new Set(["web-learn"]),
		persistKey: "toolset-state:portal.learn",
		defaultEnabled: true,
		masked: false,
		requires: ["portal.web"],
	});
	mock.defineFakeToolset({
		id: "host.api",
		names: new Set(["host-call"]),
		persistKey: "toolset-state:host.api",
		defaultEnabled: true,
	});

	autoRegisterBuiltinAndOrphans(pi);
	for (const entry of getRegisteredToolsets()) entry.toolset.enable(pi);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREFIX_CHECKED = "\u2713";

/** Create a GroupEditorComponent for tests. Use generous width to avoid truncation. */
function createComp(
	overrides?: Partial<GroupEditorConfig>,
	devMode = false,
): GroupEditorComponent {
	return new GroupEditorComponent(
		{
			groupName: "test",
			devMode,
			initial: { toolsets: [], tools: [] },
			units: buildPickerUnits(devMode),
			onSave: () => {},
			onCancel: () => {},
			...overrides,
		},
		stubTheme,
	);
}

/** Count item rows in render output (lines with ✓ or ○). */
function countItems(lines: string[]): number {
	return lines.filter((l) => l.includes("\u2713") || l.includes("\u25CB"))
		.length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("picker — normal mode option list", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setupRichRegistry(mock, pi);
		setSettingsOverrideForTests({
			tbox: { groups: { mygroup: { toolsets: [], tools: [] } } },
		});
	});

	afterEach(() => setSettingsOverrideForTests(null));

	it("masked toolset appears as one sealed row; its members absent", () => {
		const comp = createComp();
		const lines = comp.render(120);

		const portalWebRows = lines.filter((l) => l.includes("Portal Web"));
		expect(portalWebRows.length).toBe(1);
		expect(portalWebRows[0]).toContain("3 tools");

		const fetchRows = lines.filter((l) => l.includes("web-fetch"));
		expect(fetchRows.length).toBe(0);
	});

	it("pi.builtin is absent from the option list", () => {
		const comp = createComp();
		const lines = comp.render(120);

		const builtinRows = lines.filter(
			(l) => l.includes("Pi Builtins") || l.includes("pi.builtin"),
		);
		expect(builtinRows.length).toBe(0);
	});

	it("orphan tools appear in the unit list", () => {
		const comp = createComp();

		// Check via filteredItems (all units, not windowed render)
		const ids = comp.filteredItems.map((u) => u.id);
		expect(ids).toContain("ext-a-tool");
		expect(ids).toContain("ext-b-tool");

		// In the rendered window, at least the visible orphans appear
		const lines = comp.render(120);
		const extA = lines.filter((l) => l.includes("ext-a-tool"));
		expect(extA.length).toBe(1);
	});

	it("unmasked toolset appears as toolset row + member rows", () => {
		const comp = createComp();
		const lines = comp.render(120);

		// The toolset label in the unit is "host.api (1 tools)"
		const hostApiRows = lines.filter((l) => l.includes("host.api (1 tools)"));
		expect(hostApiRows.length).toBe(1);

		const hostCallRows = lines.filter((l) => l.includes("host-call"));
		expect(hostCallRows.length).toBe(1);
	});
});

describe("picker — dev mode option list", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setupRichRegistry(mock, pi);
		setSettingsOverrideForTests({
			tbox: { dev: true, groups: { mygroup: { toolsets: [], tools: [] } } },
		});
	});

	afterEach(() => setSettingsOverrideForTests(null));

	it("masked toolset members are present as individual rows in dev mode", () => {
		const comp = createComp({}, true);
		const lines = comp.render(120);

		const webFetchRows = lines.filter((l) => l.includes("web-fetch"));
		expect(webFetchRows.length).toBe(1);

		const maskedToolsetRow = lines.filter(
			(l) => l.includes("Portal Web") && l.includes("masked"),
		);
		expect(maskedToolsetRow.length).toBe(0);
	});

	it("pi.builtin is absent in dev mode too", () => {
		const comp = createComp({}, true);
		const lines = comp.render(120);

		const builtinRows = lines.filter(
			(l) => l.includes("Pi Builtins") || l.includes("pi.builtin"),
		);
		expect(builtinRows.length).toBe(0);
	});
});

describe("picker — forward closure in normal mode", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setupRichRegistry(mock, pi);
		setSettingsOverrideForTests({
			tbox: { groups: { mygroup: { toolsets: [], tools: [] } } },
		});
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
		MockPI.cleanRegistry();
	});

	it("selecting portal.learn toolset auto-checks portal.web via forward closure; group saved with both", () => {
		let savedSpec: { toolsets: string[]; tools: string[] } | null = null;

		const comp = createComp({
			initial: { toolsets: [], tools: [] },
			onSave: (spec) => {
				savedSpec = spec;
			},
		});

		const idx = comp.filteredItems.findIndex((u) => u.id === "portal.learn");
		expect(idx).toBeGreaterThanOrEqual(0);
		comp.selectedIndex = idx;

		comp.handleInput(KEY.enter);
		comp.handleInput(KEY.save);

		expect(savedSpec).not.toBeNull();
		expect(savedSpec!.toolsets).toContain("portal.learn");
		expect(savedSpec!.toolsets).toContain("portal.web");

		// Cue text was captured
		expect(comp.lastCue).toContain("portal.web");
	});
});

describe("picker — reverse closure in normal mode", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setupRichRegistry(mock, pi);
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
		MockPI.cleanRegistry();
	});

	it("deselecting portal.learn removes it; portal.web stays (user-checked)", () => {
		let savedSpec: { toolsets: string[]; tools: string[] } | null = null;

		const comp = createComp({
			initial: { toolsets: ["portal.learn", "portal.web"], tools: [] },
			onSave: (spec) => {
				savedSpec = spec;
			},
		});

		const idx = comp.filteredItems.findIndex((u) => u.id === "portal.learn");
		expect(idx).toBeGreaterThanOrEqual(0);
		comp.selectedIndex = idx;

		comp.handleInput(KEY.enter);
		comp.handleInput(KEY.save);

		expect(savedSpec).not.toBeNull();
		expect(savedSpec!.toolsets).toContain("portal.web");
		expect(savedSpec!.toolsets).not.toContain("portal.learn");
	});
});

describe("picker — confirm writes config; re-open reflects saved state", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setupRichRegistry(mock, pi);
		setSettingsOverrideForTests({
			tbox: { groups: { savetest: { toolsets: [], tools: [] } } },
		});
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
		MockPI.cleanRegistry();
	});

	it("confirm saves group spec via onSave callback", () => {
		let savedSpec: { toolsets: string[]; tools: string[] } | null = null;

		const comp = createComp({
			groupName: "savetest",
			initial: { toolsets: [], tools: [] },
			onSave: (spec) => {
				savedSpec = spec;
			},
		});

		const idx = comp.filteredItems.findIndex((u) => u.id === "host.api");
		expect(idx).toBeGreaterThanOrEqual(0);
		comp.selectedIndex = idx;
		comp.handleInput(KEY.enter);
		comp.handleInput(KEY.save);

		expect(savedSpec).not.toBeNull();
		expect(savedSpec!.toolsets).toContain("host.api");
		expect(savedSpec!.tools).toEqual([]);
	});

	it("re-opening shows previously-saved checks", () => {
		let savedSpec: { toolsets: string[]; tools: string[] } | null = null;

		const comp1 = createComp({
			groupName: "savetest",
			initial: { toolsets: [], tools: [] },
			onSave: (spec) => {
				savedSpec = spec;
			},
		});

		const idx = comp1.filteredItems.findIndex((u) => u.id === "host-call");
		expect(idx).toBeGreaterThanOrEqual(0);
		comp1.selectedIndex = idx;
		comp1.handleInput(KEY.enter);
		comp1.handleInput(KEY.save);

		expect(savedSpec).not.toBeNull();
		expect(savedSpec!.tools).toContain("host-call");

		// Second pass: re-open with saved state
		const comp2 = createComp({
			groupName: "savetest",
			initial: savedSpec!,
		});
		const lines = comp2.render(120);

		// host-call should show as checked (✓ in the line)
		const checkedHostCall = lines.find(
			(l) => l.includes(PREFIX_CHECKED) && l.includes("host-call"),
		);
		expect(checkedHostCall).toBeDefined();
	});

	it("cancel discards changes", () => {
		let cancelled = false;
		let saved = false;

		const comp = createComp({
			groupName: "savetest",
			initial: { toolsets: [], tools: [] },
			onSave: () => {
				saved = true;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		const idx = comp.filteredItems.findIndex((u) => u.id === "host.api");
		comp.selectedIndex = idx;
		comp.handleInput(KEY.enter);
		comp.handleInput(KEY.escape);

		expect(cancelled).toBe(true);
		expect(saved).toBe(false);
	});
});

describe("picker — windowing", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setupRichRegistry(mock, pi);
		setSettingsOverrideForTests({
			tbox: { groups: { mygroup: { toolsets: [], tools: [] } } },
		});
	});

	afterEach(() => setSettingsOverrideForTests(null));

	it("render shows at most 8 item rows with a large fixture", () => {
		const comp = createComp();
		const lines = comp.render(120);

		const itemCount = countItems(lines);
		expect(itemCount).toBeLessThanOrEqual(8);

		// Scroll indicator present since 9 items > maxVisible (8)
		const scroll = lines.find((l) => l.includes("/") && /\d+\/\d+/.test(l));
		expect(scroll).toBeDefined();
	});
});
