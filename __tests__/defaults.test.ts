import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getActiveAllowlist,
	getDefaultResolutionMode,
	getRegisteredToolsets,
	setSettingsOverrideForTests,
	setSettingsWriterOverrideForTests,
} from "pi-tool-masking";
import { handleDefaults } from "../src/defaults.js";
import { focusUnit } from "../src/focus.js";
import { setFocusUnit, getFocusUnit } from "../src/status-slot.js";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fixture: three explicit toolsets, no orphan auto-registration
// ---------------------------------------------------------------------------

function registerFixtureTools(mock: MockPI): void {
	mock.registerTool({
		name: "a-tool",
		description: "Alpha tool",
		sourceInfo: {
			path: "alpha.ts",
			source: "alpha",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "b-tool",
		description: "Beta tool",
		sourceInfo: {
			path: "beta.ts",
			source: "beta",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "c-tool",
		description: "Gamma tool",
		sourceInfo: {
			path: "gamma.ts",
			source: "gamma",
			scope: "user",
			origin: "top-level",
		},
	});
}

function defineFixtureToolsets(mock: MockPI): void {
	mock.defineFakeToolset({
		id: "alpha.tool",
		names: new Set(["a-tool"]),
		persistKey: "toolset-state:alpha.tool",
		defaultEnabled: true,
	});
	mock.defineFakeToolset({
		id: "beta.tool",
		names: new Set(["b-tool"]),
		persistKey: "toolset-state:beta.tool",
		defaultEnabled: true,
	});
	mock.defineFakeToolset({
		id: "gamma.tool",
		names: new Set(["c-tool"]),
		persistKey: "toolset-state:gamma.tool",
		defaultEnabled: false,
	});
}

/** Enable everything, then drop gamma to its packaged default (off). */
function setupFixture(mock: MockPI, pi: ExtensionAPI): void {
	registerFixtureTools(mock);
	defineFixtureToolsets(mock);
	for (const entry of getRegisteredToolsets()) entry.toolset.enable(pi);
	getRegisteredToolsets()
		.find((e) => e.spec.id === "gamma.tool")!
		.toolset.disable(pi);
	mock.clearEntries();
}

const KEY = {
	alpha: "toolset-state:alpha.tool",
	beta: "toolset-state:beta.tool",
	gamma: "toolset-state:gamma.tool",
} as const;

// ---------------------------------------------------------------------------
// Seam tests — reader + writer overrides, never touch disk
// ---------------------------------------------------------------------------

describe("/tbox defaults (seams)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;
	let writer: {
		global: Record<string, { enabled: boolean }>;
		project: Record<string, { enabled: boolean }>;
	};

	beforeEach(() => {
		MockPI.cleanRegistry();
		setSettingsOverrideForTests({});
		writer = { global: {}, project: {} };
		setSettingsWriterOverrideForTests(writer);
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
		setupFixture(mock, pi);
	});

	afterEach(() => {
		setSettingsOverrideForTests(null);
		setSettingsWriterOverrideForTests(null);
	});

	function ctx() {
		return mock.createCommandContext();
	}

	describe("save", () => {
		it("pins only toolsets whose live state differs from their effective default", () => {
			// Everything at its effective default → zero pins.
			let result = handleDefaults(pi, ctx(), "defaults save");
			expect(result.level).toBe("info");
			expect(result.message).toContain("Saved 0 toolset defaults");
			expect(writer.project).toEqual({});

			// Toggle beta off → one pin, wrapped shape.
			getRegisteredToolsets()
				.find((e) => e.spec.id === "beta.tool")!
				.toolset.disable(pi);
			result = handleDefaults(pi, ctx(), "defaults save");
			expect(result.message).toContain("Saved 1 toolset default");
			expect(result.message).toContain(".pi/settings.json");
			expect(result.message).toContain("(project)");
			expect(writer.project).toEqual({ [KEY.beta]: { enabled: false } });
		});

		it("scope: bare → project, --global → global, --project → usage error, no write", () => {
			getRegisteredToolsets()
				.find((e) => e.spec.id === "beta.tool")!
				.toolset.disable(pi);

			handleDefaults(pi, ctx(), "defaults save");
			expect(writer.project).toEqual({ [KEY.beta]: { enabled: false } });
			expect(writer.global).toEqual({});

			const globalResult = handleDefaults(pi, ctx(), "defaults save --global");
			expect(globalResult.level).toBe("info");
			expect(globalResult.message).toContain("(global)");
			expect(writer.global).toEqual({ [KEY.beta]: { enabled: false } });

			const before = JSON.parse(JSON.stringify(writer)) as typeof writer;
			const projectResult = handleDefaults(
				pi,
				ctx(),
				"defaults save --project",
			);
			expect(projectResult.level).toBe("error");
			expect(projectResult.message).toContain("unknown flag --project");
			expect(projectResult.message).toContain("/tbox defaults --help");
			expect(writer).toEqual(before);
		});

		it("during focus captures the allowlist selection as exclusion pins (not refused)", () => {
			// Focus gamma (packaged default off) → gamma on, alpha/beta off.
			focusUnit(pi, "+gamma.tool");

			const result = handleDefaults(pi, ctx(), "defaults save");

			expect(result.level).toBe("info"); // no focus-guard refusal
			expect(result.message).toContain("Saved 3 toolset defaults");
			// gamma live on vs default off → {enabled:true}; alpha/beta live
			// off vs default on → {enabled:false}.
			expect(writer.project).toEqual({
				[KEY.gamma]: { enabled: true },
				[KEY.alpha]: { enabled: false },
				[KEY.beta]: { enabled: false },
			});
		});
	});

	describe("show", () => {
		it("empty state prints the no-pins message", () => {
			const result = handleDefaults(pi, ctx(), "defaults show");
			expect(result.level).toBe("info");
			expect(result.message).toContain(
				"No toolset defaults pinned in settings",
			);
		});

		it("bare /tbox defaults defaults to show", () => {
			setSettingsOverrideForTests({ [KEY.alpha]: { enabled: false } });
			const result = handleDefaults(pi, ctx(), "defaults");
			expect(result.message).toContain("Toolset defaults pinned in settings");
			expect(result.message).toContain(KEY.alpha);
		});

		it("lists pins with enabled/disabled words, sorted by persistKey", () => {
			setSettingsOverrideForTests({
				[KEY.beta]: { enabled: false },
				[KEY.alpha]: { enabled: true },
			});
			const result = handleDefaults(pi, ctx(), "defaults show");
			expect(result.level).toBe("info");
			expect(result.message.indexOf(KEY.alpha)).toBeLessThan(
				result.message.indexOf(KEY.beta),
			);
			expect(result.message).toContain("enabled");
			expect(result.message).toContain("disabled");
		});
	});

	describe("clear", () => {
		it("removes the block with true/false wording, honoring --global", () => {
			writer.global[KEY.alpha] = { enabled: false };

			let result = handleDefaults(pi, ctx(), "defaults clear --global");
			expect(result.level).toBe("info");
			expect(result.message).toContain("Cleared toolset defaults from");
			expect(result.message).toContain("(global)");
			expect(writer.global).toEqual({});

			result = handleDefaults(pi, ctx(), "defaults clear");
			expect(result.message).toContain("No toolsetDefaults block in");
			expect(result.message).toContain("(project)");
			expect(result.message).toContain("— nothing to clear.");
		});
	});

	describe("restore", () => {
		it("tombstones stale entries, applies defaults, lifts focus", () => {
			// Pre-focus manual toggle: beta off (branch entry {enabled:false}).
			getRegisteredToolsets()
				.find((e) => e.spec.id === "beta.tool")!
				.toolset.disable(pi);
			focusUnit(pi, "+gamma.tool");
			expect(getActiveAllowlist()).toEqual(["gamma.tool"]);

			const result = handleDefaults(pi, ctx(), "defaults restore");

			expect(result.level).toBe("info");
			expect(result.message).toBe("Restored 3 toolsets to settings defaults.");
			expect(getDefaultResolutionMode()).toBe("exclusion");
			expect(getActiveAllowlist()).toBeUndefined();
			expect(getFocusUnit()).toBeNull();

			// Live state back to effective defaults: alpha on, beta on, gamma off.
			const active = new Set(pi.getActiveTools());
			expect(active.has("a-tool")).toBe(true);
			expect(active.has("b-tool")).toBe(true);
			expect(active.has("c-tool")).toBe(false);

			// beta's stale {enabled:false} entry is tombstoned to null.
			const betaEntries = mock.getEntries(KEY.beta);
			expect(betaEntries.at(-1)?.data).toBeNull();
		});

		it("repeat restore with no intervening toggle writes zero tombstones", () => {
			handleDefaults(pi, ctx(), "defaults restore");
			expect(mock.getEntries(KEY.alpha)).toHaveLength(0);
			expect(mock.getEntries(KEY.beta)).toHaveLength(0);

			handleDefaults(pi, ctx(), "defaults restore");
			expect(mock.getEntries(KEY.alpha)).toHaveLength(0);
			expect(mock.getEntries(KEY.beta)).toHaveLength(0);
		});
	});

	describe("flags + help", () => {
		it("--help prints the help block before any other check", () => {
			const result = handleDefaults(pi, ctx(), "defaults save --help");
			expect(result.level).toBe("info");
			expect(result.message).toContain("/tbox defaults");
			expect(result.message).toContain("restore");
			// --help wins over the would-be save write: nothing was written.
			expect(writer.project).toEqual({});
		});

		it("an unknown -- flag is rejected with the pointed error", () => {
			const result = handleDefaults(pi, ctx(), "defaults save --gloal");
			expect(result.level).toBe("error");
			expect(result.message).toContain("unknown flag --gloal");
			expect(result.message).toContain("/tbox defaults --help");
		});

		it("--global is rejected on show and restore; accepted on save and clear", () => {
			for (const args of [
				"defaults show --global",
				"defaults restore --global",
			]) {
				const result = handleDefaults(pi, ctx(), args);
				expect(result.level).toBe("error");
				expect(result.message).toContain(
					"--global only applies to 'save' and 'clear'",
				);
			}

			const save = handleDefaults(pi, ctx(), "defaults save --global");
			expect(save.level).toBe("info");
			const clear = handleDefaults(pi, ctx(), "defaults clear --global");
			expect(clear.level).toBe("info");
		});

		it("an unknown defaults subcommand is rejected", () => {
			const result = handleDefaults(pi, ctx(), "defaults frobnicate");
			expect(result.level).toBe("error");
			expect(result.message).toContain(
				'unknown defaults subcommand "frobnicate"',
			);
		});
	});

	describe("command dispatch (seams)", () => {
		beforeEach(async () => {
			const mod = await import("../index.js");
			mod.default(pi);
			mock.fireLifecycleEvent("session_start");
			mock.clearUiRecords();
		});

		it("/tbox defaults restore routes through the command handler", async () => {
			focusUnit(pi, "+alpha.tool");
			await mock.dispatchCommand("defaults restore");

			const notify = mock.getLastNotify();
			expect(notify).toBeDefined();
			expect(notify!.message).toContain("Restored 3 toolsets");
			expect(getActiveAllowlist()).toBeUndefined();
			expect(getFocusUnit()).toBeNull();
		});

		it("/tbox focus release dispatches to focusRelease", async () => {
			focusUnit(pi, "+alpha.tool");
			await mock.dispatchCommand("focus release");

			const notify = mock.getLastNotify();
			expect(notify).toBeDefined();
			expect(notify!.message).toContain("Focus released");
			expect(getActiveAllowlist()).toBeUndefined();
			const active = new Set(pi.getActiveTools());
			expect(active.has("a-tool")).toBe(true);
			expect(active.has("b-tool")).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// Disk round-trips — neither seam; mkdtemp + env + chdir (attribution
// needs per-scope reads the reader override collapses)
// ---------------------------------------------------------------------------

describe("/tbox defaults (disk round-trips)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;
	let tmpHome: string;
	let oldCwd: string;
	let oldAgentDir: string | undefined;

	beforeEach(() => {
		MockPI.cleanRegistry();
		setSettingsOverrideForTests(null);
		setSettingsWriterOverrideForTests(null);
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);
		setupFixture(mock, pi);

		tmpHome = mkdtempSync(join(tmpdir(), "tbox-defaults-"));
		oldCwd = process.cwd();
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tmpHome, ".pi", "agent");
		process.chdir(tmpHome);
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		mkdirSync(join(tmpHome, ".pi"), { recursive: true });
	});

	afterEach(() => {
		process.chdir(oldCwd);
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(tmpHome, { recursive: true, force: true });
		setSettingsOverrideForTests(null);
		setSettingsWriterOverrideForTests(null);
	});

	function ctx() {
		return mock.createCommandContext();
	}

	const globalPath = () => join(tmpHome, ".pi", "agent", "settings.json");
	const projectPath = () => join(tmpHome, ".pi", "settings.json");

	it("show attributes a global-only pin as [global]", () => {
		writeFileSync(
			globalPath(),
			JSON.stringify({ toolsetDefaults: { [KEY.alpha]: { enabled: false } } }) +
				"\n",
		);

		const result = handleDefaults(pi, ctx(), "defaults show");
		expect(result.level).toBe("info");
		expect(result.message).toContain("[global]");
		expect(result.message).not.toContain("(overrides global)");
	});

	it("a project pin shadowing a global pin shows [project] (overrides global)", () => {
		writeFileSync(
			globalPath(),
			JSON.stringify({ toolsetDefaults: { [KEY.alpha]: { enabled: true } } }) +
				"\n",
		);
		writeFileSync(
			projectPath(),
			JSON.stringify({ toolsetDefaults: { [KEY.alpha]: { enabled: false } } }) +
				"\n",
		);

		const result = handleDefaults(pi, ctx(), "defaults show");
		expect(result.message).toContain("disabled");
		expect(result.message).toContain("[project] (overrides global)");
	});

	it("save (bare → project) then show attributes the new pin [project]", () => {
		getRegisteredToolsets()
			.find((e) => e.spec.id === "beta.tool")!
			.toolset.disable(pi);

		const save = handleDefaults(pi, ctx(), "defaults save");
		expect(save.level).toBe("info");
		expect(save.message).toContain(projectPath());
		expect(save.message).toContain("(project)");
		expect(existsSync(projectPath())).toBe(true);

		const show = handleDefaults(pi, ctx(), "defaults show");
		expect(show.message).toContain(KEY.beta);
		expect(show.message).toContain("[project]");
		expect(show.message).not.toContain("(overrides global)");
	});

	it("clear removes only the toolsetDefaults block, preserving other keys", () => {
		writeFileSync(
			projectPath(),
			JSON.stringify({
				provider: "openai",
				toolsetDefaults: { [KEY.alpha]: { enabled: false } },
			}) + "\n",
		);

		const result = handleDefaults(pi, ctx(), "defaults clear");
		expect(result.level).toBe("info");
		expect(result.message).toContain("Cleared toolset defaults from");
		expect(result.message).toContain(projectPath());

		const parsed = JSON.parse(readFileSync(projectPath(), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(parsed.provider).toBe("openai");
		expect("toolsetDefaults" in parsed).toBe(false);
	});

	it("save with a corrupt settings.json surfaces the error as an error notify, no crash", () => {
		writeFileSync(projectPath(), "{ not json !!");

		const result = handleDefaults(pi, ctx(), "defaults save");
		expect(result.level).toBe("error");
		expect(result.message).toContain(projectPath());
		expect(result.message).toContain("Refusing to overwrite");
		// The corrupt file is never overwritten.
		expect(readFileSync(projectPath(), "utf-8")).toBe("{ not json !!");
	});

	it("clear with a non-object settings.json surfaces the error and never overwrites it", () => {
		writeFileSync(projectPath(), JSON.stringify([1, 2, 3]));

		const result = handleDefaults(pi, ctx(), "defaults clear");
		expect(result.level).toBe("error");
		expect(result.message).toContain(projectPath());
		expect(readFileSync(projectPath(), "utf-8")).toBe(
			JSON.stringify([1, 2, 3]),
		);
	});
});
