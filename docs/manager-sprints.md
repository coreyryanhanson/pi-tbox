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
                          #   auto-registration of pi.builtin + tbox.orphans
  src/
    registry.ts           # auto-register pi.builtin + tbox.orphans from getAllTools()
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

## Sprint 0 — Scaffolding, auto-registration, slot skeleton

**Goal:** a loadable pi extension that registers `/tbox` (no-op stub),
owns the `tbox` status slot in its **pristine** state, and auto-registers
the `pi.builtin` and `tbox.orphans` toolsets at load so every later
sprint has a complete registry to work against.

### Work

1. `package.json`: `name: "pi-tbox"`, `type: "module"`, `keywords:
   ["pi-package", "pi-extension"]`, `pi: { extensions: ["./index.ts"] }`,
   `dependencies: { "pi-tool-masking": "file:../pi-tool-masking", ... }`,
   `peerDependencies` matching portal's (`@earendil-works/pi-coding-agent`,
   `@earendil-works/pi-tui`, `typebox`). `scripts.test: "vitest run"`.
   `tsconfig.json` mirroring the library's strict flags
   (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
   `module: "nodenext"`, `isolatedModules`, `noEmit: true`).
2. `__tests__/mock-pi.ts`: derive from the library's MockPI, extended per
   **Testing strategy** above. This is the foundation every sprint's
   tests build on — get it right now.
3. `src/registry.ts`: `autoRegisterBuiltinAndOrphans(pi)`. At load (inside
   the factory, after capturing the post-startup tool population), scan
   `pi.getAllTools()`:
   - `source === "builtin"` → register toolset `pi.builtin` with those
     names, `persistKey: "toolset-state:pi.builtin"`, `defaultEnabled:
     true`, `masked: false`. This is the point-3 protected toolset.
   - extension tools (`source !== "builtin" && source !== "sdk"`) **not
     in any `getRegisteredToolsets()` toolset** → register
     `tbox.orphans` (one catch-all; per-source groupings deferred — see
     "Open" in `manager-mvp.md`) with those names,
     `persistKey: "toolset-state:tbox.orphans"`, `defaultEnabled: true`.
   - `sdk` tools → **not registered**, not counted, never toggled.
   - **Timing:** `pi.getAllTools()` is only complete after every
     extension has loaded. Register from a `session_start` handler
     (portal/search register their toolsets at factory time; tbox reads
     the registry + tool population at `session_start`, after siblings
     have registered). Re-run on `session_tree` for the fresh branch.
     Dedup against already-registered ids (the library is
     idempotent-by-content for an *unchanged* spec, so a re-scan is a
     no-op when nothing moved; if the orphan population changed since
     the last scan, the `tbox.orphans` spec differs and the library
     replaces+warns rather than no-opping — acceptable, since new tools
     are active by pi's startup activation and a stale restore only
     affects old names).
4. `src/status-slot.ts`: `render()` for the **pristine** state only this
   sprint — `○ tbox` dim. Wire `ctx.ui` capture in `session_start` +
   `session_tree` (call `render()` at the end of the capture handler),
   `TOOLSET_EVENTS.changed`/`restored` listeners that call `render()`,
   and `session_shutdown` clears the slot.
5. `index.ts` factory: `pi.registerCommand("tbox", { description, handler:
   async (args, ctx) => { ctx.ui.notify("tbox: not yet implemented",
   "info"); } })`; call the slot wiring; call auto-registration from
   `session_start`.

### Acceptance criteria

- [ ] `pi -e ./index.ts` loads with no errors; `/tbox` prints the stub
      notification.
- [ ] The `tbox` status slot shows `○ tbox` (dim) on a fresh session with
      no toggles, from the very first paint (capture-handler `render()`).
- [ ] After load, `getRegisteredToolsets()` includes `pi.builtin` and
      `tbox.orphans`; `pi.builtin`'s names equal
      `getAllTools().filter(t => t.sourceInfo.source === "builtin").map(t
      => t.name)`; `tbox.orphans` contains extension tools no other
      toolset claims.
- [ ] No `sdk`-source tool appears in any registered toolset.
- [ ] `npm test` green; `tsc --noEmit` clean.

### Tests

- `mock-pi.test.ts`: the extended MockPI behaves — `registerCommand`
  records + dispatches; `ui.setStatus` records per-slot; `theme.fg`
  wraps with markers; `defineFakeToolset` lands in
  `getRegisteredToolsets()`.
