# Plan: intent/observation drift visibility + `/tbox sync`

Status: proposed (not implemented).

After the intent/observation split, a toolset's persisted intent
(`effectiveEnabled`) can disagree with the observed active set
(`pi.getActiveTools()`). Today this drift is silent: the `before_agent_start`
re-assert in `pi-tool-masking` defends only the leak direction at its
load-order position, and nothing labels the mismatch on any tbox surface.
This plan adds a shared drift predicate, surfaces it on the stats commands,
and adds a one-batch repair command.

## Why drift exists (background for the wording)

1. **Load order** — the re-assert runs at masking's load-order position; a
   foreign reconciler that registers after it re-adds its tool *after* the
   repair, and the leak survives into the turn (flagged `ponytail:` in the
   library).
2. **Force-removal is undefended by design** — the exclusion re-assert only
   removes *leaks into disabled* toolsets; tools force-*removed* from an
   intent-enabled toolset stay removed (masking cannot distinguish
   force-removal from deliberate removal). No automatic repair exists; only
   an off/on toggle cycle or `/tbox sync` fixes it.
3. **Between turn boundaries** — a foreign mid-session `setActiveTools` write
   leaves observation ≠ intent until the next `before_agent_start`, so a
   stats command run right after shows the drifted state unlabeled.

## Design

One predicate, three stat-surface consumers, one repair command. No new
`pi-tool-masking` API, no per-prompt hooks, no toast outside a user-invoked
command.

### 1. Drift predicate — `src/drift.ts` (new)

Per registered toolset, compare intent to observation:

- **Intent off, any member active** — leak drift (the re-assert repairs this
  at the next boundary, but the current state is wrong).
- **Intent on, some-but-not-all members active** — force-removal drift
  (toolsets toggle all-or-nothing, so a partial active count is never a
  legitimate state).
- **Intent on, zero members active** — *not* drift: the inert-toolset case
  (MCP server not connected, members hidden). `/tbox sync` is a no-op here
  (`toggleBatch`'s delta gate returns `[]`; an actuate would write nothing);
  flagging it would tell the user to run a command that cannot help.

Returns the mismatched toolset ids plus a short per-id fact string
(`+web (intent off, 3 active)`), for the footer render. Uses the exported
`effectiveEnabled` from `pi-tool-masking` with the caller's branch snapshot —
one `getBranch()` read per command, threaded to all consumers (branch-reader
rule).

### 2. Stat surfaces — footer line + `ctx.ui.notify`

`/tbox list`, `/tbox chars`, and `/tbox status` each:

- Append one conditional footer line to their normal output when the
  predicate returns anything, e.g.
  `⚠ intent mismatch: +web (intent off, 3 active) — run /tbox sync`
  (multiple mismatches join on one line or wrap; ids sorted by registry
  order).
- Call `ctx.ui.notify(...)` with the same message when a mismatch exists.
  The notify only ever fires from inside a user-invoked stats command —
  never per prompt — so there is no spam vector beyond running the command
  repeatedly, which is the user's own action.

Wording is direction-neutral ("intent and active state disagree") because the
automatic re-assert fixes leaks but never force-removal — "it will be turned
off automatically" is not always true.

Table layouts stay untouched: no `enabled` column in `/tbox chars`, no
second table. In the common no-drift case the column would read ✓ uniformly
(redundant again, just inverted); the drift is per toolset, so a sentence
carries the fact better than a row schema. `list`'s grouped view already
*shows* the drift via its active/inactive counts — the footer just *labels*
it.

### 3. `/tbox sync` — one-batch reconcile

New subcommand; applies the persisted intent to the active set in a single
`toggleBatch` call (one branch read, one settings read, atomic pre-write
plan):

- Domain function in `src/groups.ts` (or a small `src/sync.ts` if groups.ts
  is the wrong shape): one op per registered toolset at
  `effectiveEnabled(spec, branch, defaultsSnapshot).enabled`, through
  masking's `toggleBatch` over `ctx.sessionManager`. Throws raw; the
  dispatch seam owns refusal copy.
- No intent pre-gate. When observation already matches intent the delta gate
  returns `[]`; render that as "already in the desired state."
- Repairs both directions in one batch (leak + force-removal), with the
  usual `requires` cascade semantics.
- Under focus/allowlist mode the batch throws `AllowlistModeError`
  (mode-global); catch it in `toggleRefusalMessage` like the other
  actuation commands. `checkFocusGuard` runs first, matching every other
  actuation path.

## Wiring checklist

- `src/reserved.ts` — add `sync` to the reserved-word list.
- `index.ts` dispatch — route `sync` before the `+`/bare-name addressability
  check (it's a subcommand, not a unit); it sits beneath the existing
  `/tbox` dispatch defer gate like every other command.
- Bare help (`formatBareHelp`) — one line for `sync`.
- Help text for `list`/`chars` unchanged (footer is conditional, not a flag).
- `CHANGELOG.md` `[Unreleased]` entries.

## Tests (`__tests__/sync.test.ts`, plus additions to list/chars suites)

- Predicate: leak (intent off, member active) flags; force-removal (intent
  on, partial active) flags; inert (intent on, zero active) does not flag;
  clean toolset does not flag.
- Footer line appears on `list`/`chars`/`status` when drifting, absent when
  clean; notify called only when drifting.
- `sync`: repairs a clobbered loadout in one batch (assert one
  `toggleBatch`-shaped write, both directions); no-op returns the
  "already in the desired state" message; refused under focus with the
  allowlist refusal copy; `sync` rejected as a group name.
- `MockPI.cleanRegistry()` in `beforeEach` per the existing pattern.

## Out of scope (deliberate)

- No new masking event for drift — the passive footer/notify is expected to
  suffice; add a distinct library event only if the marker proves too quiet.
- No per-prompt drift check and no drift toast outside user-invoked
  commands.
- No `/tbox chars` column change; table schema frozen.
- `/tbox sync` does not touch the pi-managed group or builtin floor
  (non-togglable by definition).
