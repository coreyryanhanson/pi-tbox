import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

describe("MockPI", () => {
	let mock: MockPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
	});

	describe("registerCommand", () => {
		it("records a command", async () => {
			mock.registerCommand("tbox", {
				description: "Test command",
				handler: async (args, ctx) => {
					ctx.ui.notify(`Called with: ${args}`, "info");
				},
			});

			const commands = mock.getTboxCommands();
			expect(commands).toHaveLength(1);
			expect(commands[0]!.name).toBe("tbox");
			expect(commands[0]!.description).toBe("Test command");
		});

		it("dispatches a command", async () => {
			mock.registerCommand("tbox", {
				description: "Test command",
				handler: async (args, ctx) => {
					ctx.ui.notify(`Called with: ${args}`, "info");
				},
			});

			await mock.dispatchCommand("list --flat");

			const notifies = mock.getNotifyRecords();
			expect(notifies).toHaveLength(1);
			expect(notifies[0]!.message).toBe("Called with: list --flat");
		});
	});

	describe("ui.setStatus", () => {
		it("records status per slot", async () => {
			mock.registerCommand("tbox", {
				description: "Test command",
				handler: async (_args, ctx) => {
					ctx.ui.setStatus("tbox", "● tbox 3");
				},
			});

			await mock.dispatchCommand("test");

			const status = mock.getStatusRecords();
			expect(status).toHaveLength(1);
			expect(status[0]!.slot).toBe("tbox");
			expect(status[0]!.text).toBe("● tbox 3");
		});

		it("getLastStatus returns the last status for a slot", async () => {
			mock.registerCommand("tbox", {
				description: "Test command",
				handler: async (_args, ctx) => {
					ctx.ui.setStatus("tbox", "○ tbox");
					ctx.ui.setStatus("other", "other slot");
					ctx.ui.setStatus("tbox", "● tbox 5");
				},
			});

			await mock.dispatchCommand("test");

			const lastTbox = mock.getLastStatus("tbox");
			expect(lastTbox?.text).toBe("● tbox 5");

			const lastOther = mock.getLastStatus("other");
			expect(lastOther?.text).toBe("other slot");

			expect(mock.getLastStatus("nonexistent")).toBeUndefined();
		});
	});

	describe("ui.theme.fg", () => {
		it("wraps text with color markers", async () => {
			mock.registerCommand("tbox", {
				description: "Test command",
				handler: async (_args, ctx) => {
					const text = ctx.ui.theme.fg("accent", "●");
					ctx.ui.notify(text, "info");
				},
			});

			await mock.dispatchCommand("test");

			const notifies = mock.getNotifyRecords();
			expect(notifies[0]!.message).toBe("<accent>●</accent>");
		});
	});

	describe("defineFakeToolset", () => {
		it("registers a toolset in the global registry", () => {
			const entry = mock.defineFakeToolset({
				id: "portal.web",
				names: new Set(["web-fetch", "browser-navigate"]),
				persistKey: "toolset-state:portal.web",
				defaultEnabled: true,
			});

			expect(entry.spec.id).toBe("portal.web");
			expect(entry.spec.names).toEqual(
				new Set(["web-fetch", "browser-navigate"]),
			);
		});

		it("makes the toolset visible via getRegisteredToolsets", () => {
			mock.defineFakeToolset({
				id: "portal.web",
				names: new Set(["web-fetch"]),
				persistKey: "toolset-state:portal.web",
			});

			const toolsets = getRegisteredToolsets();
			expect(
				toolsets.some((e: RegistryEntry) => e.spec.id === "portal.web"),
			).toBe(true);
		});
	});

	describe("getAllTools with different source flavors", () => {
		it("registers tools with different sourceInfo.source values", () => {
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

			const tools = mock.getAllTools();
			expect(tools).toHaveLength(3);

			const builtin = tools.find((t) => t.sourceInfo.source === "builtin");
			expect(builtin?.name).toBe("read");

			const sdk = tools.find((t) => t.sourceInfo.source === "sdk");
			expect(sdk?.name).toBe("custom-x");

			const ext = tools.find((t) => t.sourceInfo.source === "extension");
			expect(ext?.name).toBe("web-fetch");
		});
	});

	describe("clearUiRecords", () => {
		it("clears all UI records", async () => {
			mock.registerCommand("tbox", {
				description: "Test command",
				handler: async (_args, ctx) => {
					ctx.ui.setStatus("tbox", "test");
					ctx.ui.notify("test", "info");
				},
			});

			await mock.dispatchCommand("test");
			expect(mock.getStatusRecords()).toHaveLength(1);
			expect(mock.getNotifyRecords()).toHaveLength(1);

			mock.clearUiRecords();
			expect(mock.getStatusRecords()).toHaveLength(0);
			expect(mock.getNotifyRecords()).toHaveLength(0);
		});
	});
});
