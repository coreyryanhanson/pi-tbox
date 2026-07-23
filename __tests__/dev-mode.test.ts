import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDevMode, setDevMode } from "../src/toggle.js";
import { formatStatus } from "../src/list.js";
import tboxFactory from "../index.js";

// ---------------------------------------------------------------------------
// Unit: setDevMode / isDevMode (in-memory, session-scoped)
// ---------------------------------------------------------------------------

describe("dev mode (in-memory)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setDevMode(false);
	});

	it("starts disabled", () => {
		expect(isDevMode()).toBe(false);
	});

	it("setDevMode(true) flips flag on", () => {
		setDevMode(true);
		expect(isDevMode()).toBe(true);
	});

	it("setDevMode(false) flips flag back off", () => {
		setDevMode(true);
		expect(isDevMode()).toBe(true);

		setDevMode(false);
		expect(isDevMode()).toBe(false);
	});

	it("session_shutdown resets dev mode to false", async () => {
		tboxFactory(pi);
		mock.fireLifecycleEvent("session_start");
		await mock.dispatchCommand("dev on");
		expect(isDevMode()).toBe(true);

		mock.fireLifecycleEvent("session_shutdown");
		expect(isDevMode()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Integration: dev command via dispatchCommand
// ---------------------------------------------------------------------------

describe("dev command via dispatchCommand", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setDevMode(false);

		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();
	});

	it("dev on flips flag and notifies", async () => {
		await mock.dispatchCommand("dev on");

		expect(isDevMode()).toBe(true);

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Dev mode enabled");
	});

	it("dev off flips flag and notifies", async () => {
		// Enable first
		await mock.dispatchCommand("dev on");
		mock.clearUiRecords();

		// Then disable
		await mock.dispatchCommand("dev off");

		expect(isDevMode()).toBe(false);

		const notify = mock.getLastNotify();
		expect(notify).toBeDefined();
		expect(notify!.message).toContain("Dev mode disabled");
	});

	it("dev bare reports current state", async () => {
		await mock.dispatchCommand("dev");

		const notify1 = mock.getLastNotify();
		expect(notify1).toBeDefined();
		expect(notify1!.message).toContain("off");

		mock.clearUiRecords();
		await mock.dispatchCommand("dev on");
		mock.clearUiRecords();

		await mock.dispatchCommand("dev");
		const notify2 = mock.getLastNotify();
		expect(notify2).toBeDefined();
		expect(notify2!.message).toContain("on");
	});

	it("/tbox status reflects dev mode state", async () => {
		// Off by default
		const output1 = formatStatus(pi);
		expect(output1).toContain("Dev Mode: off");

		// Enable via command
		await mock.dispatchCommand("dev on");
		const output2 = formatStatus(pi);
		expect(output2).toContain("Dev Mode: on");
	});
});
