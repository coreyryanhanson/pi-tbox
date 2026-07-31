/**
 * /tbox defaults — settings-tier pin management.
 *
 * Thin dispatch over pi-tool-masking's toolsetDefaults reader/writer:
 * `save` snapshots the live on/off state as pins, `show` lists pins
 * annotated by scope, `clear` removes a scope's toolsetDefaults block,
 * `restore` applies settings defaults to live state (lifting focus).
 *
 * Scope default is project; `--global` opts into the shared file — for
 * `save` and `clear` only (the write-scoped subcommands). `show` reads
 * both scopes and `restore` applies the merged view, so `--global` is a
 * usage error there.
 *
 * @module
 */

import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	clearToolsetDefaults,
	getEffectiveDefault,
	getRegisteredToolsets,
	MalformedSettingsError,
	readMergedToolsetDefaults,
	readToolsetDefaults,
	writeToolsetDefaults,
} from "pi-tool-masking";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./list.js";
import { applyEffectiveDefaults } from "./focus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The minimal command context defaults handlers need. */
interface DefaultsCtx {
	sessionManager: { getBranch: () => readonly SessionEntry[] };
}

/** A defaults command result: message + notify level. */
interface DefaultsResult {
	message: string;
	level: "info" | "error";
}

// ---------------------------------------------------------------------------
// Help + flags
// ---------------------------------------------------------------------------

const DEFAULTS_HELP = `\
/tbox defaults [subcommand]

Subcommands:
  (bare)   show pinned settings defaults (both scopes, annotated)
  save     snapshot the live on/off state into settings (scope: project)
  show     list settings-defaults pins, annotated by scope
  clear    remove the toolsetDefaults block from a scope (scope: project)
  restore  apply settings defaults to live state now (lifts focus)

Flags:
  --global   apply save/clear to the shared global settings file instead
             of the project's .pi/settings.json (save/clear only)
  --help     this help`;

const KNOWN_DEFAULTS_FLAGS = new Set(["global", "help"]);

/**
 * Resolve the write scope from flags. `--project` is NOT a known flag —
 * project is the default; only `--global` opts into the shared file.
 */
function resolveScope(flags: Set<string>): "global" | "project" {
	return flags.has("global") ? "global" : "project";
}

/**
 * Resolve a scope's settings.json path, mirroring pi-tool-masking's
 * private `settingsPath` so success/error messages name the real file.
 *
 * ponytail: ~3-line duplication of the library's private path helper.
 * Upgrade path: promote `settingsPath` in the library.
 */
function settingsPathFor(scope: "global" | "project"): string {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return scope === "global"
		? join(agentDir, "settings.json")
		: join(process.cwd(), ".pi", "settings.json");
}