- `registry.test.ts`: given a mock tool population
  `{builtin: [read,bash], sdk: [customX], ext-in-toolset: [web-navigate]
  (claimed by a fake portal.web), ext-orphan: [orphan-tool]}`, after
  `autoRegisterBuiltinAndOrphans`: `pi.builtin` = `{read,bash}`,
  `tbox.orphans` = `{orphan-tool}`, `customX` in no toolset.
  Re-running `autoRegisterBuiltinAndOrphans` is a no-op (idempotent).
  `sdk` tool never registered.
- `status-slot.test.ts`: fresh session → `ui.setStatus` called with the
  pristine glyph string exactly once on first paint (capture-handler
  render), not zero, not twice. `session_shutdown` clears the slot.
- `load.test.ts`: the factory does not throw when
  `pi-tool-masking` registry is empty (no siblings installed) —
  `pi.builtin` + `tbox.orphans` still register.

---

## Sprint 1 — `/tbox list`, `/tbox`, `/tbox status`

**Goal:** point 1 (listing tools) + the bare `/tbox` and `/tbox status`
surfaces. The status slot stays Sprint 0's pristine state; the excluded
count arrives in Sprint 2.

### Work

1. `src/list.ts`: enumerate tools from `pi.getAllTools()` cross-referenced
   with `getRegisteredToolsets()`.
   - **`--grouped` (default):** smallest-toolset-wins — each tool appears
     under its **smallest** (by `names.size`) containing toolset only, no
     duplication. A tool in multiple toolsets resolves to the most
     specific. A tool in no toolset → `tbox.orphans` (or `pi.builtin` if
     builtin — though builtins are now in `pi.builtin` after Sprint 0, so
     this is the same row). `portal.learn` (members: `web-learn`) shows
     `web-learn` under `learn`; `portal.web`'s members show under `web`.
   - **`--flat`:** every tool as a row. `sdk`-source tools appear as
     **read-only** rows (no enable/disable affordance, clearly marked
     "host-managed"). Builtin tools appear normally (toggleable only in
     dev mode — but the affordance guard is Sprint 2; this sprint just
     renders them).
   - **`masked` honoring in grouped view:** a masked toolset renders as
     **one row** (the group) with members suppressed; an unmasked toolset
     renders its members as individual rows. This is the §13.1
     addressable-unit derivation.
   - **Filters:** `--active` (only currently enabled, per
     `getActiveTools()`), `--inactive` (only disabled). Both apply in
     both views. A tool is "active" iff `getActiveTools().includes(name)`.
2. `/tbox` bare: slot mirror (the current slot text) + a brief help line
   listing the subcommands. No full enumeration.
3. `/tbox status`: full status — toolsets (id, enabled, member count,
   masked flag), user groups (from Sprint 3's config — until then,
   "no groups defined"), focus state ("off" until Sprint 5), dev mode
   ("off" until Sprint 2), and **char count** (from Sprint 6 — until
   then, omit the line). Each subsystem lands its line when its sprint
   ships; `/tbox status` is the aggregator and grows over sprints.

### Acceptance criteria

- [ ] `/tbox list` (no args) shows the grouped view; each tool appears
      exactly once under its smallest containing toolset; masked
      toolsets show as one row with members hidden.
- [ ] `/tbox list --flat` shows every tool as a row; `sdk` tools are
      present and marked read-only/host-managed; no `sdk` tool carries a
      toggle affordance.
- [ ] `/tbox list --active` / `--inactive` filter correctly in both
      views; combined flags (`--flat --inactive`) work.
- [ ] `/tbox` prints the slot mirror + help; `/tbox status` prints the
      aggregated status (subsystems not yet shipped say "off"/"none").
- [ ] `npm test` green; `tsc --noEmit` clean.

### Tests

- `list.test.ts`:
  - **Smallest-toolset-wins:** fake toolsets `big = {a,b,c,web-learn}`
    (size 4) and `small = {web-learn}` (size 1); grouped view shows
    `web-learn` under `small` only, `a`/`b`/`c` under `big`. No
    duplication.
  - **Masked suppression:** `portal.web` masked with 3 members → grouped
    view shows one `portal.web` row, zero member rows; unmasked
    `portal.learn` shows `web-learn` as its own row.
  - **Orphan routing:** an extension tool in no toolset appears under
    `tbox.orphans`.
  - **sdk read-only:** a `sdk`-source tool appears in `--flat` marked
    read-only and appears in **no** grouped-view row (it is in no
    toolset).
  - **Filters:** with `a` active and `b` inactive, `--active` shows only
    `a`, `--inactive` only `b`, in both views.
  - **Combined flags** parse without error.
