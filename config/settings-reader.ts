/**
 * Tbox's own merged-settings reader.
 *
 * Mirrors `pi-lean-portal/core/shared/settings-reader.ts` — the library
 * exports no settings reader (`design.md` §5.1), so tbox ships its own.
 * Cross-cutting: `rg "readMergedSettings" src/` matches only this file.
 *
 * Tbox-owned keys live under a single `tbox` object in merged settings:
 *
 * ```jsonc
 * "tbox": {
 *   "dev": false,
 *   "groups": {
 *     "mygroup": { "toolsets": ["portal.web"], "tools": ["web-learn"] }
 *   }
 * }
 * ```
 *
 * Storage-shape decision (Sprint 3, "Open" item from `manager-mvp.md`):
 * groups live under `tbox.groups` in merged settings (global + project,
 * project wins). A group resolves to addressable units = whole toolsets
 * (`toolsets[]`) and/or individual tools (`tools[]`). The write path lands
 * in Sprint 4's picker-confirm; it writes back through this same key with
 * a careful merge that preserves sibling keys. A dedicated `groups.json`
 * was rejected — one config location is simpler and matches the MVP
 * recommendation.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = ".pi/settings.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A user group: addressable units = whole toolsets and/or individual tools. */
export interface GroupSpec {
	toolsets: string[];
	tools: string[];
}

/** The tbox-owned slice of merged settings. */
export interface TboxConfig {
	dev: boolean;
	groups: Record<string, GroupSpec>;
}

// ---------------------------------------------------------------------------
// Test-injectable override
// ---------------------------------------------------------------------------

// ponytail: a module-level override lets tests inject merged settings
// without touching real disk. Null in production — readMergedSettings()
// falls through to the file read. One small hook beats per-test fs mocks.
let _override: Record<string, unknown> | null = null;

/**
 * Inject (or clear) merged settings for tests. Pass `null` to restore the
 * disk-read path. Production code never calls this.
 *
 * @internal
 */
export function setSettingsOverrideForTests(
	obj: Record<string, unknown> | null,
): void {
	_override = obj;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Read and parse a JSON settings file. Returns {} on any failure. */
export function readSettingsFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * Read global + project settings and merge them (project overrides global).
 */
export function readMergedSettings(
	globalPath: string = GLOBAL_SETTINGS_PATH,
	projectPath: string = PROJECT_SETTINGS_PATH,
): Record<string, unknown> {
	if (_override !== null) return { ..._override };
	const global = readSettingsFile(globalPath);
	const project = readSettingsFile(projectPath);
	return { ...global, ...project };
}

// ---------------------------------------------------------------------------
// tbox slice
// ---------------------------------------------------------------------------

/**
 * Read the `tbox` slice from merged settings.
 *
 * - `dev` defaults to `false` when absent or not a boolean.
 * - `groups` defaults to `{}` when absent; malformed groups are skipped.
 */
export function readTboxConfig(): TboxConfig {
	const merged = readMergedSettings();
	const tbox = merged["tbox"];

	if (!tbox || typeof tbox !== "object" || Array.isArray(tbox)) {
		return { dev: false, groups: {} };
	}

	const raw = tbox as Record<string, unknown>;
	const dev = typeof raw["dev"] === "boolean" ? raw["dev"] : false;

	const groups: Record<string, GroupSpec> = {};
	const rawGroups = raw["groups"];
	if (rawGroups && typeof rawGroups === "object" && !Array.isArray(rawGroups)) {
		for (const [name, val] of Object.entries(
			rawGroups as Record<string, unknown>,
		)) {
			if (!val || typeof val !== "object" || Array.isArray(val)) continue;
			const g = val as Record<string, unknown>;
			const toolsets = Array.isArray(g["toolsets"])
				? g["toolsets"].filter((s): s is string => typeof s === "string")
				: [];
			const tools = Array.isArray(g["tools"])
				? g["tools"].filter((s): s is string => typeof s === "string")
				: [];
			groups[name] = { toolsets, tools };
		}
	}

	return { dev, groups };
}
