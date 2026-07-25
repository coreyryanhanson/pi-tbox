# `pi-tbox` — Sprint Plan & Acceptance Criteria

> **Source of truth:** [`manager-mvp.md`](./manager-mvp.md) (approved design).
> **Library:** [`pi-tool-masking`](../pi-tool-masking/) — frozen v1 API
> (see [`design.md`](../pi-tool-masking/docs/design.md) §5, `index.ts`).
> **References:** `~/pi-browser/packages/pi-lean-portal` and `pi-lean-search`
> for real extension-authoring patterns (factory shape, `ctx.ui` capture,
> `TOOLSET_EVENTS` listeners, status-slot glyph, the §6 capture-ordering fix).
>
> **Repo shape:** `pi-tbox` is a **single package, not a monorepo.** It is a
> real pi extension that depends on `pi-tool-masking` as a hard
> `dependency`. It registers the `/tbox` command, one status-bar slot (`tbox`),
> and no tools of its own.

This doc divides the MVP from `manager-mvp.md` into eight sprints (0–7),
each independently shippable and testable. Every sprint lists **work**,
**acceptance criteria** (checkboxes a reviewer can run), and **tests**
(the concrete cases that must exist and pass before the sprint is done).

---

## Conventions (read once, apply to every sprint)

### Architecture rules (from `manager-mvp.md`)

- **Tbox goes through the frozen library API only.** Imports from
  `pi-tool-masking`: `defineToolset`, `TOOLSET_EVENTS`,
  `getRegisteredToolsets`, `setDefaultResolutionMode`,
  `getDefaultResolutionMode`, and the types `ToolsetSpec`, `RegistryEntry`,
  `ToolsetChangedEvent`, `DefaultResolutionMode`. **Never** touch
  `globalThis.__piToolMaskingRegistry` or `__piToolMaskingModuleState`
  directly — that boundary is load-bearing (`design.md` §6.1).
- **Tbox's domain is extension tools only.** The canonical discriminator
  is `t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk"`
  (`extensions.md` §"pi.getAllTools()"). `builtin` tools are excluded
  from the tbox registry entirely — protected by source-based guards
  in toggle/focus/all (never toggled, grouped, focused, or offered
  in the picker). `sdk`
  tools → **out of tbox's domain entirely** (read-only rows in `--flat`,
  never registered into a toolset, never counted in the status slot's
  excluded count).
- **Curation (`requires` closure, group resolution) is tbox-owned.** The
  library does not export a graph helper; the forward/reverse walks live
  privately in `_enableToolset`/`_disableDependents`. Tbox re-implements
  them in **one shared helper** (`requires-graph.ts`), never inlined per
  command (`manager-mvp.md` §2).
- **`ctx.ui` capture follows the §6 pattern.** Capture from
  `session_start` (and `session_tree`), call `render()` at the **end** of
  the capture handler so the first paint lands on post-restore state
  regardless of handler registration order. Clear the slot on
  `session_shutdown`. This is verified-correct in `pi-lean-portal` and
  `pi-lean-search` — mirror their shape.
- **No unrequested abstractions.** No interface-with-one-impl, no factory
  for one product, no config-for-a-constant. Tbox has a single
  addressability model (all toolsets are togglable as units); do not
  add `atomic`/`visible` siblings.

### Repo layout (target, not prescriptive)

```
pi-tbox/
  package.json            # name: "pi-tbox", type: "module", "pi-package" keyword,
                          #   pi: { extensions: ["./index.ts"] }
                          #   dependencies: { "pi-tool-masking": "^1.0.0", ... }
  index.ts                # default factory: registerCommand("tbox"), slot wiring,
                          #   auto-registration of per-source orphan toolsets
  src/
    registry.ts           # auto-register per-source orphan toolsets from getAllTools()
    requires-graph.ts     # forward/reverse requires walks (one shared helper)
    groups.ts             # user group config read/write + resolution to units
    list.ts               # /tbox list (grouped/flat, filters, smallest-toolset-wins)
    toggle.ts             # /tbox toggle <tool>, /tbox all on|off, guards
    focus.ts              # /tbox focus <unit> / focus off (inclusion mode + re-actuation)
    chars.ts              # /tbox chars (serialized char count from getAllTools defs)
    status-slot.ts        # the 4-state tbox slot: render(), excluded-count, listeners
    reserved.ts           # reserved-wordlist + collision disambiguation
  config/
    settings-reader.ts    # local merged-settings reader (groups live under a tbox key)
  __tests__/
    mock-pi.ts            # tbox's MockPI (extended — see Testing below)
    …one test file per src module + integration.test.ts
```

> Files are a guide, not a contract. Fewer files is fine where a module is
> small. The **one hard rule** is `requires-graph.ts` being a single
> shared helper for the closure walks — do not inline them per command.

### Testing strategy