- `command.test.ts`: `/tbox` bare prints a string containing the current
  slot text; `/tbox status` prints a line per subsystem with the
  not-yet-shipped subsystems reporting their default-off/none state.

---

## Sprint 2 — `/tbox toggle`, `/tbox all`, dev mode, guards

**Goal:** points 6 (individual toggle), 8 (all on/off), and 3 (dev mode +
the masked/builtin guards). The status slot now renders its second state
(`● tbox n` blue).

### Work

1. `src/toggle.ts`:
   - `/tbox toggle <tool>`: resolve `<tool>` against `pi.getAllTools()`
     names. If multiple tools share the suffix (e.g. `web:click` vs
     `api:click`), require a longer prefix and error clearly listing
     candidates. Toggle = if the tool is active → disable its containing
     toolset; if inactive → enable its containing toolset. A tool in no
     toolset (orphan) → toggle `tbox.orphans`. A `sdk` tool → refuse with
     a message explaining host-management.
   - **Guards (normal mode):**
     - A **masked** toolset's members are not individually toggleable —
       `toggle <masked-member>` errors "this tool is part of the sealed
       group `<group>`; toggle the group, or enable dev mode." Dev mode
       lifts this.
     - **`pi.builtin`** is not toggleable — `toggle <builtin>` errors
       "builtins are protected; enable dev mode." Dev mode lifts this.
   - `/tbox all on`: enable every registered toolset (`toolset.enable(pi)`
     per `getRegisteredToolsets()`). `/tbox all off`: disable every
     **non-builtin** toolset (`pi.builtin` protected). `sdk` tools
     untouched (they are in no toolset).
2. `src/toggle.ts` (dev mode): `/tbox dev on` / `/tbox dev off` flips a
   tbox-owned dev-mode flag (in tbox's user config under a `tbox.dev`
   key, persisted via the settings reader — **not** a library concern).
   Dev mode lifts: (a) the `pi.builtin` toggle guard, (b) the masked-
   member toggle guard. It does **not** lift the `sdk` exclusion (the
   MVP is explicit: sdk tools are not guaranteed present next session;
   dev mode only unseals masking and exposes builtins).
3. `src/status-slot.ts`: extend `render()` to compute the excluded count
   `n` = `getAllTools().filter(source !== builtin && source !== sdk)`
   minus `getActiveTools()`. State: pristine (`○ tbox` dim) when `n === 0`
   and not in focus; `● tbox n` blue when `n > 0`. Focus states
   (green/red) arrive in Sprint 5/6. The `changed`/`restored` listeners
   already call `render()`; this sprint just makes the count real.

### Acceptance criteria

- [ ] `/tbox toggle <tool>` toggles the tool's containing toolset on/off;
      re-running toggles back. Ambiguous prefix → clear error listing
      candidates. `sdk` tool → refused.
- [ ] In normal mode, toggling a masked toolset's member is refused;
      toggling a builtin is refused. `/tbox dev on` lifts both; `/tbox
      dev off` restores both guards.
- [ ] Dev mode persists across `/reload` (read from tbox user config at
      load).
- [ ] `/tbox all on` enables every registered toolset; `/tbox all off`
      disables every non-builtin toolset; `pi.builtin` stays enabled
      after `all off` in normal mode; no `sdk` tool's activation
      changes.
- [ ] Status slot shows `● tbox 3` (blue) when 3 extension tools are
      excluded; `○ tbox` (dim) when nothing is excluded; the count
      excludes builtin and sdk tools (excluding only builtins/sdk →
      `○ tbox`).
- [ ] `npm test` green; `tsc --noEmit` clean.

### Tests

- `toggle.test.ts`:
  - Toggle a tool in `portal.web` (unmasked) → that toolset's `enable`
    is called; toggle again → `disable`. Assert via MockPI's recorded
    `setActiveTools` / `appendEntry`.
  - Masked member toggle in normal mode → refused (no `setActiveTools`
    call, an error notify). In dev mode → the toolset toggles.
  - Builtin toggle refused in normal mode; allowed in dev mode.
  - `sdk` tool toggle refused in **both** modes.
  - Ambiguous prefix → error lists both candidates; exact match wins.
  - Orphan tool → toggles `tbox.orphans`.
