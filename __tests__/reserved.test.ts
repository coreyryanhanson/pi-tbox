import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReserved } from "../src/reserved.js";
import {
	setGroupsOverrideForTests,
	writeGroup,
} from "../config/settings-reader.js";
import { autoRegisterBuiltinAndOrphans } from "../src/registry.js";
import { getRegisteredToolsets } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// isReserved / wordlist
// ---------------------------------------------------------------------------

describe("reserved wordlist", () => {
	it("'dev' is NOT reserved (the /tbox dev command was removed in Sprint 3)", () => {
		expect(isReserved("dev")).toBe(false);
	});

	it("seed subcommands are all reserved", () => {
		for (const w of [
			"status",
			"focus",
			"all",
			"list",
			"group",
			"on",
			"off",
			"edit",
			"remove",
			"chars",
		]) {
			expect(isReserved(w)).toBe(true);
		}
	});

	it("non-reserved names are not reserved", () => {
		expect(isReserved("mygroup")).toBe(false);
		expect(isReserved("portal")).toBe(false);
		// "toggle" was freed when the toggle command was removed.
		expect(isReserved("toggle")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Dispatch: reserved words hit their subcommand, not a group
// ---------------------------------------------------------------------------

describe("reserved-word dispatch via /tbox", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setGroupsOverrideForTests(null);

		// A tool population so list/status have something to render.
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
		mock.defineFakeToolset({
			id: "portal.web",
			names: new Set(["web-fetch"]),
			persistKey: "toolset-state:portal.web",
			defaultEnabled: true,
		});
		autoRegisterBuiltinAndOrphans(pi);
		for (const entry of getRegisteredToolsets()) entry.toolset.enable(pi);

		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();
	});

	afterEach(() => {
		setGroupsOverrideForTests(null);
	});

	it("/tbox list on (reserved 'list') does NOT actuate a group — dispatches to list", async () => {
		// Even though "on" is a valid action, "list" is reserved so the
		// subcommand wins. list ignores the trailing "on" and renders.
		await mock.dispatchCommand("list on");

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		// The list output contains the grouped header, not a group-actuation line.
		expect(notify!.message).toContain("Tools by group");
		expect(notify!.message).not.toContain("Enabled group");
	});

	it("/tbox focus on dispatches to the focus subcommand, not group shorthand", async () => {
		await mock.dispatchCommand("focus on");
		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		// "focus" is a real subcommand, so this goes to the focus handler,
		// not the group shorthand. "on" as a focus unit won't match anything.
		expect(notify!.message).not.toContain("Enabled group");
		expect(notify!.message).toContain("No group matching");
	});
});
