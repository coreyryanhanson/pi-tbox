import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { invocationError } from "../src/list.js";

// Pins the shared invocation guard (src/list.ts) directly and at
// dispatch: --help serves usage, unknown flags and beyond-grammar words
// are rejected.

describe("invocationError (shared guard)", () => {
	it("returns the help text at info for --help", () => {
		const err = invocationError(new Set(["help"]), new Set(), ["all"], 2, "all", "HELP");
		expect(err).toEqual({ message: "HELP", level: "info" });
	});

	it("rejects unknown flags at error", () => {
		const err = invocationError(new Set(["bogus"]), new Set(), ["all"], 2, "all", "HELP");
		expect(err!.level).toBe("error");
		expect(err!.message).toContain("unknown flag --bogus");
	});

	it("rejects trailing words beyond the grammar at error", () => {
		const err = invocationError(new Set(), new Set(), ["all", "on", "extra"], 2, "all", "HELP");
		expect(err!.level).toBe("error");
		expect(err!.message).toContain('unexpected argument "extra"');
	});

	it("accepts a well-formed invocation", () => {
		expect(invocationError(new Set(), new Set(), ["all", "on"], 2, "all", "HELP"))
			.toBeNull();
	});
});

describe("/tbox CLI consistency via dispatch", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(async () => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;

		const mod = await import("../index.js");
		mod.default(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();
	});

	const dispatch = (cmd: string) => mock.dispatchCommand(cmd);
	const last = () => mock.getLastNotify();

	describe("--help serves usage on every surface", () => {
		const cases: [string, string][] = [
			["all --help", "Usage: /tbox all on"],
			["solo --help", "Usage: /tbox solo"],
			["focus --help", "Usage: /tbox focus"],
			["group list --help", "Usage: /tbox group"],
			["group --help", "Usage: /tbox group"],
			["chars --help", "Usage: /tbox chars"],
			["+anything --help", "Usage: /tbox +<toolset>"],
			["mygroup --help", "Usage: /tbox <group> on"],
			["list --help", "/tbox list [--flat] [--active|--inactive]"],
		];
		for (const [cmd, expected] of cases) {
			it(`/tbox ${cmd}`, async () => {
				await dispatch(cmd);
				expect(last()!.message).toContain(expected);
			});
		}
	});

	describe("unknown flags are rejected everywhere", () => {
		const cases = [
			"all --bogus on",
			"solo +x --bogus",
			"focus off --bogus",
			"group list --bogus",
			"+x --bogus",
			"mygroup on --bogus",
			"list --bogus",
		];
		for (const cmd of cases) {
			it(`/tbox ${cmd}`, async () => {
				await dispatch(cmd);
				expect(last()!.message).toContain("unknown flag --bogus");
			});
		}

		it("pluralizes multiple unknown flags", async () => {
			await dispatch("list --foo --bar");
			expect(last()!.message).toContain("unknown flags --foo, --bar");
		});
	});

	describe("trailing words beyond the grammar are rejected everywhere", () => {
		const cases: [string, string][] = [
			["all on extra", "extra"],
			["solo +x extra", "extra"],
			["focus off extra", "extra"],
			["+x on extra", "extra"],
			["mygroup off extra", "extra"],
			["group mygrp edit extra", "extra"],
			// list/status/sync rejections are pinned in sync.test.ts, where
			// the drift-seam skip is asserted alongside them.
			["chars foo", "foo"],
		];
		for (const [cmd, word] of cases) {
			it(`/tbox ${cmd}`, async () => {
				await dispatch(cmd);
				expect(last()!.message).toContain(`unexpected argument "${word}"`);
			});
		}
	});

	describe("invalid operands are rejections at error", () => {
		const rejections: [string, string][] = [
			["all onn", "Usage: /tbox all"],
			["+x foo", "Usage: /tbox +<toolset>"],
			["mygroup foo", "Usage: /tbox <group> on"],
			["group mygrp junksub", "Usage: /tbox group"],
			["group list junk", "reserved word"],
		];
		for (const [cmd, usage] of rejections) {
			it(`/tbox ${cmd}`, async () => {
				await dispatch(cmd);
				expect(last()!.level).toBe("error");
				expect(last()!.message).toContain(usage);
			});
		}
	});

	// defaults guards inside handleDefaults, not at dispatch — its
	// invocation cases are pinned in defaults.test.ts.
});
