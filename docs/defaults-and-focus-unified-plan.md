# Plan: `/tbox defaults` + allowlist-mode focus (unified)

**Status:** Proposed. See "Why this design" below for the constraints
that shaped the decisions (an earlier draft assumed a
`toolsetResolutionMode` settings tier that the locked masking plan dropped).
**Depends on:** `pi-tool-masking@1.2.0` (unreleased, on the
`feat/stored-settings-and-allowlist` branch), specifically:
`toolsetDefaults` settings tier + reader/writer/clearer, `getEffectiveDefault`,
the **`"allowlist"` resolution mode** + `getActiveAllowlist()`,
null-tombstone restore, `clearToolsetEntry` / `clearAllToolsetEntries`,
and `applyToolsetEnabled`. The companion plan is
[`pi-tool-masking/plans/settings-tier-and-allowlist-mode.md`](../pi-tool-masking/plans/settings-tier-and-allowlist-mode.md)
— the *what* and *why* of that surface; this doc is the *pi-tbox UX and
adoption*.

## Why this design

An earlier draft of this plan assumed a `toolsetResolutionMode` settings
tier — a second settings key so a saved focus config could reproduce its
resolution mode on a fresh session. The locked masking plan **dropped that
tier**: mode is branch-persisted only, with no settings key for it. The
settings tier itself (`toolsetDefaults`) and null-tombstone restore
semantics survived; the mode-persistence layer did not. Consequences that
cascade into the decisions below:

- **`save` can't persist the resolution mode** (the key doesn't exist).
  `save` writes `toolsetDefaults` pins only.
- **`show` / `clear` have no mode row** — nothing to show or clear.
  `show` is pins-only; `clear` removes the `toolsetDefaults` block only.
- **A saved focus config can't reproduce the allowlist for toolsets
  installed after the save.** `save` writes **exclusion pins**, and a
  toolset installed *after* the save with no pin hits the exclusion floor
  (`defaultEnabled ?? true`) and comes on. The post-install leak is
  **accepted** for settings files (editable-once-and-fixed, unlike
  append-only chat state). A resilient `toolsetAllowlist` settings key is
  deferred to a later release.
- **`restore` lifts focus.** For settings to flow, `restore` must append
  an `exclusion` mode entry to supersede any active allowlist. So
  `restore`-during-focus is coherent *and* exits focus.

## Decisions locked in brainstorm

| # | Decision | Choice | One-line rationale |
|---|---|---|---|
| D1 | `save` semantic | **Live-state-diff, mode-agnostic** | Pin every toolset whose live on/off differs from `getEffectiveDefault(spec)`. One code path, works during focus *and* outside it, minimal pins, no focus guard. |
| D2 | `focus off` behavior | **Restore to effective defaults** | Drive every toolset to `getEffectiveDefault`, switch to exclusion. Preserves current user expectation ("turn focus off = back to normal"); smallest behavior delta from today. |
| D3 | Second focus exit | **`focus release` = retain live set** | Keep the live on/off set, flush the allowlist selection to per-toolset branch entries, switch to exclusion. "Release the constraint, keep my working set." |
| D4 | `restore` during focus | **Allowed; lifts focus** | Tombstone toolset entries + append `exclusion` mode + apply `getEffectiveDefault` live. Settings flow; focus ends. Distinct from `focus off` (defaults) and `focus release` (retain). |
| D5 | Actuation during focus | **Still refused** (unchanged) | Toggles mid-focus re-shape the allowlist — UX-incoherent. `save`/`show`/`clear`/`restore` are not actuation and are not refused. |
| D6 | `show` surface | **Pins only, no mode row** | No mode settings tier exists. `show` lists `toolsetDefaults` pins annotated by scope. |

### D1 — `save` = live-state-diff

For each registered toolset, compute `live = entry.toolset.isEnabled(pi)`
and `baseline = getEffectiveDefault(spec, snapshot)` (snapshot read once
before the loop). Pin **only where they differ**:

```ts
const scope = flags.has("global") ? "global" : "project"; // default: project
const snapshot = readMergedToolsetDefaults();
const pins: Record<string, { enabled: boolean }> = {};
for (const { spec, toolset } of getRegisteredToolsets()) {
    const baseline = getEffectiveDefault(spec, snapshot);
    const live = toolset.isEnabled(pi);
    if (live !== baseline) pins[spec.persistKey] = { enabled: live };
}
writeToolsetDefaults(pins, scope);
```

Properties:

- **Mode-agnostic.** During focus (allowlist mode), live state *is*
  "allowlist members on, others off" — the diff captures the focus
  selection as exclusion pins. Outside focus, it captures your manual
  toggles. Same code path, same semantic both ways.
- **Minimal pins.** A toolset still at its effective default is not
  pinned, so a later settings edit or default change flows to it
  correctly instead of being locked.
- **No focus guard.** `save` works mid-focus. No refusal, no two-step
  `focusOff`-then-`save` workflow.
