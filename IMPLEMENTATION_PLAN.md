# Implementation Plan — pi-tbox 0.3.0

Make MCP tools visible and togglable, stop miscounting them as non-togglable
"core", and make the char count honest about codemode.

**Depends on `pi-tool-masking@^2.0.0`** (the runtime-membership raw-mutation
contract on live registry entries, the allowlist-aware `effectiveEnabled`
export, and the `hidden`-exposure fix; the 2.0.0 `inclusion`-mode removal
is a no-op here — tbox source and tests only ever set
`"exclusion"`/`"allowlist"` (`src/focus.ts`). The one vestigial
`setDefaultResolutionMode(pi, "inclusion")` call in
`__tests__/registry-per-source.test.ts` is deleted: it drove nothing (the
test's enable/disable loop acts regardless of mode) and the test passes
unchanged without it. That release ships first — see `pi-tool-masking/IMPLEMENTATION_PLAN.md`,
which is the source of truth for the API contract. MCP support cannot land before
it, because tbox's CI clones only this repo and would otherwise resolve the old
published library.

## Why

Pi 0.99.0 added MCP servers. Their tools are registered by the builtin `mcp`
extension, so `sourceInfo.source === "builtin"` — and `isExtensionTool`
(`src/chars.ts`) excludes `builtin` and `sdk`. Consequences today:

- MCP tools are never registered as toolsets: they cannot be listed, grouped,
  focused, or toggled, even though they are ordinary togglable tools.
- Three surfaces classify togglability via `isExtensionTool`, which is false for
  MCP tools: `computeCharCount` (`src/chars.ts`) counts them as `core`
  ("non-togglable floor"), `activeExtensionChars` (`src/list.ts`) drops them
  from char totals, and `formatStatus`'s `pi.builtin` row lists and counts them
  as builtin.

This is live in the current environment: `/root/.pi/agent/mcp.json` defines
`siyuan` with `exposure: "direct"`, so ~29 `mcp__siyuan__*` tools are declared to
the model on every request. `/tbox list` shows none of them.

Codemode is *not* the trigger here — it is not enabled locally. But under
codemode the char count would misreport in a second way, so this release fixes
both.

## Scope

In:

- One toolset per MCP server, containing only its **declarable** tools.
- Re-scan when MCP membership changes.
- Char-count bucket classification and the static codemode overhead note.
- The shared togglable predicate applied at every classification site —
  `computeCharCount` (`src/chars.ts`), `activeExtensionChars` and
  `formatStatus`'s builtin row (`src/list.ts`) — not just the first.
- README caveats.
- Dependency bump and release guarding.

Out (decided non-goals):

- **No codemode UI.** `codemode`/`codemode-deferred`/`deferred`/`hidden` MCP
  tools are not listed or toggled. They are reachable through codemode/`tool_search`
  and their reachability is `exposure`, which tbox cannot change.
- **No reachability enforcement.** "off" means *not declared and not counted*.
  It does not make a `codemode`/`deferred`-exposure tool script-unreachable.
- **No exposure changes.** tbox toggles activation only.
- No `preserve`/"no opinion" default in the library (avoided by declared-only
  scoping), and no upstream pi changes.

## Design: declared-only scoping

An MCP toolset's members are the server's tools whose `exposure` is declarable
(`direct` or `model-only`). Everything else is excluded.

Why this is the right default rather than a boolean over the whole server:

- `direct` MCP tools are activated by pi at registration (declarable exposure
  and no `defaultActive`, so `_isActivatedOnRegistration` is true,
  `agent-session.ts:3511-3518`). The set is therefore **homogeneous**
  and `defaultEnabled: true` unions already-active members — a no-op. Nothing can
  be force-declared, so no library default change is needed.
- The alternative — one toolset over the whole server — cannot express the mixed
  default: `defaultEnabled: true` would declare the `codemode` tools,
  `false` would undeclare the `direct` ones. Masking's restore actuates every
  registered toolset, so neither value is a no-op.
- "off" for a `direct` tool is a real off: an inactive `direct` tool is neither
  declared nor callable.
- A server with **no** declarable members (the `codemode` default) gets no
  toolset at all — it has nothing tbox can meaningfully toggle. This applies to
  creation only: an **existing** toolset whose set drains to zero stays (see
  step 3).

## Steps

### 1. Detect MCP tools (`src/chars.ts` or a new `src/mcp.ts`)

```ts
export function isMcpTool(tool: ToolInfo): boolean {
	return tool.namespace?.name.startsWith("mcp__") === true;
}
```

Fallback when `namespace` is absent: `sourceInfo.path === "builtin:mcp"` and the
name starts with `mcp__`. Read `namespace`/`exposure` defensively so the code also
runs on pre-0.99 pi, where the fields don't exist (step 8 removes the
`^0.84.4` types pin):

```ts
const exposure = (tool as { exposure?: ToolExposure }).exposure;
```

Capability detection, not a version check: a missing `exposure` is treated as
`direct` (pi's default), and a missing `namespace` means "not an MCP tool". This
keeps pre-0.99 pi working, where MCP does not exist.

`isExtensionTool` **stays as it is.** It is also used by
`autoRegisterBuiltinAndOrphans`, and widening it would group MCP tools into a
bogus `tbox.tool@builtin` orphan toolset.

### 2. Register one declared-only toolset per server (`src/registry.ts`)

Add `registerMcpToolsets(pi): string[]`, called from the same place orphans are
registered:

- Group MCP tools by `namespace.name` (e.g. `mcp__siyuan`).
- Members = tools whose exposure is `direct` or `model-only`
  (`exposure ?? "direct"`). Skip the server when this is empty.
- Toolset id `tbox.mcp@<server>` (namespace name minus the `mcp__` prefix),
  label `mcp__<server>`, persistKey `toolset-state:tbox.mcp@<server>`,
  `defaultEnabled: true`.
- Return newly-registered ids so the caller can actuate them via the existing
  `actuateNewToolsets` helper.

Also make the orphan scan skip MCP tools **explicitly** (they are currently
excluded only as a side effect of the source check), so a future change to
`isExtensionTool` cannot silently create a `tbox.tool@builtin` toolset.

### 3. Re-scan when MCP membership changes (`index.ts`)

MCP servers connect **asynchronously after `session_start`** — the mcp
extension's handler schedules `setImmediate(...).then(loadMcpRuntime).then(createConnection)`
— so the scan in `captureAndRender` runs before their tools exist. Wiring:

- **Primary hook — the per-turn re-scan.** The existing `before_agent_start`
  re-render already fires every turn; make it call the (cheap, idempotent)
  re-scan too. This is the only mechanism that can observe mid-session
  membership changes: MCP tool-list changes arrive as the
  `notifications/tools/list_changed` notification
  (`extensions/mcp/runtime.ts:375-376`), which pi handles by re-registering
  tools internally — no extension event fires, so there is nothing else to
  subscribe to. It cannot catch turn-1 tools: builtin extensions load after
  user extensions (`package-manager.ts` appends `builtin:*` last), so within
  a turn's `before_agent_start` dispatch this handler runs *before* the mcp
  extension's handler — the one that awaits startup connections (bounded by
  `startupWaitMs`, default 10 s). That is fine: the model never misses tools
  (the first prompt waits on startup connections, and `direct` tools are
  activated by pi on registration regardless); only the status listing can
  lag one turn.
- **Optional prompt — `pi.on("mcp_servers_change", ...)`.** This event fires
  only when an extension calls `registerMcpServer`/`unregisterMcpServer`
  (`extensions/runner.ts:457-459`); it never fires for mcp.json servers,
  whose config the builtin extension loads directly
  (`extensions/mcp/index.ts:791-802`). It is therefore useless for the
  motivating mcp.json case; add it only if prompt re-renders for
  extension-registered servers are wanted. Default: skip it (registering it
  on older pi is harmless — the event never fires — but it adds a handler
  for no observed benefit).
- **New server** → `defineToolset` + `actuateNewToolsets`.
- **Existing server whose declarable set changed** → raw mutation of the live
  registry entry: `entry.spec.names = new Set(next)` (masking 2.0.0's documented
  membership-change contract — no `setMembers` method exists; mutating the
  registered spec in place avoids the `defineToolset` warn-and-replace, so no
  handle goes stale and no actuate/persist/emit fires, which is fine here
  because our members are all pi-activated-on-registration `direct`/`model-only`
  tools). Delta-gate on set inequality so an unchanged scan does nothing.
  The mutation site asserts the entry is tbox-managed before writing —
  `spec.id` starts with `tbox.mcp@` or `tbox.tool@` — so a future regression
  that broadens the lookup into a registry-wide scan fails loudly instead of
  silently mutating a foreign declared toolset. Beyond the tripwire, declared
  toolsets are protected by construction: the re-scan looks entries up by ids
  tbox itself generated (never reachable for a foreign id), and masking's
  name-overlap guard keeps MCP tools out of any declared toolset, so no
  declared toolset's `spec.names` can be affected.
  This includes the drain-to-zero case: when every member is re-registered
  `hidden` (pi does this for dropped/disabled MCP tools,
  `extensions/mcp/index.ts:272-285`), write the empty set and keep the toolset.
  No special-casing — the `tbox.mcp@<server> (0 members)` row is a useful
  connectivity/toggle-state diagnostic, prior toggle intent survives the
  emptying (resolution reads `spec.id`, not members) and reapplies if the
  tools return — new toggles while empty are no-ops, since masking's witness
  gate is vacuously satisfied at zero members — and masking has nothing to
  mask with zero members. The empty-set write must not throw or corrupt the live
  registry entry.
- Look handles up via `getRegisteredToolsets()` by id rather than caching them,
  so nothing goes stale across `/reload`.

### 4. Togglable classification (`src/chars.ts`, `src/list.ts`)

MCP tools are togglable, so every classification site must treat them as such.
Introduce one shared predicate and use it at all three sites:

```ts
export function isTogglableTool(tool: ToolInfo): boolean {
	return isExtensionTool(tool) || isMcpTool(tool);
}
```

- `computeCharCount` (`src/chars.ts`): `core` = tools that are not togglable
  (`builtin`/`sdk` that are not MCP); `extension` = `isTogglableTool`.
- `activeExtensionChars` (`src/list.ts:77`): replace the
  `if (!isExtensionTool(tool)) continue;` skip with `isTogglableTool` —
  otherwise an all-MCP toolset renders `+0 chars` and `formatByChars`'s
  `charCount === 0` skip (`src/list.ts:324`) drops it entirely, leaving the
  context cost this release exists to expose invisible.
- `formatStatus` (`src/list.ts:546`): the `pi.builtin` row filters
  `source === "builtin"`, which now includes every `mcp__*` tool; exclude MCP
  tools (`!isMcpTool(t)`) so they appear only under their own toolset row.

Keep `isExtensionTool` unchanged for callers that need the old meaning
(`autoRegisterBuiltinAndOrphans`, the registry scan). The builtin-group branch
in `formatByGroups` (`src/list.ts:230`) needs no change: steps 1–2 claim MCP
tools into their per-server toolset before rendering, so they never reach the
non-toolset group.

### 5. Intent vs observation per use site (`src/groups.ts`, `src/list.ts`,
`src/defaults.ts`, `src/status-slot.ts`)

