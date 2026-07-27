# Changelog

## [Unreleased]

### Added

- **Initial release of `pi-tbox`** — one `/tbox` command surface that
  lists, toggles, groups, and focuses tools from every installed Pi
  extension. tbox sits *across* extensions rather than inside any one of
  them: it discovers toolsets from any registered extension
  automatically and operates at the toolset granularity their author
  declared, so per-extension digging is replaced by a single addressable
  surface. Per-toolset on/off memory, the `requires` cascade, and the
  inclusion/exclusion default-resolution mode that makes focus
  drift-free are owned by the [`pi-tool-masking`](https://www.npmjs.com/package/pi-tool-masking)
  dependency; tbox layers on top of that library's events and reaches no
  extension internals.

- **`/tbox list` enumerates every tool across every extension** —
  grouped by toolset by default, with a `--flat` view (one row per tool,
  no grouping) and `--active` / `--inactive` filters. The grouped view
  resolves overlapping toolsets by smallest-toolset-wins: each tool
  appears once under its most specific containing toolset, no
  duplication. Tools unclaimed by any toolset are grouped per-source, so
  a plugin that only registers tools shows up as one focusable unit just
  like one that declares toolsets. Builtin tools and `sdk`-source (host
  `customTools`) tools appear as read-only rows in `--flat` only — they
  are out of tbox's scope and never togglable.

- **Toolset toggling at the declared boundary** — `/tbox +<toolset> on`
  / `off` flips a whole toolset, and `/tbox all on` / `off` hits every
  non-builtin toolset at once. State persists per-toolset across
  reloads and resume via `pi-tool-masking`.

- **Named groups of toolsets** — `/tbox group <name> edit` opens a
  keyboard-driven TUI picker (windowed 8 rows, fuzzy search,
  `Enter`/`Ctrl+A`/`Ctrl+X`/`Ctrl+S`/`Esc` shortcuts, all remappable)
  to curate a collection of toolsets. Groups are stored globally in
  `~/.pi/agent/pi-tbox/groups.json` as a bare `{ toolsets: string[] }`
  table — defined once, usable from any directory. The `requires`
  dependency closure is auto-maintained in both directions while
  editing, so a group is always a coherent closed set: inline footer
  cues report auto-checked dependencies and auto-unchecked dependents
  as you toggle. `/tbox group <name>` describes a group, `/tbox group
  list` enumerates them, `/tbox group <name> remove` deletes one.
  `/tbox <group> on` / `off` actuates every toolset in a group.

- **Focus mode** — `/tbox focus <group>` (or `focus +<toolset>`) flips
  the underlying library into inclusion mode so only the focused unit's
  allowlist plus Pi's builtins is active, and unknown toolsets default
  off. The choice persists in chat state, so it survives reloads,
  resume, and installing new extensions without drifting. While focus
  is active, the actuation commands (`all on|off`, `<group> on|off`,
  `+<toolset> on|off`) are refused — the slot advertises a known
  working set and toggling underneath it would break that promise.
  `focus off` restores defaults.

- **`/tbox status` and the status-bar slot** — `/tbox status` reports
  toolsets, groups, focus, and a serialized character-count split into
  a `core` floor (builtins — immutable overhead) and an `extension`
  budget (what `/tbox` can actually move), turning the count into a
  decision tool. The bar slot renders four live states: `○ tbox`
  (pristine), `● tbox n masked` (exclusion-mode count), `● focus:<unit>
  (n)` (focused), and `● focus:∅` (focus on but allowlist left nothing
  active — broken). The slot syncs on `session_start` and `session_tree`
  so it stays correct through conversation-tree navigation.

- **`/tbox chars` budget view** — flat list of toolsets ranked by
  serialized character count descending (most expensive first). Builtins
  are excluded as the non-togglable floor; toolsets with no active
  members (charging +0 chars) are omitted. Each line reports the
  toolset's active/inactive split and its +chars cost.

- **Addressability rules and reserved-word guard** — a `+` prefix means
  a toolset, a bare name means a group, so `+find` is always the toolset
  and `find` is always the group even when they share a name. Reserved
  words (`status`, `focus`, `all`, `list`, `group`, `on`, `off`,
  `edit`, `remove`, `chars`) are rejected as group names, so bare
  `/tbox <group> on|off` always parses unambiguously.

- **Dependency graph for picker display** — `src/requires-graph.ts`
  provides the local view of the `requires` closure used by the picker
  for auto-check/uncheck cues; the source of truth for actuation lives
  in `pi-tool-masking`.

- **Test suite** — Vitest against a hand-rolled `MockPI` stub backed by
  `node:events`, exercising the real `tboxFactory` across registry,
  groups, focus, list, chars, status-slot, picker, restore, and the
  `session_tree` re-sync path. `MockPI.cleanRegistry()` is called in
  `beforeEach` because the `pi-tool-masking` registry is process-global.