**Why `pi-tool-masking/` is the test repo.** The library ships a
`MockPI` (`pi-tool-masking/__tests__/mock-pi.ts`) that implements the
masking-relevant `ExtensionAPI` subset: `setActiveTools`/`getActiveTools`/
`getAllTools` (returns `ToolInfo[]`), `registerTool`, `appendEntry`,
`on`, a real `EventEmitter` as `events`, and `sessionManager.getBranch()`.
It is the harness the library's own 123 tests run against. Tbox reuses the
**pattern** but needs a **richer mock** — so tbox ships its own
`__tests__/mock-pi.ts` derived from the library's, extended with the
surfaces tbox exercises that the library's mock lacks:

- `registerCommand(name, opts)` — record commands, dispatch a synthetic
  `/tbox …` call into the registered handler (so tests can drive the
  command surface end-to-end without a real pi runner).
- `ui.setStatus(slot, text)` + `ui.theme.fg(color, text)` — record the
  last status string per slot so slot-state assertions are exact. `theme`
  can be a passthrough that wraps text in markers (e.g. `<accent>…</accent>`)
  so color is assertable without a real terminal.
- `ui.custom<T>(factory)` — the picker (Sprint 4) mounts a tbox-owned
  `GroupEditorComponent` through this; the mock instantiates the
  component from the factory, drains a queued key sequence through
  `handleInput`, and returns the captured `done()` result. A `keyFor(action)`
  helper maps logical actions (`down`/`up`/`confirm`/`save`/`cancel`/
  `ctrl+a`/`ctrl+x`) to real key bytes, and tests assert on the
  component's `render()` output rather than a synthetic options array.
- `getAllTools()` returning tools with **the three** `sourceInfo.source`
  flavors the MVP cares about: `builtin`, `sdk`, and extension tools —
  some inside plugin-declared toolsets, some orphaned — so the
  auto-registration and list logic is exercised against a realistic
  population.
- A `defineFakeToolset(spec)` helper on the mock that registers a
  toolset directly into the shared `globalThis` registry (simulating a
  sibling extension like `portal.web`/`portal.learn`) without going
  through the real `defineToolset` — so tbox's tests can stand up a
  multi-extension registry in one line and assert tbox reads it through
  `getRegisteredToolsets()` only. **Test-only, not a production
  pattern** — this pokes library internals so test fixtures can skip
  registering restore handlers on the mock pi; the cross-cutting
  `rg "__piToolMasking" src/` check excludes `__tests__/`, so it never
  leaks into shipped code.

**Reuse, don't duplicate, the library's invariants.** The peer-composition
invariant and `requires` cascade have exactly one test home
(`pi-tool-masking`). Tbox's tests assert **tbox's behavior on top of**
those invariants — e.g. "a group containing `{portal.learn}` auto-checks
`portal.web` at curation" — not the cascade itself. Do not re-test the
library. (`design.md` §12, `implementation-plan.md` cross-cutting
acceptance.)

**Every sprint ships runnable tests.** `npm test` (`vitest run`) must be
green at the end of each sprint. No sprint is "done" with failing or
missing tests. Non-trivial logic (parsing, closure walks, char
serialization, the focus re-actuation sequence) also leaves a tiny
self-check (`__main__`/`demo` or one `test_*.ts`) — but the real coverage
is the vitest suite.

**Manual verification is noted where automated coverage is impractical**
(e.g. true `/reload` of a running pi process). Those rows say "manual" and
list the exact steps; they are acceptance criteria but not automated
tests.

### The `pi-tool-masking` dev dependency while unpublished

While `pi-tool-masking@1.0.0` is not yet on npm, tbox depends on it via
`"pi-tool-masking": "file:../pi-tool-masking"` (mirrors how
`pi-lean-portal` wires it today). Sprint 7 covers swapping to `^1.0.0`
once the library publishes.

---

## Sprint 0 — ✅ Done: Scaffolding, auto-registration, slot skeleton

Shipped:

- **Project init** — `package.json` (`name: "pi-tbox"`, `type: "module"`,
  `keywords: ["pi-package", "pi-extension"]`,
  `pi: { extensions: ["./index.ts"] }`,
  `dependencies: { "pi-tool-masking": "file:../pi-tool-masking", ... }`,
  peer deps matching portal), `tsconfig.json` (strict library flags),
  `vitest.config.ts`.
- **`__tests__/mock-pi.ts`** — extended MockPI: `registerCommand` records
  - dispatches, `ui.setStatus` records per-slot, `theme.fg` wraps with
  markers, `defineFakeToolset` lands in `getRegisteredToolsets()`.
- **`src/registry.ts`** — `autoRegisterBuiltinAndOrphans(pi)`: scans
  `getAllTools()`, registers per-source orphan toolsets for
  extension tools not claimed by any toolset, **skips sdk and builtin
  entirely**. Builtins are never registered — they are protected by
  source-based guards in toggle/focus/all. Run
  from `session_start` + `session_tree`; idempotent (library is
  idempotent-by-content for an unchanged spec).
  **Note:** Sprint 0 shipped a single catch-all `tbox.tool` toolset.
  Sprint 3.5 supersedes this with per-source registration
  (`tbox.tool@<source>`); the idempotent re-registration scaffold
  here is reused, only the grouping key changes.
