/**
 * /tbox defaults — settings-tier pin management.
 *
 * Thin dispatch over pi-tool-masking's toolsetDefaults reader/writer:
 * `save` snapshots live tool state as pins — project writes a **full
 * snapshot** (stable per-repo baseline), `--global` writes a **sparse
 * diff against the packaged default** (shared tweak layer); `show` lists
 * pins annotated by scope, `clear` removes a scope's toolsetDefaults
 * block, `restore` applies settings defaults to live state (lifting
 * focus).
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
	getRegisteredToolsets,
	MalformedSettingsError,
	readMergedToolsetDefaults,
	readToolsetDefaults,
	writeToolsetDefaults,
} from "pi-tool-masking";
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
  save     snapshot live on/off state into settings (project: full
           snapshot; --global: diff vs packaged default)
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
 * save — project: full snapshot; --global: tweaks-vs-packaged diff.
 *
 * Project save pins **every** registered toolset to its live on/off, so
 * a later `defaults restore` reproduces the save exactly — immune to
 * subsequent global changes (a sparse diff would leave silent keys open
 * to global override). Global save pins only toolsets whose live state
 * differs from the packaged default (`spec.defaultEnabled ?? true`):
 * global is the shared "tweak vs upstream" layer, so diffing against the
 * merged view would bake project-context state into the shared file.
 * Works during focus: the allowlist selection is captured either way.
 * `writeToolsetDefaults` merges — stale pins from a prior save are
 * `clear`'s job to remove.
 */
function defaultsSave(pi: ExtensionAPI, flags: Set<string>): DefaultsResult {
	const scope = resolveScope(flags);
	const pins: Record<string, { enabled: boolean }> = {};
	for (const { spec, toolset } of getRegisteredToolsets()) {
		const live = toolset.isEnabled(pi);
		if (scope === "project" || live !== (spec.defaultEnabled ?? true)) {
			pins[spec.persistKey] = { enabled: live };
		}
	}

	let path: string;
	try {
		path = writeToolsetDefaults(pins, scope);
	} catch (err: unknown) {
		if (err instanceof MalformedSettingsError) {
			return { message: `Error: ${err.message}`, level: "error" };
		}
		throw err;
	}

	const count = Object.keys(pins).length;
	return {
		message: `Saved ${count} toolset default${count !== 1 ? "s" : ""} to ${path}.`,
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
function defaultsShow(flags: Set<string>): DefaultsResult {
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
	try {
		const path = clearToolsetDefaults(scope);
		return path
			? {
					message: `Cleared toolset defaults from ${path}.`,
					level: "info",
				}
			: {
					message: `No toolsetDefaults block in ${scope} scope — nothing to clear.`,
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
			return defaultsShow(flags);
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
