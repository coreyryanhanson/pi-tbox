# Design: `/tbox defaults` — settings.json-backed default enabled state

**Status:** Approved
**Depends on:** `pi-tool-masking@1.2.0` (Sprints 1–3.5: the settings reader,
writer, `getEffectiveDefault`, and the inclusion-mode revision are all
implemented and unreleased in `pi-tool-masking`; this repo consumes them).
Companion plan: [`pi-tool-masking/plans/settings-json-defaults.md`](../pi-tool-masking/plans/settings-json-defaults.md)
(the *what* and *why* of the settings tier); this doc is the *pi-tbox UX* —
the command surface that lets a user author those settings without hand-editing
JSON.

## Problem

`pi-tool-masking@1.2.0` adds a durable precedence tier between the
chat-branch entry (tier 1, session-scoped) and the packaged
`spec.defaultEnabled` (tier 3, a baked constant):

```
1. chat-branch entry (last-writer-wins)              ← existing
2. settings.json.toolsetDefaults[persistKey].enabled ← NEW (1.2.0)
3. spec.defaultEnabled ?? true                       ← existing
```

Today a user who wants a toolset's *fresh-session* default to differ from
what the package author shipped has no durable path: toggling writes a
chat-branch entry (session-scoped, gone after a fresh session), and editing
`spec.defaultEnabled` means editing the package source. The settings tier
fixes that — but only if the user hand-edits
`~/.pi/agent/settings.json` (global) or `./.pi/settings.json` (project)
under the reserved `toolsetDefaults` wrapper key. That is error-prone
(JSON syntax, the nested schema, the wrapper-key convention) and gives no
feedback. `/tbox defaults` is the authoring surface: snapshot live toggles
into settings, see what's pinned, and clear pins — without leaving the
command line.

## Non-goals

- **Not a general settings editor.** tbox owns exactly one key in
  `settings.json` (`toolsetDefaults`); pi-core owns the rest (`provider`,
  `theme`, `packages`, …). The command never reads, writes, or displays
  any other top-level key. The library's writer preserves every
  non-`toolsetDefaults` key on write; the command inherits that guarantee
  and adds nothing on top.
- **Not per-toolset pinning in v1.** The writer supports `N=1` writes, so
  a future `/tbox +web default off --global` is a small addition, but it
  is out of scope here. v1 is snapshot-only (see "Action surface" below).
- **Not live-refresh.** Settings take effect on the next restore
  (`/reload` or new session), consistent with how pi treats
  `settings.json` generally. No mid-session re-application.
- **Not a per-entry clear.** The library's `clearToolsetDefaults(scope)`
  removes the whole `toolsetDefaults` block; there is no per-entry clear
  primitive by design. A user who wants to un-pin one toolset re-runs
  `save` after toggling it back to its packaged default (which drops it
  from the snapshot — see "Snapshot semantic").

## Command surface

```
/tbox defaults                       show every settings-tier pin (both scopes, annotated)
/tbox defaults save  --project       snapshot live toggles → ./.pi/settings.json
/tbox defaults save  --global        snapshot live toggles → ~/.pi/agent/settings.json
/tbox defaults clear --project       remove toolsetDefaults block from ./.pi/settings.json
/tbox defaults clear --global        remove toolsetDefaults block from ~/.pi/agent/settings.json
```

### Decisions locked in brainstorm

| Decision | Choice | Rationale |
|---|---|---|
| Noun | `defaults` | Matches the `toolsetDefaults` schema key, the plan's tier name, and the data's semantic (default enabled state). tbox owns one key in `settings.json`, not the whole config — `config` would over-claim the surface. |
| Scope word | `project` (not `local`) | Matches the library's `"global" \| "project"` API and pi-core's "project settings" vocabulary. `local` is intuitive but introduces a synonym, and in pi-adjacent contexts can misread as "this session/chat-local" — which is exactly the tier these defaults are *not*. |
| Scope on save/clear | **required** (`--global` / `--project`) | A durable write, possibly to a shared global file, must not default silently. The user states the target. |
| Actions | `save` / `show` / `clear` (snapshot-only) | One batch action per verb. The writer is batch-oriented; a snapshot is one read-merge-write, not N. Per-toolset pin is deferred. |
| `show` scope | none (shows both) | "What did I pin?" is cross-scope by nature. Output annotates each pin with its scope so the override direction is visible. |

