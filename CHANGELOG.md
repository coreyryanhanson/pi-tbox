# Changelog

## [Unreleased]

## [0.2.3] - 2026-09-03

### Changed

- `/tbox status` now lists user groups alphabetically, matching
  `/tbox group list` (previously file order from `groups.json`).

- **The groups file now honors `PI_CODING_AGENT_DIR`.** `groups.json` was
  hardcoded to `~/.pi/agent/pi-tbox/groups.json`, while settings-tier
  defaults (`/tbox defaults save`) resolve their base dir from
  `PI_CODING_AGENT_DIR ?? ~/.pi/agent` — so a user with a relocated agent
  dir got their groups and their defaults pins written into two different
  trees, and `/tbox status`'s "User Groups" wouldn't match the settings
  tbox had just written. The path is now
  `${PI_CODING_AGENT_DIR ?? ~/.pi/agent}/pi-tbox/groups.json`, matching
  the library. Default installs resolve to the identical path — no action
  needed. If you set `PI_CODING_AGENT_DIR` and already have groups, move
  the old `groups.json` into the new location once.

- Bumped `pi-tool-masking` from 1.2.3 to 1.3.0.

### Fixed

- **`/tbox solo` during focus now reports the focus refusal instead of a
  unit-resolution error.** `soloUnit` resolved the unit before the focus
  guard, so `/tbox solo <bad-unit>` while focus was active answered
  `No toolset matching ...` and hid the actual problem. The guard now
  runs first, matching every other actuation path.

- **Focus state no longer survives branch navigation to a pre-focus
  leaf.** `restoreFocusUnit` only assigned the focus label when the
  branch had a `tbox-focus-state` entry; it never reset the in-memory
  label when the entry was absent. `session_tree` fires in-process on
  `/tree` navigation, so focusing a unit on branch A and then navigating
  to a leaf created before the focus entry left tbox's status slot
  showing `● focus:<unit>` with the actuation guard refusing every
  command — while the library's `doRestore` (same event) had already
  lifted the allowlist, and `focus release` answered "Focus is not
  active". The two states now agree: absence of a focus entry on the
  branch is treated as a focus fact and resets the label. Navigating to
  a leaf *after* the focus entry still replays focus correctly.