Masking 2.0.0's inert-toolset contract splits "the toolset is on" into
persisted *intent* (branch entry, `effectiveEnabled`) and *observation*
(`isEnabled()`); the two diverge for inert toolsets — members `hidden`, or the
MCP server not yet connected, the exact case steps 2–3 introduce. Each site
picks the right read:

- **Display and toggle-gating read intent** —
  `effectiveEnabled(spec, branch, readMergedToolsetDefaults())`, with `branch`
  from `ctx.sessionManager.getBranch()` inside the handler. Six observation
  reads of the toolset-state class switch to intent (line numbers verified in
  current source):
  - `src/groups.ts:301` — the "already enabled" toggle guard;
  - `src/groups.ts:307` — the "already disabled" toggle guard, which refuses
    "off" on an intent-on inert toolset (the motivating case);
  - `src/groups.ts:266` — `toggleAll`'s `wasEnabled` gate: `/tbox all off` on
    an intent-on inert toolset currently drops the off entirely (neither
    applied nor persisted) and under-counts the summary; reading intent also
    lets `/tbox all on` skip an already-intent-on inert toolset instead of
    re-appending a duplicate entry;
  - `src/groups.ts:239` — `describeToolset`'s state line;
  - `src/list.ts:538` — the toolset glyph in `/tbox list`;
  - `src/defaults.ts:127` — `defaults capture`, which must capture intent,
    never a mid-session `isEnabled()` snapshot — capturing while a toolset is
    inert would pin a temporary divergence as a permanent misconfiguration.