`defaults` joins the reserved-word list in `src/reserved.ts` (it cannot be
a group name — same rule as `status`, `focus`, `all`, etc.).

### `save` — snapshot live toggles into settings

**Semantic: copy the chat-branch tier into the settings tier.** For every
toolset that has a chat-branch entry (`pi.appendEntry(persistKey, { enabled })`
is what every toggle writes), write
`toolsetDefaults[persistKey] = { enabled: <its value> }` to the chosen scope.

This is **mode-independent and pins only what the user actually touched:**

- **Exclusion mode** (default floor `true`) → the off ones **plus** any
  the user toggled *on against a packaged default-off* (e.g. a toolset
  ships `defaultEnabled: false` and the user turned it on). "Off ones
  only" would silently drop that on-toggle on the next restore — a real
  bug. Snapshotting the branch entries catches both directions.
- **Inclusion mode** (default floor `false`) → the on ones. The only
  toolsets with branch entries are the ones the user explicitly turned on
  (the floor is `false`, so anything on got there by a toggle).

Toolsets still sitting at their packaged default have no branch entry and
are **not** pinned — the file stays minimal, captures actual user intent,
and never sweeps in newly-installed toolsets on re-snapshot. This is the
"pin currently-toggled toolsets" option, restated as "read the branch,
write each entry's `enabled` to settings" — which is exactly what the
chat-branch tier already records.

**Implementation:** in the `/tbox defaults save` handler, read
`ctx.sessionManager.getBranch()`, filter to entries whose `customType`
matches a registered toolset's `persistKey` and whose `data.enabled` is a
boolean, last-writer-wins per `persistKey`, build the flat
`{ [persistKey]: boolean }` map, and call
`writeToolsetDefaults(map, scope)`. One read of the branch, one
read-merge-write of settings — no per-toolset loop over the file.

**Scope flag parsing:** `--global` / `--project` are `--`-prefixed, so
`parseArgs` (`src/list.ts`) collects them into its `flags: Set<string>`
output, **not** into `rest` (the bare-positional tail). Read them with
`flags.has("global")` / `flags.has("project")` — the same destructuring
`formatList` and other handlers already use. Missing or both/unsupported
→ usage message, no write. (Note: the `all on|off` sub-arg pattern uses a
bare positional word in `rest[1]`, not a `--` flag, so it is *not* a
literal mirror — `flags` is the seam here, not `rest`.)

**Output:** a confirmation naming the scope, the count of entries written,
and the path written to (so the user knows which file they just touched).
Example: `Saved 4 toolset defaults to ~/.pi/agent/settings.json (global).`

### `clear` — remove the `toolsetDefaults` block

Calls `clearToolsetDefaults(scope)`. Returns `true` if the block existed
and was removed, `false` if already absent. The library's malformed-file
guard applies (throws rather than overwrites a corrupt settings file).
Output follows the `removeGroup` success/failure ternary pattern (the
name-based `Group "${name}" removed.` / `No group named "${name}".`),
but with richer wording naming the file path and scope, since this
command touches `settings.json` rather than a named group: `Cleared
toolset defaults from <path> (<scope>).` or `No toolsetDefaults block in
<path> (<scope>) — nothing to clear.`

After `clear`, every toolset in that scope falls back to tier 3
(`spec.defaultEnabled ?? true`) — or, for project scope, to the global
scope's pins (project-absent ⇒ global wins per the merge semantics).

### `show` — list every pin, annotated by scope

Reads `readMergedToolsetDefaults()` for the *merged* view (what restore
actually uses) and `readToolsetDefaults("global")` /
`readToolsetDefaults("project")` for each scope's raw block, to attribute
each pin to its source scope. Output, one row per pin:

```
toolset-state:pi-lean-dimension.web    enabled  [global]
toolset-state:pi-lean-dimension.api    disabled [project]  (overrides global)
```

Project pins that override a global pin for the same `persistKey` are
annotated `(overrides global)` so the override direction is visible — the
shallow per-entry merge means project wins outright, and a user debugging
"why is this still on?" needs to see both. Pins with no branch entry
(durable, not session-scoped) are the whole point; the view is the source
of truth for "what will the next fresh session look like, ignoring my
current toggles?"

If the merged map is empty: `No toolset defaults pinned in settings. Every
toolset uses its packaged default (spec.defaultEnabled ?? true).`

