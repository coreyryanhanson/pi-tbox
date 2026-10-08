<p align="center">
  <img src="assets/tbox-dino.svg" alt="pi-tbox logo — a t-rex stuck in a cardboard box" width="180" />
</p>

<h1 align="center">pi-tbox</h1>

<p align="center">One command surface for every tool your Pi extensions install.</p>

---

## The problem

Every Pi extension you install brings tools. Install a browser, a search
index, a code lens, a few MCP bridges — and suddenly the model has dozens
of tools active at once, each one eating context budget, whether or not
you're using it. Pi has no unified way to see or shape that population:
each plugin is its own world, and turning tools off means digging into each
one individually.

**pi-tbox** is the one surface that sits *across* all of them. It lists
every tool from every extension, lets you toggle whole toolsets at the level
their authors declared them, curate named groups of them, and focus the
model down to just the ones a task needs — with the choice persisting across
reloads and resume.

## What it gives you

A natural progression — each step is the next thing you'd want once you
have the one before it:

1. **See them.** `/tbox list` enumerates every tool across every installed
   extension, grouped by the toolset it belongs to. Tools unclaimed by any
   toolset are grouped per-source, so a plugin that only registers tools
   shows up as one focusable unit just like one that declares toolsets.
2. **Toggle them.** `/tbox +<toolset> on` / `off` flips whole toolsets at
   the level their author declared them — the natural addressability
   boundary, not individual tools. `/tbox all on|off` hits everything at
   once.
3. **Group them.** `/tbox group <name> edit` opens a keyboard-driven
   picker to curate a named collection of toolsets, saved globally so it's
   usable from any directory. Dependency (`requires`) closures are
   auto-maintained both directions — a group is always a coherent closed
   set, so `/tbox research on` enables exactly what's visible, no hidden
   cascades.
4. **Focus on a subset.** `/tbox focus <group>` (or `focus +<toolset>`)
   restricts the model to Pi's builtins plus that one unit, and the choice
   *persists in chat state* — it survives reloads and resume, and survives
   installing new extensions without drifting. `focus off` restores
   defaults; `focus release` exits focus but keeps the live selection, so a
   `/reload` replays what you see. Release can refuse (if the selection
   can't be expressed as toolset state, e.g. a dependency cycle, nothing
   changes), unlike `focus off`.
   Want focus's shape without its lock? `/tbox solo <group>` (or
   `solo +<toolset>`) is equivalent to `all off` + the unit `on` — plain
   per-toolset state, no allowlist, nothing refused afterward.
5. **Pin a baseline.** `/tbox defaults` snapshots live on/off state into
   Pi's settings tier, so a baseline survives `/reload`, resume, *and*
   later global changes. `save` writes a full per-project snapshot (a
   stable repo baseline) or, with `--global`, a sparse diff against each
   toolset's packaged default (a shared tweak layer). `show` lists pins
   from both scopes with attribution, `clear` removes a scope's block,
   and `restore` applies the merged settings to live state now (lifting
   focus).
