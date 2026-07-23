import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isDevMode,
	loadDevModeFromSettings,
	resetDevMode,
} from "../src/toggle.js";
import { formatStatus } from "../src/list.js";
import {
	setSettingsOverrideForTests,
	readTboxConfig,
} from "../config/settings-reader.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import tboxFactory from "../index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A tool population + toolsets with a masked group and a builtin. */
function setupFixture(mock: MockPI, pi: ExtensionAPI): void {
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
		description: "Fetch",
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
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
		masked: true,
	});
	autoRegisterBuiltinAndOrphans(pi);
	for (const entry of getRegisteredToolsets()) entry.toolset.enable(pi);
}

// ---------------------------------------------------------------------------
// Unit: readTboxConfig + loadDevModeFromSettings (settings-backed)
// ---------------------------------------------------------------------------

describe("dev mode (settings-backed)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		resetDevMode();
		setSettingsOverrideForTests(null);
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
	});

	it("defaults to off when tbox.dev is absent", () => {
		setSettingsOverrideForTests({});
		expect(loadDevModeFromSettings()).toBe(false);
		expect(isDevMode()).toBe(false);
	});

	it("reads tbox.dev: true and flips the flag on", () => {
		setSettingsOverrideForTests({ tbox: { dev: true } });
		expect(loadDevModeFromSettings()).toBe(true);
		expect(isDevMode()).toBe(true);
	});

	it("reads tbox.dev: false and keeps the flag off", () => {
		setSettingsOverrideForTests({ tbox: { dev: false } });
		expect(loadDevModeFromSettings()).toBe(false);
		expect(isDevMode()).toBe(false);
	});

	it("ignores a non-boolean tbox.dev (treats as false)", () => {
		setSettingsOverrideForTests({ tbox: { dev: "yes" } });
		expect(loadDevModeFromSettings()).toBe(false);
	});

	it("resetDevMode clears the in-memory flag (session_shutdown)", () => {
		setSettingsOverrideForTests({ tbox: { dev: true } });
		loadDevModeFromSettings();
		expect(isDevMode()).toBe(true);

		resetDevMode();
		expect(isDevMode()).toBe(false);
	});

	it("readTboxConfig returns dev + groups together", () => {
		setSettingsOverrideForTests({
			tbox: { dev: true, groups: { mygroup: { toolsets: ["portal.web"] } } },
		});
		const cfg = readTboxConfig();
		expect(cfg.dev).toBe(true);
		expect(Object.keys(cfg.groups)).toEqual(["mygroup"]);
	});
});

// ---------------------------------------------------------------------------
// Integration: session_start reads tbox.dev; guards lift accordingly
// ---------------------------------------------------------------------------

describe("dev mode via session_start + guards", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		resetDevMode();
		setSettingsOverrideForTests(null);

		const mod = await import("../index.js");
		mod.default(pi);
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
	});

	it("session_start with tbox.dev: true lifts the masked-member guard", async () => {
		setupFixture(mock, pi);
		setSettingsOverrideForTests({ tbox: { dev: true } });

		mock.fireLifecycleEvent("session_start");
		expect(isDevMode()).toBe(true);

		mock.clearUiRecords();
		await mock.dispatchCommand("toggle web-fetch");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		// Dev mode on → masked member is toggleable, not refused.
		expect(notify!.message).not.toContain("sealed group");
		expect(notify!.message).toContain("web-fetch");
	});

	it("session_start with tbox.dev absent keeps the masked-member guard", async () => {
		setupFixture(mock, pi);
		setSettingsOverrideForTests({});

		mock.fireLifecycleEvent("session_start");
		expect(isDevMode()).toBe(false);

		mock.clearUiRecords();
		await mock.dispatchCommand("toggle web-fetch");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.level).toBe("error");
		expect(notify!.message).toContain("sealed group");
	});

	it("session_start with tbox.dev: true lifts the builtin guard", async () => {
		setupFixture(mock, pi);
		setSettingsOverrideForTests({ tbox: { dev: true } });

		mock.fireLifecycleEvent("session_start");

		mock.clearUiRecords();
		await mock.dispatchCommand("toggle read");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).not.toContain("builtins are protected");
	});

	it("/tbox status reports Dev Mode from the read value", async () => {
		setupFixture(mock, pi);
		setSettingsOverrideForTests({ tbox: { dev: true } });
		mock.fireLifecycleEvent("session_start");

		const output = formatStatus(pi);
		expect(output).toContain("Dev Mode: on");
	});

	it("there is no /tbox dev command — 'dev' is a group shorthand", async () => {
		setupFixture(mock, pi);
		setSettingsOverrideForTests({ tbox: { dev: true } });
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		// /tbox dev on → no group named "dev" → resolveGroup error, NOT a
		// dev-mode toggle. Proves the command surface is gone.
		await mock.dispatchCommand("dev on");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain('No group named "dev"');
		expect(isDevMode()).toBe(true); // unchanged
	});

	it("session_shutdown resets the in-memory dev flag", async () => {
		setupFixture(mock, pi);
		setSettingsOverrideForTests({ tbox: { dev: true } });
		mock.fireLifecycleEvent("session_start");
		expect(isDevMode()).toBe(true);

		mock.fireLifecycleEvent("session_shutdown");
		expect(isDevMode()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Sanity: a group named "dev" is reachable via the group shorthand
// ---------------------------------------------------------------------------

describe("group named 'dev' (no longer reserved)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		resetDevMode();
		setSettingsOverrideForTests({ tbox: { dev: true } });
		const mod = await import("../index.js");
		mod.default(pi);
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
	});

	it("/tbox dev on actuates a group named 'dev' (not a dev-mode command)", async () => {
		setupFixture(mock, pi);
		// Define a group named "dev" containing portal.web.
		setSettingsOverrideForTests({
			tbox: { dev: true, groups: { dev: { toolsets: ["portal.web"] } } },
		});
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();

		// Disable portal.web first so actuation has a visible effect.
		const web = getRegisteredToolsets().find(
			(e: RegistryEntry) => e.spec.id === "portal.web",
		)!;
		web.toolset.disable(pi);
		mock.clearUiRecords();

		await mock.dispatchCommand("dev on");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain('Enabled group "dev"');
	});
});