## Required pi-tbox work (beyond the command)

Four changes the plan names as pi-tbox-side; all gate on `1.2.0` and ship
with `/tbox defaults`:

### 1. Call-site swaps to `getEffectiveDefault` (Sprint 4)

`src/focus.ts` (`focusOff`) and `src/registry.ts` (`actuateNewToolsets`)
read `spec.defaultEnabled` directly and would ignore the new settings
tier. Swap both to `getEffectiveDefault(spec, snapshot)`, reading
`readMergedToolsetDefaults()` **once before the loop** in each (both
iterate the registry; per-toolset disk reads would be O(toolsets) reads
per action). Detailed in
[`pi-tool-masking/plans/settings-json-defaults-sprints.md`](../pi-tool-masking/plans/settings-json-defaults-sprints.md)
Sprint 4.

### 2. Focus-enter correctness fix (Sprint 3.5 follow-up)

The inclusion-mode revision (Sprint 3.5) has a named consequence for
focus: a settings-pinned `{enabled: true}` non-allowlist toolset that is
currently off will turn itself on at the next restore while focus is
active — breaking the "only the focused unit is on" contract. The
focus-enter code in `src/focus.ts` today persists `{enabled: false}` only
for **currently-enabled** non-allowlist toolsets. Under the revised floor,
an already-off settings-pinned toolset takes the else-branch at restore,
reads its settings pin (`true`), and flips on.

**Fix (pi-tbox-side, not a library change):** focus-enter must persist
`pi.appendEntry(persistKey, { enabled: false })` for **all** non-allowlist
toolsets (not just currently-enabled ones), so restore takes the
if-branch for them where mode and settings are both ignored. This is a
one-loop change in `focusUnit`'s second pass: drop the `isEnabled(pi)`
guard on the disable path and always `appendEntry({enabled:false})` for
non-allowlist entries (still call `disable()` only when currently enabled,
to avoid needless events). The `focusOff` swap (item 1 above) then
correctly restores each toolset to its settings-or-packaged default on
exit.

This fix is **not optional** alongside `/tbox defaults save --global`: a
user who pins a toolset on globally and later enters focus would
otherwise see it leak back on at the next `/reload`. Shipping the command
without the fix ships a known regression.

### 3. Focus-exit cascade-undone fix (Sprint 4)

The `requires` cascade in `focusOff` can re-enable a settings-pinned-off
toolset. When `focusOff` iterates the registry using
`entry.toolset.enable(pi)` / `entry.toolset.disable(pi)`, each call
triggers the library's cascade: `enable()` cascades forward to
`requires` dependencies, `disable()` cascades backward to dependents.

If toolset A (`defaultEnabled: true`) is pinned `off` via settings and
toolset B requires A (`defaultEnabled: true`, no settings pin):

1. `focusOff` disables A (settings override) → `_disableDependents`
   also disables B (cascade to dependent).
2. Loop continues to B → `getEffectiveDefault` returns `true`
   (no override) → `entry.toolset.enable(pi)` cascades forward and
   **re-enables A** via the `requires` edge.

This is a pre-existing design issue (the same could happen with
`defaultEnabled: false` on a dependency before Sprint 3), but the
settings tier makes it more visible since users can now durably pin
any toolset off.

**Fix:** switch `focusOff` from per-toolset `enable()`/`disable()`
calls (which trigger the cascade) to direct state application, mirroring
the pattern `actuateNewToolsets` already uses:

```ts
const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
const activeSet = new Set(pi.getActiveTools());
let flipped = 0;

for (const entry of registry) {
  const wantsEnabled = getEffectiveDefault(entry.spec, defaultsSnapshot);
  const names = [...entry.spec.names].filter((n) => allToolNames.has(n));
  for (const name of names) {
    if (wantsEnabled) {
      if (!activeSet.has(name)) { activeSet.add(name); flipped++; }
    } else {
      if (activeSet.has(name)) { activeSet.delete(name); flipped++; }
    }
  }
}

if (flipped > 0) {
  pi.setActiveTools([...activeSet]);
  pi.events.emit(TOOLSET_EVENTS.changed, { id: "tbox.focus-off", enabled: true });
}
```

This builds the desired active set from effective defaults in one pass
and applies it atomically, bypassing the `requires` cascade entirely.
The restored-toolsets count shifts from "cascade-toggle actions" to
"tools whose state actually changed" — slightly different semantics
but more honest (no double-counting cascade artifacts).

