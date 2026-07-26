/**
 * Tests for src/chars.ts — character counter.
 *
 * Verifies:
 *   - Known tool population → exact sum
 *   - Toggle delta = serialized size of affected tools
 *   - Determinism across runs
 *   - SDK and builtin tools counted when active
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import { computeCharCount, formatChars } from "../src/chars.js";
import { defineToolset } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Note: MockPI's registerTool only stores name, description, sourceInfo —
// it does NOT preserve parameters/promptGuidelines. The serialized length
// below reflects what the mock actually stores (those fields are undefined
// and dropped by JSON.stringify).

const LEN_A = 150; // tool-alpha
const LEN_B = 144; // tool-beta
const LEN_BUILTIN = 134; // pi.help
const LEN_SDK = 142; // sdk.file_read

const TOOL_A = {
	name: "tool-alpha",
	description: "Alpha tool for testing",
	sourceInfo: {
		path: "alpha.ts",
		source: "extension" as const,
		scope: "user" as const,
		origin: "top-level" as const,
	},
};

const TOOL_B = {
	name: "tool-beta",
	description: "Beta does analysis",
	sourceInfo: {
		path: "beta.ts",
		source: "extension" as const,
		scope: "user" as const,
		origin: "top-level" as const,
	},
};

const TOOL_BUILTIN = {
	name: "pi.help",
	description: "Pi help tool",
	sourceInfo: {
		path: "builtin",
		source: "builtin" as const,
		scope: "user" as const,
		origin: "top-level" as const,
	},
};

const TOOL_SDK = {
	name: "sdk.file_read",
	description: "Read a file via SDK",
	sourceInfo: {
		path: "sdk.ts",
		source: "sdk" as const,
		scope: "user" as const,
		origin: "top-level" as const,
	},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeCharCount", () => {
	let mock: MockPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
	});

	afterEach(() => {
		MockPI.cleanRegistry();
	});

	it("returns 0 core and 0 extension when no tools are active", () => {
		const result = computeCharCount(mock as any);
		expect(result.core).toBe(0);
		expect(result.extension).toBe(0);
	});

	it("returns correct sum for a single active extension tool", () => {
		mock.registerTool(TOOL_A);
		mock.setActiveTools(["tool-alpha"]);
		const result = computeCharCount(mock as any);
		expect(result.core).toBe(0);
		expect(result.extension).toBe(LEN_A);
	});

	it("returns correct sum for multiple active extension tools", () => {
		mock.registerTool(TOOL_A);
		mock.registerTool(TOOL_B);
		mock.setActiveTools(["tool-alpha", "tool-beta"]);
		const result = computeCharCount(mock as any);
		expect(result.core).toBe(0);
		expect(result.extension).toBe(LEN_A + LEN_B);
	});

	it("does not count inactive tools", () => {
		mock.registerTool(TOOL_A);
		mock.registerTool(TOOL_B);
		mock.setActiveTools(["tool-alpha"]); // only A active
		const result = computeCharCount(mock as any);
		expect(result.extension).toBe(LEN_A);
		expect(result.core).toBe(0);
	});

	it("counts builtin tools in core, not extension", () => {
		mock.registerTool(TOOL_A);
		mock.registerTool(TOOL_BUILTIN);
		mock.setActiveTools(["tool-alpha", "pi.help"]);
		const result = computeCharCount(mock as any);
		expect(result.core).toBe(LEN_BUILTIN);
		expect(result.extension).toBe(LEN_A);
	});

	it("counts sdk tools in core, not extension", () => {
		mock.registerTool(TOOL_A);
		mock.registerTool(TOOL_SDK);
		mock.setActiveTools(["tool-alpha", "sdk.file_read"]);
		const result = computeCharCount(mock as any);
		expect(result.core).toBe(LEN_SDK);
		expect(result.extension).toBe(LEN_A);
	});

	it("counts all active tools with correct split (builtin+sdk in core, extension tools in extension)", () => {
		mock.registerTool(TOOL_A);
		mock.registerTool(TOOL_B);
		mock.registerTool(TOOL_BUILTIN);
		mock.registerTool(TOOL_SDK);
		mock.setActiveTools([
			"tool-alpha",
			"tool-beta",
			"pi.help",
			"sdk.file_read",
		]);
		const result = computeCharCount(mock as any);
		expect(result.core).toBe(LEN_BUILTIN + LEN_SDK);
		expect(result.extension).toBe(LEN_A + LEN_B);
	});

	it("is deterministic — same input produces same split across calls", () => {
		mock.registerTool(TOOL_A);
		mock.registerTool(TOOL_B);
		mock.setActiveTools(["tool-alpha", "tool-beta"]);

		const first = computeCharCount(mock as any);
		const second = computeCharCount(mock as any);
		const third = computeCharCount(mock as any);
		expect(first.extension).toBe(second.extension);
		expect(second.extension).toBe(third.extension);
		expect(first.core).toBe(second.core);
		expect(second.core).toBe(third.core);
	});

	it("reflects toggle — enabling a toolset increases the extension bucket by its members' sizes", () => {
		// Register two tools
		mock.registerTool(TOOL_A);
		mock.registerTool(TOOL_B);

		// One toolset containing both
		defineToolset(mock as any, {
			id: "test.set",
			names: new Set(["tool-alpha", "tool-beta"]),
			defaultEnabled: true,
			persistKey: "toolset-state:test.set",
		});

		// Both active initially (defaultEnabled: true)
		mock.setActiveTools(["tool-alpha", "tool-beta"]);
		const full = computeCharCount(mock as any);
		expect(full.extension).toBe(LEN_A + LEN_B);
		expect(full.core).toBe(0);

		// Deactivate one → extension drops by that tool's size, core unchanged
		mock.setActiveTools(["tool-alpha"]);
		expect(computeCharCount(mock as any).extension).toBe(LEN_A);

		// Deactivate both → extension is zero
		mock.setActiveTools([]);
		expect(computeCharCount(mock as any).extension).toBe(0);
	});
});

describe("formatChars", () => {
	let mock: MockPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
	});

	afterEach(() => {
		MockPI.cleanRegistry();
	});

	it("returns a human-readable string with the split", () => {
		mock.registerTool(TOOL_A);
		mock.setActiveTools(["tool-alpha"]);
		const output = formatChars(mock as any);
		expect(output).toBe(
			`Char count \u2014 core: 0 | extension: ${LEN_A} (total: ${LEN_A})`,
		);
	});

	it("returns 0 for both buckets when no tools are active", () => {
		const output = formatChars(mock as any);
		expect(output).toBe("Char count \u2014 core: 0 | extension: 0 (total: 0)");
	});

	it("shows builtin+sdk in core and extension tools in extension", () => {
		mock.registerTool(TOOL_A);
		mock.registerTool(TOOL_BUILTIN);
		mock.registerTool(TOOL_SDK);
		mock.setActiveTools(["tool-alpha", "pi.help", "sdk.file_read"]);
		const output = formatChars(mock as any);
		const total = LEN_BUILTIN + LEN_SDK + LEN_A;
		expect(output).toBe(
			`Char count \u2014 core: ${LEN_BUILTIN + LEN_SDK} | extension: ${LEN_A} (total: ${total})`,
		);
	});
});