- **`src/status-slot.ts`** — pristine `○ tbox` (dim) render. `ctx.ui`
  capture in `session_start` + `session_tree` with `render()` at the
  **end** of the capture handler (§6 fix); `TOOLSET_EVENTS.changed`/
  `restored` listeners re-render; `session_shutdown` clears the slot.
- **`index.ts`** — factory registers `/tbox` (stub notify), wires the
  slot, calls auto-registration from `session_start`.

Tests shipped (green): `mock-pi`, `registry`, `status-slot`, `load`.

---

## Sprint 1 — ✅ Done: `/tbox list`, `/tbox`, `/tbox status`

Shipped (`src/list.ts`):

- **`--grouped` (default)** — smallest-toolset-wins: each tool appears
  once under its smallest (by `names.size`) containing toolset; all
  toolset members appear as individual rows; orphans →
  their `tbox.tool@<source>` toolset (per Sprint 3.5; Sprint 1
  shipped against a catch-all `tbox.tool`, refined by 3.5).
- **`--flat`** — every tool as a row; `sdk`-source tools present and
  marked read-only/host-managed (no toggle affordance).
- **Filters** — `--active` / `--inactive` in both views, combinable
  (`--flat --inactive`). Active iff `getActiveTools().includes(name)`.
- **Bare `/tbox`** — slot mirror + brief subcommand help.
- **`/tbox status`** — aggregator: toolsets (id, enabled, member count,
  members); groups/focus/chars lines default to "none"/"off"/omitted
  until their sprints ship.

Tests shipped (green): `list`, `command`.

---

## Sprint 2 — ✅ Done: `/tbox toggle`, `/tbox all`, guards

Shipped (`src/toggle.ts`, `src/status-slot.ts`):

- **`/tbox toggle <tool>`** — exact→prefix resolution; ambiguous prefix
  errors listing candidates; `sdk` tool always refused; orphan →
  its `tbox.tool@<source>` toolset (per Sprint 3.5; Sprint 2 shipped
  against a catch-all `tbox.tool`, refined by 3.5); re-running
  toggles back.