6. **Glance at the cost.** A status-bar slot shows masking and focus state
   at a glance; `/tbox status` reports a serialized character count split
   into a `core` floor (pi-core builtins, host `sdk` tools, and non-declarable
   tools — the overhead you can't move with `/tbox`) and an `extension`
   budget (declarable MCP tools plus everything else you can actually move).
   When codemode is active, the count carries a static note instead, since
   that overhead isn't measured.

## Quick start

```sh
pi install npm:pi-tbox
```

Then in any Pi session:

```
/tbox            # show current state + brief help
/tbox list       # every tool, grouped by toolset
/tbox status     # toolsets, groups, focus, and char-count split
```

The status slot appears in your bar automatically and updates live as you
toggle. It reflects chat state only: `defaults` writes to settings, so it
doesn't move the slot. Five states:

| Glyph | State | Meaning |
|---|---|---|
| `○ tbox` | pristine | all defaults — nothing toggled, nothing masked |
| `● tbox n masked` | count | exclusion mode, `n` togglable tools turned off |
| `● focus:<unit> (n)` | focus | deliberately constrained to one group/toolset; `n` active extension tools |
| `● focus (n)` | focus-unlabeled | allowlist mode held by another extension (tbox mirror unset); `n` active extension tools |
| `● focus:∅` | focus-empty | focus is on but the allowlist left nothing active — broken |

On top of any state, drift (see **Intent vs. the live set** below) renders
the slot's leading glyph in the warning color: the glyph shape still tells
you which state you're in, the color tells you the live set disagrees with
your declared state; it clears as soon as the two match again.

## Commands

All commands live under the `/tbox` shortcut. Two addressability rules keep
the surface unambiguous: a **`+` prefix means a toolset**, a **bare name
means a group**, so `+find` is always the toolset and `find` is always the
group even if they share a name. Reserved words (`status`, `focus`, `solo`,
`all`, `list`, `group`, `on`, `off`, `edit`, `remove`, `chars`, `defaults`,
`release`, `restore`, `sync`) are rejected at group creation, so bare
`/tbox <group> on|off` always works.

| Command | Effect |
|---|---|
| `/tbox` | current state (slot mirror + brief help) |
| `/tbox list [--flat] [--active|--inactive]` | enumerate tools (see views & filters below) |
| `/tbox chars` | budget view: toolsets ranked by +chars descending |
| `/tbox <group> on` / `off` | enable / disable every toolset in a group |
| `/tbox +<toolset> on` / `off` | enable / disable a single toolset directly |
| `/tbox +<toolset>` | describe the toolset (members, state) |
| `/tbox group <name> edit` | curate a group in the keyboard-driven picker |
| `/tbox group <name> remove` | delete the group |
| `/tbox group <name>` | describe a single group |
| `/tbox group list` | list every group with its toolsets |
| `/tbox focus <group>` / `focus +<toolset>` | enter focus on a group or toolset |
| `/tbox focus off` | exit focus → restore effective defaults |
| `/tbox focus release` | exit focus → keep the live selection (may refuse, leaving state untouched) |
| `/tbox solo <group>` / `solo +<toolset>` | everything off, one unit on (focus without the lock) |
| `/tbox defaults [show]` | list settings-tier pins, annotated by scope |
| `/tbox defaults save [--global]` | snapshot live state into settings (project: full; `--global`: diff vs packaged default) |
| `/tbox defaults clear [--global]` | remove a scope's `toolsetDefaults` block |
| `/tbox defaults restore` | apply settings defaults to live state now (lifts focus) |
| `/tbox all on` / `off` | enable all / disable all registered toolsets (extension and MCP alike) |
| `/tbox sync` | align the live tool set with declared toolset state (see Intent vs. the live set below) |
| `/tbox status` | full status: toolsets, groups, focus, char-count split |

### `/tbox list` views and filters

```
/tbox list [--flat] [--active|--inactive]
  --flat      one row per tool, no grouping
  --active    show only active tools
  --inactive  show only inactive tools
```

Each tool appears once, under the one toolset that claims it — toolsets
cannot overlap, so no resolution rule is needed. `--active` /
`--inactive` narrow the list to only the enabled or disabled tools.

### `/tbox defaults` — settings-tier pins

```
/tbox defaults [show]           list pins from both scopes (default)
/tbox defaults save [--global]  snapshot live on/off into settings
/tbox defaults clear [--global] remove a scope's toolsetDefaults block
/tbox defaults restore          apply settings defaults to live state now
```

`save` writes **project** scope by default — a *full snapshot* pinning
every registered toolset to its live on/off, so a later `restore`
reproduces the save exactly even if global settings later change. With
`--global`, it writes a *sparse diff* against each toolset's packaged
default (`spec.defaultEnabled ?? true`), so the shared file records only
your tweaks vs upstream — project-context state never leaks into the
shared file. `show` reads both scopes and annotates each row `[global]`
or `[project]` (with `(overrides global)` where project shadows a global
pin for the same key). `restore` applies the merged settings to live
state and lifts focus, using the same tombstone-and-apply path as
`focus off`. `--global` is a write-scope flag (save/clear only); `show`
and `restore` already read/apply both scopes, so `--global` is a usage
error there. `save` works during focus — the allowlist selection is
captured either way.

### `/tbox chars` — budget view

```
/tbox chars
```

Flat, ranked list of toolsets sorted by serialized character count
descending (most expensive first). Only toolset rows appear — pi-core
builtins, `sdk` tools, and MCP tools tbox can't toggle are excluded (they
are the non-togglable floor; their chars live in `core`). Toolsets with no
active members (charging +0 chars) are omitted — they're not consuming
budget, so there's nothing to save. No flags. Each line reports the
toolset's active member count and its +chars cost. When codemode is
active, a static note is appended after the computed estimate, since that
overhead isn't measured.

