# Manager MVP — `pi-tbox` design

> **Status: APPROVED.** This is the finalized design for the
> user-facing manager extension (`pi-tbox`), reviewed against the
> `pi-tool-masking` library code and tests and the pi extension docs.
> The `pi-tool-masking` library API (§5 of `design.md`) is frozen; this
> doc consumes it. The MVP ships the full 7-point surface below. (The
> `/tbox toggle` subcommand, shipped in Sprint 2, was later removed —
> see the group-API revision.)

## Premise

`pi-tbox` is a real pi extension (not the library) that depends on
`pi-tool-masking` and provides the end-user cross-extension tool
management surface. It is the §13 manager from `design.md`, built before
the library is published so the frozen API is validated against a real
consumer.

The library owns *toolset on/off memory*, the `requires` cascade,
the inclusion/exclusion default-resolution mode, and registry enumeration. `pi-tbox` owns
*user intent*: which tools are grouped together, which unit is focused,
how the user sees and toggles everything. The library never learns what a "group" or "focus label" is;
tbox stores those in its own user config and resolves them to library
primitives at actuation time. tbox never reaches into
`globalThis.__piToolMaskingRegistry` directly; it goes through
`getRegisteredToolsets()`.

## Command surface — `/tbox`

All commands live under the `/tbox` shortcut. Two addressability rules
keep the surface unambiguous:

1. **`+` prefix = toolset, bare = group.** The two namespaces can never
   overlap: group names may not contain `+` (it is the toolset-addressing
   prefix), so `/tbox +portal.web off` is always a toolset and
   `/tbox research on` is always a group — even when a group and a
   toolset share a name (`find` the group vs `+find` the toolset).
2. **Reserved words are rejected at group creation, not tolerated at
   actuation.** `writeGroup` refuses a name that is a tbox keyword or
   contains `+`, so no reserved-named group can ever exist and bare
   `/tbox <group> on|off` always works. The old explicit
   `/tbox group <name> on|off` escape hatch is gone — it existed only to
   reach reserved-named groups, which can no longer be created.

**Reserved words:** `status`, `focus`, `all`, `list`, `chars`, `group`,
`on`, `off`, `edit`, `remove`. (`edit`/`remove` are reserved so
`/tbox group edit`, `/tbox group remove`, and `/tbox group list` parse
unambiguously as subcommands, never "describe the group named edit".
`toggle` was removed from the set when the toggle command was deleted —
a group may now be named `toggle`.)

| Command | Effect |
|---|---|
| `/tbox` | show current state (slot mirror + brief help) |
| `/tbox list [--flat\|--by-chars] [--active\|--inactive]` | enumerate tools (point 1) |
| `/tbox <group> on` / `/tbox <group> off` | enable / disable every toolset in the group (point 2) |
| `/tbox +<toolset> on` / `/tbox +<toolset> off` | enable / disable a single toolset directly (point 2) |
| `/tbox +<toolset>` | describe the toolset (members, state) |
| `/tbox group <name> edit` | curate a group (point 4) |
| `/tbox group <name> remove` | delete the group from the global store |
| `/tbox group list` | list every group with its toolsets |
| `/tbox group <name>` | describe a single group (members, actuation hint) |
| `/tbox focus <group>` / `/tbox focus +<toolset>` | enter focus on a group or toolset (point 2) |
| `/tbox focus off` | exit focus → flip inclusion back to exclusion, restore defaults |
| `/tbox all on` / `/tbox all off` | enable all / disable all non-builtin tools (point 7) |
| `/tbox chars` | print the serialized char count of the active tool set (point 5) |
| `/tbox status` | full status: toolsets, groups, focus, char count |

## The 7-point surface

### 1. Listing tools

`/tbox list` enumerates every registered tool. Three views:

- **(default, grouped):** tools grouped by their toolset. Overlapping
  toolsets resolve by **smallest-toolset-wins** — each tool appears under
  its most specific (smallest) toolset only, no duplication. `portal.learn`
  (members: `web-learn`) shows `web-learn` under `learn`; `portal.web`'s
  members show under `web`. A tool in no registered toolset shows under
  its `tbox.tool@<source>` toolset — one per unclaimed-source plugin
  (see point 7). Each group header reports `(a active, b inactive,
  +c chars)` — the full toolset's state and char contribution (extension
  tools only); a footer total reconciles with `/tbox chars`'s `tools`
  bucket.
