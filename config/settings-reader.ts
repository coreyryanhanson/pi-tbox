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

import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { isReserved } from "../src/reserved.js";

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

/**
 * Thrown when the groups file exists but cannot be parsed as a groups
 * table. Writers refuse to proceed so a corrupt file is never overwritten
 * (that would silently destroy every user-defined group); read paths catch
 * this and degrade to an empty table.
 */
export class GroupsFileCorruptError extends Error {}

/**
 * Read and parse the groups file. Returns {} when the file is missing or
 * empty. Throws `GroupsFileCorruptError` when the file exists but is not a
 * valid groups table — callers must never write over such a file.
 */
function readGroupsFile(
	path: string = GROUPS_FILE_PATH,
): Record<string, GroupSpec> {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf-8");
	// An empty (zero-byte) file is indistinguishable from "no groups yet" —
	// treat it as absent rather than blocking writes on a `touch`ed file.
	if (!raw.trim()) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new GroupsFileCorruptError(
			`Groups file at ${path} is not valid JSON; refusing to overwrite it. Fix or delete the file, then retry.`,
			{ cause: err },
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new GroupsFileCorruptError(
			`Groups file at ${path} is not a groups table (expected a JSON object); refusing to overwrite it.`,
		);
	}

	// Per-entry normalization is lenient, not strict: malformed entries are
	// dropped, never fatal — the table-level checks above already refused
	// anything that isn't a plain object.
	const groups: Record<string, GroupSpec> = {};
	for (const [name, val] of Object.entries(parsed as Record<string, unknown>)) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const g = val as Record<string, unknown>;
		const toolsets = Array.isArray(g["toolsets"])
			? g["toolsets"].filter((s): s is string => typeof s === "string")
			: [];
		groups[name] = { toolsets };
	}
	return groups;
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
	try {
		return readGroupsFile(path);
	} catch (err) {
		if (err instanceof GroupsFileCorruptError) return {};
		throw err;
	}
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
	if (name.includes("+")) {
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

	// Production: read-merge-write the global groups file. readGroupsFile
	// throws GroupsFileCorruptError on an unparseable file, refusing to
	// clobber user data — callers surface the error.
	const current = readGroupsFile(path);
	current[name] = { toolsets: [...spec.toolsets] };
	writeGroupsFile(path, current);
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
	writeGroupsFile(path, current);
	return true;
}

/**
 * Atomically replace the groups file: write to a temp sibling, then rename
 * over the target. A crash mid-write can no longer truncate the real file
 * (the failure mode that corrupts it in the first place).
 */
function writeGroupsFile(
	path: string,
	groups: Record<string, GroupSpec>,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(groups, null, 2) + "\n");
	renameSync(tmp, path);
}
