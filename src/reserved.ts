/**
 * Reserved-wordlist + name-validation helpers.
 *
 * Reserved words are subcommand names that cannot be group names.
 * The toolset-addressing prefix `+` is also reserved for group names.
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
	"edit",
	"remove",
];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_WORDS);

/** Whether `name` is a reserved subcommand word. */
export function isReserved(name: string): boolean {
	return RESERVED_SET.has(name);
}

/**
 * Whether `name` contains `+`, which is reserved as the toolset-addressing
 * prefix. Group names may not contain `+`.
 */
export function containsPlus(name: string): boolean {
	return name.includes("+");
}