- **`--flat`:** every tool as a row, no grouping. Tools outside
  tbox's domain (see point 7 — `sdk`-source tools) appear as
  read-only rows so the user sees they exist and understands why they
  can't be toggled, but they carry no enable/disable affordance.
- **`--by-chars`:** budgeting surface — a flat list of toolsets (no tool
  rows) sorted by `+chars` descending, so the most expensive toolsets to
  disable float to the top. Excludes builtins (non-togglable floor).
  `--by-chars --active` hides fully-disabled groups.

Filters: `--active` (only currently enabled), `--inactive` (only
disabled). Both filters work in all views.

The grouped view shows each tool under its smallest
toolset only, no duplication. Every toolset renders its members
as individual rows. A tool in no registered toolset
shows under its `tbox.tool@<source>` toolset.

### 2. User groups + focus

A **user group** is a curated, named set of whole toolsets stored in
tbox's own user config (`{ toolsets: string[] }` — there is no per-tool
field; pi-tool-masking has no per-tool persist primitive, so a per-tool
field would collapse to its containing toolset at actuation). The
library never knows what a group is. `/tbox <group> on` resolves the
group → its toolsets → calls `toolset.enable/disable` per member; focus
additionally flips the library's default-resolution mode to inclusion.

**`requires` closure at curation.** The portal graph
(`portal.learn requires portal.web`) leaks into curation: a group
containing `{portal.learn}` but not `portal.web` is incoherent, because
enabling learn silently pulls web on via the library's forward cascade
(§4.4). Tbox makes this visible at curation time by auto-maintaining the
closure in **both directions**:

- Check `portal.learn` → `portal.web` auto-checks (forward closure).
- Uncheck `portal.web` while `portal.learn` is checked → `portal.learn`
  auto-unchecks (reverse closure).

The curated group is then always a closed set under the dependency
graph, so `/tbox <group> on` enables exactly what's visible — no hidden
enables.

**Disable cascade reaches outside the group — and tbox can't stop it.**
`/tbox <group> off` on a `{portal.web}`-only group disables web, which
the library's reverse cascade extends to *every* dependent of web
(`portal.learn`) regardless of whether learn is in the group. This is
inherent to the peer-composition invariant (§9) and unfixable at the
tbox layer. Tbox surfaces it: post-actuation status reports everything
that actually moved, including cascaded non-members.

**Drift model (point 6).** The library persists per-toolset `{ enabled }`
entries, not "this group is active." So enabling a group writes those
entries; editing the group later does **not** retroactively change
saved sessions — only the resulting per-toolset state was stored. Drift
is inherent to `on`/`off` and the user re-adjusts with `/tbox` commands.
**Focus is drift-free** by design: inclusion mode (§4.5) makes unknown
toolsets default off, so a focus snapshot survives new-extension installs
without re-applying. This asymmetry is documented to users: `on`/`off`
can drift, `focus` won't.

**Focus arity: single-unit.** `/tbox focus <group>` resolves the group;
`/tbox focus +<toolset>` resolves the toolset directly. One label,
clean allowlist. Multi-unit focus deferred.

**Mutual exclusion with actuation commands.** While focus is active,
the three actuation entry points (`all on|off`, `<group> on|off`, `+<toolset> on|off`)
are refused with a message pointing to `/tbox focus off`. Focus is an
inclusion-mode snapshot that promises a known working set (the allowlist).
If the user could toggle individual toolsets on/off while the slot still
claims `● focus:<unit> (n)`, the active set would diverge from what the slot
advertises — the slot would lie. `group edit` (config-only),
`list`/`status`/`chars` (read-only), and `focus <other-unit>` (re-focus,
still a coherent focus state) are all unguarded. After `focus off` the
actuation commands work normally again.

**Builtins are out of tbox's management scope.** Builtins are never
the subject of a group, focus, or direct toolset operation; they are always
preserved. Unlike the old approach where tbox auto-registered
`pi.builtin` as a toolset and explicitly guarded it, builtins are now
excluded from registry registration entirely — they live outside
tbox's domain (tracked by `sourceInfo.source === "builtin"` rather than
by toolset membership). Because builtins never appear in
`getRegisteredToolsets()`, inclusion-mode focus can never disable them:
they're invisible to both the enable and disable passes. No drift gap.

