/**
 * Reserved-wordlist + collision disambiguation.
 *
 * `/tbox <name> on|off` is the group shorthand **unless** `<name>` is
 * reserved, in which case the subcommand wins. A group named e.g.
 * `focus` is only reachable via the explicit `/tbox group focus on`.
 *
 * `dev` is **not** reserved: the `/tbox dev` command was removed in
 * Sprint 3's dev-mode swap (dev mode is now a `tbox.dev` setting read at
 * load), so `/tbox dev on` is just the group shorthand for a group named
 * `dev`.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Wordlist
// ---------------------------------------------------------------------------

/**
 * Reserved words that always dispatch to their subcommand, never a group.
 * Seed set confirmed against the shipped command surface in Sprint 7.
 */
export const RESERVED_WORDS: readonly string[] = [
	"toggle",
	"status",
	"focus",
	"all",
	"list",
	"chars",
	"group",
	"on",
	"off",
];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_WORDS);

/** Whether `name` is a reserved subcommand word. */
export function isReserved(name: string): boolean {
	return RESERVED_SET.has(name);
}
