import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import tboxFactory from "../index.js";

describe("load.test", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("factory does not throw when pi-tool-masking registry is empty", () => {
		expect(() => {
			tboxFactory(pi);
		}).not.toThrow();
	});

	it("factory registers the /tbox command", () => {
		tboxFactory(pi);

		const commands = mock.getTboxCommands();
		expect(commands).toHaveLength(1);
		expect(commands[0]!.name).toBe("tbox");
	});

	it("factory does not throw when pi.getAllTools() returns empty", () => {
		expect(() => {
			tboxFactory(pi);
		}).not.toThrow();
	});

	it("session_start handler registers pi.builtin and per-source orphan toolsets", () => {
		// Add some tools before loading
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
			name: "orphan-tool",
			description: "Orphaned tool",
			sourceInfo: {
				path: "ext.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});

		tboxFactory(pi);

		// Fire session_start to trigger auto-registration
		mock.fireLifecycleEvent("session_start");

		// Check that toolsets were registered
		const toolsets = getRegisteredToolsets();
		const ids = toolsets.map((e: RegistryEntry) => e.spec.id);

		expect(ids).toContain("pi.builtin");
		expect(ids).toContain("tbox.tool@extension");
	});

	it("session_start handler renders the status slot", () => {
		tboxFactory(pi);

		// Fire session_start
		mock.fireLifecycleEvent("session_start");

		// Check that status was set
		const status = mock.getLastStatus("tbox");
		expect(status).toBeDefined();
	});

	it("session_shutdown handler clears the status slot", () => {
		tboxFactory(pi);

		// Fire session_start first
		mock.fireLifecycleEvent("session_start");

		// Then fire session_shutdown
		mock.fireLifecycleEvent("session_shutdown");

		// Check that status was cleared
		const status = mock.getLastStatus("tbox");
		expect(status?.text).toBe("");
	});
});
