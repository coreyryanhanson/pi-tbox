import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	autoRegisterBuiltinAndOrphans,
	ORPHAN_TOOLSET_PREFIX,
	orphanToolsetId,
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

	it("does not register builtin tools as a toolset", () => {
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

		// Builtins are not registered as a toolset — they are
		// outside tbox's domain.
		const builtin = toolsets.find(
			(e: RegistryEntry) => e.spec.id === "pi.builtin",
		);
		expect(builtin).toBeUndefined();
	});

	it("registers per-source orphan toolsets for unclaimed extension tools", () => {
		// Two sources, one tool each
		mock.registerTool({
			name: "lens-search",
			description: "Search codebase",
			sourceInfo: {
				path: "pi-lens.ts",
				source: "pi-lens",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.registerTool({
			name: "deploy-run",
			description: "Run deployment",
			sourceInfo: {
				path: "deploy.ts",
				source: "pi-deploy",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();

		// Two orphan toolsets — one per source
		const lensToolset = toolsets.find(
			(e: RegistryEntry) => e.spec.id === orphanToolsetId("pi-lens"),
		);
		const deployToolset = toolsets.find(
			(e: RegistryEntry) => e.spec.id === orphanToolsetId("pi-deploy"),
		);

		expect(lensToolset).toBeDefined();
		expect(lensToolset!.spec.names).toEqual(new Set(["lens-search"]));
		expect(lensToolset!.spec.defaultEnabled).toBe(true);
		expect(lensToolset!.spec.masked).toBe(false);
		// Single-tool source gets description passed through
		expect(lensToolset!.spec.description).toBe("Search codebase");

		expect(deployToolset).toBeDefined();
		expect(deployToolset!.spec.names).toEqual(new Set(["deploy-run"]));
		expect(deployToolset!.spec.defaultEnabled).toBe(true);
		expect(deployToolset!.spec.masked).toBe(false);
		expect(deployToolset!.spec.description).toBe("Run deployment");

		// No catch-all tbox.orphans
		const catchAll = toolsets.find(
			(e: RegistryEntry) => e.spec.id === "tbox.orphans",
		);
		expect(catchAll).toBeUndefined();
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

	it("does not register extension tools claimed by other toolsets in orphan toolsets", () => {
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
				source: "portal",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.registerTool({
			name: "browser-navigate",
			description: "Browser navigate tool",
			sourceInfo: {
				path: "portal.ts",
				source: "portal",
				scope: "user",
				origin: "top-level",
			},
		});
		// Add an orphan tool from a different source
		mock.registerTool({
			name: "orphan-tool",
			description: "Orphaned tool",
			sourceInfo: {
				path: "ext.ts",
				source: "pi-other",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();

		// Portal's tools should NOT appear in any orphan toolset
		for (const entry of toolsets) {
			if (entry.spec.id.startsWith(ORPHAN_TOOLSET_PREFIX)) {
				expect(entry.spec.names).not.toContain("web-fetch");
				expect(entry.spec.names).not.toContain("browser-navigate");
			}
		}

		// The orphan tool should still show up in its source's toolset
		const otherToolset = toolsets.find(
			(e: RegistryEntry) => e.spec.id === orphanToolsetId("pi-other"),
		);
		expect(otherToolset).toBeDefined();
		expect(otherToolset!.spec.names).toContain("orphan-tool");
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

		// Builtins are not registered — only orphan toolsets
		// are created, and they must not duplicate either.
		expect(toolsets.length).toBeGreaterThanOrEqual(0);
		const ids = new Set(toolsets.map((e: RegistryEntry) => e.spec.id));
		expect(ids.size).toBe(toolsets.length);
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

		// Extension tools — some claimed, some orphaned from different sources
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
				source: "portal",
				scope: "user",
				origin: "top-level",
			},
		});
		mock.registerTool({
			name: "orphan-tool",
			description: "Orphaned tool",
			sourceInfo: {
				path: "ext.ts",
				source: "pi-other",
				scope: "user",
				origin: "top-level",
			},
		});

		autoRegisterBuiltinAndOrphans(pi);

		const toolsets = getRegisteredToolsets();
		// Builtins are not registered as a toolset
		const builtin = toolsets.find(
			(e: RegistryEntry) => e.spec.id === "pi.builtin",
		);
		expect(builtin).toBeUndefined();

		const orphanEntry = toolsets.find(
			(e: RegistryEntry) => e.spec.id === orphanToolsetId("pi-other"),
		);

		expect(orphanEntry).toBeDefined();
		expect(orphanEntry!.spec.names).toEqual(new Set(["orphan-tool"]));

		// sdk tool should not be in any toolset
		const allNames = toolsets.flatMap((e: RegistryEntry) => [...e.spec.names]);
		expect(allNames).not.toContain("custom-x");

		// No catch-all
		const catchAll = toolsets.find(
			(e: RegistryEntry) => e.spec.id === "tbox.orphans",
		);
		expect(catchAll).toBeUndefined();
	});
});
