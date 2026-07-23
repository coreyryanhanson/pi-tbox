import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	render,
	computeSlotState,
	renderSlotText,
	setFocusUnit,
	getFocusUnit,
	clearSlot,
	SLOT_NAME,
} from "../src/status-slot.js";

describe("status-slot", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
	});

	describe("computeSlotState", () => {
		it("returns pristine when no tools are excluded", () => {
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
			mock.setActiveTools(["read"]);

			const state = computeSlotState(pi);
			expect(state).toEqual({ kind: "pristine" });
		});

		it("returns count when extension tools are excluded", () => {
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
			// Only read is active, web-fetch is excluded
			mock.setActiveTools(["read"]);

			const state = computeSlotState(pi);
			expect(state).toEqual({ kind: "count", n: 1 });
		});

		it("counts only extension tools, not builtin or sdk", () => {
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
				name: "custom-x",
				description: "Custom SDK tool",
				sourceInfo: {
					path: "sdk.ts",
					source: "sdk",
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
			// Only read is active, web-fetch is excluded, but custom-x is sdk (not counted)
			mock.setActiveTools(["read"]);

			const state = computeSlotState(pi);
			expect(state).toEqual({ kind: "count", n: 1 });
		});

		it("returns focus state when in focus", () => {
			setFocusUnit("portal.web");

			// Add an active extension tool so focus is not empty
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
			mock.setActiveTools(["web-fetch"]);

			const state = computeSlotState(pi);
			expect(state).toEqual({ kind: "focus", unit: "portal.web" });
		});

		it("returns focus-empty when focus allowlist is empty", () => {
			setFocusUnit("portal.web");
			// No extension tools are active
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
			mock.setActiveTools([]);

			const state = computeSlotState(pi);
			expect(state).toEqual({ kind: "focus-empty" });
		});
	});

	describe("renderSlotText", () => {
		it("renders pristine state", () => {
			const fg = (color: string, text: string) =>
				`<${color}>${text}</${color}>`;
			const text = renderSlotText({ kind: "pristine" }, fg);
			expect(text).toBe("<dim>○</dim> tbox");
		});

		it("renders count state", () => {
			const fg = (color: string, text: string) =>
				`<${color}>${text}</${color}>`;
			const text = renderSlotText({ kind: "count", n: 3 }, fg);
			expect(text).toBe("<accent>●</accent> tbox 3");
		});

		it("renders focus state", () => {
			const fg = (color: string, text: string) =>
				`<${color}>${text}</${color}>`;
			const text = renderSlotText({ kind: "focus", unit: "portal.web" }, fg);
			expect(text).toBe("<success>●</success> focus:portal.web");
		});

		it("renders focus-empty state", () => {
			const fg = (color: string, text: string) =>
				`<${color}>${text}</${color}>`;
			const text = renderSlotText({ kind: "focus-empty" }, fg);
			expect(text).toBe("<error>●</error> focus:∅");
		});
	});

	describe("render", () => {
		it("sets the status bar with pristine state on fresh session", () => {
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
			mock.setActiveTools(["read"]);

			const ctx = mock.createContext();
			render(
				pi,
				ctx as unknown as {
					ui: {
						setStatus: (slot: string, text: string) => void;
						theme: { fg: (color: string, text: string) => string };
					};
				},
			);

			const status = mock.getLastStatus(SLOT_NAME);
			expect(status).toBeDefined();
			expect(status!.text).toBe("<dim>○</dim> tbox");
		});

		it("sets the status bar with count state when tools are excluded", () => {
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
			mock.setActiveTools([]);

			const ctx = mock.createContext();
			render(
				pi,
				ctx as unknown as {
					ui: {
						setStatus: (slot: string, text: string) => void;
						theme: { fg: (color: string, text: string) => string };
					};
				},
			);

			const status = mock.getLastStatus(SLOT_NAME);
			expect(status).toBeDefined();
			expect(status!.text).toBe("<accent>●</accent> tbox 1");
		});
	});

	describe("focus management", () => {
		it("setFocusUnit and getFocusUnit round-trip", () => {
			expect(getFocusUnit()).toBeNull();

			setFocusUnit("portal.web");
			expect(getFocusUnit()).toBe("portal.web");

			setFocusUnit(null);
			expect(getFocusUnit()).toBeNull();
		});
	});

	describe("clearSlot", () => {
		it("clears the slot on session shutdown", () => {
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
			mock.setActiveTools([]);

			// First render
			const ctx = mock.createContext();
			render(
				pi,
				ctx as unknown as {
					ui: {
						setStatus: (slot: string, text: string) => void;
						theme: { fg: (color: string, text: string) => string };
					};
				},
			);

			expect(mock.getLastStatus(SLOT_NAME)).toBeDefined();

			// Clear on shutdown
			clearSlot(
				ctx as unknown as {
					ui: { setStatus: (slot: string, text: string) => void };
				},
			);

			const lastStatus = mock.getLastStatus(SLOT_NAME);
			expect(lastStatus?.text).toBe("");
		});
	});
});
