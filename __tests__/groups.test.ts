import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	actuateGroup,
	resolveGroup,
	describeGroup,
	getGroupNames,
} from "../src/groups.js";
import { setSettingsOverrideForTests } from "../config/settings-reader.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * portal.web (masked, 3 members) + portal.learn (requires portal.web) +
 * host.api (independent) + a builtin + an orphan.
 */
function setupRegistry(mock: MockPI, pi: ExtensionAPI): void {
	mock.registerTool({
		name: "read",
		description: "Read",
		sourceInfo: {
			path: "b.ts",
			source: "builtin",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "web-fetch",
		description: "Fetch",
		sourceInfo: {
			path: "p.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "browser-navigate",
		description: "Navigate",
		sourceInfo: {
			path: "p.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "page-read",
		description: "Read page",
		sourceInfo: {
			path: "p.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "web-learn",
		description: "Learn",
		sourceInfo: {
			path: "p.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "host-call",
		description: "Host",
		sourceInfo: {
			path: "h.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "orphan-tool",
		description: "Orphan",
		sourceInfo: {
			path: "e.ts",
			source: "extension",
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
// resolveGroup / describeGroup / getGroupNames
// ---------------------------------------------------------------------------

describe("group config reading", () => {
	beforeEach(() => {
		setSettingsOverrideForTests({
			tbox: {
				groups: {
					mygroup: { toolsets: ["portal.web"] },
				},
			},
		});
	});
	afterEach(() => setSettingsOverrideForTests(null));

	it("resolveGroup returns the spec for a configured group", () => {
		const r = resolveGroup("mygroup");
		expect("group" in r).toBe(true);
		if ("group" in r) {
			expect(r.group.toolsets).toEqual(["portal.web"]);
		}
	});

	it("resolveGroup errors for a non-existent group", () => {
		const r = resolveGroup("nope");
		expect("error" in r).toBe(true);
		if ("error" in r) expect(r.error).toContain('No group named "nope"');
	});

	it("getGroupNames lists configured groups", () => {
		expect(getGroupNames()).toEqual(["mygroup"]);
	});

	it("describeGroup lists the units", () => {
		const out = describeGroup("mygroup");
		expect(out).toContain("portal.web");
	});
});

// ---------------------------------------------------------------------------
// actuateGroup
// ---------------------------------------------------------------------------

describe("actuateGroup", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setupRegistry(mock, pi);
		setSettingsOverrideForTests(null);
	});

	afterEach(() => setSettingsOverrideForTests(null));

	it("on enables every toolset in the group; requires deps come on via cascade", () => {
		setSettingsOverrideForTests({
			tbox: { groups: { webgroup: { toolsets: ["portal.web"] } } },
		});
		// Disable portal.web (and its dependent portal.learn) first.
		const web = getRegisteredToolsets().find(
			(e) => e.spec.id === "portal.web",
		)!;
		web.toolset.disable(pi);

		const msg = actuateGroup(pi, "webgroup", true);
		expect(msg).toContain('Enabled group "webgroup"');
		expect(mock.getActiveTools()).toContain("web-fetch");
	});

	it("off disables the group's toolset and reports a cascaded non-member (portal.learn)", () => {
		setSettingsOverrideForTests({
			tbox: { groups: { webgroup: { toolsets: ["portal.web"] } } },
		});
		// Everything starts enabled. Disabling portal.web cascades to
		// portal.learn (which requires portal.web).
		const msg = actuateGroup(pi, "webgroup", false);
		expect(msg).toContain('Disabled group "webgroup"');
		expect(mock.getActiveTools()).not.toContain("web-fetch");
		// portal.learn is a cascaded non-member — surfaced in the output.
		expect(msg).toContain("Cascaded");
		expect(msg).toContain("portal.learn");
	});

	it("actuates multiple toolsets in a group", () => {
		setSettingsOverrideForTests({
			tbox: {
				groups: {
					mixed: { toolsets: ["host.api", "portal.learn"] },
				},
			},
		});
		// Disable both first.
		const host = getRegisteredToolsets().find((e) => e.spec.id === "host.api")!;
		const learn = getRegisteredToolsets().find(
			(e) => e.spec.id === "portal.learn",
		)!;
		host.toolset.disable(pi);
		learn.toolset.disable(pi);

		const msg = actuateGroup(pi, "mixed", true);
		expect(msg).toContain('Enabled group "mixed"');
		expect(mock.getActiveTools()).toContain("host-call");
		expect(mock.getActiveTools()).toContain("web-learn");
	});

	it("actuating a non-existent group → clear error", () => {
		setSettingsOverrideForTests({ tbox: { groups: {} } });
		const msg = actuateGroup(pi, "ghost", true);
		expect(msg).toContain('No group named "ghost"');
	});

	it("the drift caveat line appears in the output", () => {
		setSettingsOverrideForTests({
			tbox: { groups: { webgroup: { toolsets: ["portal.web"] } } },
		});
		const msg = actuateGroup(pi, "webgroup", true);
		expect(msg).toContain("drift-free snapshots");
	});
});

// ---------------------------------------------------------------------------
// Integration: /tbox <group> on|off and /tbox group <name> on|off via dispatch
// ---------------------------------------------------------------------------

describe("group dispatch via /tbox", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setupRegistry(mock, pi);
		setSettingsOverrideForTests({
			tbox: { groups: { webgroup: { toolsets: ["portal.web"] } } },
		});

		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();
	});

	afterEach(() => setSettingsOverrideForTests(null));

	it("/tbox webgroup on enables the group's toolset", async () => {
		// Disable portal.web first.
		const web = getRegisteredToolsets().find(
			(e: RegistryEntry) => e.spec.id === "portal.web",
		)!;
		web.toolset.disable(pi);
		mock.clearUiRecords();

		await mock.dispatchCommand("webgroup on");
		const notify = mock.getLastNotify();
		expect(notify!.message).toContain('Enabled group "webgroup"');
		expect(mock.getActiveTools()).toContain("web-fetch");
	});

	it("/tbox webgroup off disables + reports cascaded portal.learn", async () => {
		await mock.dispatchCommand("webgroup off");
		const notify = mock.getLastNotify();
		expect(notify!.message).toContain('Disabled group "webgroup"');
		expect(notify!.message).toContain("portal.learn");
		expect(mock.getActiveTools()).not.toContain("web-fetch");
	});

	it("/tbox group webgroup on behaves identically to the bare form", async () => {
		const web = getRegisteredToolsets().find(
			(e: RegistryEntry) => e.spec.id === "portal.web",
		)!;
		web.toolset.disable(pi);
		mock.clearUiRecords();

		await mock.dispatchCommand("group webgroup on");
		const notify = mock.getLastNotify();
		expect(notify!.message).toContain('Enabled group "webgroup"');
	});

	it("/tbox group webgroup edit — save immediately via key sequence", async () => {
		mock.setCustomKeySequence([mock.keyFor("save")]);

		await mock.dispatchCommand("group webgroup edit");
		const notify = mock.getLastNotify();
		expect(notify!.message).toContain('Group "webgroup" saved');
	});

	it("/tbox group webgroup (bare) describes the group", async () => {
		await mock.dispatchCommand("group webgroup");
		const notify = mock.getLastNotify();
		expect(notify!.message).toContain('Group "webgroup"');
		expect(notify!.message).toContain("portal.web");
	});

	it("/tbox ghostgroup on → no-group error", async () => {
		await mock.dispatchCommand("ghostgroup on");
		const notify = mock.getLastNotify();
		expect(notify!.message).toContain('No group named "ghostgroup"');
	});

	it("/tbox webgroup (bare, no action) → usage pointer", async () => {
		await mock.dispatchCommand("webgroup");
		const notify = mock.getLastNotify();
		expect(notify!.message).toContain("Usage");
		expect(notify!.message).toContain("webgroup on");
	});
});