This fix is **not optional** alongside `/tbox defaults save --global`: a
user who pins a toolset off globally and later exits focus while a
dependent toolset has no settings pin would otherwise see the pinned-off
toolset silently re-enabled. Shipping the command without this fix ships
a known regression.

### 4. Refuse `save` while focus is active

`save` snapshots the chat-branch tier, and while focus is active that tier
is full of focus-era entries: `focusUnit` writes `{enabled:true}` for
allowlist members and (after the fix above) `{enabled:false}` for *all*
non-allowlist toolsets. Running `/tbox defaults save` mid-focus would pin
that focus state as durable defaults — almost certainly not the user's
intent, and a quiet footgun.

`defaults save` is not technically an actuation command (it doesn't
toggle), so AGENTS.md's "refuse actuation commands during focus" rule
doesn't automatically cover it. Extend the same guard to `save` in the
`/tbox defaults` dispatch: while focus is active, refuse `save` with the
same focus-active message the actuation commands use, no write. `show`
and `clear` remain available (read/remove don't snapshot live state).

## Test isolation

Every pi-tbox test that exercises `focusOff` or `actuateNewToolsets`
(`__tests__/focus.test.ts`, `__tests__/restore-timing.test.ts`,
`__tests__/integration.test.ts`) must pin the reader override to `{}`
so a developer's real `~/.pi/agent/settings.json` can't flake the suite:

```ts
import { setSettingsOverrideForTests } from "pi-tool-masking";

beforeEach(() => {
  MockPI.cleanRegistry();
  setSettingsOverrideForTests({});
});
afterEach(() => {
  setSettingsOverrideForTests(null);
});
```

New tests for `/tbox defaults` itself use **both** seams:
`setSettingsOverrideForTests({})` (reader → empty, so assertions about
the *merged* `show` output are deterministic) and
`setSettingsWriterOverrideForTests` (writer → in-memory capture, so
`save`/`clear` assertions don't hit disk). A round-trip test must clear
**both** overrides or they mask each other (per the library's W5 test).
Mirror the `setGroupsOverrideForTests` pattern already in
`__tests__/picker.test.ts`.

**Caveat — `show` scope attribution can't use the reader override.** When
`setSettingsOverrideForTests` is set, `readToolsetDefaults(scope)` returns
*that override for both scopes* (per its JSDoc), so both global and
project raw reads collapse to the same map and the `(overrides global)`
annotation is untestable through the seam. The writer override doesn't
help either — it captures writes in-memory and doesn't serve reads, so
there is no "writer seam + read" round-trip. Attribution tests therefore
need a **real disk round-trip**: no reader override, no writer seam,
`process.chdir(tmpDir)` + `PI_CODING_AGENT_DIR` env var pointed at a temp
`~/.pi/agent`, mirroring the library's own W6 disk tests. Use the
reader/writer seams for the merged-view and `save`/`clear` assertions;
reserve the disk round-trip for the attribution paths only.

## Strict-TS notes

- `readMergedToolsetDefaults()` returns `Record<string, boolean>`; indexed
  access yields `boolean | undefined` under `noUncheckedIndexedAccess` —
  guard with `typeof === "boolean"` before use (the library already does
  this in `doRestore`).
- `exactOptionalPropertyTypes`: never assign `undefined` to an optional
  prop explicitly; omit the key instead.
- Relative imports use `.js` extensions (pi-tbox's `module: nodenext`);
  the `pi-tool-masking` imports are package imports, no extension.

## Out of scope / deferred

- **Per-toolset pin** (`/tbox +web default off --global`) — the writer
  supports it; add when snapshot-only proves insufficient for surgical
  edits.
- **`/tbox list` pin-marker column** — the plan flags printing the nested
  `toolsetDefaults[<persistKey>]` path in toolset output as a UX nicety.
  Separate follow-up; `show` covers the "what's pinned?" question until
  then.
- **Cross-scope propagation** — a toolset settings-pinned in global but
  not in project is already durable; snapshotting to project won't re-pin
  it. If users want "copy my global pins into project," that's a distinct
  command, not `save`.
- **Downstream cleanup** (portal `browserToggle.defaultEnabled` / host
  `apiToggle.defaultEnabled` injection deletion) — tracked separately in
  the plan; not gated on this command.