- **No drift mid-save.** The snapshot is frozen for the diff; the write
  doesn't mutate it. The only future "change" to the baseline is a later
  settings edit — the intended user lever.
- **`getRegisteredToolsets()` inline is fine.** `for...of` evaluates its
  iterable once at loop start, so `for (const { spec } of getRegisteredToolsets())`
  snapshots the registry exactly once — equivalent to the current code's
  `const registry = getRegisteredToolsets();` capture. No separate local
  needed; this holds for every inline loop in the snippets below.
- **Coupling note.** A′ depends on `getEffectiveDefault`'s
  mode-agnostic contract (settings pin → `spec.defaultEnabled`). That
  contract is documented in the masking plan and tested; it's a stable
  seam. If a future masking revision ever made `getEffectiveDefault`
  mode-aware or branch-aware, the diff would shift — flag in the plan,
  not a reason to avoid the cleanest design today.

### D2 — `focus off` = restore to effective defaults

```ts
export function focusOff(pi: ExtensionAPI): string {
    setFocusUnit(null);
    persistFocusUnit(pi, null);
    clearAllToolsetEntries(pi, ctx.sessionManager.getBranch()); // tombstone stale per-toolset entries
    const snapshot = readMergedToolsetDefaults();
    for (const { spec } of getRegisteredToolsets())
        applyToolsetEnabled(pi, spec, getEffectiveDefault(spec, snapshot));
    setDefaultResolutionMode(pi, "exclusion"); // after loop, matches current ordering
    rerenderSlot(pi);
    return `Focus off — toolsets restored to effective defaults.`;
}
```

- **Current behavior preserved.** Today's `focusOff` drives every toolset
  to its default; this swaps `enable()`/`disable()` (which trigger the
  `requires` cascade and can surprise re-enable) for `applyToolsetEnabled`
  (no-cascade apply) and `spec.defaultEnabled` for `getEffectiveDefault`
  (settings-aware). Same user-visible semantic, fixed mechanics.
- **Smallest delta from current code.** The `getEffectiveDefault` swap is
  already on the branch; this just replaces the `enable()/disable()` loop
  with `applyToolsetEnabled` (which the masking plan ships for exactly
  this path) and drops the cascade-undone `ponytail:` comment.
- **Durable via tombstone.** Under allowlist mode, focus-enter writes
  no per-toolset branch entries (the array is the authority), so a
  pristine session has none to clear. But a session with *pre-focus*
  manual toggles carries stale `{enabled: ...}` entries into focus;
  they're dormant during focus (allowlist wins) and wake on `/reload`
  after `off`. `clearAllToolsetEntries` tombstones them so `/reload`
  falls to `getEffectiveDefault` → defaults, matching the live
  `applyToolsetEnabled` result. Without this, `off` would drift on
  `/reload` for any non-pristine session (live = default, restored =
  pre-focus toggle). 2 branch writes (tombstone + exclusion mode), durable.
- **The old item-3 cascade problem is fixed for free** —
  `applyToolsetEnabled` is the no-cascade apply path the masking plan's
  D8 introduced.

### D3 — `focus release` = retain live set

```ts
export function focusRelease(pi: ExtensionAPI): string {
    const allow = getActiveAllowlist();
    if (!allow) // no focus active — guard before any state mutation
        return `Focus is not active — nothing to release. Use /tbox focus <group>|+<toolset> first.`;
    setFocusUnit(null);
    persistFocusUnit(pi, null);
    const allowSet = new Set(allow);
    for (const { spec } of getRegisteredToolsets())
        pi.appendEntry(spec.persistKey, { enabled: allowSet.has(spec.id) });
    setDefaultResolutionMode(pi, "exclusion"); // after loop, matches focusOff ordering
    rerenderSlot(pi);
    return `Focus released — selection retained, focus guard lifted.`;
}
```

- **Guarded against no-focus call.** `getActiveAllowlist()` returns
  `undefined` when focus isn't active; without a guard the empty set
  would append `{enabled:false}` for *every* registered toolset,
  disabling everything. The guard returns early with a hint message
  before any state mutation. It lives in `focusRelease` itself (not the
  `index.ts` dispatch) so the function is safe from any call path —
  mirrors `focusOff`'s idempotent-outside-focus posture.
- **Live state untouched.** What you see is what you keep — no surprise
  re-enables (the old item-1 complaint).
- **Flushes N per-toolset entries** to persist the selection under
  exclusion (without them, `/reload` → defaults). Accumulates per
  focus-cycle; `ponytail:` comment names the tombstone-accumulation
  ceiling and the pi-core compact-op upgrade path.
- **Aligned with the masking plan's downstream `focusOff` description**
  (the plan describes retain as one coherent option; we adopt it as
  `release`).
- **Decoupled from `save` by D1.** Under the old design, retaining on
  exit was forced because it was the only way to persist a focus config.
  With D1, a user can `save` mid-focus before any exit, so `release` and
  `off` are pure UX choices, not coupled to persistence.

### D4 — `restore` lifts focus

