# Sprints: `/tbox defaults` command + `pi-tool-masking@1.2.0` adoption

Companion to [`defaults-command-design.md`](./defaults-command-design.md)
(the approved *what* / *why* / UX). This doc is the *how* / *when* — a
shippable sprint breakdown for the pi-tbox development team, plus
acceptance criteria per sprint. The upstream library plan is
[`pi-tool-masking/plans/settings-json-defaults-sprints.md`](../pi-tool-masking/plans/settings-json-defaults-sprints.md);
its Sprint 4 is the pi-tbox adoption work, which is folded in and
expanded here.

**Goal:** ship `/tbox defaults` (save / show / clear) and the
`getEffectiveDefault` call-site swaps in a single pi-tbox PR that is
developed against the **unreleased** `pi-tool-masking@1.2.0` source, then
flattened to main alongside the `1.2.0` release.

**Working posture:** develop against the local `pi-tool-masking` checkout
(see Sprint 1) so gaps in the unreleased library surface before it ships.
The local link is temporary and **must be reverted** before the PR merges
to main — the merge commit pins the published `1.2.0` instead (Sprint 7).

**Every sprint leaves `npm test` + `npm run typecheck` green.** Typecheck
is not in CI; run it yourself. Strict TS (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`) applies throughout.

---

## Sprint map

| Status | Sprint | Ships behavior? | Depends on | Repo touched |
|--------|--------|-----------------|------------|--------------|
| ✅ Done | 1 — Local link + API smoke | No (setup)  | —                                       | `pi-tbox` (`package.json`) |
| ✅ Done | 2 — Test-isolation baseline | No (hygiene) | Sprint 1                              | `pi-tbox` (`__tests__/`) |
| ✅ Done | 3 — `getEffectiveDefault` call-site swaps | Yes (restore correctness) | Sprint 2 | `pi-tbox` (`src/focus.ts`, `src/registry.ts`) |
| ☐ Todo  | 4 — Focus correctness (enter + exit) | Yes (focus contract) | Sprint 3 | `pi-tbox` (`src/focus.ts`) |
| ☐ Todo  | 5 — `/tbox defaults` command | Yes (command surface) | Sprint 3 | `pi-tbox` (`index.ts`, `src/`, `config/`) |
| ☐ Todo  | 6 — Tests for `/tbox defaults` | No (tests) | Sprint 5 | `pi-tbox` (`__tests__/`) |
| ☐ Todo  | 7 — Flatten & release prep | Yes (release) | Sprints 1–6 + `pi-tool-masking@1.2.0` published | `pi-tbox` (`package.json`, `CHANGELOG.md`) |

Sprints 1–2 are unblocking (done); 3 and 4 are the library-adoption work
(and the two focus regression fixes that gate the whole feature); 5–6 are
the command; 7 is the release merge.

---

## Sprint 1 — ✅ Complete: Local-link `pi-tool-masking` and smoke-test the API

**Goal:** make pi-tbox resolve `pi-tool-masking` to the local source
checkout (`./pi-tool-masking`) so previews run against the unreleased
`1.2.0` code, and confirm every API the design depends on is importable
and typechecks.

**What was done:**

- `package.json`: `"pi-tool-masking": "file:./pi-tool-masking"` +
  `npm install`; `node_modules/pi-tool-masking` is a symlink into the
  checkout, version `1.1.0`.
- All 8 required exports present in `pi-tool-masking/index.ts`: the 5
  public functions (`getEffectiveDefault`, `readMergedToolsetDefaults`,
  `readToolsetDefaults`, `writeToolsetDefaults`, `clearToolsetDefaults`),
  `MalformedSettingsError`, and both test seams
  (`setSettingsOverrideForTests`, `setSettingsWriterOverrideForTests`).
- `npm run typecheck` green (baseline, no new imports); `npm test` 235/235.

**Deviations from plan (necessary, library-driven):**

- Bumped pi-tbox's `@earendil-works/pi-coding-agent` devDep `^0.78.0` →
  `^0.83.0` to match the library checkout's peer pin (the library
  requires `^0.83.0`). Resolved by updating pi-tbox rather than mutating
  the library's `node_modules`.
- `__tests__/mock-pi.ts`: added `registerEntryRenderer(...)` no-op (new
  on the 0.83.0 `ExtensionAPI`) and `scopedModels` / `isProjectTrusted`
  to `createContext()` (new `ExtensionContext` fields). No test exercises
  them; they satisfy the interface.
- `__tests__/list.test.ts` "smallest-toolset-wins" test: gave the two
  toolsets disjoint tool names (`{a,b,c}` vs `{d}`) — library v1.1.0
  enforces a name-overlap guard that the old overlapping fixture
  tripped.

**Carried forward:** the `package.json` local link is **temporary** —
reverted in Sprint 7. Note this in the PR description so a reviewer
doesn't flag it.

---

## Sprint 2 — ✅ Complete: Test-isolation baseline (pin the settings reader)

**Goal:** pin the settings reader override to `{}` in every existing
test that exercises `focusOff` or `actuateNewToolsets`, so a developer's
real `~/.pi/agent/settings.json` can't flake the suite once Sprint 3
routes those call sites through `readMergedToolsetDefaults()`. Done
**before** the swaps so the baseline is green and any later failure is
attributable to the swap.

**What was done** (mirroring the `setGroupsOverrideForTests` pattern from
`__tests__/picker.test.ts`):

- `__tests__/focus.test.ts` — added `setSettingsOverrideForTests({})` to
  the existing `beforeEach` (alongside `cleanRegistry()`); created a new
  `afterEach` block (the file had none) restoring `(null)`.
- `__tests__/restore-timing.test.ts` — same: pin in `beforeEach`, new
  `afterEach` restoring `(null)`.
- `__tests__/integration.test.ts` — pin in `beforeEach`, `(null)` added
  to the file's existing `afterEach` (no new block; the file already
  uses one and follows vitest-globals style).

**Audit outcome (files correctly left untouched):**

- `__tests__/focus-exit.test.ts` — imports `focusOff` but never calls it
  (only `focusUnit`); no reach to the swapped call sites.
- `__tests__/restore.test.ts` — doesn't call `focusOff` or
  `actuateNewToolsets`. Its `doRestore` → `readMergedToolsetDefaults()`
  path is pre-existing/latent (independent of these sprints), and its
  assertions are on registry IDs / slot renders, not toolset enabled
  states — flake risk is low. Left untouched.

**Verification:** `npm test` 235/235 green with **no production code
changes** (proves the pin is non-disruptive); `npm run typecheck` green.
Every `setSettingsOverrideForTests({})` has a matching `(null)` restore
in `afterEach`.

---

## Sprint 3 — ✅ Complete: Swap call sites to `getEffectiveDefault`

**Goal:** `src/focus.ts` (`focusOff`) and `src/registry.ts`
(`actuateNewToolsets`) stop reading `spec.defaultEnabled` directly and
consult the settings tier through `getEffectiveDefault(spec, snapshot)`
instead — the core library adoption that makes a settings-pinned default
actually take effect on restore / new-toolset actuation.

**What was done:**

- Both call sites read `readMergedToolsetDefaults()` **once before the
  loop** and pass the snapshot into `getEffectiveDefault(entry.spec,
  defaultsSnapshot)`. No per-iteration disk read.
- `actuateNewToolsets` reads the snapshot **after** its `ids.length === 0`
  early-return, so empty-input calls never touch disk.
- Imports added to both files (alphabetical, package imports — no `.js`):
  `getEffectiveDefault`, `readMergedToolsetDefaults`.
- `config/settings-reader.ts` (the group store) untouched; no new files,
  no new state.
- `focusOff` JSDoc updated to reference the effective default
  ("settings tier first, then `spec.defaultEnabled`");
  `actuateNewToolsets` JSDoc left unchanged (its contract didn't change,
  only the implementation detail — ponytail: avoid unrequested prose).
- 4 new tests: 2 in `__tests__/focus.test.ts` (settings-pinned-off
  overrides `defaultEnabled: true`; pinned-on overrides
  `defaultEnabled: false`), 2 in `__tests__/integration.test.ts` (same
  pair for `actuateNewToolsets`). Both directions, both call sites.

**Equivalence (for the PR description):** `?? true` (focus) and
`!== false` (registry) both coerce `undefined` → `true` and pass
booleans through — identical to the helper's `?? true` on the tier-3
path. The swap is behavior-preserving when no settings pin is present.

**Discovered during testing — folded into Sprint 4 as Bug B:** `focusOff`'s
per-toolset `enable()`/`disable()` loop fires the library's `requires`
cascade, which can re-enable a settings-pinned-off dependency when a
dependent toolset (no settings override) gets enabled. Pre-existing (same
issue with `defaultEnabled: false` on a dependency before this sprint),
but the settings tier makes it user-visible. Documented in the design
doc and Sprint 4; **not yet implemented** — `focusOff` still uses the
`enable()`/`disable()` loop as of this sprint.

**Verification:** `npm test` 239/239 green (235 baseline + 4 new);
`npm run typecheck` green. `getEffectiveDefault` returns `boolean`, so no
new `noUncheckedIndexedAccess` guards at the call site.

---

## Sprint 4 — Focus correctness (enter + exit)

**Goal:** fix two focus bugs that the settings tier surfaces. Both are
gating regressions — shipping `/tbox defaults save --global` without
either ships a known breaking contract.

### Bug A — Focus-enter: settings-pinned-on toolset leaks into focus

The inclusion-mode revision (Sprint 3.5 of the library) means a
settings-pinned `{enabled: true}` non-allowlist toolset that is currently
off will flip itself on at the next restore while focus is active —
breaking the "only the focused unit is on" contract. The focus-enter code
in `focusUnit` persists `{enabled: false}` only for **currently-enabled**
non-allowlist toolsets. An already-off settings-pinned toolset has no
persist entry, hits the else-branch at restore, reads its settings pin
(`true`), and turns on.

**Fix A (pi-tbox-side, not a library change):** focus-enter must persist
`pi.appendEntry(persistKey, { enabled: false })` for **all** non-allowlist
toolsets, not just currently-enabled ones. This way restore always takes
the if-branch (chat-branch entry wins) for non-allowlist toolsets, where
mode and the settings tier are both ignored.

### Bug B — Focus-exit: `requires` cascade undoes a settings-pinned-off dependency

`focusOff` iterates the registry calling `entry.toolset.enable(pi)` /
`entry.toolset.disable(pi)`. Each call triggers the library's cascade:
`enable()` cascades forward through `requires`, `disable()` cascades
backward to dependents.

If toolset A (`defaultEnabled: true`) is pinned `off` via settings and
toolset B (`defaultEnabled: true`, no settings pin) requires A:

1. `focusOff` disables A (settings override) → `_disableDependents`
   also disables B (dependent cascade).
2. Loop continues to B → `getEffectiveDefault` returns `true`
   (no override) → `entry.toolset.enable(pi)` cascades forward and
   **re-enables A** via the `requires` edge.

This is pre-existing (same issue with `defaultEnabled: false` on a
dependency before Sprint 3), but the settings tier makes it user-visible
since anyone can now durably pin a toolset off.

**Fix B:** switch `focusOff` from per-toolset `enable()`/`disable()`
calls to direct state application, mirroring the pattern
`actuateNewToolsets` already uses. Build the desired active set from
effective defaults in one pass and apply it atomically via
`pi.setActiveTools()`, bypassing the cascade entirely.

### Work

#### Work A — `focusUnit` second-pass persist (focus-enter)

In `src/focus.ts` → `focusUnit`'s second pass (disable loop over
non-allowlist toolsets), drop the `isEnabled(pi)` guard on the persist
path and always `pi.appendEntry(persistKey, { enabled: false })` for
every non-allowlist toolset. Keep the `disable()` call guarded on
`isEnabled(pi)` so already-off toolsets don't emit needless events:

```ts
for (const entry of registry) {
  const id = entry.spec.id;
  if (allowlist.has(id)) continue;

  // Always persist the focus-era off entry so restore takes the
  // if-branch (chat-branch wins) for this toolset, where mode and the
  // settings tier are both ignored. Without this, a settings-pinned-on
  // non-allowlist toolset that's currently off would hit the else-branch
  // at restore and flip on under the revised inclusion floor.
  pi.appendEntry(entry.spec.persistKey, { enabled: false });

  if (entry.toolset.isEnabled(pi)) {
    entry.toolset.disable(pi);
    disabled++;
  }
}
```

**Note on intentional redundancy:** for a currently-enabled non-allowlist
  toolset, `appendEntry({ enabled: false })` is now called twice — once
  unconditionally above, once inside `disable()` (which internally calls
  `appendEntry`). Both write the same `{ enabled: false }` value, so
  last-writer-wins makes the second a harmless no-op. The unconditional
  call is a *superset* of what `disable()` writes: it covers the
  already-off case (no `disable()` call) that the fix targets. Do not
  "optimize" the unconditional call away by relying on `disable()` —
  that reintroduces the leak for already-off toolsets.

#### Work B — `focusOff` direct state application (focus-exit)

Replace the per-toolset `enable()`/`disable()` loop in `focusOff` with
direct set-building:

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

Key changes:

- No `entry.toolset.enable()` / `disable()` calls → no `requires` cascade.
- Single `pi.setActiveTools()` call → atomic state transition.
- Single event emission (instead of potentially many per-toolset emits).
- `restored` counter changes to `flipped` counting per-tool-name state
  changes (not cascade-toggle actions — but more honest since it no
  longer double-counts cascade artifacts).

**Imports needed:** none new — `getEffectiveDefault` and
`readMergedToolsetDefaults` were already added in Sprint 3. No
additional `pi-tool-masking` imports needed.

### Files

- `src/focus.ts` (both A and B)

### Acceptance criteria

**Bug A (focus-enter):**

- [ ] `focusUnit`'s second pass calls `appendEntry({ enabled: false })`
      for **every** non-allowlist toolset, regardless of current enabled
      state.
- [ ] `disable()` is still only called when the toolset is currently
      enabled (no spurious events / count inflation in the success
      message).
- [ ] New test: with a settings-pinned-on non-allowlist toolset
      (`setSettingsOverrideForTests({ "<persistKey>": true })`,
      `spec.defaultEnabled` irrelevant) that is **currently off**, enter
      focus, then simulate a restore (or call `focusOff`); assert the
      toolset stays off through the focus window and returns to its
      settings default on `focusOff`. Without the fix, the restore step
      would turn it on.

**Bug B (focus-exit):**

- [ ] `focusOff` uses direct state application (no
      `entry.toolset.enable()` / `disable()` calls). No `requires`
      cascade fires.
- [ ] New test: with a two-toolset dependency pair where the dependency
      is settings-pinned-off (`defaultEnabled: true`, override → `false`)
      and the dependent has `defaultEnabled: true` with `requires:
      ["dependency"]`, call `focusOff` and assert the dependency
      stays **off** after exit. Without the fix, the dependent's
      enable cascade re-enables the dependency.
- [ ] Single `pi.setActiveTools()` call, single
      `TOOLSET_EVENTS.changed` emit.

**Both:**

- [ ] Existing focus tests still green — re-check `disabled` count
      assertions in `__tests__/focus.test.ts`; Bug A's count semantics
      are unchanged, Bug B's `flipped` may differ from the old `restored`
      for toolsets with multiple tool names (each tool tracked
      independently vs. once per toolset).
- [ ] `npm run typecheck` green.

---

## Sprint 5 — `/tbox defaults` command surface

**Goal:** implement the `defaults` subcommand with `save`, `clear`, and
`show` actions per the approved design. This is the user-facing feature.

### Work

#### 5a — Reserve the word

Add `"defaults"` to `RESERVED_WORDS` in `src/reserved.ts` (it joins
`status`, `focus`, `all`, `list`, `group`, `on`, `off`, `edit`, `remove`,
`chars`). It cannot be a group name.

#### 5b — Dispatch in `index.ts`

Add a `case "defaults":` branch to the command switch (alongside
`list` / `status` / `all` / `group` / `chars` / `focus`). Parse the
action from `rest[1]` and the scope from the `--global` / `--project`
**flags** (not `rest` — `parseArgs` in `src/list.ts` collects `--`-prefixed
args into its `flags: Set<string>` output):

- `rest[1] === "save"` → `defaultsSave(pi, scope)`
- `rest[1] === "clear"` → `defaultsClear(scope)`
- `rest[1] === "show"` (or no action / bare `defaults`) →
  `defaultsShow()`
- anything else → usage message

**Flag handling — mirror `list`, don't diverge:** `list` (`src/list.ts`)
  both supports `--help` and rejects unknown flags (`Error: unknown flag
  --foo. See: /tbox list --help.`). Do the same here: a `KNOWN_DEFAULTS_
  FLAGS = new Set(["global", "project", "help"])` allowlist, `--help`
  prints a `DEFAULTS_HELP` block before any other check, and any `--`-flag
  not in the set → `Error: unknown flag --foo. See: /tbox defaults --help.`
  This is design-faithful (the design says "unsupported → usage message,
  no write") and prevents typo-silent-no-op bugs (e.g. `--gloal` silently
  resolving to no scope instead of erroring). The cost is a few lines
  that parallel `list`'s pattern — ponytail-clean because the pattern
  already exists in this repo, not a new abstraction.

**Scope resolution helper** (shared by `save` / `clear`):

```ts
function resolveScope(flags: Set<string>): "global" | "project" | null {
  const g = flags.has("global");
  const p = flags.has("project");
  return g && !p ? "global" : p && !g ? "project" : null;
}
```

`null` (missing, or both, or unsupported flags) → usage message, no
write. `show` ignores scope entirely (shows both).

#### 5c — `save` handler

New module `src/defaults.ts` (or inline in `index.ts` if small — prefer a
module to keep `index.ts` thin, matching `src/focus.ts` / `src/groups.ts`
convention):

1. **Refuse while focus is active** (design item #3). Reuse the same
   focus-active check the actuation commands use; if focus is on, return
   the focus-active message and **do not write**. (`show` and `clear`
   are not refused — read/remove don't snapshot live state.)
2. Read `ctx.sessionManager.getBranch()` once. Filter to entries whose
   `customType` matches a registered toolset's `persistKey` and whose
   `data.enabled` is a `boolean`. **Last-writer-wins per `persistKey`**
   (a toolset toggled twice in the branch keeps only the final value).
   Build the flat `{ [persistKey]: boolean }` map.
3. Call `writeToolsetDefaults(map, scope)`.
4. **Output:** `Saved <N> toolset defaults to <path> (<scope>).` where
   `<path>` is the resolved **settings file path** (not the directory) for
   the scope. Reuse the library's path resolution if exported; otherwise
   compute it the same way the library does — **global →
   `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/settings.json`, project →
   `<process.cwd()/.pi>/settings.json`** (the `settings.json` filename is
   load-bearing: the directories alone are not the file path, and getting
   this wrong shows the wrong path in the success message). **Ponytail
   ceiling:** if the path isn't exported (`settingsPath` is currently
   private in the library), duplicate the ~3-line resolver rather than
   add a dependency — note it as `ponytail:` with the upgrade path
   "promote `settingsPath` in the library."

The handler needs `ctx` (for `sessionManager`) and `pi` (for the
focus-active check), so it takes the same `(pi, ctx, scope)` shape the
other dispatch arms pass through.

#### 5d — `clear` handler

Call `clearToolsetDefaults(scope)`. Returns `true`/`false`. Output
follows the `removeGroup` success/failure ternary, naming the path and
scope:

- `true` → `Cleared toolset defaults from <path> (<scope>).`
- `false` → `No toolsetDefaults block in <path> (<scope>) — nothing to clear.`

If the library throws `MalformedSettingsError` (malformed-file guard),
surface a readable error via `ctx.ui.notify(..., "error")` rather than
letting it crash the command — the user needs to know which file to fix.
Catch with `instanceof MalformedSettingsError` (exported by the library)
and avoid string-matching `message`. `save` shares this guard behavior.

#### 5e — `show` handler

Read `readMergedToolsetDefaults()` (the merged view restore uses) plus
`readToolsetDefaults("global")` and `readToolsetDefaults("project")`
(per-scope raw blocks) for attribution. One row per pin in the merged
view:

```
<persistKey>    enabled|disabled  [global|project]  (overrides global)?
```

- The `[scope]` tag comes from whichever raw block contains the
  `persistKey` (project wins on conflict per the shallow per-entry merge).
- Append `(overrides global)` when a project pin shadows a global pin
  for the same `persistKey`.
- Empty merged map → `No toolset defaults pinned in settings. Every
  toolset uses its packaged default (spec.defaultEnabled ?? true).`

Sort rows by `persistKey` for deterministic output (tests rely on it).

### Files

- `src/reserved.ts` (add word)
- `index.ts` (dispatch branch)
- `src/defaults.ts` (new — handlers + `KNOWN_DEFAULTS_FLAGS` /
  `DEFAULTS_HELP` constants) **or** inline in `index.ts`
- `__tests__/reserved.test.ts` (add `"defaults"` to the reserved-word
  assertion, if not already parameterized)

### Acceptance criteria

- [ ] `defaults` is reserved (rejected as a group name with the existing
      reserved-word message); `__tests__/reserved.test.ts` updated.
- [ ] `/tbox defaults` (bare) and `/tbox defaults show` produce the same
      annotated listing; empty state prints the no-pins message.
- [ ] `/tbox defaults save --global` and `--project` each snapshot live
      branch toggles to the correct scope's file; missing/both/other
      flags → usage, no write.
- [ ] `/tbox defaults --help` (and `defaults save --help`, etc.) prints a
      help block before any other check; unknown `--` flags (e.g.
      `--foo`, `--gloal`) → `Error: unknown flag --foo. See: /tbox
      defaults --help.`, no write — mirroring `list`'s convention.
- [ ] `save` output names the scope, the count of entries written, and
      the file path.
- [ ] `save` is **refused while focus is active** with the focus-active
      message and writes nothing; `show` and `clear` work during focus.
- [ ] `save` snapshots only toolsets with a chat-branch entry whose
      `data.enabled` is boolean; toolsets at their packaged default are
      not pinned. Last-writer-wins per `persistKey` when a toolset was
      toggled multiple times.
- [ ] `/tbox defaults clear --global|--project` removes the
      `toolsetDefaults` block; `true` → cleared message, `false` →
      nothing-to-clear message.
- [ ] `clear`/`save` surface `MalformedSettingsError` as a readable
      `error`-level notify naming the file, without crashing.
- [ ] `show` annotates each pin with its source scope and marks
      project-overrides-global rows.
- [ ] `npm test` + `npm run typecheck` green (command logic lands here;
      the dedicated test suite is Sprint 6, but at least one happy-path
      test per action lands with the code so Sprint 5 is green on its
      own).

---

## Sprint 6 — Test suite for `/tbox defaults`

**Goal:** full coverage of the command using both test seams, plus a
real disk round-trip for the `show` attribution paths that the seams
can't express. Per the design's "Test isolation" section.

### Work

New file `__tests__/defaults.test.ts`. Use **both** seams where
appropriate:

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
`__tests__/picker.test.ts`. Remember: a round-trip test must clear
**both** overrides or they mask each other (library W5).

**Seam-based tests** (deterministic, no disk):

- `show` empty state; `show` with a seeded merged map.
- `save` writes the flat map via the writer seam (assert the captured
  `global` / `project` state); count + scope routing.
- `save` refused during focus (seed focus-active state, assert no write
  captured).
- `save` usage errors for missing/both flags and for unknown `--` flags
  (assert no write captured); `--help` prints the help block.
- `clear` `true`/`false` via the writer seam; usage errors for bad or
  unknown flags.
- `save` last-writer-wins: append two branch entries for one
  `persistKey` with different `enabled`, assert only the final value is
  written.

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

Mirror the library's own W6/W7 disk tests. Attribution assertions:

- A global-only pin → `[global]`, no override marker.
- A project pin shadowing a global pin for the same `persistKey` →
  `[project] (overrides global)`.
- `save --project` then `show` shows the new project pin attributed
  `[project]`.

### Files

- `__tests__/defaults.test.ts` (new)

### Acceptance criteria

- [ ] Every seam-based test clears **both** overrides in `afterEach`
      (reader + writer), or neither is set in the test.
- [ ] `show` empty-state and seeded-merged-map tests pass through the
      reader seam.
- [ ] `save`/`clear` assertions go through the writer seam (in-memory
      capture); no `save`/`clear` test in the seam block hits disk.
- [ ] `save` focus-active refusal test asserts **zero** captured writes.
- [ ] `save` last-writer-wins test asserts the final branch value only.
- [ ] Attribution tests use the real disk round-trip (no reader/writer
      override), `process.chdir` + `PI_CODING_AGENT_DIR` into a temp
      dir, cleaned in `afterEach`. Project-overrides-global annotation
      is asserted.
- [ ] `npm test` green run **in a clean environment** (no
      `~/.pi/agent/settings.json` leakage) — spot-check by running with
      a temporary `HOME`.
- [ ] `npm run typecheck` green. `getBranch()` entry access uses
      `typeof === "boolean"` guards under `noUncheckedIndexedAccess`.

---

## Sprint 7 — Flatten to main & release prep

**Goal:** merge the feature branch into main against the **published**
`pi-tool-masking@1.2.0`, reverting the temporary local link. This sprint
gates on `1.2.0` actually being released (upstream Sprint 5). Do not
merge before the library is on npm.

### Work

1. **Revert `package.json`** — change the dependency back to a published
   version range pinning `1.2.0`:

   ```jsonc
   "dependencies": {
     "pi-tool-masking": "^1.2.0"
   }
   ```

   Run `npm install` to regenerate `package-lock.json` against the
   published package. Confirm
   `node_modules/pi-tool-masking` is **no longer** a symlink into
   `./pi-tool-masking`.
2. **Decide the fate of the local checkout.** The `./pi-tool-masking`
   directory in this repo is a working clone, not a submodule. If it
   isn't already gitignored, add it to `.gitignore` so it never gets
   committed as part of the PR (it's a dev artifact). Confirm with the
   maintainer whether to keep the clone around or remove it.
3. **Full-suite verification** against the published `1.2.0`:
   `npm test` + `npm run typecheck`. Re-run the Sprint 6 clean-env
   spot-check.
4. **CHANGELOG entry** in `pi-tbox/CHANGELOG.md` under the appropriate
   `[Unreleased]` / version section:
   - New `/tbox defaults` command (`save` / `show` / `clear`, `--global`
     / `--project`), snapshotting live toggles into
     `settings.json` `toolsetDefaults`.
   - `getEffectiveDefault` adoption in `focusOff` and
     `actuateNewToolsets` (settings tier now honored on restore /
     new-toolset actuation).
   - Focus-enter fix: persists `{enabled:false}` for all non-allowlist
     toolsets so a settings-pinned-on toolset can't leak on during
     focus.
   - `defaults` added to the reserved-word list.
   - Dependency bump: `pi-tool-masking@^1.2.0`.
5. **PR description checklist:** note the `?? true` vs `!== false`
   equivalence (Sprint 3), the focus regression that the Sprint 4 fix
   closes, and that the local link has been reverted.

### Files

- `package.json` (revert link → `^1.2.0`)
- `package-lock.json` (regenerated)
- `.gitignore` (if the local checkout isn't already ignored)
- `CHANGELOG.md`

### Acceptance criteria

- [ ] `package.json` pins `pi-tool-masking@^1.2.0` (published), **not**
      `file:./pi-tool-masking`.
- [ ] `node_modules/pi-tool-masking` is the published package, not a
      symlink into the local clone.
- [ ] Full `npm test` + `npm run typecheck` green against published
      `1.2.0`.
- [ ] CHANGELOG entry covers the command, both call-site swaps, the
      focus-enter fix, the reserved word, and the dependency bump.
- [ ] The temporary local-link edit is gone from the merge commit's
      `package.json` diff (only the `^1.2.0` pin remains).
- [ ] No `pi-tool-masking/` working clone is committed to the repo.

---

## Cross-cutting notes (apply every sprint)

- **Strict TS:** `exactOptionalPropertyTypes` +
  `noUncheckedIndexedAccess` are on. Indexed access into the
  `Record<string, boolean>` snapshot/branch yields `T | undefined` —
  guard with `typeof === "boolean"` before use (the library already does
  this in `doRestore` and `getEffectiveDefault`). Never assign
  `undefined` to an optional prop explicitly; omit the key.
- **`.js` imports in pi-tbox:** relative imports use `.js` extensions
  even for `.ts` files (`module: nodenext` + `allowImportingTsExtensions`).
  Don't "fix" them. `pi-tool-masking` imports are package imports — no
  extension.
- **`MockPI.cleanRegistry()` in every `beforeEach`** — the
  `pi-tool-masking` registry is process-global and leaks across tests.
  Existing convention; keep it alongside the new settings-override pins.
- **No real-disk reads/writes in seam tests** —
  `setSettingsOverrideForTests({})` pins the reader to an empty map;
  `setSettingsWriterOverrideForTests` captures writes in memory; `null`
  restores disk. The only disk-touching tests are the Sprint 6
  attribution round-trips, which deliberately set neither seam.
- **Ponytail posture:** the command is a thin dispatch over four
  already-built library functions. Resist adding a settings schema
  validator, a settings cache, a path-argument overload, a per-toolset
  pin subcommand (deferred per design), or a `/tbox list` pin-marker
  column (deferred per design). The path resolver is the one place a
  ~3-line duplication is acceptable over a new dependency — mark it
  `ponytail:` if you take that route.
- **Focus-active guard is load-bearing.** `save` must be refused during
  focus (design item #3); `show`/`clear` must not be. Don't broaden the
  guard to all three.

## Deferred / out of scope (tracked, not in this plan)

From the design's "Out of scope" section — do **not** pull these in:

- Per-toolset pin (`/tbox +web default off --global`).
- `/tbox list` pin-marker column.
- Cross-scope propagation ("copy my global pins into project").
- Downstream cleanup (portal `browserToggle.defaultEnabled` / host
  `apiToggle.defaultEnabled` deletion) — separate issues, tracked in the
  upstream Sprint 5.