/** Pointed error for --global misuse (accepted on save/clear only). */
function globalOnlyForWrites(): DefaultsResult {
	return {
		message:
			"Error: --global only applies to 'save' and 'clear'. See: /tbox defaults --help.",
		level: "error",
	};
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/**
 * save — live-state-diff, mode-agnostic.
 *
 * Pins every registered toolset whose live on/off differs from its
 * effective default (snapshot read once). Works during focus: the diff
 * captures the allowlist selection as exclusion pins. `writeToolsetDefaults`
 * merges — stale pins from a prior save are `clear`'s job to remove.
 */
function defaultsSave(pi: ExtensionAPI, flags: Set<string>): DefaultsResult {
	const scope = resolveScope(flags);
	const snapshot = readMergedToolsetDefaults();
	const pins: Record<string, { enabled: boolean }> = {};
	for (const { spec, toolset } of getRegisteredToolsets()) {
		const baseline = getEffectiveDefault(spec, snapshot);
		const live = toolset.isEnabled(pi);
		if (live !== baseline) pins[spec.persistKey] = { enabled: live };
	}

	const path = settingsPathFor(scope);
	try {
		writeToolsetDefaults(pins, scope);
	} catch (err: unknown) {
		if (err instanceof MalformedSettingsError) {
			return { message: `Error: ${err.message}`, level: "error" };
		}
		throw err;
	}

	const count = Object.keys(pins).length;
	return {
		message: `Saved ${count} toolset default${count !== 1 ? "s" : ""} to ${path} (${scope}).`,
		level: "info",
	};
}

/**
 * show — pins only, annotated by scope.
 *
 * Merged view + per-scope attribution: a global-only pin shows `[global]`;
 * a project pin shadowing a global pin for the same persistKey shows
 * `[project] (overrides global)`. Rows sorted by persistKey. No mode row —
 * there is no mode settings tier.
 */
function defaultsShow(pi: ExtensionAPI, flags: Set<string>): DefaultsResult {
	if (flags.has("global")) return globalOnlyForWrites();

	const merged = readMergedToolsetDefaults();
	const keys = Object.keys(merged).sort();
	if (keys.length === 0) {
		return {
			message:
				"No toolset defaults pinned in settings. Every toolset uses its packaged default (spec.defaultEnabled ?? true).",
			level: "info",
		};
	}

	const globalMap = readToolsetDefaults("global");
	const projectMap = readToolsetDefaults("project");
	const lines = ["Toolset defaults pinned in settings:"];
	for (const key of keys) {
		const pin = merged[key];
		if (!pin) continue;
		const isProject = key in projectMap;
		const status = pin.enabled ? "enabled" : "disabled";
		const override = isProject && key in globalMap ? " (overrides global)" : "";
		lines.push(
			`  ${key}  ${status}  [${isProject ? "project" : "global"}]${override}`,
		);
	}
	return { message: lines.join("\n"), level: "info" };
}

/**
 * clear — remove the toolsetDefaults block from one scope, preserving
 * every other top-level key. Same scope default as save: project unless
 * --global.
 */
function defaultsClear(flags: Set<string>): DefaultsResult {
	const scope = resolveScope(flags);
	const path = settingsPathFor(scope);
	try {
		const cleared = clearToolsetDefaults(scope);
		return cleared
			? {
					message: `Cleared toolset defaults from ${path} (${scope}).`,
					level: "info",
				}
			: {
					message: `No toolsetDefaults block in ${path} (${scope}) — nothing to clear.`,
					level: "info",
				};
	} catch (err: unknown) {
		if (err instanceof MalformedSettingsError) {
			return { message: `Error: ${err.message}`, level: "error" };
		}
		throw err;
	}
}

/**
 * restore — apply settings defaults to live state now; lifts focus.
 *
 * Same tombstone + exclusion + apply mechanism as `focus off`
 * (applyEffectiveDefaults); callable mid-focus as a settings pull.
 */
function defaultsRestore(
	pi: ExtensionAPI,
	ctx: DefaultsCtx,
	flags: Set<string>,
): DefaultsResult {
	if (flags.has("global")) return globalOnlyForWrites();

	const count = applyEffectiveDefaults(pi, ctx.sessionManager.getBranch());
	return {
		message: `Restored ${count} toolset${count !== 1 ? "s" : ""} to settings defaults.`,
		level: "info",
	};
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch /tbox defaults.
 *
 * Mirrors /tbox list's flag handling: --help first, then unknown-flag
 * rejection. Bare `/tbox defaults` shows the pins.
 */
export function handleDefaults(
	pi: ExtensionAPI,
	ctx: DefaultsCtx,
	args: string,
): DefaultsResult {
	const { flags, rest } = parseArgs(args);

	if (flags.has("help")) {
		return { message: DEFAULTS_HELP, level: "info" };
	}

	const unknown = [...flags].filter((f) => !KNOWN_DEFAULTS_FLAGS.has(f));
	if (unknown.length > 0) {
		return {
			message: `Error: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown
				.map((f) => `--${f}`)
				.join(", ")}. See: /tbox defaults --help.`,
			level: "error",
		};
	}

	const sub = rest[1] ?? "show";
	switch (sub) {
		case "save":
			return defaultsSave(pi, flags);
		case "show":
			return defaultsShow(pi, flags);
		case "clear":
			return defaultsClear(flags);
		case "restore":
			return defaultsRestore(pi, ctx, flags);
		default:
			return {
				message: `Error: unknown defaults subcommand "${sub}". See: /tbox defaults --help.`,
				level: "error",
			};
	}
}