Three rules follow:
(a) groups never contain builtins (a group that can mass-disable
builtins is the point-3 footgun through the back door — a group of
always-on builtins is meaningless for `on` and dangerous for `off`);
(b) focus never targets builtins (`/tbox focus pi.builtin` errors on
the reserved id `pi.builtin`, which can never be a user group or
toolset name); (c) the picker never offers builtins as rows.
(Former rule (d), checking `/tbox toggle <builtin>`, was removed with
the toggle command itself.)

**Focus exit is re-actuation, not a mode flip.** `/tbox focus off` does
more than flip inclusion→exclusion: while in focus, tbox writes
`{ enabled: false }` entries for every non-allowlist toolset (the
library's `_applyDisable`). Restore honors a persisted entry regardless
of mode — an entry always wins (§4.5) — so flipping the mode bit alone
leaves those toolsets stuck off. The `ExtensionAPI` surface exposes
only `appendEntry`, no `removeEntry`/clear, so tbox cannot delete the
focus-era entries either. The exit path must therefore **re-actuate**:
for every registered toolset, call `enable()`/`disable()` to drive it
back to `spec.defaultEnabled`, overwriting the focus-era entries with
the default's `{ enabled }`. "Restore defaults" means each toolset
returns to `spec.defaultEnabled` (the library never remembers
pre-focus state — confirmed in code). This is a confirmed implementation
requirement, not a TBD.

**Curation re-walks the `requires` graph; keep it in one place.** The
both-direction closure above needs the `requires` graph from registry
specs. The library does not export a graph helper — the forward/reverse
walks live privately in `_enableToolset`/`_disableDependents` — so tbox
re-implements them. This is consistent with the design split (curation is
tbox-owned "user intent"), but the duplicated logic must live in one
shared helper inside tbox, not be inlined per command.

### 3. Default guards

Tbox has one mode. Two guards are unconditional — there is no escape
hatch and no runtime toggle:

1. **Pi builtin tools are protected.** Builtins live outside
tbox's toolset registry entirely (tracked by `sourceInfo.source ===
"builtin"`, not by toolset membership). Because builtins never
appear in `getRegisteredToolsets()`, inclusion-mode focus can
never disable them and no actuation pass (`actuateToolset`,
`actuateGroup`, `toggleAll`) can reach them. The `/tbox all off`
safety skip is a defense-in-depth layer — builtins are always-on
by nature; grouping them is meaningless for `on` and dangerous for
`off`, and a newly shipped Pi builtin must stay active during focus.
2. **Toolset members are not individually toggleable when the
toolset itself is toggled.** Tbox toggles toolsets as units —
toggling one toolset does not toggle its members independently.
The group is the natural addressability boundary; individual member
toggles are not needed because the toolset itself is the
user-facing unit.

### 4. Group editing UX

Curating a group (`/tbox group <name> edit`) opens a windowed,
searchable, keyboard-driven TUI component (`GroupEditorComponent`)
mounted through pi's documented `ctx.ui.custom<T>(factory)` extension
API. It mirrors the shape of pi's internal scoped-models picker using
only **public** `@earendil-works/pi-tui` primitives — no reach into
pi's interactive-mode internals (those are not re-exported from the
SDK and would break across updates). Requires interactive (`tui`) mode.

**One granularity: toolsets only.** Every addressable unit is one
check row per toolset. There are no member rows —
pi-tool-masking has no per-tool persist primitive, so per-tool rows
would collapse to the containing toolset at actuation. Builtins are
not shown (protected, out of scope — point 2/3).

**`requires` closure auto-maintained** (point 2): checking a toolset
forward-closes its deps; unchecking reverse-closes dependents. Cues
render inline in the component footer (`auto-checked: ...` /
`auto-unchecked: ...`), fading on the next keypress.

**Keyboard** (all remappable via user keybindings): `↑`/`↓` navigate,
Enter toggle, Ctrl+A enable all, Ctrl+X clear all, Ctrl+S save, Esc /
Ctrl+C cancel (clears search first if a filter is active). The list is
windowed (`maxVisible = 8`) with a fuzzy-filter search input, so it
never exceeds the viewport regardless of how many toolsets exist.

**`emitMemberEvents` is not used by the MVP picker.** The library offers
`spec.emitMemberEvents` (§13.1) for per-tool UI fanout on enable/disable.
The picker derives membership from `getRegisteredToolsets()` and
refreshes on `TOOLSET_EVENTS.changed`/`restored`, which is sufficient —
fine-grained per-member events are YAGNI for the MVP. Deferred without
prejudice: if the picker later needs live per-row animations, this is the
knob.

### 5. Char counter

`/tbox chars` prints the serialized character count of the current
active tool set. Computed from `pi.getAllTools()` full definitions
(verified: each tool exposes `name`, `description`, `parameters` [JSON
schema], `promptGuidelines`, `sourceInfo`) — serialize each enabled
tool's fields and sum (all active tools, including builtin and sdk —
the honest serialized size of what the LLM sees). Accurate, no upstream
ask. **The output is a core/extension split** (`core` = builtin+sdk floor,
`extension` = togglable extension budget, total reported), turning the
number into a decision tool: builtins are immutable overhead, extension
tools are your budget. Folded into the status slot only indirectly (see
status slot below); the command is the on-demand surface.

### 6. Session drift (scoping)

User groups are entirely scoped to tbox. They store references to the
base components from `pi-tool-masking` (toolset ids, tool names) in
tbox's own user config. A session saves the **per-toolset state** at the
time (via the library's `toolset-state:<id>` entries) and can drift if
the user updates their group selections later. The user manually adjusts
state with `/tbox` commands. Focus (inclusion mode) is the exception —
it's drift-free by library design (§4.5).

### 7. Enable/disable all

`/tbox all on` enables every registered toolset. `/tbox all off`
disables every non-builtin toolset (builtins protected by point 3).

**Auto-registration of orphan toolsets.** Tools that belong to
no registered toolset can't be persistently toggled through the library
(the library persists state per toolset, and a raw `setActiveTools`
filter won't survive restore). Tbox fixes this by auto-registering
toolsets for them at load. tbox's domain is **extension tools only** —
it mirrors pi's own canonical discriminator (docs: `extensions.md`
§"pi.getAllTools()", `all.filter((t) => t.sourceInfo.source !== "builtin"
&& t.sourceInfo.source !== "sdk")`). The three `sourceInfo.source`
categories pi exposes:

- `builtin` — built-in tools. Protected (point 3).
- `sdk` — tools injected by a host embedding pi via
  `createAgentSession({ customTools })`. **Outside tbox's domain.**
- extension source metadata — tools registered by pi extensions.
  These are what tbox manages.

Registered toolsets at load:

- **`pi.builtin`** — excluded from registry registration entirely.
  Builtins are tracked by `sourceInfo.source === "builtin"` and kept
  active by tbox's source-based guards (never registered into any
  toolset, so no actuation pass can reach them) — they
  never enter the registry as a toolset, so inclusion-mode focus
  never touches them. No hardcoded list, no drift.
- **`tbox.tool@<source>`** — one toolset per distinct unclaimed
  `sourceInfo.source` among extension tools
  (`source !== "builtin" && source !== "sdk"`) not in any plugin-declared
  toolset. Registered the same way so they persist through the library
  like any other toolset. The `@<source>` key makes each such plugin an
  individually focusable unit — a plugin that only registers tools
  (e.g. pi-lens) gets the same focus granularity as one that calls
  `defineToolset`. The user-facing id `tbox.tool@<source>`'s
  naming mirrors `pi.builtin`'s singular-category-noun shape
  (one entry per source category) and hides whether the
  plugin opted into the library's vocabulary. `label` is derived from
  `<source>` (the plugin id); `description` is passed through from the
  tool only when the source contributes exactly one tool (the common
  single-tool-plugin case gets a real description for free), otherwise
  omitted — the grouped view already shows members, so a missing
  description costs nothing and misrepresenting one tool's description
  as the group's would mislabel the others.
- **`sdk`-source tools are not registered into any toolset**, not
  toggleable via `/tbox <group> on|off`, `/tbox +<toolset>`, or `/tbox all`,
  and not counted in the status slot's excluded count. They appear as
  read-only rows in `/tbox list --flat` (point 1). Rationale: an sdk
  tool's presence is controlled by the host, not the extension system;
  persisting `{ enabled }` state for a toolset whose membership the host
  may swap next session is semantically broken, and `/tbox all off`
  must not clobber host intent (e.g. a deliberately-restricted
  read-only session's `customTools`). sdk tools are not guaranteed
  present next session. If a future need arises, a future escalation
  can add sdk toggling — YAGNI now.

Everything routes through the frozen library API (including
`getRegisteredToolsets()`); no new persist shape, and tbox never touches
`globalThis.__piToolMaskingRegistry` directly.

## Status slot

Tbox owns one status-bar slot (`tbox`). Four states, one glance each:

| State | Glyph | Color | Meaning |
|---|---|---|---|
| Exclusion, nothing excluded | `○ tbox` | dim/default | pristine — all defaults, nothing toggled |
| Exclusion, n tools excluded | `● tbox n masked` | blue (accent) | exclusion mode, n non-builtin tools masked (turned off) |
| Focus on | `● focus:<unit> (n)` | green (success) | deliberate focus mode engaged; n = active extension tools in the focus set |
| Focus on, empty allowlist | `● focus:∅` | red (error) | focus is on but nothing's allowed — broken |

Color semantics: dim = pristine, blue = configured-normal (matches
portal's `● idle` accent — "tools on, normal operation"), green =
deliberately-constrained (matches portal's learn-mode green — "user
chose this mode and it's holding"), red = broken (matches search's
unreachable red). No color is overloaded.

The excluded-count (`n`) is **non-builtin, non-sdk** excluded tools —
i.e. extension tools tbox actually manages (registered toolsets
containing them). Computed as `getAllTools()` (filtered to `source
!== "builtin" && source !== "sdk"`) minus `getActiveTools()`.
Updates on every toggle via the `TOOLSET_EVENTS.changed`/`restored`
listeners tbox wires for the slot. A user who's excluded only builtins or
sdk tools (unusual) sees `○ tbox`; a user who's excluded 3 real
extension tools sees `● tbox 3 masked`. The unit word `masked` (chosen
over `off`/`hidden`/`N/M`) names what tbox did to the tools, not tbox's
own state — `● tbox 3 off` would parse as "tbox is off" on a glance,
and a bare denominator resolves no ambiguity. A count of 0 still renders
pristine `○ tbox`, not `● tbox 0 masked`.

The slot shows focus state only — **not** the char count. `/tbox chars`
is the on-demand surface for the count. Budget awareness during focus is
valuable but the slot stays semantic; the count is ephemeral.

`ctx.ui` capture follows the documented pattern (§6 of `design.md`):
capture from `session_start`, call `render()` at the end of the capture
handler so the first paint lands on post-restore state regardless of
handler registration order. Slot cleared on `session_shutdown` (tbox
owns it).

## Edge case: web + learn (portal)

The "cohesive web group with a separate learn tool" case needs no
library expansion. Portal registers two toolsets:

- `portal.web` = {browser-navigate, browser-click, …}
- `portal.learn` = {web-learn}, `requires: ["portal.web"]`

The `requires` cascade (§4.4) gives every composition for free:

- `/tbox portal.web on` + `portal.learn off` → base web only
- `/tbox portal.learn on` → pulls web on via requires → "learn mode"
- `/tbox portal.web off` → cascades learn off via requires → no web

Two toolsets, one dependency edge, zero new mechanism. Tbox exposes both
as addressable units; the library handles the composition.

## Decision summary

| Area | Decision |
|---|---|
| Registry enumeration | library exports typed `getRegisteredToolsets()` + `RegistryEntry`; tbox reads registered toolsets through it, never via `globalThis` |
| Orphans/builtins | builtins are excluded from the registry entirely (protected by source checks in actuateToolset/focusUnit/toggleAll); one `tbox.tool@<source>` toolset per distinct unclaimed extension source (extension tools: `source !== "builtin" && source !== "sdk"`); `sdk`-source tools excluded from management and the slot count; all persist through the library |
| Group editing | one row per toolset; members not individually addressable; `requires` closure auto-maintained |
| Overlapping toolsets | smallest-toolset-wins, no duplication in grouped view |
| Requires at curation | both-direction closure (check dep → forward; uncheck dep → reverse); cues inline in the picker footer |
| Command collisions | reserved words rejected at group creation; `+` prefix for toolset addressing; bare `<group>` always a group, `+<toolset>` always a toolset |
| Focus | single-unit; green glyph; drift-free via inclusion mode |
| Status slot | `○ tbox` pristine / `● tbox n masked` blue / `● focus:<unit> (n)` green / `● focus:∅` red |
| Char counter | `/tbox chars` command, computed from `getAllTools()` full defs |
| Session drift | per-toolset state persists; group edits don't retroact; `on`/`off` drift, `focus` doesn't |
| MVP scope | expanded to all 7 points |

## API verification (confirmed against pi)

- **`pi.getAllTools()` exposes full definitions** — `name`,
  `description`, `parameters` (JSON schema), `promptGuidelines`,
  `sourceInfo`. `/tbox chars` can serialize and sum accurately. No
  upstream ask. (Source: `docs/extensions.md` §"pi.getAllTools()")
- **Builtin identification is in tool metadata** —
  `sourceInfo.source === "builtin"` is the exact discriminator; the docs
  show the canonical `all.filter((t) => t.sourceInfo.source === "builtin")`
  pattern. No hardcoded list, no `pi.getBuiltinTools()` needed.
- **`sdk` is a distinct third source category** — the docs
  (`extensions.md` §"pi.getAllTools()") list `builtin`, `sdk` (tools
  from `createAgentSession({ customTools })`), and extension metadata,
  and show the two-sided exclusion `source !== "builtin" &&
  source !== "sdk"` as the canonical "extension tools" filter. tbox's
  domain follows this: point 7 registers extension orphans (no builtins)
  and excludes sdk tools from management, and the status slot's
  `n` counts non-builtin/non-sdk excluded only.
- **Registry enumeration is exported and frozen** — the §5 exports
  include the typed `getRegisteredToolsets()` accessor and `RegistryEntry`
  interface. tbox reads registered toolsets through it, never via the
  internal `globalThis.__piToolMaskingRegistry` (design §6.1, §13).

## MVP scope

**Expanded to all 7 points.** The MVP ships groups, focus, the picker,
and the char counter together. This validates more of the frozen
library API against a real consumer before publish (the stated reason
for building the manager early, per `implementation-plan.md`). The cost
is more surface to get right under review; the benefit is de-risking
the whole API surface. (The `/tbox toggle` subcommand was shipped in
Sprint 2 and later removed, shrinking the original 8-point surface to
7 — see the group-API revision.)

## Open for implementation

- ~~Final reserved-wordlist (seed set above; may grow).~~ — **resolved
  (group-API revision):** `edit`/`remove` added as reserved words;
  `toggle` removed from the set when the toggle command was deleted;
  `containsPlus()` helper enforces that group names never contain `+`.
- ~~Group config storage shape in tbox's user config~~ — **resolved
  (revised):** groups are **global/user-scoped** in a dedicated file
  `~/.pi/agent/pi-tbox/groups.json` (the groups table directly, no
  wrapper key); `GroupSpec = { toolsets: string[] }` (whole-toolset
  units only). Revised from the earlier `tbox.groups` key in merged
  settings — that wrote per-project and conflated user data with
  pi-core config. Repo-scoped *actuation defaults*, if ever needed,
  would name global groups in `.pi/settings.json` without redefining
  them. See `manager-sprints.md` Sprint 3.
- ~~Whether `tbox.tool` is one catch-all or per-source-plugin groupings~~
  — **resolved:** per-source (`tbox.tool@<source>`) is the default. A
  catch-all makes per-plugin focus impossible for plugins that only
  register tools (the `tbox.tool@<source>` shape is what closes that
  asymmetry); see `manager-sprints.md` Sprint 3.5 for the landing.
- ~~`requires`-closure picker interaction details~~ — **resolved:**
  inline footer cues in the `GroupEditorComponent`
  (`auto-checked:` / `auto-unchecked:` one-liner, fading on next
  keypress). See `manager-sprints.md` Sprint 4.
- `emitMemberEvents` left off for the MVP picker (decision recorded in
  point 4); revisit only if live per-row picker animation is needed.