- `all.test.ts`:
  - `all on` → `enable` called for every `getRegisteredToolsets()` entry.
  - `all off` → `disable` called for every entry except `pi.builtin`.
  - `sdk` tool's presence in `getActiveTools()` unchanged by `all off`.
- `status-slot.test.ts`:
  - 3 extension tools excluded → slot text is exactly the `● tbox 3`
    blue form.
  - Only builtin/sdk excluded → pristine `○ tbox`.
  - Toggling a toolset fires `changed` → `render()` updates the count
    without a manual refresh.
- `dev-mode.test.ts`: dev flag round-trips through the settings reader;
  a `session_start` after a simulated `/reload` restores the persisted
  dev state.

---

## Sprint 3 — User groups: storage, on/off, reserved words, closure helper

**Goal:** point 2 (user groups) — the **actuation** half. Curation UX
(the picker) is Sprint 4. This sprint ships `/tbox <group> on|off`, the
explicit `/tbox group <name> [on|off]` form, the reserved-wordlist
collision disambiguation, and the shared `requires-graph.ts` closure
helper (used by Sprint 4's picker).

### Work

1. `config/settings-reader.ts`: tbox's own merged-settings reader
   (mirror `pi-lean-portal/core/shared/settings-reader.ts` — the library
   exports none, `design.md` §5.1). Groups live under a `tbox.groups` key
   in merged settings. **Decide the storage shape** (an "Open" item in
   `manager-mvp.md`): recommend

   ```jsonc
   "tbox": { "groups": { "mygroup": { "toolsets": ["portal.web"],
                                       "tools": ["web-learn"] } } },
   "tbox": { "dev": false }
   ```

   — group → `{ toolsets: string[], tools: string[] }` (addressable units
   = whole toolsets and/or individual tools). Reads merge global + project
   (project wins). **Writing** groups back (Sprint 4's edit command) uses
   the same reader's write path; if programmatic settings.json writes are
   judged too risky, fall back to a dedicated
   `~/.pi/agent/pi-tbox/groups.json` — **decide in this sprint and record
   the call in the sprint's PR description.**
2. `src/groups.ts`: load groups from config; resolve a group → its units
   (toolset ids + tool names) → call `toolset.enable/disable` per
   toolset member and toggle the individual tools' containing toolsets
   for tool members.
   - **`/tbox <group> on`** resolves → enable each toolset member
     (`requires` cascade in the library pulls deps on); for individual
     tool members, enable their containing toolset (toggling a single
     tool is always via its toolset — there is no per-tool persist
     primitive).
   - **`/tbox <group> off`** resolves → disable each toolset member
     (library reverse-cascades to dependents outside the group — tbox
     **surfaces this** in post-actuation status: report every toolset
     that actually moved, including cascaded non-members). Compute the
     moved set by **diffing `getActiveTools()` before vs. after
     actuation** — this reflects reality (including any cross-extension
     companions the static graph wouldn't predict); do **not** predict
     it via `reverseClosure`, which would drift from what the library
     actually did.
   - **Drift is documented** (point 7): `on`/`off` writes per-toolset
     entries; editing the group later does not retroact. The command's
     output includes a one-line note when a group is actuated
     ("group state saved per-toolset; editing this group won't change
     already-saved sessions — use focus for drift-free snapshots").
3. `src/reserved.ts`: the reserved wordlist (`toggle`, `status`, `focus`,
   `all`, `list`, `chars`, `dev`, `group`, `on`, `off`). Command
   dispatch: `/tbox <name> on|off` is the group shorthand **unless**
   `<name>` is reserved, in which case the subcommand wins and a group
   named e.g. `focus` is only reachable via `/tbox group focus on`
   (error on the bare form points the user at the explicit form).
4. `/tbox group <name> [on|off]`: explicit group form (for reserved-name
   groups and as the unambiguous path). `/tbox group <name> edit` is
   wired to a stub this sprint (picker lands in Sprint 4).
5. `src/requires-graph.ts`: the **one shared helper** for the
   both-direction `requires` closure over `getRegisteredToolsets()`.
   - `forwardClosure(toolsetIds)`: given a set of ids, return the set
     plus every transitive `requires` target.
   - `reverseClosure(toolsetIds)`: given a set, return the set plus every
     toolset that transitively `requires` one of them.
   - Built from `getRegisteredToolsets()` specs only (no `globalThis`).
   - Cycle detection: the library throws on cycles at actuation; tbox's
     walk should detect and surface a cycle at curation time too (re-use
     the visited-stack pattern) rather than letting the library throw
     mid-actuation.
   - This sprint: the helper exists and is unit-tested; Sprint 4's
     picker calls it.

### Acceptance criteria

- [ ] `/tbox mygroup on` (non-reserved name) enables every toolset in
      `mygroup`; `requires` deps come on via the library cascade;
      post-actuation status lists everything that moved.
- [ ] `/tbox mygroup off` disables every toolset in `mygroup`; cascaded
      non-members (e.g. `portal.learn` when only `portal.web` is in the
      group) are reported in the output as moved-by-cascade.
- [ ] `/tbox focus on` (reserved name) errors and points at `/tbox group
      focus on`; the explicit form works.
- [ ] `/tbox group <name> on|off` is the unambiguous path and behaves
      identically to the bare form for non-reserved names.
- [ ] `/tbox group <name> edit` prints a "picker coming in Sprint 4"
      stub (no crash).
- [ ] `forwardClosure`/`reverseClosure` return the correct transitive
      sets over a multi-toolset `requires` graph; a cycle is detected
      and reported with the cycle path.
- [ ] `npm test` green; `tsc --noEmit` clean.

### Tests

- `groups.test.ts`:
  - Group `{toolsets: ["portal.web"]}` → `on` enables `portal.web`;
    `off` disables it and reports `portal.learn` as cascaded-off (fake
    `portal.learn` with `requires: ["portal.web"]`).
  - Group with both a toolset and an individual tool member → both
    actuate.
  - Actuating a non-existent group → clear error.
  - Post-actuation output mentions the drift caveat line.
- `reserved.test.ts`: every reserved word dispatches to its subcommand,
  not a group; a group named `list` is reachable only via
  `/tbox group list on`; bare `/tbox list on` errors with the pointer.
- `requires-graph.test.ts`:
  - `forwardClosure(["portal.learn"])` → `{portal.learn, portal.web}`.
  - `reverseClosure(["portal.web"])` → `{portal.web, portal.learn}` (and
    any deeper dependents).
  - A 3-node cycle `A→B→C→A` → throws naming `A → B → C → A`.
  - Forward-reference (a `requires` id not in the registry) is skipped,
    not fatal.

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
     show as individual tool-rows under `tbox.orphans`.
   - **Dev mode:** masked toolsets expand to show individual members as
     checkable rows; `pi.builtin` surfaces as a toggleable row; the
     `requires` closure is **not** auto-applied (raw behavior; the
     library still resolves `requires` at actuation, so an unclosed
     group just pulls deps on anyway — documented in the picker's
     dev-mode help line).
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
- [ ] In dev mode, masked toolsets expand to member rows; `pi.builtin`
      is a toggleable row; no closure auto-apply.
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
  - Dev-mode option list: masked members present; `pi.builtin` present.
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
   name, one toolset id, or one tool name. Resolve to an allowlist of
   toolset ids:
   - group → the group's toolsets (from config) plus their `requires`
     closure (forward) — focus on a group must keep deps on;
   - toolset → that toolset plus its `requires` closure;
   - tool → its containing toolset plus that toolset's `requires`
     closure.
2. **Enter focus:**
   - `setDefaultResolutionMode(pi, "inclusion")` — unknown toolsets
     default off, so a future new extension's toolsets don't break
     focus (drift-free, `design.md` §4.5/§13.2).
   - For every registered toolset: if in the allowlist → `enable(pi)`
     (the library's `requires` cascade pulls deps on); else →
     `disable(pi)`. This writes `{ enabled: false }` entries for every
     non-allowlist toolset (the MVP's confirmed focus-era writes).
   - Builtins stay active emergently (disabling a toolset only removes
     its own members; builtins are not members of any toolset the user
     focused away from — `design.md` §13.2). Do not register a
     "protected builtin" hack for focus.
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

- [ ] `/tbox focus portal.web` sets inclusion mode, enables `portal.web`
      (+ `requires` closure), disables every other registered toolset;
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
    enabled (closure), `host.api` disabled, builtins untouched. Inclusion
    mode set. Entries written for all three toolsets.
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
   flag (Sprint 2) must survive `/reload` and `session_tree`. Verify:
   - Auto-registration re-runs against the fresh `pi` on `/reload`
     (jiti re-evaluates the module; the factory re-invokes; the
     `session_start` handler re-scans). The library's registry is
     idempotent-by-content so re-registration is a no-op for unchanged
     specs.
   - The `ctx.ui` capture-ordering fix (`render()` at the end of the
     capture handler) is in place — assert the first paint lands on
     post-restore state even if tbox's `session_start` handler runs
     before/after a sibling's.
2. **Multi-extension integration test.** A single
   `integration.test.ts` that stands up a realistic registry: fake
   `portal.web` (masked) + `portal.learn` (requires web) + `host.api`
   - `search.web` + tbox's own `pi.builtin` + `tbox.orphans`, with a
   tool population spanning builtin/sdk/extension sources. Then drive
   the full `/tbox` surface end-to-end through the MockPI's
   `registerCommand` dispatch: `list` (grouped + flat + filters), group
   on/off with cascade reporting, toggle with guards, all on/off, focus
   on/off with re-actuation, chars, status. This is the test that
   catches integration bugs the library's own MockPI tests cannot
   (exactly the stated reason for building the manager early).
3. **Reserved-wordlist finalization.** Confirm the seed set
   (`toggle`, `status`, `focus`, `all`, `list`, `chars`, `dev`, `group`,
   `on`, `off`) against the shipped command surface; add any discovered
   collisions; document the final list in the README.
4. **`tbox.orphans` shape decision** (an "Open" item): one catch-all vs
   per-source-plugin groupings. The MVP notes per-source is more
   informative in the grouped view. Decide based on the Sprint 1 list
   output — if a single catch-all reads well, keep it; if a real
   multi-extension registry makes it noisy, promote to per-source.
   Record the call.
5. **Publish prep.** When `pi-tool-masking@1.0.0` is published: swap
   `"pi-tool-masking": "file:../pi-tool-masking"` → `"^1.0.0"`,
   `npm install`, `npm test` green. Add the `pi-package` gallery keyword
   (already in Sprint 0's `package.json` — re-verify). Confirm the
   tarball (`npm pack` dry-run) ships `index.ts` + `src/` + `config/` +
   no test files, and that `pi-tool-masking` resolves in the dep tree.
6. **README** with the `/tbox` command reference, the 4-state slot
   legend, the drift caveat (`on`/`off` drifts, `focus` doesn't), and
   the dev-mode explanation.

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
- [ ] `tbox.orphans` shape decision recorded (catch-all or per-source).
- [ ] After swapping to `pi-tool-masking@^1.0.0`: `npm install` clean,
      `npm test` green, `npm pack` dry-run tarball is correct.
- [ ] `npm test` green; `tsc --noEmit` clean; `npm run publish:dry` (or
      equivalent) succeeds.

### Tests

- `integration.test.ts`: the big end-to-end (see Work #2). At minimum:
  - `list --grouped` on the realistic registry matches a snapshot of the
    expected grouped output (smallest-toolset-wins, masked sealed,
    orphans under `tbox.orphans`, sdk read-only in `--flat`).
  - Define a group `{toolsets: ["portal.learn"]}` via the picker →
    `on` → `portal.web` cascades on; status reports both.
  - `toggle <portal.web member>` in normal mode → refused (masked);
    dev on → allowed.
  - `all off` → every non-builtin toolset off; `pi.builtin` on; sdk
    untouched.
  - `focus host.api` → inclusion mode, only `host.api` (+ closure) on,
    slot green; `focus off` → all toolsets back to `defaultEnabled`,
    exclusion mode, slot pristine or `● tbox n`.
  - `chars` deterministic across two calls in the same state.
- `restore.test.ts`: simulate `/reload` by re-invoking the factory
  against a fresh MockPI sharing the same `globalThis`; assert
  auto-registration re-runs, registry has no duplicates, dev mode
  restored from config, slot re-paints once on the capture handler.
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
| Final reserved-wordlist | 7 | Seed set + any discovered collisions |
| Group config storage shape | 3 | `tbox.groups` key in merged settings, or dedicated `~/.pi/agent/pi-tbox/groups.json` if settings writes are too risky |
| `tbox.orphans` shape | 7 | Start catch-all; promote to per-source if the realistic registry makes it noisy |
| `requires`-closure picker interaction | 4 | Visible auto-check/auto-uncheck + one-line cue |
| `emitMemberEvents` | — | Off for MVP (recorded deferral); revisit only if live per-row animation needed |
| `/tbox chars` serialization shape | 6 | `JSON.stringify({name,description,parameters,promptGuidelines,sourceInfo})` per active tool, summed |
| Whether `chars` counts builtin/sdk active tools | 6 | Yes — the count is the honest serialized size of what the LLM sees |
