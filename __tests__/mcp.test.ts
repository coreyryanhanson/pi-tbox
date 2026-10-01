/**
 * MCP tool detection predicates (`src/mcp.ts`).
 *
 * Fabricates MCP-shaped ToolInfo fixtures (0.99.x shape: `exposure` required,
 * `namespace` optional) and covers the three predicates plus their graceful
 * degradation when `exposure`/`namespace` are absent (pre-0.99 pi).
 */
import { describe, it, expect } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	isMcpTool,
	isDeclarableMcpTool,
	isMcpResourceTool,
} from "../src/mcp.js";

function tool(overrides: Partial<ToolInfo> & { name: string }): ToolInfo {
	return {
		description: "desc",
		parameters: undefined as any,
		exposure: "direct",
		sourceInfo: {
			path: "builtin:mcp",
			source: "builtin",
			scope: "builtin",
			origin: "builtin",
		},
		...overrides,
	} as ToolInfo;
}

describe("isMcpTool", () => {
	it("matches mcp__-namespaced tools", () => {
		expect(isMcpTool(tool({ name: "notebook_create_doc" }))).toBe(false);
		expect(
			isMcpTool(
				tool({
					name: "notebook_create_doc",
					namespace: { name: "mcp__siyuan" },
				}),
			),
		).toBe(true);
	});

	it("rejects tools without a namespace", () => {
		expect(isMcpTool(tool({ name: "some_builtin" }))).toBe(false);
	});

	it("rejects non-MCP namespaces", () => {
		expect(
			isMcpTool(tool({ name: "t", namespace: { name: "portal.web" } })),
		).toBe(false);
	});

	it("matches regardless of exposure", () => {
		// hidden re-registrations (e.g. /mcp-disabled servers) stay MCP tools.
		expect(
			isMcpTool(
				tool({
					name: "t",
					exposure: "hidden",
					namespace: { name: "mcp__x" },
				}),
			),
		).toBe(true);
	});
});

describe("isDeclarableMcpTool", () => {
	it("accepts direct-exposure MCP tools", () => {
		expect(
			isDeclarableMcpTool(
				tool({
					name: "t",
					exposure: "direct",
					namespace: { name: "mcp__siyuan" },
				}),
			),
		).toBe(true);
	});

	it("treats a missing exposure as direct (pi's default)", () => {
		const t = tool({
			name: "t",
			namespace: { name: "mcp__siyuan" },
		});
		const { exposure: _present, ...withoutExposure } = t;
		// Cast: simulates a pre-0.99 ToolInfo, where the field is absent.
		expect(isDeclarableMcpTool(withoutExposure as ToolInfo)).toBe(true);
	});

	it("rejects codemode/deferred/hidden exposures", () => {
		for (const exposure of ["codemode", "deferred", "hidden"] as const) {
			expect(
				isDeclarableMcpTool(
					tool({
						name: "t",
						exposure,
						namespace: { name: "mcp__siyuan" },
					}),
				),
				exposure,
			).toBe(false);
		}
	});

	it("rejects non-MCP tools even with direct exposure", () => {
		expect(isDeclarableMcpTool(tool({ name: "read", exposure: "direct" }))).toBe(
			false,
		);
	});
});

describe("isMcpResourceTool", () => {
	it("matches the three shared resource tools by name", () => {
		for (const name of [
			"list_mcp_resources",
			"list_mcp_resource_templates",
			"read_mcp_resource",
		]) {
			expect(isMcpResourceTool(tool({ name })), name).toBe(true);
		}
	});

	it("rejects other names, including MCP-server tools", () => {
		expect(
			isMcpResourceTool(
				tool({
					name: "notebook_create_doc",
					namespace: { name: "mcp__siyuan" },
				}),
			),
		).toBe(false);
		expect(isMcpResourceTool(tool({ name: "list_resources" }))).toBe(false);
	});
});
