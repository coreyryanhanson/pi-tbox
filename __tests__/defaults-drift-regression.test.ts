import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRegisteredToolsets,
	setSettingsOverrideForTests,
	setSettingsWriterOverrideForTests,
} from "pi-tool-masking";
import { handleDefaults } from "../src/defaults.js";
import { focusUnit, focusOff } from "../src/focus.js";
import { toggleAll } from "../src/groups.js";
import { setFocusUnit } from "../src/status-slot.js";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for the user's drift report:
//   /tbox focus web
//   /tbox defaults save
//   /tbox focus off
//   /tbox defaults restore
//   /tbox all off
//   /tbox defaults save --global
//   /tbox defaults restore
// Expectation (fixed): web + search both enabled at the end.
// With the old sparse-diff project save, search was silent in the project
// file (live == packaged default at save time) and the later global
// off-pin won the merge — search turned off. The full-snapshot project
// save pins search explicitly, so the global change can't leak in.

const WEB = "pi-lean-dimension.web";
const SEARCH = "pi-lean-dimension.search";
const KEY = {
	web: "toolset-state:pi-lean-dimension.web",
	search: "toolset-state:pi-lean-dimension.search",
} as const;

const REAL_GROUPS = join(homedir(), ".pi", "agent", "pi-tbox", "groups.json");

function defineToolsets(mock: MockPI): void {
	mock.registerTool({
		name: "web-fetch",
		description: "web fetch",
		sourceInfo: {
			path: "x.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "browser-navigate",
		description: "nav",
		sourceInfo: {
			path: "x.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.registerTool({
		name: "web-search",
		description: "search",
		sourceInfo: {
			path: "x.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
	mock.defineFakeToolset({
		id: WEB,
		names: new Set(["web-fetch", "browser-navigate"]),
		persistKey: KEY.web,
		defaultEnabled: false,
	});
	mock.defineFakeToolset({
		id: SEARCH,
		names: new Set(["web-search"]),
		persistKey: KEY.search,
		defaultEnabled: true,
	});
}

describe("drift repro: focus web → save → off → restore → all off → save --global → restore", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;
	let tmpHome: string;
	let oldCwd: string;
	let oldAgentDir: string | undefined;
	let groupsBackup: string | null;

	beforeEach(() => {
		MockPI.cleanRegistry();
		setSettingsOverrideForTests(null);
		setSettingsWriterOverrideForTests(null);
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
		setFocusUnit(null);

		tmpHome = mkdtempSync(join(tmpdir(), "tbox-drift-"));
		oldCwd = process.cwd();
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tmpHome, ".pi", "agent");
		process.chdir(tmpHome);
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		mkdirSync(join(tmpHome, ".pi"), { recursive: true });
		mkdirSync(join(tmpHome, ".pi", "agent", "pi-tbox"), { recursive: true });

		// Back up the real groups file and install a fixture with a "web" group
		// containing both search + web (matches the user's groups.json).
		groupsBackup = existsSync(REAL_GROUPS) ? REAL_GROUPS + ".bak" : null;
		if (groupsBackup) copyFileSync(REAL_GROUPS, groupsBackup);
		writeFileSync(
			REAL_GROUPS,
			JSON.stringify({ web: { toolsets: [SEARCH, WEB] } }) + "\n",
		);

		defineToolsets(mock);
		// Seed live state to effective defaults by firing the library's
		// session_start restore handler (what a real fresh session does).
		mock.clearEntries();
		mock.fireLifecycleEvent("session_start");
	});

	afterEach(() => {
		process.chdir(oldCwd);
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(tmpHome, { recursive: true, force: true });
		if (groupsBackup) {
			copyFileSync(groupsBackup, REAL_GROUPS);
			rmSync(groupsBackup, { force: true });
		} else {
			rmSync(REAL_GROUPS, { force: true });
		}
		setSettingsOverrideForTests(null);
		setSettingsWriterOverrideForTests(null);
	});

	function ctx() {
		return mock.createCommandContext();
	}
	const globalPath = () => join(tmpHome, ".pi", "agent", "settings.json");
	const projectPath = () => join(tmpHome, ".pi", "settings.json");
	function readJson(p: string): Record<string, unknown> {
		if (!existsSync(p)) return {};
		return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
	}
	function live(id: string): boolean {
		return getRegisteredToolsets()
			.find((e) => e.spec.id === id)!
			.toolset.isEnabled(pi);
	}

	it("project full-snapshot save keeps the focus selection stable against later global changes", () => {
		// Fresh settings — no global or project pins; packaged defaults rule
		// (web off, search on). Mirrors the user's pre-save state.
		writeFileSync(globalPath(), "{}\n");
		writeFileSync(projectPath(), "{}\n");

		const log: string[] = [];
		const snap = (label: string): void => {
			log.push(
				`[${label}] web=${live(WEB)} search=${live(SEARCH)} | ` +
					`project=${JSON.stringify(readJson(projectPath()).toolsetDefaults ?? {})} | ` +
					`global=${JSON.stringify(readJson(globalPath()).toolsetDefaults ?? {})}`,
			);
		};

		// Fresh session: live = effective defaults.
		// merged: web=true(project wins), search=false(global) → web ON, search OFF.
		snap("start");

		// 1. /tbox focus web  → allowlist [search, web], both ON.
		focusUnit(pi, "web");
		snap("focus web");

		// 2. /tbox defaults save  (project scope)
		handleDefaults(pi, ctx(), "defaults save");
		snap("defaults save");

		// 3. /tbox focus off
		focusOff(pi, mock.createCommandContext().sessionManager.getBranch());
		snap("focus off");

		// 4. /tbox defaults restore
		handleDefaults(pi, ctx(), "defaults restore");
		snap("defaults restore");

		// 5. /tbox all off
		toggleAll(pi, false);
		snap("all off");

		// 6. /tbox defaults save --global
		handleDefaults(pi, ctx(), "defaults save --global");
		snap("defaults save --global");

		// 7. /tbox defaults restore
		handleDefaults(pi, ctx(), "defaults restore");
		snap("defaults restore (final)");

		// eslint-disable-next-line no-console
		console.log(log.join("\n"));

		// The regression: web and search must BOTH stay enabled at the end —
		// the project full snapshot pins search on, so the global off-pin
		// from step 6 cannot turn it off.
		expect(live(WEB)).toBe(true);
		expect(live(SEARCH)).toBe(true);
	});
});
