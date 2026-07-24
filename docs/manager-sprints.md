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
  (`extensions.md` §"pi.getAllTools()"). `builtin` tools → protected
  `pi.builtin` toolset. `sdk` tools → **out of tbox's domain entirely**
  (read-only rows in `--flat`, never registered into a toolset, never
  counted in the status slot's excluded count, not lifted by dev mode).
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
  for one product, no config-for-a-constant. `masked` is the single
  addressability knob; do not add `atomic`/`visible` siblings.

### Repo layout (target, not prescriptive)

```
pi-tbox/
  package.json            # name: "pi-tbox", type: "module", "pi-package" keyword,
                          #   pi: { extensions: ["./index.ts"] }
                          #   dependencies: { "pi-tool-masking": "^1.0.0", ... }
  index.ts                # default factory: registerCommand("tbox"), slot wiring,
                          #   auto-registration of pi.builtin + tbox.tool
  src/
    registry.ts           # auto-register pi.builtin + tbox.tool from getAllTools()
    requires-graph.ts     # forward/reverse requires walks (one shared helper)
    groups.ts             # user group config read/write + resolution to units
    list.ts               # /tbox list (grouped/flat, filters, smallest-toolset-wins)
    toggle.ts             # /tbox toggle <tool>, /tbox all on|off, dev-mode guards
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
- `ui.notify`, `ui.select`, `ui.confirm` — the picker (Sprint 4) drives
  `select`; record the options presented and return the test's choice.
- `getAllTools()` returning tools with **all five** `sourceInfo.source`
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
  `getAllTools()`, registers `pi.builtin` (`defaultEnabled: true`,
  `masked: false`) from builtin tools, registers `tbox.tool` from
  extension tools no other toolset claims, **skips sdk entirely**. Run
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
  once under its smallest (by `names.size`) containing toolset; masked
  toolset → one sealed row with members suppressed; orphans →
  their `tbox.tool@<source>` toolset (per Sprint 3.5; Sprint 1
  shipped against a catch-all `tbox.tool`, refined by 3.5).
- **`--flat`** — every tool as a row; `sdk`-source tools present and
  marked read-only/host-managed (no toggle affordance).
- **Filters** — `--active` / `--inactive` in both views, combinable
  (`--flat --inactive`). Active iff `getActiveTools().includes(name)`.
- **Bare `/tbox`** — slot mirror + brief subcommand help.
- **`/tbox status`** — aggregator: toolsets (id, enabled, member count,
  masked); groups/focus/chars lines default to "none"/"off"/omitted
  until their sprints ship.

Tests shipped (green): `list`, `command`.

---

## Sprint 2 — ✅ Done: `/tbox toggle`, `/tbox all`, guards; dev mode deferred to settings

Shipped (`src/toggle.ts`, `src/status-slot.ts`):

- **`/tbox toggle <tool>`** — exact→prefix resolution; ambiguous prefix
  errors listing candidates; `sdk` tool always refused; orphan →
  its `tbox.tool@<source>` toolset (per Sprint 3.5; Sprint 2 shipped
  against a catch-all `tbox.tool`, refined by 3.5); re-running
  toggles back.
- **Guards (normal mode)** — masked-member toggle refused ("part of the
  sealed group `<group>`; toggle the group, or enable dev mode");
  `pi.builtin` toggle refused ("builtins are protected; enable dev
  mode"). Both lifted when dev mode is on. `sdk` exclusion is **never**
  lifted.
- **`/tbox all on`** — enable every registered toolset. **`/tbox all off`**
  — disable every non-builtin toolset (`pi.builtin` protected);
  `sdk` untouched.
- **Status slot count state** — `● tbox n` (blue) where
  `n` = non-builtin, non-sdk tools minus `getActiveTools()`; pristine
  `○ tbox` when `n === 0`. `changed`/`restored` listeners re-render.

**Dev-mode course correction (recorded):** dev mode is **not** a runtime
`/tbox dev on|off` toggle — a runtime toggle over a load-time guard flag
is unrequested state machinery. Dev mode is a single `tbox.dev` boolean
in `settings.json`, read at load by **Sprint 3's** settings reader
(`config/settings-reader.ts`). The current code's in-memory
`setDevMode`/`isDevMode` flag and `/tbox dev on|off` command surface are
**placeholders to be replaced in Sprint 3**: Sprint 3 swaps them for a
read of `tbox.dev` at `session_start`, removes the `/tbox dev` command
entirely, and `/tbox status` reports "Dev mode: on|off" from the read
value. `dev` is therefore **dropped from the reserved-wordlist**
(Sprint 3) — with no `/tbox dev` command, `/tbox dev on` is just the
group shorthand for a group named `dev`.

Tests shipped (green): `toggle`, `all`, `status-slot` (count + event
re-render), `dev-mode` (exercises the placeholder flag; Sprint 3
rewrites it to assert the settings.json read).

---

## Sprint 3 — ✅ Done: User groups: storage, on/off, reserved words, closure helper

Shipped (`config/settings-reader.ts`, `src/groups.ts`, `src/reserved.ts`,
`src/requires-graph.ts`, `index.ts`):

- **`config/settings-reader.ts`** — tbox's own merged-settings reader
  (library exports none, `design.md` §5.1). Tbox-owned keys live under
  one `tbox` object: `tbox.dev` (boolean) and `tbox.groups` (group →
  `{ toolsets: string[], tools: string[] }`). Reads merge global +
  project (project wins); a test-injectable override avoids fs mocks.
  **Storage-shape decision (recorded):** groups live under `tbox.groups`
  in merged settings — a dedicated `~/.pi/agent/pi-tbox/groups.json` was
  rejected (one config location is simpler, matches the MVP
  recommendation). The write path lands in Sprint 4's picker-confirm.
- **Dev-mode swap (lands here, not Sprint 2)** — at `session_start`,
  tbox reads `tbox.dev` and sets the in-memory flag the guards consult,
  replacing Sprint 2's placeholder `setDevMode`/`isDevMode` + `/tbox dev`
  command. The `/tbox dev` command is **removed entirely**; edit
  `settings.json` and `/reload` to change. `/tbox status` reports "Dev
  mode: on|off" from the read value. `dev-mode.test.ts` rewritten to
  assert the settings read (`session_start` with `tbox.dev: true` →
  guards lifted).
- **`src/groups.ts`** — `/tbox <group> on` enables each toolset member
  (library cascade pulls deps on); individual tool members actuate via
  their containing toolset. `/tbox <group> off` disables each member; the
  moved set is computed by **diffing `getActiveTools()` before vs.
  after** (not `reverseClosure` — reflects reality incl. cross-extension
  companions the static graph wouldn't predict); cascaded non-members
  are reported in the output. Drift caveat line shipped on every
  actuation.
- **`src/reserved.ts`** — reserved wordlist (`toggle`, `status`,
  `focus`, `all`, `list`, `chars`, `group`, `on`, `off`); **`dev`
  dropped** (no `/tbox dev` command). `/tbox <name> on|off` is the group
  shorthand unless `<name>` is reserved; a reserved-named group is
  reachable only via `/tbox group <name> on`, and the bare form errors
  with a pointer to the explicit form.
- **`/tbox group <name> [on|off]`** — explicit group form (unambiguous
  path + reserved-name escape). `/tbox group <name> edit` is a stub
  ("picker coming in Sprint 4").
- **`src/requires-graph.ts`** — the one shared helper for the
  both-direction `requires` closure over `getRegisteredToolsets()`:
  `forwardClosure(ids)` (ids + transitive `requires` targets) and
  `reverseClosure(ids)` (ids + everything that transitively `requires`
  one of them). Built from registry specs only (no `globalThis`). Cycle
  detection surfaces the cycle path at curation time rather than letting
  the library throw mid-actuation; forward-references (a `requires` id
  absent from the registry) are skipped, not fatal.

Tests shipped (green): `groups`, `reserved`, `requires-graph`,
`dev-mode` (rewritten for the settings read).

---

## Decision record — builtins are preserved, not grouped or focused

> Recorded after Sprint 3, before Sprint 4. This is a **spec
> clarification**, not a re-design: it sharpens an invariant that was
> implicit in the MVP and corrects one Sprint 5 claim that became stale
> once Sprint 0 registered `pi.builtin`. No shipped Sprint 1–3 code is
> incorrect in any user-reachable path; one one-line hardening in
> `groups.ts` folds into Sprint 4.

**The invariant:** *Builtins are never the **subject** of a group or
focus operation; they are always **preserved** by one.*

### Why (the drift argument)

Focus durability against new-tool drift has two halves:

- **Library half (done, §13.2):** inclusion mode — unknown toolsets
  default off, so a newly installed extension's toolsets don't break
  focus. This is `pi-tool-masking`'s job and it's shipped.
- **Builtin half (was under-specified):** a newly shipped Pi builtin must
  stay active during focus. `design.md` §13.2's original argument —
  *builtins survive focus emergently because they are not members of any
  `defineToolset` toolset* — **stops holding once tbox registers
  `pi.builtin`** (Sprint 0): `pi.builtin` is now a registered toolset,
  and if it isn't in the focus allowlist the focus loop would disable
  it. A new Pi builtin would go dark for every focused user until tbox
  ships a new release.

The fix is **tbox-owned, one line in `src/focus.ts`**, not a library
change: always seed the focus allowlist with `pi.builtin` (or skip it in
the disable pass). The library staying source-agnostic is what keeps it
stable; the taxonomy is each consumer's call. Moving `pi.builtin`
registration into the library would **propagate** the drift bug to every
library consumer (portal, search, host) instead of just tbox users.

### The three resulting rules

1. **Groups never contain builtins.** A group containing a builtin name
   means `group off` disables `pi.builtin` — the exact footgun Sprint 2's
   guards exist to prevent, smuggled in through the back door. There is
   no useful "group of builtins": they're always-on by nature, so
   grouping them is meaningless for `on` and dangerous for `off`.
2. **Focus never targets builtins.** `/tbox focus <builtin-tool-or-
   toolset>` errors. Focus on a builtin resolves to the `pi.builtin`
   allowlist, disabling everything else — a weird working set that
   conflates the preservation invariant with focus intent. A dev who
   wants to isolate one builtin already has `/tbox toggle` for surgical
   per-tool control.
3. **Dev mode's builtin affordance is `/tbox toggle` only, not the
   picker.** The picker (Sprint 4) never offers builtins as groupable
   rows, in any mode. Dev mode lifts the `/tbox toggle <builtin>` guard
   (one tool, deliberate, per-session); it does **not** grant the power
   to build a group that can later mass-disable builtins — that's a
   weaponized composition, not an override.

---

## Sprint 3.5 — Per-source orphan toolsets

**Goal:** close the focus-granularity asymmetry between plugins that
call `defineToolset` (e.g. `portal.web`) and plugins that only register
tools (e.g. pi-lens). A catch-all `tbox.tool` makes per-plugin focus
impossible — `/tbox focus tbox.tool` keeps *every* orphan or none.
Per-source registration makes each unclaimed-source plugin its own
focusable unit. This is a **spec clarification that refines shipped
Sprint 0 code**, in the same category as the builtins decision record
above: Sprint 0's idempotent re-registration scaffold is reused, only
the grouping key changes. No shipped Sprint 1–3 path is incorrect.

**Why a separate sprint, and why now:** Sprint 4's picker renders
toolsets as rows and Sprint 5's focus resolves "tool → its containing
toolset" — both depend on the orphan shape. Landing per-source in
Sprint 7 (publish prep) would force Sprint 4–6 to build against the
catch-all and rework. Sprint 3.5 lands the structural change before the
sprints that consume it.

### Work

1. **`src/registry.ts`** — change the orphan branch of
   `autoRegisterBuiltinAndOrphans` from one catch-all to one toolset
   per distinct `sourceInfo.source` among unclaimed extension tools:
   - **Id:** `tbox.tool@<source>` (stable, addressable; `<source>`
     is the extension source metadata from `sourceInfo.source`).
   - **`names`:** all unclaimed extension tools sharing that source.
   - **`label`:** derived from `<source>` (the plugin id). `ToolInfo`
     has no `label` field, so this is derivation, not pass-through.
   - **`description`:** pass through from the tool **only when the
     source contributes exactly one orphaned tool** (the common
     single-tool-plugin case gets a real description for free). When
     the source contributes multiple tools, omit `description`
     (`ToolsetSpec.description` is optional) rather than synthesize a
     bland "tools from X" string — the grouped view already shows
     members, so a missing description costs nothing and
     misrepresenting one tool's description as the group's would
     mislabel the others.
   - **`defaultEnabled: true`, `masked: false`, `persistKey:`**
     `toolset-state:tbox.tool@<source>` — unchanged from the
     catch-all plan per field.
   - **Skips sdk entirely** — unchanged; sdk tools are never registered
     into any toolset (out of tbox's domain).
2. **Idempotence preserved:** the library is idempotent-by-content for
   an unchanged spec, so re-registration on `/reload` is a no-op for
   unchanged sources. A source that gains/loses a tool between reloads
   updates its `names` set; a source that disappears leaves a stale
   entry — Sprint 7's restore-safety pass verifies this is benign (a
   stale entry with no matching tools is a harmless no-op at restore).
3. **No change to builtins or sdk handling** — `pi.builtin` and the sdk
   skip are exactly as Sprint 0 shipped them.

### Acceptance criteria

- [ ] A session with two unclaimed-source plugins (e.g. `pi-lens` with
      ~15 tools and a single-tool plugin) produces **two** orphan
      toolsets: `tbox.tool@pi-lens` (multi-tool, `description`
      omitted) and `tbox.tool@<single>` (one tool, `description`
      passed through from that tool's `description`).
- [ ] `/tbox focus tbox.tool@pi-lens` keeps only pi-lens's tools +
      `pi.builtin`, disabling every other registered toolset including
      the other orphan toolset — the asymmetry that prompted this
      sprint is closed.
- [ ] `/tbox toggle <pi-lens-tool>` still works (the name is in
      `tbox.tool@pi-lens.spec.names`); per-tool toggle granularity
      is unchanged from the catch-all design.
- [ ] Re-running `autoRegisterBuiltinAndOrphans` against an unchanged
      tool population is a no-op (registry contents unchanged); the
      idempotent-by-content guarantee from Sprint 0 still holds under
      the per-source keying.
- [ ] `/reload` (simulated via `session_tree`) re-registers against
      the fresh `pi`; a source that gained a tool reflects the new
      `names` set.
- [ ] `npm test` green; `tsc --noEmit` clean.

### Tests

- `registry-per-source.test.ts`:
  - Multi-source population: register builtin tools, sdk tools, two
    plugins' worth of extension tools (none calling `defineToolset`),
    and one plugin that *does* call `defineToolset` (its tools must not
    be claimed by any `tbox.tool@*`). After
    `autoRegisterBuiltinAndOrphans`: one `pi.builtin`, one
    `tbox.tool@<source-A>` (multi-tool, no `description`), one
    `tbox.tool@<source-B>` (single-tool, `description` passed
    through), zero `tbox.tool` catch-all, sdk tools in no toolset.
  - Focus granularity: enter focus on `tbox.tool@<source-A>`;
    assert source-A's tools active, source-B's tools inactive,
    `pi.builtin` active (allowlist-seeded per Sprint 5's rule — this
    test pre-pins the rule Sprint 5 will enforce).
  - Idempotence: call `autoRegisterBuiltinAndOrphans` twice; assert the
    second call writes no new registry entries and no new `appendEntry`
    calls.
  - Single-tool description pass-through: assert
    `tbox.tool@<source-B>.spec.description === <source-B tool's
    description>` and `tbox.tool@<source-A>.spec.description` is
    `undefined`.

---

## Sprint 4 — Group editing picker UX

**Goal:** point 4 (curation UX). `/tbox group <name> edit` opens a
filtered check-list (the same UX as pi's scoped-models picker), with the
`requires` closure auto-maintained in normal mode.

### Work

1. The picker: present every **addressable unit** as a check row.
   - **Normal mode:** masked toolsets show as **one sealed row** (the
     group); members are not surfaced. Builtins are not shown (protected
     — they only surface in dev mode). Unmasked toolsets show as one row
     per toolset **and** their member tools as individual rows (so a
     group can include a whole toolset or cherry-pick members). Orphans
     show as individual tool-rows under their `tbox.tool@<source>`
     toolset (per Sprint 3.5).
   - **Dev mode:** masked toolsets expand to show individual members as
     checkable rows; the `requires` closure is **not** auto-applied (raw
     behavior; the library still resolves `requires` at actuation, so an
     unclosed group just pulls deps on anyway — documented in the
     picker's dev-mode help line). **`pi.builtin` is never a groupable
     row, in any mode** (decision record above): builtins are preserved
     by groups/focus, never the subject of them. Dev mode's builtin
     access is `/tbox toggle <builtin>` only.
2. **`requires` closure auto-maintained (normal mode):**
   - Check `portal.learn` → `portal.web` auto-checks (forward closure).
   - Uncheck `portal.web` while `portal.learn` is checked →
     `portal.learn` auto-unchecks (reverse closure).
   - Use `src/requires-graph.ts` from Sprint 3. Surface the auto-check
     to the user (the MVP leaves the interaction detail open —
     recommend: the auto-checked row flips visibly and a one-line note
     "enabled: requires portal.web" appears; auto-uncheck shows
     "disabled: portal.learn depends on this"). Decide and record.
3. On confirm: write the curated `{toolsets, tools}` back to tbox user
   config (via Sprint 3's chosen storage path). The group is then
   immediately actuate-able via `/tbox <name> on|off`.
4. `emitMemberEvents` is **not** used by the MVP picker
   (`manager-mvp.md` §4). Derive membership from
   `getRegisteredToolsets()` and refresh on `TOOLSET_EVENTS.changed`/
   `restored`. Record the deferral in a code comment.

### Acceptance criteria

- [ ] `/tbox group newgroup edit` opens a check-list of addressable
      units; masked toolsets are sealed rows in normal mode; builtins
      absent; orphans present as individual tools.
- [ ] Checking `portal.learn` auto-checks `portal.web` (forward closure)
      with a visible cue; unchecking `portal.web` auto-unchecks
      `portal.learn` (reverse closure) with a visible cue.
- [ ] In dev mode, masked toolsets expand to member rows; no closure
      auto-apply. **`pi.builtin` is absent from the row list in both
      modes** (decision record).
- [ ] Confirming writes the group to config; `/tbox newgroup on`
      immediately actuates the curated set.
- [ ] Re-opening `edit` shows the previously-saved checks.
- [ ] `npm test` green; `tsc --noEmit` clean.

### Tests

- `picker.test.ts` (drive via MockPI's `ui.select` recording the options
  presented and returning a controlled selection):
  - Normal-mode option list: masked toolset present as one row, its
    members **absent** from the option list; builtin toolset absent;
    orphan tool present.
  - Dev-mode option list: masked members present; `pi.builtin` **absent**
    (builtins are never groupable — decision record).
  - Selecting `portal.learn` → the selection passed back through
    forwardClosure includes `portal.web`; the group written to config
    contains both.
  - Selecting `portal.web` only (with `portal.learn` previously
    selected) → reverseClosure removes `portal.learn`; written group
    has only `portal.web`.
  - Confirm → config write call recorded with the expected shape.
  - Re-open → presented checks reflect the saved config.

---

## Sprint 5 — Focus: single-unit, inclusion mode, drift-free exit

**Goal:** point 2's focus half. `/tbox focus <unit>` and `/tbox focus off`,
with the **re-actuation exit** (not a mode flip) the MVP confirms as a
hard requirement.

### Work

1. `src/focus.ts`: focus is **single-unit** — the `<unit>` is one group
   name, one toolset id, or one tool name — **but never a builtin**
   (decision record above). `/tbox focus <builtin-tool-or-toolset>`
   errors with "builtins are preserved during focus, not focused on;
   use `/tbox toggle` to adjust one." Resolve a non-builtin unit to an
   allowlist of toolset ids:
   - group → the group's toolsets (from config) plus their `requires`
     closure (forward) — focus on a group must keep deps on;
   - toolset → that toolset plus its `requires` closure;
   - tool → its containing toolset plus that toolset's `requires`
     closure.
2. **Enter focus:**
   - `setDefaultResolutionMode(pi, "inclusion")` — unknown toolsets
     default off, so a future new extension's toolsets don't break
     focus (drift-free, `design.md` §4.5/§13.2).
   - **Seed the allowlist with `pi.builtin`** (or skip it in the disable
     pass) so builtins survive focus regardless of what Pi ships next —
     this is the drift fix that `design.md` §13.2's emergent-preservation
     argument can no longer carry once `pi.builtin` is a registered
     toolset (Sprint 0). One line; tbox-owned (the library stays
     source-agnostic).
   - For every registered toolset: if in the allowlist → `enable(pi)`
     (the library's `requires` cascade pulls deps on); else →
     `disable(pi)` — **except `pi.builtin`, which is never disabled by
     focus.** This writes `{ enabled: false }` entries for every
     non-allowlist, non-builtin toolset (the MVP's confirmed focus-era
     writes).
3. **Exit focus (`/tbox focus off`):** this is **re-actuation, not a mode
   flip.** Flipping inclusion→exclusion alone leaves the focus-era
   `{ enabled: false }` entries stuck off (the `ExtensionAPI` exposes
   only `appendEntry`, no `removeEntry`/clear — tbox cannot delete them;
   an entry always wins regardless of mode, `design.md` §4.5). So:
   - For every registered toolset, call `enable()`/`disable()` to drive
     it back to `spec.defaultEnabled`, **overwriting** the focus-era
     entries with the default's `{ enabled }`.
   - Then `setDefaultResolutionMode(pi, "exclusion")` — restore the
     library default mode so unknown toolsets default on again.
   - "Restore defaults" means each toolset returns to
     `spec.defaultEnabled` (the library never remembers pre-focus state
     — confirmed in code, `manager-mvp.md` §2). Document this in the
     command output.
4. `src/status-slot.ts`: focus state. In focus → `● focus:<unit>`
  green; if the allowlist resolves to **empty** → `● focus:∅` red
  (broken). Exit → back to pristine/`● tbox n`.
5. `/tbox status` now reports the focus line.

### Acceptance criteria

- [ ] `/tbox focus <builtin-tool-or-toolset>` errors (builtins are
      preserved, not focused on — decision record).
- [ ] `/tbox focus portal.web` sets inclusion mode, enables `portal.web`
      (+ `requires` closure), disables every other registered toolset;
      `pi.builtin` stays enabled (allowlist-seeded, not emergent);
      builtins remain active.
- [ ] `/tbox focus mygroup` (a group) focuses the group's toolsets +
      their forward closure.
- [ ] The slot shows `● focus:portal.web` (green) during focus;
      `● focus:∅` (red) if the allowlist is empty.
- [ ] `/tbox focus off` re-actuates every registered toolset back to its
      `spec.defaultEnabled` (overwriting focus-era entries), restores
      exclusion mode, and the slot returns to pristine or `● tbox n`.
      **A mode-flip-only exit is a bug** — assert the entries are
      overwritten, not just the bit flipped.
- [ ] **Drift-free:** after entering focus, registering a new fake
      toolset `E` (no entry) and triggering a restore → `E` restores
      **off** under inclusion mode (focus survives). After `focus off`,
      the same `E` restores to its `defaultEnabled` under exclusion.
- [ ] `npm test` green; `tsc --noEmit` clean.

### Tests

- `focus.test.ts`:
  - Enter focus on `portal.web` with fake `portal.learn` (requires web)
    - `host.api` registered → `portal.web` enabled, `portal.learn`
    enabled (closure), `host.api` disabled, `pi.builtin` **kept enabled**
    (allowlist-seeded, not emergent — this is the drift fix). Inclusion
    mode set. Entries written for `portal.web`, `portal.learn`,
    `host.api` — **not** for `pi.builtin`.
  - Empty allowlist (focus on a group with no toolsets) → slot red, no
    toolset enabled except via requires-nada.
  - Exit focus → every toolset driven to `spec.defaultEnabled`; the
    focus-era `false` entries for non-allowlist toolsets are
    **overwritten** with the default's `{ enabled }` (assert via
    MockPI's recorded `appendEntry` sequence: the last write for each
    persistKey matches the default). Exclusion mode restored.
  - Drift-free: enter focus, register `E` with `defaultEnabled: true`,
    fire a `session_tree` restore → `E` is off (inclusion). `focus off`
    → fire restore → `E` is on (exclusion, default honored). This is
    integration-level (it drives the library's inclusion/exclusion
    restore through tbox's focus enter/exit), so it's the one place
    tbox's tests come closest to re-asserting a library invariant —
    acceptable because it pins tbox's *use* of the mode API end-to-end,
    not the mode fallback in isolation (`design.md` §12 owns that).
  - Slot text asserts the green and red forms exactly.
- `focus-exit.test.ts`: the **negative** test — explicitly assert that
  flipping only the mode bit (without re-actuation) leaves a previously-
  disabled toolset stuck off; this documents why the re-actuation path
  is mandatory. (This is a regression guard against a future "simpler"
  refactor.)

---

## Sprint 6 — Char counter + status slot finalization

**Goal:** point 5 (char counter) and locking down the full 4-state slot.

### Work

1. `src/chars.ts`: `/tbox chars` prints the serialized character count
   of the current active tool set. Computed from `pi.getAllTools()` full
   definitions — for each **enabled** tool (in `getActiveTools()`),
   serialize `name` + `description` + `parameters` (JSON schema) +
   `promptGuidelines` + `sourceInfo` and sum the character counts.
   - The exact serialization shape (which fields, JSON vs. line-format)
     should be **deterministic** so the count is stable and testable —
     pick one (recommend `JSON.stringify` of `{name, description,
     parameters, promptGuidelines, sourceInfo}` per tool, summed) and
     record it. The number is the contract; the shape is an impl detail.
   - `/tbox status` now includes the char count line.
2. `src/status-slot.ts` finalization: all four states wired
   (pristine / `● tbox n` / `● focus:<unit>` / `● focus:∅`), colors per
   the MVP table (dim / blue-accent / green-success / red-error). The
   slot shows focus state only — **not** the char count (the count is
   ephemeral, `/tbox chars` is the on-demand surface).
3. The excluded count `n` is non-builtin, non-sdk — already correct from
   Sprint 2; this sprint just re-verifies with focus active (focus
   disables toolsets, so `n` is large during focus — but the slot shows
   the focus glyph, not the count, so this is consistent).

### Acceptance criteria

- [ ] `/tbox chars` prints a single integer = sum of serialized chars of
      every enabled tool's full definition; the number is deterministic
      across runs with the same tool population + active set.
- [ ] Toggling a toolset on/off changes `/tbox chars` by exactly the
      serialized size of that toolset's now-(in)active members.
- [ ] `/tbox status` includes the char count line.
- [ ] The slot shows all four states correctly with the right colors and
      never shows the char count.
- [ ] `npm test` green; `tsc --noEmit` clean.

### Tests

- `chars.test.ts`:
  - A known tool population with hand-computed serialized sizes →
    `/tbox chars` returns the exact sum.
  - Toggle a toolset → delta equals the serialized size of its members.
  - Determinism: two runs with identical inputs → identical number.
  - `sdk` and `builtin` tools, when active, **are** counted (they are
    active tools with full definitions — the count is "active tool set,"
    not "tbox-managed tool set"); verify the MVP's intent here — the
    count is the honest serialized size of what the LLM sees, so all
    active tools count. (If the team decides otherwise, record the
    decision; the MVP text says "current active tool set" with no
    exclusion, so all active tools count.)
- `status-slot.test.ts`: a table-driven test over all four states —
  given a registry/active-set/focus configuration, assert the exact slot
  string + color marker.

---

## Sprint 7 — Hardening, restore safety, integration, publish prep

**Goal:** the cross-cutting concerns that don't belong to a single
feature sprint: `/reload` + `session_tree` restore safety, the
multi-extension integration test, reserved-wordlist finalization, and
swapping the library dep to the published version.

### Work

1. **Restore safety.** Tbox's auto-registration (Sprint 0) and dev-mode
   setting (Sprint 3) must survive `/reload` and `session_tree`. Verify:
   - Auto-registration re-runs against the fresh `pi` on `/reload`
     (jiti re-evaluates the module; the factory re-invokes; the
     `session_start` handler re-scans). The library's registry is
     idempotent-by-content so re-registration is a no-op for unchanged
     specs.
   - Dev mode survives `/reload` trivially: it is re-read from
     `tbox.dev` in `settings.json` at every `session_start`, so no
     in-memory flag or persist entry is involved.
   - The `ctx.ui` capture-ordering fix (`render()` at the end of the
     capture handler) is in place — assert the first paint lands on
     post-restore state even if tbox's `session_start` handler runs
     before/after a sibling's.
2. **Multi-extension integration test.** A single
   `integration.test.ts` that stands up a realistic registry: fake
   `portal.web` (masked) + `portal.learn` (requires web) + `host.api`
   - `search.web` + tbox's own `pi.builtin` + per-source `tbox.tool@*`
  toolsets (at least two unclaimed-source plugins, to exercise the
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
   `on`, `off`) against the shipped command surface; `dev` is **not**
   reserved (the `/tbox dev` command was removed in Sprint 3). Add any
   discovered collisions; document the final list in the README.
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
   the dev-mode explanation (a `tbox.dev` setting in `settings.json`,
   read at load — no runtime toggle; edit + `/reload` to change).

### Acceptance criteria

- [ ] `integration.test.ts` green: the full `/tbox` surface against a
      realistic multi-source, multi-toolset registry, including cascade
      reporting and focus re-actuation.
- [ ] **Manual:** `/reload` in a real pi session with tbox + a sibling
      (portal) installed → slot re-paints correctly, auto-registration
      re-runs, no duplicate toolsets in `getRegisteredToolsets()`, dev
      mode persists. Steps documented in the PR.
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
    expected grouped output (smallest-toolset-wins, masked sealed,
    orphans under their `tbox.tool@<source>` toolsets, sdk
    read-only in `--flat`).
  - Define a group `{toolsets: ["portal.learn"]}` via the picker →
    `on` → `portal.web` cascades on; status reports both.
  - `toggle <portal.web member>` in normal mode → refused (masked);
    with `tbox.dev: true` in settings → allowed.
  - `all off` → every non-builtin toolset off; `pi.builtin` on; sdk
    untouched.
  - `focus host.api` → inclusion mode, only `host.api` (+ closure) on,
    slot green; `focus off` → all toolsets back to `defaultEnabled`,
    exclusion mode, slot pristine or `● tbox n`.
  - `chars` deterministic across two calls in the same state.
- `restore.test.ts`: simulate `/reload` by re-invoking the factory
  against a fresh MockPI sharing the same `globalThis`; assert
  auto-registration re-runs, registry has no duplicates, dev mode
  re-read from `tbox.dev` in settings, slot re-paints once on the
  capture handler.
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
| **Builtins: preserved not grouped/focused** | 4, 5 | Decision record above — picker never offers builtins (Sprint 4); focus allowlist seeds `pi.builtin` + rejects builtin targets (Sprint 5); one-line `groups.ts` disable-guard folds into Sprint 4 |
| Final reserved-wordlist | 7 | Seed set + any discovered collisions |
| Group config storage shape | 3 | `tbox.groups` key in merged settings, or dedicated `~/.pi/agent/pi-tbox/groups.json` if settings writes are too risky |
| `tbox.tool` shape | 3.5 | **Closed:** per-source is the default (`tbox.tool@<source>`); landed before Sprint 4/5 which depend on the shape |
| `requires`-closure picker interaction | 4 | Visible auto-check/auto-uncheck + one-line cue |
| `emitMemberEvents` | — | Off for MVP (recorded deferral); revisit only if live per-row animation needed |
| `/tbox chars` serialization shape | 6 | `JSON.stringify({name,description,parameters,promptGuidelines,sourceInfo})` per active tool, summed |
| Whether `chars` counts builtin/sdk active tools | 6 | Yes — the count is the honest serialized size of what the LLM sees |
