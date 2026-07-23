import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	autoRegisterBuiltinAndOrphans,
	BUILTIN_TOOLSET_ID,
	ORPHANS_TOOLSET_ID,
} from "../src/registry.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

describe("autoRegisterBuiltinAndOrphans", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("registers pi.builtin with builtin tools", () => {
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
			description: "Run bash commands",
			sourceInfo: {
				path: "builtin.ts",
				source: "builtin",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		const builtin = toolsets.find(
			(e: RegistryEntry) => e.spec.id === BUILTIN_TOOLSET_ID,
		);

		expect(builtin).toBeDefined();
		expect(builtin!.spec.names).toEqual(new Set(["read", "bash"]));
		expect(builtin!.spec.defaultEnabled).toBe(true);
		expect(builtin!.spec.masked).toBe(false);
	});

	it("registers tbox.orphans with unclaimed extension tools", () => {
		mock.registerTool({
			name: "orphan-tool",
			description: "An orphaned tool",
			sourceInfo: {
				path: "ext.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		const orphans = toolsets.find(
			(e: RegistryEntry) => e.spec.id === ORPHANS_TOOLSET_ID,
		);

		expect(orphans).toBeDefined();
		expect(orphans!.spec.names).toEqual(new Set(["orphan-tool"]));
		expect(orphans!.spec.defaultEnabled).toBe(true);
	});

	it("does not register sdk tools in any toolset", () => {
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

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		const allNames = toolsets.flatMap((e: RegistryEntry) => [...e.spec.names]);

		expect(allNames).not.toContain("custom-x");
	});

	it("does not register extension tools claimed by other toolsets in tbox.orphans", () => {
		// Register a fake toolset claiming web-fetch
		mock.defineFakeToolset({
			id: "portal.web",
			names: new Set(["web-fetch", "browser-navigate"]),
			persistKey: "toolset-state:portal.web",
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
		mock.registerTool({
			name: "browser-navigate",
			description: "Browser navigate tool",
			sourceInfo: {
				path: "portal.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		});
		// Add an orphan tool to ensure orphans toolset is created
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

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		const orphans = toolsets.find(
			(e: RegistryEntry) => e.spec.id === ORPHANS_TOOLSET_ID,
		);

		// Orphans toolset should exist but not contain claimed tools
		expect(orphans).toBeDefined();
		expect(orphans!.spec.names).not.toContain("web-fetch");
		expect(orphans!.spec.names).not.toContain("browser-navigate");
		// Orphan tool should be in orphans
		expect(orphans!.spec.names).toContain("orphan-tool");
	});

	it("is idempotent — re-running does not duplicate toolsets", () => {
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

		autoRegisterBuiltinAndOrphans(pi);
		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		const builtins = toolsets.filter(
			(e: RegistryEntry) => e.spec.id === BUILTIN_TOOLSET_ID,
		);

		expect(builtins).toHaveLength(1);
	});

	it("handles empty tool population", () => {
		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		// No toolsets should be registered if there are no tools
		expect(toolsets).toHaveLength(0);
	});

	it("handles mixed tool population correctly", () => {
		// Builtin tools
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

		// SDK tool (should be ignored)
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

		// Extension tools — some claimed, some orphaned
		mock.defineFakeToolset({
			id: "portal.web",
			names: new Set(["web-fetch"]),
			persistKey: "toolset-state:portal.web",
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

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		const builtin = toolsets.find(
			(e: RegistryEntry) => e.spec.id === BUILTIN_TOOLSET_ID,
		);
		const orphans = toolsets.find(
			(e: RegistryEntry) => e.spec.id === ORPHANS_TOOLSET_ID,
		);

		expect(builtin).toBeDefined();
		expect(builtin!.spec.names).toEqual(new Set(["read"]));

		expect(orphans).toBeDefined();
		expect(orphans!.spec.names).toEqual(new Set(["orphan-tool"]));

		// sdk tool should not be in any toolset
		const allNames = toolsets.flatMap((e: RegistryEntry) => [...e.spec.names]);
		expect(allNames).not.toContain("custom-x");
	});
});
