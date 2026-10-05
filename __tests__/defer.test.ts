/**
 * Defer-child gate tests (§4).
 *
 * Two gates cover every tbox entry point (the plan's §3 architecture —
 * no per-flow or function-level defer gates exist):
 *   - one message-producing `isDeferredChild()` gate at the `/tbox` command
 *     dispatch (covers every governance-writing flow, including the
 *     settings-writer flows the library's defer rule leaves live);
 *   - one silent gate at `captureAndRender` (session_start/session_tree) —
 *     a deferring child gets no registration, actuation, MCP sync, focus
 *     restore, slot render, or per-prompt re-scan wiring at all.
 *
 * The var must be foreign-pid (only the foreign-pid check is correct — the
 * parent legitimately carries its own pid var in the same process), which
 * is exactly what masking's shared `isDeferredChild()` implements.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
	MockPI,
	useTempAgentDir,
} from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets } from "pi-tool-masking";
import { orphanToolsetId } from "../src/registry.js";
import { getFocusUnit, setFocusUnit } from "../src/status-slot.js";

// File-wide temp settings dirs — never touches the developer's ~/.pi.
const settings = useTempAgentDir();

const DEFER_ENV = "PI_TOOLMASKING_DEFER";
/** A pid that cannot be this process's — the foreign-pid shape. */
const FOREIGN_PID = "999999999";

describe("defer child: /tbox dispatch gate", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
		setupToolsets(mock);
		const mod = await import("../index.js");
		mod.default(pi);
		process.env[DEFER_ENV] = FOREIGN_PID;
	});

	afterEach(() => {
		delete process.env[DEFER_ENV];
	});

	it("/tbox all on notifies the refusal and writes no branch entries", async () => {
		mock.clearUiRecords();

		await mock.dispatchCommand("all on");

		const notify = mock.getLastNotify();
		expect(notify!.message).toBe("tbox is governed by the parent session");
		expect(notify!.level).toBe("info");
		// Not `0 changed` — the count-shaped exemption is gone with the
		// per-flow policy this gate replaces. No entries, no actuation.
		expect(
			mock
				.getEntries()
				.filter((e) => e.customType.startsWith("toolset-state:")),
		).toHaveLength(0);
		expect(mock.getActiveTools()).not.toContain("web-fetch");
	});

	it("/tbox defaults save notifies the refusal and leaves settings byte-identical", async () => {
		// The settings tier is outside the library's defer traceability rule,
		// so this dispatch gate is the only protection for it.
		const settingsPath = settings.globalSettings;
		writeFileSync(settingsPath, '{"toolsetDefaults":{}}\n');
		mock.clearUiRecords();

		await mock.dispatchCommand("defaults save");

		expect(mock.getLastNotify()!.message).toBe(
			"tbox is governed by the parent session",
		);
		expect(readFileSync(settingsPath, "utf8")).toBe('{"toolsetDefaults":{}}\n');
	});
});

describe("defer child: capture handler gate", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
		// No defineFakeToolset here: masking's defineToolset wires its own
		// before_agent_start reconciler on the mock, which would pollute the
		// handler-count assertion below. The orphan tool alone exercises the
		// gate (registration + actuation are what must not happen).
		setupToolsets(mock, false);
	});

	afterEach(() => {
		delete process.env[DEFER_ENV];
	});

	it("session_start does nothing: no registration, actuation, sync, restore, or render", async () => {
		const mod = await import("../index.js");
		mod.default(pi);
		process.env[DEFER_ENV] = FOREIGN_PID;

		mock.fireLifecycleEvent("session_start");

		// No registration — the orphan toolset was never defined.
		const ids = getRegisteredToolsets().map((e) => e.spec.id);
		expect(ids).not.toContain(orphanToolsetId("new-ext"));
		// No actuation, no slot render, no focus mirror.
		expect(mock.getActiveTools()).not.toContain("new-tool");
		expect(mock.getStatusRecords()).toHaveLength(0);
		expect(getFocusUnit()).toBeNull();
		// The per-prompt before_agent_start re-scan is never wired — a
		// prompt in the child triggers no scan and no re-render.
		expect(mock.handlerCount("before_agent_start")).toBe(0);
		mock.fireLifecycleEvent("before_agent_start");
		expect(mock.getStatusRecords()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function setupToolsets(mock: MockPI, withToolset = true): void {
	// One live extension tool from a dedicated source — if the capture
	// handler ran, autoRegisterBuiltinAndOrphans would register it as an
	// orphan toolset and actuate it.
	mock.registerTool({
		name: "new-tool",
		description: "Newly installed tool",
		exposure: "codemode",
		sourceInfo: { path: "new.ts", source: "new-ext", scope: "user", origin: "top-level" },
	});
	if (!withToolset) return;
	mock.registerTool({
		name: "web-fetch",
		description: "Fetch",
		exposure: "codemode",
		sourceInfo: { path: "p.ts", source: "p", scope: "user", origin: "top-level" },
	});
	mock.defineFakeToolset({
		id: "portal.web",
		names: new Set(["web-fetch"]),
		persistKey: "toolset-state:portal.web",
		defaultEnabled: true,
	});
}