```
/tbox defaults restore    apply settings defaults to live state now; lifts focus
```

Handler:

1. `clearAllToolsetEntries(pi, ctx.sessionManager.getBranch())` — tombstone
   per-toolset branch entries (dedup'd) so settings re-assert.
2. `setDefaultResolutionMode(pi, "exclusion")` — append an exclusion mode
   entry; supersedes any active allowlist. Focus lifted.
3. Read `readMergedToolsetDefaults()` once; for each registered toolset,
   `applyToolsetEnabled(pi, spec, getEffectiveDefault(spec, snapshot))`.
   (Same tombstone + apply pattern as D2 `focus off`; `restore` and `off`
   share the mechanism — the difference is `restore` is callable mid-focus
   as a settings pull, `off` is the focus-exit path.)
4. Output: `Restored N toolset${N!==1?"s":""} to settings defaults.`

- **Not refused during focus** — applying settings while focused is a
  coherent "reset to settings" operation, and it ends focus cleanly.
- **Same tombstone+apply mechanism as `focus off`.** Both clear
  per-toolset entries and re-apply `getEffectiveDefault`; the difference
  is `restore` is a callable mid-focus settings-pull (D4), `off` is the
  focus-exit path (D2). Distinct from `focus release` (which retains the
  live set by *writing* per-toolset entries, not tombstoning). Three
  exits, three intents.
- **Doubles as "pull settings into live state now"** — the mid-session
  settings-activation path the old "Not live-refresh" non-goal blocked.

### D5 — actuation still refused during focus

Unchanged from AGENTS.md: while focus is active, `all on|off`,
`<group> on|off`, `+<toolset> on|off` are refused. `save`/`show`/`clear`/
`restore` are **not** actuation and are not refused. Add an AGENTS.md
line noting this explicitly.

## Command surface (final)

```
/tbox defaults                                show every settings-tier pin (both scopes, annotated)
/tbox defaults save  [--global]               snapshot live-state-diff → settings (default: project)
/tbox defaults clear [--global]               remove toolsetDefaults block from scope (default: project)
/tbox defaults restore                        apply settings defaults to live state now (lifts focus)

/tbox focus <group>|+<toolset>                enter focus (allowlist mode)
/tbox focus off                               exit focus → restore to effective defaults
/tbox focus release                           exit focus → retain live selection
```

**Scope default = project.** `save` and `clear` write to the project
scope (`./.pi/settings.json`) by default; `--global` opts into the
shared global file (`~/.pi/agent/settings.json`). There is no
`--project` flag — project is the default, and passing `--project` is an
unknown-flag error (mirrors `/tbox list`'s `KNOWN_*_FLAGS` reject
pattern in `src/list.ts`). Rationale: project is the safer, narrower
blast radius; global is the footgun (shared across all projects) that
deserves the explicit opt-in. `show` and `restore` take no scope flag —
`show` reads both scopes (annotated), `restore` applies the merged view.

`defaults` joins the reserved-word list in `src/reserved.ts`. `release`
joins too (it's a `focus` subcommand, not top-level, but reserving it
prevents a group named `release` from shadowing intent — belt-and-
suspenders, matches the existing `off`/`edit`/`remove` reservations).
`save`/`show`/`clear`/`restore` are `defaults` subcommands. Of these,
`restore` is the common verb most likely to be typed bare (forgetting
`defaults`); reserving it top-level + a `case "restore":` hint dispatch
in `index.ts` turns the unhelpful `No group named "restore"` into a
pointed redirect: `"restore" is a defaults subcommand. Use /tbox
defaults restore to apply settings defaults to live state (lifts focus).`
`save`/`show`/`clear` are rarer as bare typos and stay unreserved — the
generic unknown-subcommand error is acceptable for them (skip unless a
collision surfaces).

### `show` — pins only, annotated by scope

Reads `readMergedToolsetDefaults()` (merged view) and
`readToolsetDefaults("global")` / `readToolsetDefaults("project")` (per-
scope raw) to attribute each pin. One row per pin:

```
toolset-state:pi-lean-dimension.web    enabled  [global]
toolset-state:pi-lean-dimension.api    disabled [project]  (overrides global)
```

Project pins overriding a global pin for the same `persistKey` are
annotated `(overrides global)`. If the merged map is empty: `No toolset
defaults pinned in settings. Every toolset uses its packaged default
(spec.defaultEnabled ?? true).` No mode row — there is no mode settings
tier.

### `clear` — remove the `toolsetDefaults` block

Same scope default as `save`: project unless `--global`. Calls
`clearToolsetDefaults(scope)`. Returns `true` if the block existed.
Output: `Cleared toolset defaults from <path> (<scope>).` or `No
toolsetDefaults block in <path> (<scope>) — nothing to clear.` After
`clear`, every toolset in that scope falls back to tier 3
(`spec.defaultEnabled ?? true`), or for project scope, to the global
scope's pins.

## Changes required in pi-tbox

### 1. `src/focus.ts` — allowlist-mode rewrite + `focusRelease`

**`focusUnit`** — replace the two-pass enable/disable + per-toolset
`appendEntry` with:

```ts
const resolved = resolveFocusUnit(input);
if (!resolved.ok) return resolved.error;
const ids = resolved.toolsetIds; // already forward-closure-resolved

setFocusUnit(resolved.label);
persistFocusUnit(pi, resolved.label);

setDefaultResolutionMode(pi, "allowlist", ids);
// Live-actuate per toolset via the library's public apply helper. No
// per-toolset appendEntry — the allowlist array is the authority.
// Non-toolset tools are preserved automatically: applyToolsetEnabled
// is a per-spec delta (enable = union(current, spec.names), disable =
// current \ spec.names), so each call only touches its own spec's
// names and leaves everything outside the registry untouched. The
// library's restore handler has its own set-level atomic short-circuit
// for companion-mirror safety during *restore*; focusUnit is a live
// user action, not restore, so a per-toolset apply loop is fine (and
// emits the same N `changed` events today's enable/disable loop did).
const allow = new Set(ids);
for (const { spec } of getRegisteredToolsets())
    applyToolsetEnabled(pi, spec, allow.has(spec.id));
rerenderSlot(pi);
return `Focus on "${resolved.label}" — allowlist of ${ids.length} toolset${ids.length !== 1 ? "s" : ""}.`;
```

Delete the `ponytail:` two-pass comment (the two-pass approach is gone)
and the "already enabled → persist `{enabled:true}`" branch (the allowlist
array replaces per-toolset persistence for allowlist members). The return
message drops the old `${enabled} enabled, ${disabled} disabled` counts
(the `applyToolsetEnabled` loop doesn't surface them); the new format
`Focus on "<label>" — allowlist of N toolset(s).` still contains the
`Focus on` substring existing tests assert (`toContain("Focus on")`).

**`focusOff`** — per D2 above (swap `enable()/disable()` →
`applyToolsetEnabled`, drop the cascade `ponytail:` comment).

**`focusRelease`** — new, per D3 above.

**Header doc** — rewrite: "Focus uses **allowlist mode**: the resolved
unit + forward `requires` closure becomes a finite allowlist array stored
in the branch mode entry. The library's restore handler applies
'in array → on, else → off' across all registered toolsets, including
future installs. Two exits: `focus off` restores effective defaults;
`focus release` retains the live selection."

### 2. `src/registry.ts` — `actuateNewToolsets` allowlist branch

Add an allowlist consultation **before** the existing
`getEffectiveDefault` fallback (which is already on the branch):

```ts
export function actuateNewToolsets(pi: ExtensionAPI, ids: string[]): void {
    if (ids.length === 0) return;

    const allow = getActiveAllowlist();
    const registry = getRegisteredToolsets();
    const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
    const activeSet = new Set(pi.getActiveTools());
    let changed = false;

    const wantEnabled = (spec: ToolsetSpec): boolean => {
        if (allow !== undefined) return allow.includes(spec.id);
        return getEffectiveDefault(spec, readMergedToolsetDefaults());
    };

    for (const id of ids) {
        const entry = registry.find((e) => e.spec.id === id);
        if (!entry) continue;
        const enabled = wantEnabled(entry.spec);
        // ... existing activeSet add/remove logic, unchanged ...
    }
    // ... existing setActiveTools + emit, unchanged ...
}
```

This is the masking plan's named `getActiveAllowlist()` call site. A
toolset registered after focus was entered is not in the array → off.
Read `readMergedToolsetDefaults()` once outside the loop (the branch
already does this; keep it).

### 3. `/tbox defaults` dispatch + handlers — `index.ts` + new `src/defaults.ts`

Add a `case "defaults":` to the command switch dispatching `save` /
`clear` / `show` / `restore`. Add `release` to the `case "focus":`
branch alongside `off`. Handlers live in a new `src/defaults.ts`
module (keeps `index.ts` thin, matching `src/focus.ts` / `src/groups.ts`
convention); `index.ts` just parses + delegates.

Also add a `case "restore":` (sibling of `case "defaults":`) that
doesn't delegate — it just emits the redirect hint
`"restore" is a defaults subcommand. Use /tbox defaults restore to
apply settings defaults to live state (lifts focus).` This is the N2
guard: `restore` is reserved (step 4) so it never reaches the group
fallback, and this case gives the mistype a useful pointer instead of
`Unknown subcommand`. No `save`/`show`/`clear` siblings — those stay
unreserved and fall through to the generic unknown-subcommand error.

`restore` needs `ctx.sessionManager.getBranch()` for
`clearAllToolsetEntries` — the command handler already has `ctx`
(`applyToolsetEnabled` and `setDefaultResolutionMode` take `pi`).

**Flag handling — mirror `list`, don't diverge.** `parseArgs`
(`src/list.ts`) collects `--`-prefixed args into its `flags: Set<string>`
output. Define `KNOWN_DEFAULTS_FLAGS = new Set(["global", "help"])`
(no `--project` — project is the default, passing `--project` is an
unknown-flag error). `--help` prints a `DEFAULTS_HELP` block before any
other check; any `--` flag not in the set →
`Error: unknown flag --foo. See: /tbox defaults --help.` This is
design-faithful (prevents typo-silent-no-op bugs like `--gloal`
silently resolving to no scope) and mirrors `list`'s existing
unknown-flag reject pattern — the pattern already lives in this repo,
so it's ponytail-clean, not a new abstraction.

**Scope resolution** (shared by `save` / `clear`):

```ts
function resolveScope(flags: Set<string>): "global" | "project" {
  // --project is NOT a known flag; project is the default. Only --global
  // opts into the shared file.
  return flags.has("global") ? "global" : "project";
}
```

`show` and `restore` ignore scope (show reads both, restore applies the
merged view). With `--project` rejected as unknown, there's no
"both/missing" ambiguity — only `--global` or bare (→ project).

**Output path resolution.** `save` / `clear` success messages name the
file path written. The library's `settingsPath` is currently private,
so compute the path the same way the library does:
global → `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/settings.json`,
project → `<process.cwd()/.pi>/settings.json` (the `settings.json`
filename is load-bearing: the directories alone are not the file path,
and getting this wrong shows the wrong path in the success message).
`ponytail:` note with upgrade path "promote `settingsPath` in the
library" — ~3-line duplication over a new dependency, acceptable.

**Malformed-file surfacing.** `save` / `clear` catch
`MalformedSettingsError` (exported by the library) with `instanceof` —
not string-matching `message` — and report via
`ctx.ui.notify(..., "error")` naming the file, so the user knows which
file to fix. Never crash the command on a corrupt `settings.json`; the
library's guard means a corrupt file is never overwritten either way.

**`show` row ordering.** Sort rows by `persistKey` for deterministic
output (tests rely on it).

### 4. `src/reserved.ts` — add `defaults`, `release`, `restore`

```ts
const RESERVED_WORDS: readonly string[] = [
    "status", "focus", "all", "list", "group",
    "on", "off", "edit", "remove", "chars",
    "defaults", "release", "restore",
];
```

`restore` is reserved top-level not because there's a bare `restore`
command (there isn't) but so `/tbox restore` hits the `case "restore":`
hint dispatch in step 3 instead of falling through to the group path's
`No group named "restore"`. See the reservation rationale above.

### 5. Docs + comments

- **Repoint broken cross-repo links in the masking plan** —
  `pi-tool-masking/plans/settings-tier-and-allowlist-mode.md:24` and
  `d7-branch-access-gap.md:66,166,180` reference a path that doesn't
  exist; repoint them to `docs/defaults-and-focus-unified-plan.md` so
  the companion-doc chain isn't broken.
- Keep `docs/settings-tier-and-focus-suppression-retrospective.md` —
  it's the historical diagnostic the masking plan cites as "companion
  (context, not scope)" and is referenced at
  `pi-tool-masking/plans/settings-tier-and-allowlist-mode.md:15`.
  Retrospectives don't go stale the way specs do; it's the "why we chose
  allowlist mode" reasoning. Costs nothing to keep.
- `src/focus.ts` header doc: rewrite per item 1.
- `AGENTS.md`: add a line under the focus rule — "`save`/`show`/`clear`/
  `restore` are not actuation commands and are not refused during focus;
  `restore` lifts focus." Update the focus description from "inclusion
  mode" to "allowlist mode." Also update the "Where persistence actually
  lives" paragraph: it currently says "inclusion/exclusion mode are owned
  by the `pi-tool-masking` dependency" — add `allowlist` to that list,
  since pi-tbox now actively uses it (not just the library's internal
  concern).

## Test plan

### Step 0 — fix the 4 settings-pinned tests (branch baseline)

The 4 failing tests pass `setSettingsOverrideForTests({ [key]: false })`
against the masking plan's D1 wrapped-shape reader, which reads
`map[key]?.enabled` → `undefined` → falls through to `defaultEnabled`.
Fix: `{ [key]: false }` → `{ [key]: { enabled: false } }` in
`__tests__/focus.test.ts` (2 tests) and `__tests__/integration.test.ts`
(2 tests). 4-line fix, same behavior the new plan still relies on.

### Step 0.5 — existing tests invalidated by the allowlist-mode pivot

The `focusUnit` rewrite changes the resolution mode from `"inclusion"`
to `"allowlist"` and removes the per-toolset `appendEntry` during enter.
Several existing tests assert the old behavior and **will fail after step 2**
if not updated alongside it. None of these are new tests — they are the
breaking changes the pivot introduced. Group them here so an implementer
following the plan literally doesn't leave `npm test` red.

**B1 — mode-string assertions (swap `"inclusion"` → `"allowlist"`):**

- `__tests__/focus.test.ts:217` — `expect(getDefaultResolutionMode()).toBe("inclusion");` after `focusUnit`
- `__tests__/focus.test.ts:387` — same assertion in a second `focusUnit` test
- `__tests__/focus.test.ts:515` — test name `"new toolset defaults to off under focus (inclusion mode)"` and its inline `inclusion mode` comments (`:541`, `:544`); rewrite as an allowlist-mode test (the behavior — new toolset off during focus — is preserved, the mechanism is the allowlist array, not inclusion-mode fallback)
- `__tests__/focus-exit.test.ts:97` — `expect(getDefaultResolutionMode()).toBe("inclusion");`
- `__tests__/integration.test.ts:490` — test name `"focus host.api enters inclusion mode with only host.api (+ closure) on"`; retitle to `"allowlist mode"` and assert `getActiveAllowlist()` returns the closure-resolved ids instead of the mode string alone

**B2 — `__tests__/focus-exit.test.ts` needs a rewrite, not a string swap:**

The whole file's premise is that focus-enter writes `{enabled:false}`
per-toolset branch entries for non-allowlisted toolsets, and that a
mode-flip-without-re-actuation leaves them stuck. Under allowlist mode,
`focusUnit` writes **no per-toolset entries during enter** (the array is
the authority — see section 1), so the anti-pattern this file guards
against no longer applies as written. Two options, pick one in step 2:

1. **Rewrite** the test to guard the allowlist-mode equivalent: after
   `focusUnit`, `setDefaultResolutionMode(pi, "exclusion")` *without*
   `focusOff()` must still leave non-allowlisted toolsets off (the
   now-branch-persisted exclusion mode + any pre-focus entries win),
   and `focusOff()` must re-actuate to `getEffectiveDefault` to lift
   them. The regression guard stays meaningful: a future "just flip
   the mode bit" refactor would still break `focusOff`'s contract.
2. **Delete** the file and fold the regression guard into the
   `focusOff` test block in `focus.test.ts` ("a mode-flip-only exit is
   insufficient; `focusOff` must re-actuate").

Option 1 is preferred (keeps the dedicated anti-pattern doc + negative
test shape); option 2 only if the rewrite proves awkward.

**B3 — `__tests__/focus.test.ts:593` tests the deleted branch:**

`"already-enabled allowlisted toolset persists entry so it survives
inclusion-mode restore"` asserts the exact `else` branch in `focusUnit`
that persists `{enabled:true}` for already-enabled allowlisted members.
Section 1 deletes that branch ("the allowlist array replaces per-
toolset persistence for allowlist members"). **Remove this test** —
the property it guarded (already-enabled allowlist member stays on
across restore) is now covered by the allowlist array itself, asserted
by the new `focusUnit` allowlist-mode test ("live state after enter:
allowlist members on, others off") and the `actuateNewToolsets` future-
install test. Note the deletion in step 2's test delta.

### Test isolation conventions

All tests use `MockPI` + `setSettingsOverrideForTests({})` in `beforeEach`
(existing pattern). **The settings-override shape is now wrapped**:
`{ [persistKey]: { enabled: boolean } }`, **not** flattened `{ [key]: boolean }`
(the 4 Step-0 tests were written against the old flattened shape).
`MockPI.cleanRegistry()` in every `beforeEach` (the `pi-tool-masking`
registry is process-global and leaks across tests).

`__tests__/defaults.test.ts` uses **both** seams:

```ts
import {
  setSettingsOverrideForTests,
  setSettingsWriterOverrideForTests,
} from "pi-tool-masking";

beforeEach(() => {
  MockPI.cleanRegistry();
  setSettingsOverrideForTests({});
  setSettingsWriterOverrideForTests({ global: {}, project: {} });
});
afterEach(() => {
  setSettingsOverrideForTests(null);
  setSettingsWriterOverrideForTests(null);
});
```

Mirror the `setGroupsOverrideForTests` pattern from
`__tests__/picker.test.ts`. A round-trip test must clear **both**
overrides or they mask each other (library W5). **Seam tests never hit
disk** — the reader override pins to an empty map, the writer override
captures writes in memory. The only disk-touching tests are the
`show` attribution round-trips below.

**Disk round-trip tests** (attribution only — the reader override
collapses both scopes to the same map, so `(overrides global)` is
untestable through the seam; the writer seam doesn't serve reads):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
let oldCwd: string;
let oldAgentDir: string | undefined;

beforeEach(() => {
  // NO setSettingsOverrideForTests / writer override here.
  MockPI.cleanRegistry();
  tmpHome = mkdtempSync(join(tmpdir(), "tbox-defaults-"));
  oldCwd = process.cwd();
  oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmpHome, ".pi", "agent");
  process.chdir(tmpHome);
});
afterEach(() => {
  process.chdir(oldCwd);
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(tmpHome, { recursive: true, force: true });
});
```

Mirror the library's own W6/W7 disk tests. Attribution assertions: a
global-only pin → `[global]`, no override marker; a project pin
shadowing a global pin for the same `persistKey` →
`[project] (overrides global)`; `save` (bare, → project) then `show`
shows the new project pin attributed `[project]`.

**Strict-TS notes** (apply every test): `exactOptionalPropertyTypes` +
`noUncheckedIndexedAccess` are on. Indexed access into the settings
`Record<string, { enabled: boolean }>` yields `{ enabled } | undefined` —
guard with `typeof === "boolean"` on `.enabled` before use (the library
already does this in `doRestore` and `getEffectiveDefault`). Never
assign `undefined` to an optional prop explicitly; omit the key.

### New / changed tests

**`focusUnit` — allowlist mode (`__tests__/focus.test.ts`):**

- `focusUnit` calls `setDefaultResolutionMode(pi, "allowlist", ids)` with
  the forward-closure-resolved ids; `getActiveAllowlist()` returns them.
- Live state after enter: allowlist members on, others off, across all
  registered toolsets.
- Non-toolset tools preserved: seed `pi.getActiveTools()` with a name
  not owned by any toolset; assert still active after enter. This is
  satisfied by `applyToolsetEnabled`'s per-spec delta (each call only
  touches its own spec's names), not by pi-tbox logic — the test guards
  that pi-tbox keeps using the library helper rather than a hand-rolled
  `setActiveTools` rebuild.
- No per-toolset `appendEntry` during enter (the array is the authority).
- Future-install: register a toolset *after* `focusUnit`, call
  `actuateNewToolsets` → not in array → off.

**`focusOff` — restore to defaults (`__tests__/focus.test.ts`):**

- After `focusOff`, every toolset at `getEffectiveDefault`; mode is
  `exclusion`; `getActiveAllowlist()` is `undefined`.
- No-cascade: a dependent toolset's `enable()` doesn't re-enable a
  pinned-off dependency (the old item-3 guard, now via
  `applyToolsetEnabled`).
- Settings-pinned-off overrides `defaultEnabled: true`; settings-pinned-on
  overrides `defaultEnabled: false` (the 4 Step-0 tests, now passing).

**`focusRelease` — retain (`__tests__/focus.test.ts`):**

- After `focusRelease`, live state unchanged from focus-era; mode is
  `exclusion`; branch has `{enabled:true}` for allowlist members and
  `{enabled:false}` for the rest; `getActiveAllowlist()` is `undefined`.
- `/reload` (simulate via restore handler) keeps the selection.
- **No-focus guard**: calling `focusRelease` with no active focus returns
  the hint message and mutates nothing — no per-toolset entries written,
  mode unchanged, no toolset disabled. Guards against the empty-allowlist
  destructive path.

**`actuateNewToolsets` — allowlist branch (`__tests__/integration.test.ts`,
`__tests__/restore-timing.test.ts`):**

- During focus (allowlist active), a newly-registered orphan in the
  allowlist → on; not in the allowlist → off.
- Outside focus, falls back to `getEffectiveDefault` (the Step-0 tests).
- Settings-pinned respects (the 2 Step-0 integration tests).

**`/tbox defaults save` (new, `__tests__/defaults.test.ts` or
`__tests__/integration.test.ts`):**

- Live-state-diff: pin only toolsets where `live !== getEffectiveDefault`.
  Toolsets at their default are not pinned.
- During focus: captures the allowlist selection as exclusion pins
  (allowlist members on → pin `{enabled:true}` if their default is off;
  others off → pin `{enabled:false}` if their default is on).
- Scope default = project; `--global` opts into global. `--project` is
  an unknown-flag error (no such flag). Assert: bare `save` writes
  project; `save --global` writes global; `save --project` → usage
  error, no write.
- Uses `setSettingsWriterOverrideForTests` (in-memory capture); assert
  the written map shape is wrapped `{ [key]: { enabled } }`.
- Not refused during focus (no focus guard).

**`/tbox defaults show` / `clear`:**

- `show`: merged view + per-scope attribution with `(overrides global)`.
  Attribution needs the real disk round-trip pattern above (the reader
  override collapses scopes); use the reader/writer seams for the
  merged-view (no-attribution) assertions only. Empty state prints the
  no-pins message. Rows sorted by `persistKey` for deterministic output.
- `clear`: removes the block; `true`/`false` wording; preserves other
  keys. `MalformedSettingsError` surfaced as an `error`-level notify
  naming the file (catch with `instanceof`, not string-match).

**`/tbox defaults restore`:**

- Tombstones per-toolset entries (`clearAllToolsetEntries` with
  `ctx.sessionManager.getBranch()`); appends `exclusion` mode; applies
  `getEffectiveDefault` live via `applyToolsetEnabled`.
- During focus: lifts focus (allowlist no longer active after).
- Dedup: repeat restore with no intervening toggle writes zero
  tombstones.

**`/tbox restore` (bare, no `defaults`) — hint dispatch
(`__tests__/integration.test.ts`):**

- `/tbox restore` (no group named `restore`) returns the redirect hint
  containing `defaults restore`; does *not* call `describeGroup`, does
  not mutate any toolset state. Guards the N2 fix: reserved word reaches
  the hint case, not the group fallback.

## Cross-cutting notes (apply every step)

- **`.js` imports in pi-tbox:** relative imports use `.js` extensions
even for `.ts` files (`module: nodenext` +
  `allowImportingTsExtensions`). Don't "fix" them. `pi-tool-masking`
imports are package imports — no extension.
- **Strict TS:** `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`
are on (see Test isolation conventions for the guard patterns). Never
assign `undefined` to an optional prop explicitly; omit the key.
- **`MockPI.cleanRegistry()` in every `beforeEach`** — the
`pi-tool-masking` registry is process-global and leaks across tests.
Existing convention; keep it alongside the settings-override pins.
- **No real-disk reads/writes in seam tests** —
  `setSettingsOverrideForTests({})` pins the reader to an empty map;
  `setSettingsWriterOverrideForTests` captures writes in memory; `null`
restores disk. The only disk-touching tests are the `show` attribution
round-trips, which deliberately set neither seam.
- **Ponytail posture:** the `/tbox defaults` command is a thin dispatch
over already-built library functions. Resist adding a settings schema
validator, a settings cache, a path-argument overload, a per-toolset pin
subcommand (deferred), or a `/tbox list` pin-marker column (deferred).
The path resolver is the one place a ~3-line duplication is acceptable
over a new dependency — mark it `ponytail:`.
- **Focus-active guard is load-bearing for actuation only.** `all
on|off`, `<group> on|off`, `+<toolset> on|off` must be refused during
focus (AGENTS.md). `save`/`show`/`clear`/`restore` are **not**
actuation and must **not** be refused (`save` and `restore` are
deliberately coherent during focus — D1 + D4). Don't broaden the guard.

## Flatten to main & release prep (final step)

This PR develops against the local `pi-tool-masking` checkout
(`"pi-tool-masking": "file:./pi-tool-masking"` in `package.json`,
already on the branch). Before the PR merges to main, revert that to
the published `1.2.0` pin once the library is released:

1. **`package.json`** — `"pi-tool-masking": "^1.2.0"` (published),
   `npm install` to regenerate `package-lock.json`. Confirm
   `node_modules/pi-tool-masking` is no longer a symlink into
   `./pi-tool-masking`.
2. **`.gitignore`** — if the local `./pi-tool-masking` checkout isn't
already gitignored, add it so it never commits as part of the PR (it's
a dev artifact). Confirm with the maintainer whether to keep the clone
or remove it.
3. **Full-suite verification** against published `1.2.0`: `npm test` +
   `npm run typecheck` (typecheck not in CI — run it yourself).
4. **`CHANGELOG.md` `[Unreleased]`** covering: new `/tbox defaults`
   (`save`/`show`/`clear`/`restore`, project-default + `--global`);
   allowlist-mode focus rewrite (`focus off` = defaults, `focus release`
= retain); `actuateNewToolsets` allowlist consultation; `defaults` +
   `release` reserved words; `pi-tool-masking@^1.2.0` dependency bump.

## Out of scope / deferred

- **`toolsetAllowlist` settings key** — a future settings key that
  reconstructs the allowlist array on a fresh session, making saved
  focus configs resilient to post-install toolsets. The masking plan
  names this as a clean future addition; not in this release. Today's
  `save` writes exclusion pins with the accepted post-install leak.
- **Per-toolset pin** (`/tbox +web default off --global`) — the writer
  supports N=1; add when snapshot-only proves insufficient.
- **`/tbox list` pin-marker column** — UX nicety; `show` covers
  "what's pinned?" until then.
- **pi-core compact-toolset-entries op** — the tombstone-accumulation
  ceiling (now covering focus-release flushes too); a pi-core change,
  not gated on this plan.
- **Removing/deprecating `inclusion` mode** — stays in the library for
  compat; pi-tbox no longer uses it after this lands.

## Implementation order (each step leaves `npm test` green)

0. **Fix the 4 settings-pinned tests** (Step 0) + repoint the masking-plan
links (see "5. Docs + comments") + add this plan doc. Green baseline.
1. `src/registry.ts` — `actuateNewToolsets` allowlist branch + tests.
2. `src/focus.ts` — `focusUnit` allowlist-mode rewrite + `focusOff`
   `applyToolsetEnabled` swap + tests. **Includes the Step 0.5 breaking-test
   updates** (B1 mode-string swaps, B2 `focus-exit.test.ts` rewrite/delete,
   B3 remove the `:593` test) — step 2 does not leave green until those are
done, since the rewrite is what breaks them.
3. `src/focus.ts` — `focusRelease` + tests.
4. `src/defaults.ts` + `index.ts` + `src/reserved.ts` —
   `/tbox defaults save|show|clear` dispatch + handlers + tests.
5. `index.ts` — `/tbox defaults restore` dispatch + tests.
6. `AGENTS.md` + `src/focus.ts` header doc + `CHANGELOG.md`
   `[Unreleased]`.
7. **Flatten to main** — revert local link → `^1.2.0`, `.gitignore` the
   checkout, full-suite verify against published `1.2.0` (see "Flatten
to main & release prep" above).