- **"Is anything actually declared right now?" reads observation** —
  `isEnabled()` (and the active set directly). The char count (step 6)
  already does, and the per-tool glyph (`src/list.ts:405`) stays
  observational: both are declaration-sensitive surfaces, not toolset state —
  switching them to intent would invert the rule the same way reading
  observation for toggle-gating does today. The status-bar slot
  (`src/status-slot.ts`) is in the same bucket and needs no change:
  `computeSlotState` reads `extensionToolCounts` (the active set directly;
  "n masked" is `total − active`), so it is declaration-sensitive by
  construction. Two observation-produced edges, cosmetic and
  self-correcting: an intent-on inert toolset inflates `● tbox n masked`
  ("masked" is observationally true though the user enabled them and no mask
  is suppressing them), and a non-empty but inert allowlist renders
  `focus:∅` because `active === 0` though the allowlist itself is not empty —
  both resolve when members become actuatable, and intent-based counts would
  make the slot lie in the other direction (active counts must describe the
  declared set).
- **`defaults capture` (`src/defaults.ts:127`) captures intent, never a
  mid-session `isEnabled()` snapshot** — see the sixth site above.

### 6. Char count: plain N + static codemode note (`src/chars.ts`)

The count is the serialized definitions of the tools in the active set. It is
**not** a total context meter under codemode, because `prepareLoadout` rewrites
descriptions at request time:

- `codemode.mode: "on"` rewrites the description of **every declared callable
  tool** (builtin, extension and MCP `direct` alike) to the original plus a
  codemode signature block — so the count under-reports, and not only for
  builtins. `getAllTools()` returns the unprojected description, so tbox cannot
  measure the difference.
- `codemode.mode: "only"` additionally hides active `direct` declarations, while
  the codemode description (the catalog, budgeted by `codemode.inlineBudget`,
  default 3000 est. tokens) is in context and equally unmeasurable.

Both directions exist and neither is computable without reproducing codemode's
rendering (`@earendil-works/pi-codemode`, not a host-provided package). No
qualifier on the count is sound in all modes either: `≥ N` holds only under
`"on"` (declarations stay, the catalog is added), but under `"only"` the true
footprint can be far **below** N, since the catalog is budget-capped while the
active `direct` declarations are hidden. So:

- Exclude the `codemode` tool itself from the count.
- Always render N plainly — no `≥`/`≤` qualifier, no mode branching, no
  `pi.getSettings().codemode?.mode` read.
- When `getActiveTools()` includes `codemode`, append one static note: codemode
  rewrites declarations at request time; the catalog is budgeted by
  `codemode.inlineBudget` (default 3000 est. tokens) and every declared
  callable gains a signature line.
- Do **not** print a hardcoded numeric range: the bounds track pi's codemode
  rendering, so a printed range would rot silently on a pi update. Citing the
  budget names the bound instead of guessing it.

### 7. README

- "off" means not declared and not counted; codemode/deferred-exposure tools stay
  script-callable while off, so tbox is context hygiene, not a security boundary.
- The char count reports tool definitions and excludes the codemode
  description; when codemode is active, a static note states the overhead
  (budgeted catalog + per-tool signature lines) instead of a computed estimate.
- MCP: one toolset per server, covering the server's declarable (`direct`/
  `model-only`) tools only. `codemode`/`deferred` MCP tools are managed by pi and
  `/mcp`, and are not listed or toggled here.

### 8. Dependency and release guarding

- Bump `devDependencies["@earendil-works/pi-coding-agent"]` to `^0.99.1` (the
  current pinned `^0.84.4` types have no `exposure`/`namespace`, so the code
  would not typecheck). `peerDependencies` stay `"*"` — pi requires the `"*"`
  convention and disables peer resolution for managed installs, so a stricter
  range would be non-conventional and unenforced.
- During development, point `dependencies["pi-tool-masking"]` at
  `file:../pi-tool-masking` so tests run against the local library (npm symlinks;
  the library ships TS source, so no build step).
