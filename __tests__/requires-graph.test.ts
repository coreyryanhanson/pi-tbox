import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { forwardClosure, reverseClosure } from "../src/requires-graph.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Stand up a small requires graph: learn requires web; search requires learn. */
function setupGraph(mock: MockPI, _pi: ExtensionAPI): void {
	mock.defineFakeToolset({
		id: "portal.web",
		names: new Set(["web-fetch"]),
		persistKey: "toolset-state:portal.web",
		defaultEnabled: true,
	});
	mock.defineFakeToolset({
		id: "portal.learn",
		names: new Set(["web-learn"]),
		persistKey: "toolset-state:portal.learn",
		defaultEnabled: true,
		requires: ["portal.web"],
	});
	mock.defineFakeToolset({
		id: "portal.search",
		names: new Set(["web-search"]),
		persistKey: "toolset-state:portal.search",
		defaultEnabled: true,
		requires: ["portal.learn"],
	});
}

// ---------------------------------------------------------------------------
// forwardClosure
// ---------------------------------------------------------------------------

describe("forwardClosure", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("returns the seed plus every transitive requires target", () => {
		setupGraph(mock, pi);
		// portal.search → portal.learn → portal.web
		const result = forwardClosure(["portal.search"]);
		expect(result).toEqual(
			new Set(["portal.search", "portal.learn", "portal.web"]),
		);
	});

	it("portal.learn closes to {portal.learn, portal.web}", () => {
		setupGraph(mock, pi);
		const result = forwardClosure(["portal.learn"]);
		expect(result).toEqual(new Set(["portal.learn", "portal.web"]));
	});

	it("accepts multiple seeds and unions their closures", () => {
		setupGraph(mock, pi);
		const result = forwardClosure(["portal.web", "portal.learn"]);
		expect(result).toEqual(new Set(["portal.web", "portal.learn"]));
	});

	it("skips a forward-reference requires id (not fatal)", () => {
		mock.defineFakeToolset({
			id: "a",
			names: new Set(["a-tool"]),
			persistKey: "toolset-state:a",
			requires: ["does-not-exist"], // forward reference
		});
		const result = forwardClosure(["a"]);
		expect(result).toEqual(new Set(["a"]));
	});

	it("returns just the seed for a toolset with no requires", () => {
		setupGraph(mock, pi);
		const result = forwardClosure(["portal.web"]);
		expect(result).toEqual(new Set(["portal.web"]));
	});
});

// ---------------------------------------------------------------------------
// reverseClosure
// ---------------------------------------------------------------------------

describe("reverseClosure", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("returns the seed plus every transitive dependent", () => {
		setupGraph(mock, pi);
		// portal.web is required by portal.learn, which is required by portal.search
		const result = reverseClosure(["portal.web"]);
		expect(result).toEqual(
			new Set(["portal.web", "portal.learn", "portal.search"]),
		);
	});

	it("portal.learn closes to {portal.learn, portal.search}", () => {
		setupGraph(mock, pi);
		const result = reverseClosure(["portal.learn"]);
		expect(result).toEqual(new Set(["portal.learn", "portal.search"]));
	});

	it("returns just the seed for a toolset with no dependents", () => {
		setupGraph(mock, pi);
		const result = reverseClosure(["portal.search"]);
		expect(result).toEqual(new Set(["portal.search"]));
	});
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe("cycle detection", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("forwardClosure throws naming the cycle path for A→B→C→A", () => {
		mock.defineFakeToolset({
			id: "A",
			names: new Set(["a-tool"]),
			persistKey: "toolset-state:a",
			requires: ["B"],
		});
		mock.defineFakeToolset({
			id: "B",
			names: new Set(["b-tool"]),
			persistKey: "toolset-state:b",
			requires: ["C"],
		});
		mock.defineFakeToolset({
			id: "C",
			names: new Set(["c-tool"]),
			persistKey: "toolset-state:c",
			requires: ["A"],
		});

		expect(() => forwardClosure(["A"])).toThrow(/requires cycle/);
		try {
			forwardClosure(["A"]);
		} catch (e) {
			const msg = (e as Error).message;
			// The path must name all three nodes in the cycle.
			expect(msg).toContain("A");
			expect(msg).toContain("B");
			expect(msg).toContain("C");
		}
	});

	it("reverseClosure throws on the same cycle", () => {
		mock.defineFakeToolset({
			id: "A",
			names: new Set(["a-tool"]),
			persistKey: "toolset-state:a",
			requires: ["B"],
		});
		mock.defineFakeToolset({
			id: "B",
			names: new Set(["b-tool"]),
			persistKey: "toolset-state:b",
			requires: ["C"],
		});
		mock.defineFakeToolset({
			id: "C",
			names: new Set(["c-tool"]),
			persistKey: "toolset-state:c",
			requires: ["A"],
		});

		expect(() => reverseClosure(["A"])).toThrow(/requires cycle/);
	});

	it("a self-requiring toolset is a 1-node cycle", () => {
		mock.defineFakeToolset({
			id: "self",
			names: new Set(["self-tool"]),
			persistKey: "toolset-state:self",
			requires: ["self"],
		});
		expect(() => forwardClosure(["self"])).toThrow(/requires cycle/);
	});
});

// ---------------------------------------------------------------------------
// Registry-source invariant
// ---------------------------------------------------------------------------

describe("registry source", () => {
	it("closure reads the live registry (not a stale snapshot)", () => {
		MockPI.cleanRegistry();
		const mock = new MockPI();
		const pi = mock as unknown as ExtensionAPI;

		// Before registering portal.web, learn's closure is just itself.
		mock.defineFakeToolset({
			id: "portal.learn",
			names: new Set(["web-learn"]),
			persistKey: "toolset-state:portal.learn",
			requires: ["portal.web"], // not yet registered
		});
		expect(forwardClosure(["portal.learn"])).toEqual(new Set(["portal.learn"]));

		// After registering portal.web, the closure includes it.
		mock.defineFakeToolset({
			id: "portal.web",
			names: new Set(["web-fetch"]),
			persistKey: "toolset-state:portal.web",
		});
		expect(forwardClosure(["portal.learn"])).toEqual(
			new Set(["portal.learn", "portal.web"]),
		);
		// read the var to satisfy linters; pi used implicitly via registry
		void pi;
	});
});
