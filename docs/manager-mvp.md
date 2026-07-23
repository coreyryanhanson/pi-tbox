# Manager MVP — `pi-tbox` design

> **Status: APPROVED.** This is the finalized design for the
> user-facing manager extension (`pi-tbox`), reviewed against the
> `pi-tool-masking` library code and tests and the pi extension docs.
> The `pi-tool-masking` library API (§5 of `design.md`) is frozen; this
> doc consumes it. The MVP ships the full 8-point surface below (scope
> expanded from the earlier list+toggle proposal — see "MVP scope" at the
> end).

## Premise

`pi-tbox` is a real pi extension (not the library) that depends on
`pi-tool-masking` and provides the end-user cross-extension tool
management surface. It is the §13 manager from `design.md`, built before
the library is published so the frozen API is validated against a real
consumer.

The library owns *toolset on/off memory*, the `requires` cascade, the
`masked` addressability contract, the inclusion/exclusion
default-resolution mode, and registry enumeration. `pi-tbox` owns
*user intent*: which tools are grouped together, which unit is focused,
how the user sees and toggles everything. The library never learns what a "group" or "focus label" is;
tbox stores those in its own user config and resolves them to library
primitives at actuation time. tbox never reaches into
`globalThis.__piToolMaskingRegistry` directly; it goes through
`getRegisteredToolsets()`.

## Command surface — `/tbox`

All commands live under the `/tbox` shortcut. A reserved-wordlist policy
disambiguates subcommands from user-named groups (point 6 collision
fork): `/tbox <name> on|off` works as the group shorthand **unless**
`<name>` is a reserved subcommand, in which case the subcommand wins and
a user who names a group `focus` gets a clear error pointing at
`/tbox group focus`.

**Reserved words:** `toggle`, `status`, `focus`, `all`, `list`, `chars`,
`dev`, `group`, `on`, `off`. (Finalized during implementation; this is
the seed set.)

| Command | Effect |
|---|---|
| `/tbox` | show current state (slot mirror + brief help) |
| `/tbox list [--grouped\|--flat] [--active\|--inactive]` | enumerate tools (point 1) |
| `/tbox <group> on` / `/tbox <group> off` | toggle a user group (point 2) |
| `/tbox group <name> [on\|off]` | explicit group form (for reserved-name groups) |
| `/tbox group <name> edit` | curate a group (point 4) |
| `/tbox toggle <tool>` | toggle an individual tool (point 6) |
| `/tbox focus <unit>` | enter focus on a group / toolset / tool (point 2) |
| `/tbox focus off` | exit focus → flip inclusion back to exclusion, restore defaults |
| `/tbox all on` / `/tbox all off` | enable all / disable all non-builtin tools (point 8) |
| `/tbox chars` | print the serialized char count of the active tool set (point 5) |
| `/tbox status` | full status: toolsets, groups, focus, dev mode, char count |

## The 8-point surface

### 1. Listing tools

`/tbox list` enumerates every registered tool. Two views:

