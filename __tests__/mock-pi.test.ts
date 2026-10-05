import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

describe("MockPI", () => {
	let mock: MockPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
	});

	// registerCommand / ui.setStatus / clearUiRecords behavior is exercised
	// implicitly by every suite that drives commands and slot renders through
	// the mock.
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

	describe("registerTool activation (mirrors pi)", () => {
		it("activates direct and model-only tools at registration; others are not", () => {
			for (const [name, exposure] of [
				["direct-tool", "direct"],
				["model-only-tool", "model-only"],
				["codemode-tool", "codemode"],
				["deferred-tool", "deferred"],
				["hidden-tool", "hidden"],
			] as const) {
				mock.registerTool({ name, description: name, exposure });
			}

			const active = mock.getActiveTools();
			expect(active).toContain("direct-tool");
			expect(active).toContain("model-only-tool");
			expect(active).not.toContain("codemode-tool");
			expect(active).not.toContain("deferred-tool");
			expect(active).not.toContain("hidden-tool");
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
});