## Concepts

**Toolsets** are the unit extensions declare (or that tbox auto-registers
for plugins that only register tools). A toolset is the addressability
boundary — tbox toggles whole toolsets, not individual members, because
that's the granularity at which state persists. Toolsets from any installed
extension are visible to tbox automatically. Auto-registered (orphan) toolset
ids embed the extension's source: stable and version-normalized for `npm:`
installs, but for git or local-path installs the raw source string is used, so
such ids are machine-local — groups and pins referencing them don't transfer
when the extension is installed from a different path or machine.

**Groups** are *your* named collections of toolsets, stored in tbox's own
config (`{ toolsets: string[] }` — whole toolsets only). The library never
knows what a group is; tbox resolves a group to its toolsets at actuation
time. Curating a group in the picker auto-maintains `requires` closures in
both directions, so a group is always a closed set under the dependency
graph. Groups are global/user-scoped — defined once, usable from any
directory.

**Drift, honestly.** `/tbox <group> on|off` writes per-toolset state at the
moment it runs, so editing a group later doesn't retroactively change
stored state — only the resulting per-toolset state was stored, and you
re-adjust with `/tbox` commands.

**Intent vs. the live set.** What you've declared with `/tbox` (toggles,
pins, focus) and what's actually active can drift apart: another extension
can leak tools back in at a turn boundary, a foreign write can strip a
toolset, or a narrowed `--tools` session can leave members of a toolset
you enabled permanently un-activatable. When they disagree:

- `/tbox list`, `/tbox chars`, and `/tbox status` show a warning bubble
  naming the mismatched toolsets, e.g. `intent mismatch: web (intent
  off, 3 active) — run /tbox sync to align now; ...`.
- The status slot's leading glyph turns warning-colored until declared
  and live match again (focus-empty keeps its error red). The check
  re-runs on every render, so a repair clears it immediately.
- `/tbox sync` aligns the live set with your declared state (under focus,
  with the focus list). It verifies its own write: anything pi
  refuses to activate (e.g. excluded by your session's `--tools` filter)
  is reported back instead of claimed as success. It fixes alignment
  only: if the declared state itself is wrong, change it with toggles
  or `defaults`, not sync.

**Focus** is the exception to that, and a stronger constraint than
toggling: it flips the underlying library into **allowlist mode** so that
only the focused unit's allowlist (plus Pi's builtins) is active, and
*unknown toolsets default off* — the allowlist is a finite,
branch-persisted array, so a toolset registered *after* focus was entered
stays off by construction, and a focus snapshot survives
new-extension installs without re-applying. While focus is active, the
actuation commands (`all on|off`, `<group> on|off`, `+<toolset> on|off`)
are refused — the slot advertises a known working set, and toggling
underneath it would make that promise a lie. Use `focus off` (restore
effective defaults), `focus release` (keep the live selection; may
refuse, see above), or `defaults restore` first.
`focus off` also tombstones stale per-toolset branch entries from before
the focus, so a `/reload` after `off` falls through to settings →
exclusion floor → `defaultEnabled` matching the live state `off` just
produced — no pre-focus toggle can resurface.

**Choosing between them.** For a one-off toggle, use `on`/`off`. For
focus's shape — one unit on, everything else off — as ordinary
per-toolset state with no lock and no allowlist (new toolsets installed
later come back at their packaged default), use `solo`. For a choice that
holds — drift-free, survives new installs — use `focus`. For a baseline
that holds across machines and checkouts, pin it with
`/tbox defaults save`.