- **Guards (unconditional — tbox has one mode):** builtins are
  refused via source check
  ("builtins are protected. tbox does not manage pi's core tools.");
  `sdk` tools are refused ("SDK tools are host-managed and cannot be
  toggled"). There is no escape hatch — builtin protection
  is permanent, sdk tools are always outside tbox's domain.
- **`/tbox all on`** — enable every registered toolset. **`/tbox all off`**
  — disable every non-builtin toolset (builtins are outside the
  registry and never registered, so they are naturally skipped);
  `sdk` untouched.
- **Status slot count state** — `● tbox n` (blue) where
  `n` = non-builtin, non-sdk tools minus `getActiveTools()`; pristine
  `○ tbox` when `n === 0`. `changed`/`restored` listeners re-render.

Tests shipped (green): `toggle`, `all`, `status-slot` (count + event
re-render).

---

## Sprint 3 — ✅ Done: User groups: storage, on/off, reserved words, closure helper

Shipped (`config/settings-reader.ts`, `src/groups.ts`, `src/reserved.ts`,
`src/requires-graph.ts`, `index.ts`):

- **`config/settings-reader.ts`** — tbox's own merged-settings reader
  (library exports none, `design.md` §5.1). Tbox-owned keys live under
  one `tbox` object: `tbox.groups` (group → `{ toolsets: string[] }`).
  A group is whole-toolset units only — there is no per-tool field
  (pi-tool-masking has no per-tool persist primitive, so a `tools[]`
  field would collapse to `toolsets[]` at actuation and mislead readers).
  Reads merge global + project (project wins); a test-injectable
  override avoids fs mocks. **Storage-shape decision (recorded):**
  groups live under `tbox.groups` in merged settings — a dedicated
  `~/.pi/agent/pi-tbox/groups.json` was rejected (one config location is
  simpler, matches the MVP recommendation). The write path lands in
  Sprint 4's picker-save.
- **`src/groups.ts`** — `/tbox <group> on` enables each toolset in the
  group (library cascade pulls deps on). `/tbox <group> off` disables
  each member; the moved set is computed by **diffing `getActiveTools()`
  before vs. after** (not `reverseClosure` — reflects reality incl.
  cross-extension companions the static graph wouldn't predict);
  cascaded non-members are reported in the output. Drift caveat line
  shipped on every actuation.
- **`src/reserved.ts`** — reserved wordlist (`toggle`, `status`,
  `focus`, `all`, `list`, `chars`, `group`, `on`, `off`). `/tbox <name>
  on|off` is the group shorthand unless `<name>` is reserved; a
  reserved-named group is reachable only via `/tbox group <name> on`,
  and the bare form errors with a pointer to the explicit form.
- **`/tbox group <name> [on|off]`** — explicit group form (unambiguous
  path + reserved-name escape). `/tbox group <name> edit` opens the
  picker (Sprint 4).
- **`src/requires-graph.ts`** — the one shared helper for the
  both-direction `requires` closure over `getRegisteredToolsets()`:
  `forwardClosure(ids)` (ids + transitive `requires` targets) and
  `reverseClosure(ids)` (ids + everything that transitively `requires`
  one of them). Built from registry specs only (no `globalThis`). Cycle
  detection surfaces the cycle path at curation time rather than letting
  the library throw mid-actuation; forward-references (a `requires` id
  absent from the registry) are skipped, not fatal.

Tests shipped (green): `groups`, `reserved`, `requires-graph`.

---

## Decision record — builtins are out of tbox's management scope

**The invariant:** *Builtins are never the **subject** of a group,
focus, or toggle operation; they are always **preserved**.* tbox
builtins are excluded from the registry entirely. Because builtins
never appear in `getRegisteredToolsets()`, they are invisible to
both the enable and disable passes — inclusion-mode focus can never
disable them, and no explicit seeding or skip logic is needed.

The taxonomy of what tbox manages:

- **Registered toolsets** (user-declared via `defineToolset` + tbox
  orphan toolsets `tbox.tool@<source>`) — these are tbox's domain.
- **Builtin tools** (`sourceInfo.source === "builtin"`) — protected
  by source-based checks in `toggleTool`/`focusUnit`/`toggleAll`,
  never in any registered toolset.
- **SDK tools** (`sourceInfo.source === "sdk"`) — out of tbox's
  domain entirely, never registered, never toggled.

This eliminates the need for the old approach where tbox auto-registered
`pi.builtin` as a toolset and explicitly guarded it. The library stays
source-agnostic; the taxonomy is each consumer's call.

### The three resulting rules

1. **Groups never contain builtins.** A group containing a builtin name
   means `group off` disables `pi.builtin` — the exact footgun Sprint 2's
   guards exist to prevent, smuggled in through the back door. There is
   no useful "group of builtins": they're always-on by nature, so
   grouping them is meaningless for `on` and dangerous for `off`.
2. **Focus never targets builtins.** `/tbox focus pi.builtin` errors on
   the reserved id `pi.builtin`, which can never be a user group or toolset
   name. Focus on a builtin tool name now falls through to the generic
   "No toolset or group matching" error (since builtins are not in any
   registered toolset).
3. **Builtins are never toggleable and never groupable rows.**
   `/tbox toggle <builtin>` is refused via source check in `toggleTool`.
   Builtins never appear in the picker. There is no escape hatch —
   builtins are always-on by nature, and a group that can mass-disable
   them is the rule-1 footgun through the back door.

---

## Sprint 3.5 — ✅ Done: Per-source orphan toolsets

Closes the focus-granularity asymmetry between plugins that call
`defineToolset` (e.g. `portal.web`) and plugins that only register tools
(e.g. pi-lens): a catch-all `tbox.tool` made per-plugin focus
impossible, so each unclaimed-source plugin becomes its own focusable
unit. Sprint 0's idempotent re-registration scaffold is reused; only the
grouping key changes.

Shipped (`src/registry.ts`):

- **Orphan branch of `autoRegisterBuiltinAndOrphans`** — one toolset
  per distinct unclaimed `sourceInfo.source` among extension tools,
  instead of one catch-all:
  - **Id:** `tbox.tool@<source>` (`<source>` is the extension source
    metadata from `sourceInfo.source`).
  - **`names`:** all unclaimed extension tools sharing that source.
  - **`label`:** derived from `<source>` (the plugin id). `ToolInfo`
    has no `label` field, so this is derivation, not pass-through.
  - **`description`:** passed through from the tool **only when the
    source contributes exactly one orphaned tool** (the common
    single-tool-plugin case gets a real description for free). When
    the source contributes multiple tools, `description` is omitted
    (`ToolsetSpec.description` is optional) — the grouped view already
    shows members, and misrepresenting one tool's description as the
    group's would mislabel the others.
  - **`defaultEnabled: true`,
    `persistKey: toolset-state:tbox.tool@<source>`** — per the
    catch-all plan.
  - **Skips sdk entirely** — unchanged; sdk tools are never registered
    into any toolset (out of tbox's domain).
- **Idempotence preserved** — the library is idempotent-by-content, so
  re-registration on `/reload` is a no-op for unchanged sources. A
  source that gains/loses a tool between reloads updates its `names`
  set; a source that disappears leaves a stale entry (a harmless no-op
  at restore — Sprint 7's restore-safety pass confirms).
- **No change to sdk handling** — sdk tools are still never
  registered, never toggled, never counted in the slot, and
  appear as read-only rows in `--flat`.

Tests shipped (green): `registry-per-source` (multi-source population,
focus granularity, idempotence, single-tool description pass-through).

---

## Sprint 4 — ✅ Done: Group editing picker UX

Shipped (`src/group-editor.ts`, `src/groups.ts`, `index.ts`,
`__tests__/mock-pi.ts`):

- **`GroupEditorComponent`** — a windowed, searchable, keyboard-driven
  TUI component mounted via `ctx.ui.custom<T>(factory)` on
  `/tbox group <name> edit`. It mirrors pi's internal
  `ScopedModelsSelectorComponent` shape using only **public**
  `@earendil-works/pi-tui` primitives (`Container`, `Input`, `Text`,
  `fuzzyFilter`, `getKeybindings`, `truncateToWidth`) — no reach into
  pi's interactive-mode dist path. Requires interactive (`tui`) mode;
  a non-tui session returns "Group editing requires interactive mode."
  rather than mounting the component.
- **Single granularity: toolsets only.** One row per registered toolset
  `(N tools)`. Orphans appear as their `tbox.tool@<source>` row
  (Sprint 3.5). **No member rows** — pi-tool-masking has no per-tool
  persist primitive, so per-tool rows would collapse to the containing
  toolset at actuation (theater). Builtins are not in the registry
  and never appear in the picker (decision record: builtins are out of
  tbox's management scope).
- **`requires` closure auto-maintained** via `src/requires-graph.ts`
  (Sprint 3). Checking a toolset forward-closes its deps; unchecking
  reverse-closes dependents. Cues render **inline in the component
  footer** (`auto-checked: portal.web (required by selection)` /
  `auto-unchecked: portal.learn (they depend on portal.web)`), fading
  on the next keypress — replacing the old `ui.notify` calls.
- **Keyboard shortcuts** (all remappable via user keybindings through
  `getKeybindings()`): `↑`/`↓` navigate, **Enter** toggle the focused
  row, **Ctrl+A** enable all (filtered set if search active),
  **Ctrl+X** clear all (filtered set if search active), **Ctrl+S**
  save to config, **Esc**/**Ctrl+C** cancel (clears search first if a
  filter is active, scoped-models' exact behavior).
- **Windowed list** — `maxVisible = 8`, scroll keeps the selection
  centered (math copied from scoped-models' `updateList`). A search
  `Input` at the top narrows items by `fuzzyFilter` on the unit label.
  The footer shows keybinding hints + `N/M enabled` + an `(unsaved)`
  dirty indicator.
- **Save path** — `Ctrl+S` calls `writeGroupToConfig(name, { toolsets })`
  (Sprint 3's storage path), flips the dirty flag off. The group is
  immediately actuate-able via `/tbox <name> on|off`. Re-opening `edit`
  reflects the saved checks.
- **`toggleToolsetUnit`** returns `{ cue: string }` so the component can
  render the cue inline; the `PickerUI` interface is removed and
  `editGroup` takes the full `ctx` (for `ctx.ui.custom` + `ctx.mode`).
  `toggleToolUnit`, `effectiveToolsetIds`, and `autoCheckedToolsetIds`
  are deleted (no tool rows / no `checkedTools` → no callers).
- **`emitMemberEvents` is not used** — membership derives from
  `getRegisteredToolsets()` and refreshes on
  `TOOLSET_EVENTS.changed`/`restored` (recorded deferral, code comment).
- **MockPI** gained a `ui.custom` stub with `setCustomKeySequence` +
  `keyFor(action)` so tests drive the component via key sequences and
  assert on `render()` output (stronger than the old options-array
  model: it tests the actual windowed render, incl. the windowing cap).

Tests shipped (green): `picker` (option-list/row presence, forward +
reverse closure with cue, save → config write, re-open reflects saved
state, cancel, windowing cap).

---

## Sprint 5 — ✅ Done: Focus — single-unit, inclusion mode, drift-free exit

Shipped (`src/focus.ts`, `src/status-slot.ts`, `src/toggle.ts`,
`src/groups.ts`, `index.ts`):

- **Single-unit resolution (`resolveFocusUnit`)** — the `<unit>` is one
  group name or a toolset id, resolved in that order.
  **Never a builtin:** the reserved id `pi.builtin` errors with
  "builtins are out of tbox's scope; focus on an extension toolset or
  group instead." The function no longer resolves individual tool
  names or does prefix-expansion; that path was removed to eliminate
  collision surface with user group names.
- **Allowlist = forward `requires` closure ∪ reverse `dependents`
  closure** (not forward-only as the work text suggested). The library's
  enable cascade is bi-directional, so closing in both directions keeps
  the allowlist coherent with what the cascade actually enables — a
  forward-only allowlist would have left dependents enabled by the
  cascade but "outside" focus, then wrongly disabled them in the second
  pass. Builtins are excluded from the registry entirely
  and are naturally unaffected by the focus loop — no explicit
  seeding or skip logic is needed to keep them safe during focus.
- **Enter focus (`focusUnit`)** — `setFocusUnit(label)` is called
  **before** actuating so the synchronous `TOOLSET_EVENTS.changed`
  fanout (emitted inside `enable()`/`disable()`) renders the focus
  glyph, not a one-frame-stale count glyph; a final `rerenderSlot`
  covers the no-event edge case (re-focus on an identical allowlist).
  Then `setDefaultResolutionMode(pi, "inclusion")`, a two-pass
  actuation: pass 1 enables every allowlist member (the library cascades
  deps + dependents on); pass 2 disables every non-allowlist toolset that
  is **still enabled** after the cascade — i.e. only toolsets the cascade
  did not pull in. Builtins are outside the registry entirely and are
  naturally excluded. A `ponytail:` comment flags the two-pass reliance on
  synchronous `enable()` (upgrade path: flush/tick before pass 2 if the
  library ever goes async).
- **Exit focus (`focusOff`) — re-actuation, not a mode flip.**
  `setFocusUnit(null)` first (same fanout rationale), then every
  registered toolset is driven back to `spec.defaultEnabled`,
  **overwriting** the focus-era `{ enabled: false }` entries (the
  `ExtensionAPI` exposes no `removeEntry`, so an entry always wins
  regardless of mode — `design.md` §4.5; a mode-flip-only exit is a
  documented bug). Then `setDefaultResolutionMode(pi, "exclusion")`.
  A `ponytail:` comment records that pre-focus manual toggles are lost
  (the MVP confirms the library never remembers pre-focus state);
  upgrade path: a pre-focus snapshot if users report it.
- **Status slot focus states** — `● focus:<unit> (n)` (green/success)
  where `n` is the count of active extension tools; `● focus:∅` (red/
  error) when the focused allowlist leaves zero active extension tools.
  The `(n)` suffix is an addition over the work text's `● focus:<unit>`
  — it mirrors the count slot's affordance and makes an empty focus
  visually distinct from a one-tool focus without a separate query.
  Exit returns the slot to pristine / `● tbox n masked`. The slot shows
  focus state only, never the char count.
- **`/tbox status`** reports the focus line (`Focus: on (<unit>)` /
  `Focus: off`).
- **Mutual exclusion with actuation** — one-line guards at the top of
  `toggleTool`, `toggleAll`, and `actuateGroup` (root-cause, not
  dispatch) refuse with a message pointing to `/tbox focus off` while
  `_focusUnit !== null`. This covers the bare `<group> on|off`
  shorthand for free (it routes through `actuateGroup`). `group edit`
  (config-only), `list`/`status`/`chars` (read-only), and `focus
  <unit>` (re-focus, coherent) are unguarded — the slot never lies
  about the active set.

Tests shipped (green): `focus` (enter on toolset/tool/group,
closure, exit re-actuation overwrites focus-era entries, drift-free
restore under inclusion vs exclusion, mutual-exclusion refusals across
`toggleTool`/`toggleAll`/`actuateGroup`), `focus-exit` (the negative
guard — a mode-flip-only exit leaves a disabled toolset stuck off,
documenting why re-actuation is mandatory).

---

## Sprint 6 — ✅ Done: Char counter + status slot finalization

Shipped (`src/chars.ts`, `src/status-slot.ts`, `src/list.ts`):

- **`/tbox chars` (`computeCharCount` + `formatChars`)** — serializes
  every **active** tool's full definition via `JSON.stringify({name,
  description, parameters, promptGuidelines, sourceInfo})` (fixed key
  order → deterministic across runs) and sums the character counts.
  **All active tools count, including `builtin` and `sdk`** — the count
  is the honest serialized size of what the LLM sees, not the
  tbox-managed subset (MVP: "current active tool set", no exclusion).
  **The output is a fixed/tools split, not a single integer**
  (`Char count — fixed: <builtin+sdk> | tools: <extension> (total:
  <sum>)`): `fixed` is the non-togglable floor (builtin + sdk), `tools`
  is the togglable extension budget. This is an addition over the work
  text's "single integer" — the split is more useful for budgeting
  (you can see how much of the count you can actually move with
  `/tbox`), and the total is still the contract number. The split shape
  is recorded in the open-decisions table below.
- **`/tbox status`** includes the char line via the shared
  `formatCharSplit` (same string as `/tbox chars`), so the two surfaces
  never drift.
- **Status slot finalization (`src/status-slot.ts`)** — all four states
  wired with colors per the MVP table: `○ tbox` (dim) pristine; `● tbox
  n masked` (accent/blue) count, where `n` is non-builtin, non-sdk
  excluded extension tools (Sprint 2's count, re-verified against the
  focus configuration); `● focus:<unit> (n)` (success/green) focus;
  `● focus:∅` (error/red) focus-empty. `computeSlotState` +
  `renderSlotText` are split so tests assert state→text deterministically.
  The slot shows focus state only when in focus — **never** the char
  count (the count is ephemeral; `/tbox chars` and the status line are
  the on-demand surfaces). `rerenderSlot` lets non-event callers
  (focus enter/exit) repaint synchronously so the glyph never lags a
  frame behind the actuation that produced it.

Tests shipped (green): `chars` (hand-computed population → exact sum,
toggle delta = serialized size of moved members, determinism across
runs, builtin/sdk counted in `fixed`), `status-slot` (table-driven over
all four states asserting exact slot string + color marker, focus vs
count precedence, excluded-count correctness).

---

## Sprint 7 — Hardening, restore safety, integration, publish prep

**Goal:** the cross-cutting concerns that don't belong to a single
feature sprint: `/reload` + `session_tree` restore safety, the
multi-extension integration test, reserved-wordlist finalization, and
swapping the library dep to the published version.

### Work

1. **Restore safety.** Tbox's auto-registration (Sprint 0) must survive
   `/reload` and `session_tree`. Verify:
   - **Restore-timing fix — ✅ shipped (pulled forward from this sprint).**
     Root cause: `index.ts` calls `autoRegisterBuiltinAndOrphans(pi)`
     *inside* the `session_start` handler, which calls `defineToolset` →
     `ensureRestoreHandler` → `pi.on("session_start", doRestore)`. Node's
     EventEmitter does **not** invoke a listener registered mid-emit for
     the current emit, so on the session where tbox first registers its
     orphan toolsets (`tbox.tool@<source>`), the library's restore pass
     never runs for them — their members never get actuated to
     `defaultEnabled`, so they're absent from `getActiveTools()` and
     register as "excluded" in the slot count (a stale-count / "one off"
     bug). Portal's toolsets are unaffected (they `defineToolset` at
     module-load, before `session_start` fires). **Fix (tbox-owned, one
     place):** `autoRegisterBuiltinAndOrphans` returns the ids it
     registered this call; `actuateNewToolsets(pi, ids)` then drives each
     just-registered toolset to its `spec.defaultEnabled`, mirroring what
     the library's restore would have done. The diff-and-scope guard
     (only actuate the ids returned this call) is load-bearing — it
     prevents double-actuating toolsets the library's restore already
     handled (portal, etc.). Wired in both the `session_start` and
     `session_tree` handlers (`index.ts`); helper in `src/registry.ts`.
     Builtins are outside the registry entirely and are unaffected by
     actuation — no explicit handling needed.
   - Auto-registration re-runs against the fresh `pi` on `/reload`
     (jiti re-evaluates the module; the factory re-invokes; the
     `session_start` handler re-scans). The library's registry is
     idempotent-by-content so re-registration is a no-op for unchanged
     specs.
   - The `ctx.ui` capture-ordering fix (`render()` at the end of the
     capture handler) is in place — assert the first paint lands on
     post-restore state even if tbox's `session_start` handler runs
     before/after a sibling's.
   - **Point-2 verification (no code change):** `computeExcludedCount`
     (`src/status-slot.ts`) filters `source !== "builtin" && source !==
     "sdk"` — the same filter `src/registry.ts` uses to build
     matching the filters used throughout tbox. Builtins are
     never registered as toolsets so they never enter the count.
     After the restore-timing fix makes the input honest, confirm
     the count matches `/tbox list --flat --inactive`.
2. **Multi-extension integration test.** A single
   `integration.test.ts` that stands up a realistic registry: fake
   `portal.web` + `portal.learn` (requires web) + `host.api`
   - `search.web` + tbox's own per-source `tbox.tool@*` toolsets
  (at least two unclaimed-source plugins, to exercise the
  Sprint 3.5 shape), with a
   tool population spanning builtin/sdk/extension sources. Then drive
   the full `/tbox` surface end-to-end through the MockPI's
   `registerCommand` dispatch: `list` (grouped + flat + filters), group
   on/off with cascade reporting, toggle with guards, all on/off, focus
   on/off with re-actuation, chars, status. This is the test that
   catches integration bugs the library's own MockPI tests cannot
   (exactly the stated reason for building the manager early).
3. **Reserved-wordlist finalization.** Confirm the seed set
   (`toggle`, `status`, `focus`, `all`, `list`, `chars`, `group`,
   `on`, `off`) against the shipped command surface. Add any discovered
   collisions; document the final list in the README.
4. **`tbox.tool` shape** — **closed in Sprint 3.5**: per-source is
   the default, not "promote if noisy." Verify the per-source toolsets
   behave correctly under `/reload` and `session_tree` (a source that
   disappears leaves a stale entry — confirm it's a benign no-op at
   restore, as Sprint 3.5's idempotence note predicts). No catch-all
   fallback ships.
5. **Publish prep.** When `pi-tool-masking@1.0.0` is published: swap
   `"pi-tool-masking": "file:../pi-tool-masking"` → `"^1.0.0"`,
   `npm install`, `npm test` green. Add the `pi-package` gallery keyword
   (already in Sprint 0's `package.json` — re-verify). Confirm the
   tarball (`npm pack` dry-run) ships `index.ts` + `src/` + `config/` +
   no test files, and that `pi-tool-masking` resolves in the dep tree.
6. **README** with the `/tbox` command reference, the 4-state slot
   legend, the drift caveat (`on`/`off` drifts, `focus` doesn't), and
   the picker's remappable keyboard shortcuts.

### Acceptance criteria

- [ ] `integration.test.ts` green: the full `/tbox` surface against a
      realistic multi-source, multi-toolset registry, including cascade
      reporting and focus re-actuation.
- [ ] **Manual:** `/reload` in a real pi session with tbox + a sibling
      (portal) installed → slot re-paints correctly, auto-registration
      re-runs, no duplicate toolsets in `getRegisteredToolsets()`.
      Steps documented in the PR.
- [ ] **Manual:** `/resume` or `/tree` navigation → tbox slot reflects
      the restored branch state on first paint.
- [ ] Final reserved-wordlist documented in README; every reserved word
      dispatches to its subcommand, not a group.
- [ ] `tbox.tool` per-source shape verified under `/reload` and
      `session_tree` (closed in Sprint 3.5; Sprint 7 confirms the
      stale-entry-is-benign prediction).
- [ ] After swapping to `pi-tool-masking@^1.0.0`: `npm install` clean,
      `npm test` green, `npm pack` dry-run tarball is correct.
- [ ] `npm test` green; `tsc --noEmit` clean; `npm run publish:dry` (or
      equivalent) succeeds.

### Tests

- `integration.test.ts`: the big end-to-end (see Work #2). At minimum:
  - `list --grouped` on the realistic registry matches a snapshot of the
    expected grouped output (smallest-toolset-wins, orphans under their
    `tbox.tool@<source>` toolsets, sdk read-only in `--flat`).
  - Define a group `{toolsets: ["portal.learn"]}` via the picker →
    `on` → `portal.web` cascades on; status reports both.
  - `toggle <builtin tool>` → refused, builtin source check (out of tbox scope).
  - `all off` → every non-builtin toolset off; builtins unaffected
    (outside the registry); sdk untouched.
  - `focus host.api` → inclusion mode, only `host.api` (+ closure) on,
    slot green; `focus off` → all toolsets back to `defaultEnabled`,
    exclusion mode, slot pristine or `● tbox n masked`.
  - `chars` deterministic across two calls in the same state.
- `restore-timing.test.ts` — **✅ shipped** with the restore-timing fix
  (pulled forward): register orphans inside a synthetic `session_start`
  emit → assert their members land in `getActiveTools()` and the slot
  count reflects reality; re-run on a fresh session (idempotence) → no
  duplicate entries; the "one off" regression (count equals the true
  inactive extension count, not true-minus-one).
- `restore.test.ts`: simulate `/reload` by re-invoking the factory
  against a fresh MockPI sharing the same `globalThis`; assert
  auto-registration re-runs, registry has no duplicates, slot re-paints
  once on the capture handler.
- `capture-order.test.ts`: register tbox's `session_start` handler both
  before and after a simulated sibling's (which fires `restored`
  events); assert the first slot paint is correct in both orders (the
  §6 fix).

---

## Cross-cutting acceptance (whole plan)

- [ ] Tbox never references `globalThis.__piToolMaskingRegistry` or
      `__piToolMaskingModuleState` — `rg "__piToolMasking" src/` is
      empty. All registry access goes through `getRegisteredToolsets()`.
- [ ] Tbox never imports a settings reader from `pi-tool-masking` (the
      library exports none, `design.md` §5.1) — `rg "readMergedSettings"
      src/` matches only tbox's own `config/settings-reader.ts`.
- [ ] `sdk`-source tools are never registered into a toolset, never
      toggled, never counted in the slot's `n`, and appear only as
      read-only rows in `--flat`.
- [ ] The peer-composition invariant and `requires` cascade have
      **exactly one** test home (`pi-tool-masking`); tbox's tests assert
      tbox behavior on top of them, not the cascade itself.
- [ ] The `requires`-closure walks (`forwardClosure`/`reverseClosure`)
      live in one shared helper (`src/requires-graph.ts`), not inlined
      per command.
- [ ] `npm test` green and `tsc --noEmit` clean at the end of every
      sprint, not just the last.
- [ ] The status slot's `ctx.ui` capture calls `render()` at the end of
      the `session_start`/`session_tree` capture handler (the §6 fix);
      focus-exit is re-actuation, not a mode flip (the confirmed
      requirement).

---

## Open decisions to close in-sprint (from `manager-mvp.md` "Open for implementation")

| Decision | Sprint | Recommendation |
|---|---|---|
| **Builtins: out of tbox's management scope** | 2, 4, 5 | **Closed:** builtins are excluded from the registry entirely; toggle refuses builtins via source check (Sprint 2); picker never offers builtins (Sprint 4); focus rejects the reserved id `pi.builtin` (Sprint 5). Builtins are never registered so no safety skip is needed |
| Final reserved-wordlist | 7 | Seed set + any discovered collisions |
| Group config storage shape | 3 | **Closed:** `tbox.groups` key in merged settings; `GroupSpec = { toolsets: string[] }` (whole-toolset units only — no per-tool field) |
| `tbox.tool` shape | 3.5 | **Closed:** per-source is the default (`tbox.tool@<source>`); landed before Sprint 4/5 which depend on the shape |
| `requires`-closure picker interaction | 4 | **Closed:** inline footer cues in the `GroupEditorComponent` (`auto-checked:` / `auto-unchecked:` one-liner, fading on next keypress) |
| Picker presentation | 4 | **Closed:** a tbox-owned `GroupEditorComponent` mounted via `ctx.ui.custom` (windowed, searchable, keyboard-driven) — not a `ui.select` loop; single granularity (toolsets only) |
| `emitMemberEvents` | — | Off for MVP (recorded deferral); revisit only if live per-row animation needed |
| `/tbox chars` serialization shape | 6 | **Closed:** `JSON.stringify({name,description,parameters,promptGuidelines,sourceInfo})` per active tool, summed. Output is a **fixed/tools split** (`fixed` = builtin+sdk floor, `tools` = extension budget, total reported) — not a single integer; the total is the contract number, the split surfaces the togglable budget |
| Whether `chars` counts builtin/sdk active tools | 6 | **Closed:** Yes — the count is the honest serialized size of what the LLM sees (counted under `fixed`) |