- **Add a release guard:** `scripts/release.mjs` (and `prepublishOnly`) must fail
  loudly when `dependencies["pi-tool-masking"]` is not a semver range. Publishing
  a `file:` spec would break every consumer.
- In the release commit, restore the spec to `^2.0.0` and revert the
  `package-lock.json` entry that recorded the file path.
- CHANGELOG `[Unreleased]` → `0.3.0`; `npm run release:minor`.

## Validation

Unit tests (`__tests__`, MockPI, no external services): fabricate MCP-shaped
`ToolInfo` and cover — per-server declared-only toolset creation; a
`codemode`-only server producing no toolset; `entry.spec.names` mutation on a changed server;
a server draining to zero declarable members (empty-set write keeps the
toolset, registry entry stays live; a toggle while empty is a no-op and prior
intent survives);
the re-scan being idempotent; a foreign declared toolset (any id that is not
`tbox.mcp@*`/`tbox.tool@*`, including other `tbox.*` ids) registered before
the re-scan having its `spec.names` byte-identical
afterward (the managed-prefix tripwire guards the one mutation site);
the `core`/`extension` split with MCP tools; `activeExtensionChars` including
MCP tools in the char total (a fully-active MCP toolset survives
`formatByChars`' zero-char skip); `formatStatus`'s builtin row excluding
`mcp__*` tools; the
static codemode note (present when codemode is active, absent otherwise);
graceful degradation when `exposure`/`namespace` are absent; the step-5 intent
fixes (the toggle guard honors "off" on an intent-on inert toolset;
`defaults capture` persists intent, never a mid-session `isEnabled()`
snapshot).

`npm test` and `npm run typecheck` (typecheck runs in CI before tests).

Live QA against the real `siyuan` server:

1. `/tbox list` shows a `mcp__siyuan` toolset with ~29 members.
2. Toggling it off removes those tools from the active/declared set and drops the
   extension count; toggling it back on restores them.
3. The char count no longer counts them as `core`, and `/tbox chars` shows a
   non-zero char total for the `mcp__siyuan` toolset (not dropped by the
   zero-char skip).
4. With `"defaultTools": ["+codemode"]`, the count is followed by the static
   codemode note, with no `≥` qualifier.
5. `/tbox status` lists the MCP tools under `mcp__siyuan`, not in the
   `pi.builtin` row.

The live server is the end-to-end criterion; the mock cannot exercise the async
connect or the real provider-side declaration effect.

## Risks and edge cases

- **Async connect ordering** — the primary risk. Tool-list changes are
  unobservable by extension event (`mcp_servers_change` covers only
  `registerMcpServer`/`unregisterMcpServer`, and mcp.json servers never go
  through it), so the per-turn `before_agent_start` re-scan is the sole
  catch-up: at most one turn of display lag, and no missed tools. Verify
  with live QA.
- **Disabled servers** — their tools are re-registered `hidden`, so they are
  excluded as non-declarable and the server gets no toolset (or loses members).
- **Mid-session membership changes** — handled by raw `entry.spec.names`
  mutation; verify the delta gate keeps an unchanged scan from writing, and that
  `defineToolset`'s warn-and-replace never fires (it would only fire if the
  re-scan re-`defineToolset`s an existing id, which it must not).
- **Focus/allowlist captured before MCP toolsets existed** — the new toolset ids
  are absent from a pre-existing allowlist, so they resolve off; self-heals on the
  next `focus off` / `defaults restore`, matching the documented pattern for
  toolsets added later.
- **Intent vs observation** — masking 2.0.0's inert-toolset contract splits
  "the toolset is on" into persisted *intent* (`effectiveEnabled`) and
  *observation* (`isEnabled()`); the two diverge for inert toolsets (members
  `hidden`, or the MCP server not yet connected — the exact case this release
  introduces). Step 5 assigns the right read per site; the failure it prevents
  is an observation-gated toggle guard refusing "off" on an intent-on inert
  toolset (`src/groups.ts` does this today).
- **Name overlap** — the masking guard means each tool can belong to one toolset;
  MCP tools are claimed only by their per-server toolset.
- **Codemode stays untested live** — codemode is not enabled in this environment;
  its paths are unit-tested only unless a QA pass enables it.
