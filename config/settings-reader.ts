/**
 * Tbox's group store — a dedicated global file, not merged settings.
 *
 * Groups are **user data** (named collections the user creates and grows
 * over time), not **config** (how pi behaves). They live in their own file
 * so they follow the user across directories and don't clutter
 * `~/.pi/agent/settings.json` (which holds pi-core config: providers,
 * theme, packages — static wiring, not user-authored collections).
 *
 * Storage location: `~/.pi/agent/pi-tbox/groups.json`, shape:
 *
 * ```jsonc
 * {
 *   "research": { "toolsets": ["portal.web", "portal.learn"] },
 *   "host":     { "toolsets": ["host.api"] }
 * }
 * ```
 *
 * The whole file is tbox's domain — no `tbox` wrapper key, no `groups`
 * wrapper key. One group = `{ toolsets: string[] }` (whole-toolset units
 * only; pi-tool-masking has no per-tool persist primitive, so a `tools[]`
 * field would collapse to `toolsets[]` at actuation and mislead readers).
 *
 * **Scope decision:** groups are **global/user-scoped**, never
 * project-scoped. A repo that wants per-project *actuation defaults*
 * (which groups auto-on in that checkout) would express that in
 * `.pi/settings.json` by *naming* global groups — it never redeclares
 * their definitions, so there's one source of truth and no drift.
 *
 * @module
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { isReserved, containsPlus } from "../src/reserved.js";

// ---------------------------------------------------------------------------
// Config path
// ---------------------------------------------------------------------------

/**
 * The single global path where user groups are stored. Deliberately not
 * derived from `process.cwd()` — groups follow the user, not the repo.
 */
export const GROUPS_FILE_PATH = join(
	homedir(),
	".pi",
	"agent",
	"pi-tbox",
	"groups.json",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A user group: addressable units = whole toolsets. */
export interface GroupSpec {
	toolsets: string[];
}

// ---------------------------------------------------------------------------
// Test-injectable override
// ---------------------------------------------------------------------------

// ponytail: a module-level override lets tests inject the groups table
// without touching real disk. Null in production — readGroups() falls
// through to the file read. One small hook beats per-test fs mocks.
let _override: Record<string, GroupSpec> | null = null;

/**
 * Inject (or clear) the groups table for tests. Pass `null` to restore
 * the disk-read path. Production code never calls this.
 *
 * @internal
 */
export function setGroupsOverrideForTests(
	groups: Record<string, GroupSpec> | null,
): void {
	_override = groups;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Read and parse the groups file. Returns {} on any failure. */
function readGroupsFile(
	path: string = GROUPS_FILE_PATH,
): Record<string, GroupSpec> {
	try {
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const groups: Record<string, GroupSpec> = {};
		for (const [name, val] of Object.entries(
			parsed as Record<string, unknown>,
		)) {
			if (!val || typeof val !== "object" || Array.isArray(val)) continue;
			const g = val as Record<string, unknown>;
			const toolsets = Array.isArray(g["toolsets"])
				? g["toolsets"].filter((s): s is string => typeof s === "string")
				: [];
			groups[name] = { toolsets };
		}
		return groups;
	} catch {
		return {};
	}
}

/**
 * Read the user's group definitions from the global store.
 *
 * In test mode (when `setGroupsOverrideForTests` has set an override),
 * returns the injected table. In production, reads
 * `~/.pi/agent/pi-tbox/groups.json`.
 */
export function readGroups(
	path: string = GROUPS_FILE_PATH,
): Record<string, GroupSpec> {
	if (_override !== null) return { ..._override };
	return readGroupsFile(path);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Validate a group name. Throws if the name is a reserved keyword or
 * contains `+` (the toolset-addressing prefix).
 */
function validateGroupName(name: string): void {
	if (isReserved(name)) {
		throw new TypeError(
			`"${name}" is a reserved word and cannot be used as a group name.`,
		);
	}
	if (containsPlus(name)) {
		throw new TypeError(
			`Group name "${name}" must not contain "+" (reserved for toolset addressing).`,
		);
	}
}

/**
 * Write (or overwrite) a group in the global store, preserving all other
 * groups in the file.
 *
 * Throws `TypeError` if `name` is a reserved word or contains `+`.
 *
 * In test mode (when `setGroupsOverrideForTests` has set an override),
 * updates the override in place. In production, writes to
 * `~/.pi/agent/pi-tbox/groups.json`.
 */
export function writeGroup(
	name: string,
	spec: GroupSpec,
	path: string = GROUPS_FILE_PATH,
): void {
	validateGroupName(name);

	if (_override !== null) {
		// Test mode: update the override object in place.
		_override[name] = { toolsets: [...spec.toolsets] };
		return;
	}

	// Production: read-merge-write the global groups file.
	const current = readGroupsFile(path);
	current[name] = { toolsets: [...spec.toolsets] };

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
}

/**
 * Remove a group from the global store, preserving all other groups.
 *
 * In test mode (when `setGroupsOverrideForTests` has set an override),
 * removes from the override in place. In production, writes to
 * `~/.pi/agent/pi-tbox/groups.json`.
 *
 * Returns `true` if the group existed and was removed, `false` if it
 * didn't exist.
 */
export function removeGroup(
	name: string,
	path: string = GROUPS_FILE_PATH,
): boolean {
	if (_override !== null) {
		if (!(name in _override)) return false;
		delete _override[name];
		return true;
	}

	const current = readGroupsFile(path);
	if (!(name in current)) return false;
	delete current[name];

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
	return true;
}