- **A `requires` cycle no longer crashes the TUI when hit from the
  group-edit picker.** `forwardClosure`/`reverseClosure` deliberately throw
  on cyclic toolset specs, but nothing in the picker caught that throw —
  pi's TUI dispatch calls `handleInput` bare, so pressing Enter (or
  Ctrl+A/Ctrl+X as the first interaction) on a cyclic registry bubbled an
  uncaught exception out of the key handler and killed the whole pi session
  (`process.exit(1)`). `GroupEditorComponent.handleInput` now catches, logs,
  and surfaces the cycle path in the picker footer cue instead. The throw
  contract itself is unchanged; the `/tbox` command paths were already safe
  (pi's host catches command-handler rejections).

- **A corrupt `groups.json` is no longer silently overwritten.** Parse errors in
  `readGroupsFile` previously degraded to an empty table, so the next group
  save/remove wrote that empty table over the file — one malformed write
  (e.g. a crash-truncated file) destroyed the user's entire groups table.
  Reads (`/tbox list`, describe) still degrade to an empty table (zero-byte
  files are treated as absent, so `touch`ed files don't block writes), but
  write paths now throw `GroupsFileCorruptError`, and `/tbox group edit`'s
  save and `/tbox group <name> remove` surface it at the `"error"` level
  instead of proceeding. Writes are also atomic now (`.tmp` + `renameSync`),
  so a mid-write crash can't truncate the file in the first place.

## [0.2.2] - 2026-08-29

### Added

- **`/tbox solo <group>` / `solo +<toolset>`** — lockless single-unit mode:
  equivalent to `all off` followed by enabling the unit (its `requires` deps
  come along via the library's forward cascade). Persists as ordinary
  per-toolset entries — no allowlist mode, no lock, no exit command;
  `/tbox all on` or `/tbox defaults restore` undoes it, and `/reload` replays
  it. Refused while focus is active, like every other actuation path. `solo`
  joins the reserved-word list.

## [0.2.1] - 2026-08-04

### Changed

- Bumped `pi-tool-masking` from 1.2.2 to 1.2.3, extending the turn-boundary
  leak re-assert to exclusion and inclusion modes (not just allowlist) so a
  disabled toolset can no longer leak back into the turn via another
  extension's `pi.setActiveTools` reconciler.

## [0.2.0] - 2026-08-03

### Fixed

- **Status slot now re-renders on `before_agent_start` to reflect the live
  active-tool count.** The slot previously only refreshed on `session_start`
  / `session_tree` and on `TOOLSET_EVENTS` fanout, so a third-party
  reconciler (or any plugin) calling `pi.setActiveTools` directly — without
  emitting `TOOLSET_EVENTS` — left the slot showing a pre-leak snapshot until
  the next toolset event. The rerender is registered from `session_start`
  (after all factories load) so it runs *after* factory-registered
  `before_agent_start` reconcilers and shows the true post-reconciler state.
  Complements `pi-tool-masking@1.2.1`'s allowlist re-assertion (Option A):
  when A wins the race the count stays correct, and when A loses the slot now
  shows the real leaked count instead of lying.

- **`/tbox group <reserved> edit` now refuses before opening the picker.**
  The reserved-word guard previously fired only inside `writeGroup`'s save
  callback, so editing a reserved name (e.g. `list`, `status`) or a
  `+`-prefixed name opened the picker and then threw inside the save
  callback. `editGroup` now rejects reserved / `+`-containing names up front.

- **Picker `Ctrl+X` (clear all) now reverse-cascades.** Bulk deselect
  unchecks hidden dependents via `reverseClosure`, matching single-item
  uncheck, so a saved group never retains a check on a toolset whose required
  dependency is unchecked.

### Added

- **`/tbox defaults` — settings-tier pin management.** A new subcommand
  surface for pinning toolset on/off state into Pi's settings tier, so a
  baseline survives `/reload`, resume, and global changes. `save`
  snapshots live state: project scope writes a **full snapshot** (every
  registered toolset pinned to its live on/off — a stable per-repo
  baseline immune to later global drift), `--global save` writes a
  **sparse diff against the packaged default** (`spec.defaultEnabled ??
  true`) so the shared file only records tweaks vs upstream. `show`
  lists pins from both scopes with per-row attribution (`[global]`, or
  `[project] (overrides global)` where project shadows a global pin for
  the same key), and is the default when `/tbox defaults` is run with no
  subcommand. `clear` removes a scope's `toolsetDefaults` block.
  `restore` applies the merged settings defaults to live state now and
  lifts focus. `--global` is a write-scope flag (save/clear only); `show`
  reads both scopes and `restore` applies the merged view, so `--global`
  is a usage error there. Save works during focus — the allowlist
  selection is captured either way. Backed by `pi-tool-masking`'s
  `readMergedToolsetDefaults` / `writeToolsetDefaults` /
  `clearToolsetDefaults`; tbox adds the scope rules and CLI, no new state.

- **`/tbox focus release` — exit focus while keeping the live selection.**
  The counterpart to `focus off`: instead of restoring every toolset to
  its effective default, `release` flushes the current allowlist to
  per-toolset branch entries (`{enabled:true}` for allowlist members,
  `{enabled:false}` for the rest) and switches back to exclusion mode —
  live state is untouched, so what you see is what you keep, and a later
  `/reload` replays the flushed entries. Guarded: with no active focus,
  returns a hint instead of flushing everything off.

- **Reserved words `defaults`, `release`, `restore`.** Added to the
  reserved-wordlist so they can never be group names; bare `/tbox restore`
  (a likely typo for `/tbox defaults restore`) hits the reserved-word
  guard instead of falling through to the group fallback. Bare help and
  the USAGE line now advertise `defaults`.

### Changed

- **`focus off` now tombstones stale per-toolset branch entries.**
  Previously `focus off` only re-applied defaults to live state; stale
  branch entries from pre-focus manual toggles survived, so a `/reload`
  after `off` could re-enable a toolset the user had toggled off before
  focusing. `applyEffectiveDefaults` now calls `clearAllToolsetEntries`
  (dedup'd) before re-actuating, so `/reload` after `off` falls through
  to settings → exclusion floor → `defaultEnabled`, matching the live
  state `off` just produced. `/tbox defaults restore` shares the same
  tombstone-and-apply mechanism.

- **Focus now uses `allowlist` mode instead of the deprecated `inclusion`
  mode.** Focus was previously built on `pi-tool-masking`'s `"inclusion"`
  resolution mode — an unbounded floor where unknown toolsets default
  off, which could not actually guarantee focus's contract: a toolset
  registered *after* focus was entered had no record to keep it off and
  could leak on. tbox now sets `"allowlist"` mode, backed by a finite,
  branch-persisted array of toolset ids (introduced in
  `pi-tool-masking` 1.2.0, now the minimum version). The array is a
  top-tier set-level override, so toolsets registered mid-focus stay off
  by construction, and stale per-toolset branch entries / settings pins
  can't bypass it. The exit commands (`focus off`, `focus release`) and
  `/tbox defaults restore` all switch back to `"exclusion"` mode as
  before.

## [0.1.1] - 2026-07-29

### Fixed

- **`/tbox focus` no longer enables dependents the user didn't select.**
  `resolveFocusUnit` was building the focus allowlist from the union of the
  forward `requires` closure *and* the reverse dependents closure,
  justified by a comment claiming the library's enable cascade runs both
  directions. It does not — `pi-tool-masking`'s `_enableToolset` recurses
  into `spec.requires` only; the reverse walk (`_disableDependents`) runs
  exclusively on `disable()`. The spurious reverse closure pulled any
  toolset that transitively `requires` a focused toolset into the
  allowlist, and focus's enable pass then turned those dependents on —
  diverging from `/tbox <group> on` and `/tbox +<toolset> on`, which only
  enable the declared toolsets and let the library cascade forward deps.
  The fix drops `reverseClosure` from the allowlist in both the
  `+<toolset>` and bare-group branches; the second pass already disables
  any non-allowlisted toolset directly, so dependents are now turned off,
  not on. Tests that encoded the old both-directions assumption were
  corrected.

## [0.1.0] - 2026-07-27

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