**What tbox won't touch.** Pi-core builtins and host `sdk` tools
(`customTools`) stay read-only: pi doesn't expose their activation. MCP
tools are the exception: tbox manages them (see below). Everything else
without a toggle address (the three shared MCP resource tools,
`codemode`/`deferred` MCP tools that `tool_search` loads mid-session,
and extension tools registered with a non-declarable exposure:
`codemode`, `deferred`, or `hidden` when something activates them)
appears read-only under the `pi-managed` group in `/tbox list` and
`/tbox status`, its chars booked to `core`: visible, not togglable.
Persistent control is upstream of tbox: the server's `toolExposure`
config for MCP tools, the extension's `exposure` choice for its own
tools.

### Picker keyboard shortcuts

`/tbox group <name> edit` requires interactive (`tui`) mode. All keys are
remappable through your user keybindings:

| Key | Action |
|---|---|
| `↑` / `↓` | navigate |
| `Enter` | toggle the focused row |
| `Ctrl+A` | enable all (filtered set if search is active) |
| `Ctrl+X` | clear all (filtered set if search is active) |
| `Ctrl+S` | save to config |
| `Esc` / `Ctrl+C` | cancel (clears search first if a filter is active) |

The list is windowed (8 rows) with a fuzzy search input, so it never
exceeds the viewport regardless of how many toolsets exist. Inline footer
cues report auto-checked dependencies (`auto-checked: portal.web (required
by selection)`) and auto-unchecked dependents as you toggle.

## MCP servers

Each MCP server gets one toolset, id `tbox.mcp@<server>` (the picker label
is `mcp__<server>`), covering the server's **declarable** (`direct`-exposure)
tools only: the tools pi declares to the model on every request. Toggling
it off means those tools are *not declared and not counted*; it is context
hygiene, **not a security boundary**: `codemode`/`deferred`-exposure MCP
tools stay script-callable while off, and their reachability is managed by
pi's `/mcp` surface, never by tbox. Persistent control over which tools are
declarable is the server's `toolExposure` config.

Known edges:

- A server connecting mid-session (after startup, a lazy connect, an OAuth
  reconnect) can leave its tools declared for one prompt despite being
  toggled off; tbox removes them at the next prompt. `/tbox list` and the
  other command surfaces always re-scan, so they're never stale.
- A tool whose exposure changes `direct` → `codemode`/`deferred` mid-session
  is dropped from its toolset but stays callable until reload; while active
  it shows read-only under `pi-managed`, its chars booked to `core`.
- `focus off` and `/tbox defaults restore` turn MCP toolsets on at their
  packaged default when no branch entry or settings pin exists, the same
  behavior as any other toolset added after those were captured.

## How state persists

tbox is the user-facing layer; the persistence machinery lives in its
dependency [`pi-tool-masking`](https://github.com/coreyryanhanson/pi-tool-masking),
which owns per-toolset on/off memory, the `requires` cascade, and the
allowlist/exclusion default-resolution mode that makes focus drift-free.
tbox operates entirely through that library's events, so it layers on top
of any installed extension without disrupting the event flow those
extensions already depend on — toggles survive reloads and resume, focus
survives new installs, and nothing reaches into extension internals.

## Config

Groups are stored as user data in
`${PI_CODING_AGENT_DIR ?? ~/.pi/agent}/pi-tbox/groups.json` — the
groups table directly, no wrapper key. A group defined in one directory is
usable from any other.

**Settings-tier defaults** (from `/tbox defaults save`) are written into
Pi's settings files via `pi-tool-masking`: project scope pins land in the
repo's `.pi/settings.json`, `--global` scope pins land in the shared global
settings file. Both store a `toolsetDefaults` block of `{ <persistKey>:
{ enabled: bool } }` entries. `show` reads the merged view across both
scopes; `restore` applies it to live state.

## Subagent integration

By default, pins and toggles apply to your session, not to sessions spawned
by subagent plugins — subagents configure their own tool sets explicitly,
and your pins won't strip tools their frontmatter requests. If you want
settings-tier pins enforced in subagent children too, opt in globally:

```json
{ "piToolMasking": { "childPolicy": "settings" } }
```

Details and caveats are in the
[pi-tool-masking README](https://github.com/coreyryanhanson/pi-tool-masking#subagent-inheritance-child-policy-defer).

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).