- **`--grouped` (default):** tools grouped by their toolset. Overlapping
  toolsets resolve by **smallest-toolset-wins** — each tool appears under
  its most specific (smallest) toolset only, no duplication. `portal.learn`
  (members: `web-learn`) shows `web-learn` under `learn`; `portal.web`'s
  members show under `web`. A tool in no registered toolset shows under
  `tbox.orphans` (or `pi.builtin` if it's a builtin — see point 8).
- **`--flat`:** every tool as a row, no grouping. Tools outside
  tbox's domain (see point 8 — `sdk`-source tools) appear as
  read-only rows so the user sees they exist and understands why they
  can't be toggled, but they carry no enable/disable affordance.

Filters: `--active` (only currently enabled), `--inactive` (only
disabled). Both filters work in both views.

The grouped view honors `masked`: a masked toolset renders as one row
(the group) with its members suppressed; an unmasked toolset renders its
members as individual rows. This is the §13.1 addressable-unit
derivation — masked members are not addressable units, so they don't
appear individually.

### 2. User groups + focus

A **user group** is a curated, named set of addressable units (whole
toolsets and/or individual tools) stored in tbox's own user config. The
library never knows what a group is. `/tbox <group> on` resolves the
group → its units → calls `toolset.enable/disable` per member; focus
additionally flips the library's default-resolution mode to inclusion.

**`requires` closure at curation (non-dev mode).** The portal graph
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
enables. **Dev mode skips closure** (raw behavior; the library still
resolves `requires` at actuation, so enabling an unclosed group just
pulls deps on anyway).

**Disable cascade reaches outside the group — and tbox can't stop it.**
`/tbox <group> off` on a `{portal.web}`-only group disables web, which
the library's reverse cascade extends to *every* dependent of web
(`portal.learn`) regardless of whether learn is in the group. This is
inherent to the peer-composition invariant (§9) and unfixable at the
tbox layer. Tbox surfaces it: post-actuation status reports everything
that actually moved, including cascaded non-members.

**Drift model (point 7).** The library persists per-toolset `{ enabled }`
entries, not "this group is active." So enabling a group writes those
entries; editing the group later does **not** retroactively change
saved sessions — only the resulting per-toolset state was stored. Drift
is inherent to `on`/`off` and the user re-adjusts with `/tbox` commands.
**Focus is drift-free** by design: inclusion mode (§4.5) makes unknown
toolsets default off, so a focus snapshot survives new-extension installs
without re-applying. This asymmetry is documented to users: `on`/`off`
can drift, `focus` won't.

**Focus arity: single-unit.** `/tbox focus <one-unit>` — a group, a
toolset, or a single tool. One label, clean allowlist. Multi-unit focus
deferred.

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

### 3. Developer mode + default guards

Developer mode is a single `tbox.dev` boolean in `settings.json`, read at
load (no runtime toggle — toggling it would be unrequested state
machinery, and a settings key is the natural home for a load-time
guard flag). `/tbox status` reports whether it's on. Enabling it lifts
three guards:

1. **Pi builtin tools are their own toolset and untoggleable** unless dev
   mode is on. Tbox auto-registers `pi.builtin` (see point 8) and treats
   it as protected; dev mode exposes it for toggling.
2. **`masked` toolset members are not individually toggleable** unless
   dev mode is on. In normal mode, tbox honors `spec.masked` — a masked
   toolset is a sealed unit (members hidden in the picker, only the
   group toggles). Dev mode lifts masking so members become individually
   addressable and toggleable.
3. (Reserved for future guards as they arise.)

**`masked` is the single source of truth** — no library split into
`masked`+`atomic`. The sealed-unit behavior (`masked: true` = members
hidden AND group-toggled only) is the only behavior any plugin needs.
Off-diagonal cells (visible-but-locked members) have no real consumer;
building them would expand the frozen library for speculation. The work
is **updating portal/host toolset specs to set `masked: true`**, not
expanding the library.

> **Resolved — no library action:** the masking edge case where a plugin
> wants a cohesive group (e.g. `portal.web`) with a sibling standalone
> tool (`portal.learn`) is already handled by `requires` (§4.4) — two
> toolsets, one dependency edge, no new mechanism. See "Edge case:
> web + learn" below.

### 4. Group editing UX

Curating a group (`/tbox group <name> edit`) uses the same UX as setting
pi's scoped models: a filtered list the user checks/unchecked. The
filtered list depends on dev mode:

- **Normal mode:** masked toolsets show as sealed units (one check row);
  individual members are not surfaced. Builtins not shown (protected).
  `requires` closure auto-maintained (point 2).
- **Dev mode:** masked toolsets expand to show individual members as
  checkable rows; builtins surface as toggleable; no closure auto-apply.

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
tool's fields and sum. Accurate, no upstream ask. Folded into the status
slot only indirectly (see status slot below); the command is the
on-demand surface.

### 6. Individual tool toggle

`/tbox toggle <tool>` toggles a single tool. In normal mode, masked
toolset members are not toggleable here (the guard from point 3); dev
mode lifts it. A **short prefix** may be required to avoid namespace
collisions (e.g. `web:click` vs `api:click`) — resolved against
`pi.getAllTools()` names. User-defined groups are the seamless path
(point 2); individual toggle is the power-user escape hatch.

### 7. Session drift (scoping)

User groups are entirely scoped to tbox. They store references to the
base components from `pi-tool-masking` (toolset ids, tool names) in
tbox's own user config. A session saves the **per-toolset state** at the
time (via the library's `toolset-state:<id>` entries) and can drift if
the user updates their group selections later. The user manually adjusts
state with `/tbox` commands. Focus (inclusion mode) is the exception —
it's drift-free by library design (§4.5).

### 8. Enable/disable all

`/tbox all on` enables every registered toolset. `/tbox all off`
disables every non-builtin toolset (builtins protected by point 3).

**Auto-registration of orphan + builtin toolsets.** Tools that belong to
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

- **`pi.builtin`** — scan `pi.getAllTools()`, filter
  `sourceInfo.source === "builtin"`, register those names as the
  `pi.builtin` toolset. This is the point-3 protected toolset. No
  hardcoded list, no drift, no `pi.getBuiltinTools()` upstream ask.
- **`tbox.orphans`** (or per-source-plugin groupings) — extension tools
  (`source !== "builtin" && source !== "sdk"`) not in any plugin-declared
  toolset. Registered the same way so they persist through the library
  like any other toolset.
- **`sdk`-source tools are not registered into any toolset**, not
  toggleable via `/tbox toggle`, `/tbox <group> on|off`, or `/tbox all`,
  and not counted in the status slot's excluded count. They appear as
  read-only rows in `/tbox list --flat` (point 1). Rationale: an sdk
  tool's presence is controlled by the host, not the extension system;
  persisting `{ enabled }` state for a toolset whose membership the host
  may swap next session is semantically broken, and `/tbox all off`
  must not clobber host intent (e.g. a deliberately-restricted
  read-only session's `customTools`). Dev mode does **not** lift this —
  it only unseals `masked` members and exposes `pi.builtin`, both of
  which concern tools that are always present; sdk tools are not
  guaranteed present next session. If a future need arises, a future
  escalation can add sdk toggling — YAGNI now.

Everything routes through the frozen library API (including
`getRegisteredToolsets()`); no new persist shape, and tbox never touches
`globalThis.__piToolMaskingRegistry` directly.

## Status slot

Tbox owns one status-bar slot (`tbox`). Four states, one glance each:

| State | Glyph | Color | Meaning |
|---|---|---|---|
| Exclusion, nothing excluded | `○ tbox` | dim/default | pristine — all defaults, nothing toggled |
| Exclusion, n tools excluded | `● tbox n` | blue (accent) | normal mode, n non-builtin tools turned off |
| Focus on | `● focus:<unit>` | green (success) | deliberate focus mode engaged |
| Focus on, empty allowlist | `● focus:∅` | red (error) | focus is on but nothing's allowed — broken |

Color semantics: dim = pristine, blue = configured-normal (matches
portal's `● idle` accent — "tools on, normal operation"), green =
deliberately-constrained (matches portal's learn-mode green — "user
chose this mode and it's holding"), red = broken (matches search's
unreachable red). No color is overloaded.

The excluded-count (`n`) is **non-builtin, non-sdk** excluded tools —
i.e. extension tools tbox actually manages — computed as `getAllTools()`
(filtered to `source !== "builtin" && source !== "sdk"`) minus
`getActiveTools()`. Excluding sdk tools from the count keeps the number
honest about how many *extension* tools the user turned off (see point 8).
Updates on every toggle via the `TOOLSET_EVENTS.changed`/`restored`
listeners tbox wires for the slot. A user who's excluded only builtins or
sdk tools (unusual) sees `○ tbox`; a user who's excluded 3 real
extension tools sees `● tbox 3`.

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

- `portal.web` = {browser-navigate, browser-click, …}, `masked: true`
- `portal.learn` = {web-learn}, `requires: ["portal.web"]`

The `requires` cascade (§4.4) gives every composition for free:

- `/tbox portal.web on` + `portal.learn off` → base web only
- `/tbox portal.learn on` → pulls web on via requires → "learn mode"
- `/tbox portal.web off` → cascades learn off via requires → no web

Two toolsets, one dependency edge, zero new mechanism. Tbox exposes both
as addressable units (one sealed, one single-member); the library
handles the composition.

## Decision summary

| Area | Decision |
|---|---|
| Registry enumeration | library exports typed `getRegisteredToolsets()` + `RegistryEntry`; tbox reads registered toolsets through it, never via `globalThis` |
| Orphans/builtins | tbox auto-registers `pi.builtin` (via `sourceInfo.source === "builtin"`) + `tbox.orphans` (extension tools: `source !== "builtin" && source !== "sdk"`); `sdk`-source tools excluded from management and the slot count; all persist through the library |
| Masking | `masked` is the single knob (sealed unit); portal/host specs set `masked: true`; dev mode lifts it |
| Overlapping toolsets | smallest-toolset-wins, no duplication in grouped view |
| Requires at curation | both-direction closure (check dep → forward; uncheck dep → reverse); dev mode skips |
| Command collisions | reserved wordlist; `/tbox <group> on` bare for non-reserved |
| Focus | single-unit; green glyph; drift-free via inclusion mode |
| Status slot | `○ tbox` pristine / `● tbox n` blue / `● focus:<unit>` green / `● focus:∅` red |
| Char counter | `/tbox chars` command, computed from `getAllTools()` full defs |
| Session drift | per-toolset state persists; group edits don't retroact; `on`/`off` drift, `focus` doesn't |
| MVP scope | expanded to all 8 points |

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
  domain follows this: point 8 registers only `builtin` + extension
  orphans, excludes sdk tools from management, and the status slot's
  `n` counts non-builtin/non-sdk excluded only.
- **Registry enumeration is exported and frozen** — the §5 exports
  include the typed `getRegisteredToolsets()` accessor and `RegistryEntry`
  interface. tbox reads registered toolsets through it, never via the
  internal `globalThis.__piToolMaskingRegistry` (design §6.1, §13).

## MVP scope

**Expanded to all 8 points.** The earlier list+toggle proposal is
superseded — the MVP ships groups, focus, the picker, dev mode, and the
char counter together. This validates more of the frozen library API
against a real consumer before publish (the stated reason for building
the manager early, per `implementation-plan.md`). The cost is more
surface to get right under review; the benefit is de-risking the whole
API surface, not just list+toggle.

## Open for implementation

- Final reserved-wordlist (seed set above; may grow).
- Group config storage shape in tbox's user config (tbox-owned, not
  library).
- Whether `tbox.orphans` is one catch-all or per-source-plugin groupings
  (per-source is more informative in the grouped view; one catch-all is
  simpler).
- `requires`-closure picker interaction details (how the auto-check /
  auto-uncheck surfaces to the user — animated? logged? silent?).
- `emitMemberEvents` left off for the MVP picker (decision recorded in
  point 4); revisit only if live per-row picker animation is needed.
