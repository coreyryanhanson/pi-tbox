# Implementation Plan — pi-tbox 0.3.0

Make MCP tools visible and togglable, stop miscounting them as non-togglable
"core", and make the char count honest about codemode.

**Depends on `pi-tool-masking@^2.0.0`** (the runtime-membership raw-mutation
contract on live registry entries, the allowlist-aware `effectiveEnabled`
export, and the `hidden`-exposure fix). That release ships first (its changes sit on the library's
`CHANGELOG.md` `[Unreleased]`, which — together with the JSDoc on
`getRegisteredToolsets`/`applyToolsetEnabled` in `pi-tool-masking/index.ts` —
is the source of truth for the API contract). MCP support cannot land before
it, because tbox's CI clones only this repo and would otherwise resolve the old
published library.

## Why

Pi 0.99.0 added MCP servers. Their tools are registered by the builtin `mcp`
extension, so `sourceInfo.source === "builtin"` — and `isExtensionTool`
(`src/chars.ts`) excludes `builtin` and `sdk`. Consequences today:

- MCP tools are never registered as toolsets: they cannot be listed, grouped,
  focused, or toggled, even though they are ordinary togglable tools.
- Four surfaces classify togglability by the same builtin/extension split
  (`isExtensionTool`, or `formatStatus`'s `source === "builtin"` filter), and
  all four are false for MCP tools: `computeCharCount` and
  `extensionToolCounts` (`src/chars.ts`) count them as `core` (the latter
  feeding the status bar's masked/focus counts), `activeExtensionChars`
  (`src/list.ts`) drops them from char totals, and `formatStatus`'s
  `pi.builtin` row lists and counts them as builtin.

This is live in the current environment: `/root/.pi/agent/mcp.json` defines
`siyuan` with `exposure: "direct"`, so ~29 `mcp__siyuan__*` tools are declared to
the model on every request. `/tbox list` shows them only as generic rows under
the `pi.builtin` group, with no way to toggle them.

Codemode is *not* the trigger here — it is not enabled locally. But under
codemode the char count would misreport in a second way, so this release fixes
both.

## Scope

In:

- One toolset per MCP server, containing only its **declarable** tools.
- Re-scan when MCP membership changes.
- Char-count bucket classification and the static codemode overhead note.
- The shared togglable predicate applied at every classification site —
  `computeCharCount` and `extensionToolCounts` (`src/chars.ts`),
  `activeExtensionChars` and `formatStatus`'s builtin row (`src/list.ts`) —
  not just the first.
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
- **No per-server ownership for the shared MCP resource tools.**
  `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`
  are registered by the builtin mcp extension with no `namespace` and an
  exposure computed at runtime as the widest of the resources-capable servers
  (`syncResourceTools`, `extensions/mcp/index.ts:426-439`: `direct` when any
  such server is direct, else `codemode`, else `deferred`, and `hidden` when
  none has resources), so there is no per-server owner to attach them to and
  no stable detection hook short of hardcoding the names. They are therefore
  classified as **builtins, not toolset members** — the same read-only bucket
  as builtin/`sdk` tools: the names are the only hardcoded part (a
  `MCP_RESOURCE_TOOL_NAMES` set, step 1); everything else — whether they show
  in the builtin row or nowhere — is observed dynamically from the live tool
  list at render time (step 4). They are never togglable, never join a
  toolset, and their reachability is managed by pi's `/mcp` surface. Upgrade
  path: if upstream ever namespaces these tools, they fall into the existing
  per-server machinery for free.

## Design: declared-only scoping

An MCP toolset's members are the server's tools whose `exposure` is declarable
(`direct`). Everything else is excluded. `McpExposure` is fixed upstream at
`codemode | deferred | direct | hidden` (`core/mcp-servers.ts:16`) and
`toToolExposure` maps `codemode` → `deferred`, so `direct` is the only
declarable exposure an MCP tool can arrive with.

Why this is the right default rather than a boolean over the whole server:

- `direct` MCP tools are activated by pi at registration (declarable exposure
  and no `defaultActive`, so `_isActivatedOnRegistration` is true —
  (`agent-session.ts:3522-3531`). The set is therefore **homogeneous**
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
  creation only: an **existing** toolset whose members all turn non-declarable
  never empties — it keeps its (now-hidden) members in `spec.names` (see
  step 3).

## Steps

### 1. Detect MCP tools (`src/chars.ts` or a new `src/mcp.ts`)

```ts
export function isMcpTool(tool: ToolInfo): boolean {
	return tool.namespace?.name.startsWith("mcp__") === true;
}
```

Read `exposure` defensively so the code also runs on pre-0.99 pi, where the
field doesn't exist (step 8 removes the `^0.84.4` types pin). No `namespace`
fallback is needed: pi sets `namespace` on every MCP tool it registers
(`extensions/mcp/index.ts:353-357` → `extensions/mcp/tools.ts:276`), so a
`sourceInfo.path === "builtin:mcp"` fallback could only fire in a pre-0.99
world where MCP does not exist — dead code, skipped.

```ts
const exposure = (tool as { exposure?: ToolExposure }).exposure;
```

Capability detection, not a version check: a missing `exposure` is treated as
`direct` (pi's default), and a missing `namespace` means "not an MCP tool". This
keeps pre-0.99 pi working, where MCP does not exist.

Alongside it, one shared predicate for *declarable* MCP tools — the single
source of truth for which MCP tools tbox can meaningfully manage. Every MCP
decision site (membership in step 2, re-scanning in step 3, classification in
step 4) goes through it:

```ts
export function isDeclarableMcpTool(tool: ToolInfo): boolean {
	if (!isMcpTool(tool)) return false;
	const exposure = (tool as { exposure?: string }).exposure ?? "direct";
	return exposure === "direct";
}
```

The three shared resource tools get one hardcoded constant — their bare names,
no `mcp__` prefix (`resources.ts:34-35`, `tools.ts:50`) — because they have no
namespace and no per-server owner to derive grouping from:

```ts
export const MCP_RESOURCE_TOOL_NAMES = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

export function isMcpResourceTool(tool: ToolInfo): boolean {
	return (
		tool.sourceInfo?.path === "builtin:mcp" &&
		MCP_RESOURCE_TOOL_NAMES.has(tool.name)
	);
}
```

Note `isMcpResourceTool` deliberately does **not** go through `isMcpTool`:
these tools carry no `namespace`, so `isMcpTool` is false for them — which is
exactly what makes them classify as builtins for free (`isDeclarableMcpTool`
returns false, so the togglable predicate of step 4 never picks them up).
The `builtin:mcp` path gate keeps a same-named tool registered by any other
extension out of the resource-tool classification; only names registered by
the extension that owns them match.
Only the names are hardcoded; their state is never cached — every surface
observes `exposure` and the active set live at render time (step 4). They are
never togglable and never join a toolset.

`isDeclarableMcpTool` — not bare `isMcpTool` — is also what classification must
use (step 4): `getAllTools()` includes `hidden` and `deferred` tools that pi
never activates (`_isActivatedOnRegistration` is false for them,
`agent-session.ts:3529-3531`), so a server with the default `codemode` exposure,
a `/mcp`-disabled server (whose tools are re-registered `hidden`), or any
explicit `toolExposure: "codemode"|"deferred"` override contributes tools that
no toolset covers and the user cannot affect. Classifying those as togglable
would permanently inflate `● tbox n masked` and the char-count buckets with
tools tbox did not mask. The resource tools are the one deliberate exception
to this MCP-only rule: they sit in the builtin bucket (with an exposure gate,
step 4) instead of any toolset.

`isExtensionTool` **stays as it is.** It is also used by
`autoRegisterBuiltinAndOrphans`, and widening it would group MCP tools into a
bogus `tbox.tool@builtin` orphan toolset.

### 2. Register one declared-only toolset per server (`src/registry.ts`)

Add `registerMcpToolsets(pi): string[]`, called from the same place orphans are
registered:

- Group MCP tools by `namespace.name` (e.g. `mcp__siyuan`).
- Members = tools passing `isDeclarableMcpTool` (`exposure ?? "direct"`).
  Skip the server when this is empty.
  The same predicate must be used for membership everywhere — never a bare
  `isMcpTool` — so classification and membership can never drift apart.
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

- **Hook 1 — the per-prompt re-scan.** The existing `before_agent_start`
  re-render already fires on every prompt submission (once per prompt, not
  per turn — a `list_changed` arriving mid-agent-loop is picked up at the
  next prompt); make it call the (cheap, idempotent) re-scan too. Mid-session
  membership changes are observable only through re-scanning: MCP tool-list
  changes arrive as the
  `notifications/tools/list_changed` notification
  (`extensions/mcp/runtime.ts:384-386`), which pi handles by re-registering
  tools internally — no extension event fires, so there is nothing else to
  subscribe to. The handler currently drops its arguments
  (`pi.on("before_agent_start", () => rerenderSlot(pi))`, `index.ts:229`) and
  must take `(event, ctx)` — step 5 needs the branch there anyway. It cannot
  catch first-prompt tools: builtin extensions load after
  user extensions (`package-manager.ts` appends `builtin:*` last), so within
  a prompt's dispatch this handler runs *before* the mcp
  extension's handler — the one that awaits startup connections (bounded by
  `startupWaitMs`, default 10 s). That is fine: the model never misses tools
  (the first prompt waits on startup connections, and `direct` tools are
  activated by pi on registration regardless); only the status listing can
  lag one prompt.
- **Hook 2 — the `/tbox` command path.** Command invocations never pass
  through `before_agent_start`, and the command handler (`index.ts:57-205`)
  never re-scans — so a user who starts a session, waits for the server to
  connect, and runs `/tbox list` sees the pre-MCP world, and
  `/tbox +mcp__siyuan off` answers `No toolset "mcp__siyuan"` until they
  submit a prompt. Call the same idempotent re-scan (register + reconcile)
  at the top of the command dispatch, where `pi` and `ctx` are both in
  scope. This makes every command surface — and the live-QA steps below —
  deterministic instead of prompt-timing dependent.
- **Optional prompt — `pi.on("mcp_servers_change", ...)`.** This event fires
  only when an extension calls `registerMcpServer`/`unregisterMcpServer`
  (`core/extensions/runner.ts:455-460`); it never fires for mcp.json servers,
  whose config the builtin extension loads directly
  (`extensions/mcp/index.ts:951` and `:1173-1175`). It is therefore useless for the
  motivating mcp.json case; add it only if prompt re-renders for
  extension-registered servers are wanted. Default: skip it (registering it
  on older pi is harmless — the event never fires — but it adds a handler
  for no observed benefit).
- **New server** → `defineToolset` + a branch-aware actuate. `actuateNewToolsets`
  is *not* sufficient here as-is: its resolution falls back to
  `getEffectiveDefault` (settings-pin → `defaultEnabled ?? true`), which never
  reads the branch (`pi-tool-masking/index.ts:1386-1395`). Because the server
  connects after `session_start`, the restore never saw this toolset, so for a
  server the user had toggled off in the branch, the new toolset resolves ON
  and stays declared until masking's re-assert removes it at the **next** prompt
  boundary — the same one-prompt leak the mutation-site reconcile below closes,
  on the primary motivating path (resume with a previously-off server). It
  would also make the intent reads of step 5 (`describeToolset`, the status
  glyph) say "off" while the tools are declared. So after `defineToolset`, the
  caller resolves intent directly —
  `effectiveEnabled(spec, ctx.sessionManager.getBranch(), readMergedToolsetDefaults())`
  (allowlist-aware for free) — and when the resolved intent is off, calls
  `applyToolsetEnabled(pi, spec, false)` immediately instead of relying on the
  default resolution. Intent-on needs nothing extra: `actuateNewToolsets`'
  `defaultEnabled: true` union is a no-op over pi-activated `direct` tools.
- **Existing server whose declarable set changed** → raw mutation of the live
  registry entry: `entry.spec.names = new Set(next)` (masking 2.0.0's documented
  membership-change contract — no `setMembers` method exists; mutating the
  registered spec in place avoids the `defineToolset` warn-and-replace, so no
  handle goes stale and no actuate/persist/emit fires). Delta-gate on set
  inequality so an unchanged scan does nothing.
  **Reconcile after the mutation.** The no-actuate trade is not free in one
  direction: pi computes `previousActivatedOnRegistration` from the pre-refresh
  `_toolDefinitions` (`agent-session.ts:3425-3427`, assigned at 3459), so a
  tool that reappears with a declarable exposure is re-activated "like a new
  tool" — and masking's re-assert handler runs before tbox's mutation within
  the same prompt dispatch (tbox's own `before_agent_start` registration
  follows the library's — true whenever at least one extension toolset exists
  at `session_start`, since `autoRegisterBuiltinAndOrphans` runs before the
  `pi.on` in `captureAndRender`; with zero extension toolsets the order
  flips, and the explicit reconcile below makes the outcome identical either
  way), so the re-assert read the *old* member set. Net effect: a
  newly-appearing member of an intent-off toolset is declared for exactly one
  prompt. Fix at the mutation site: when the toolset's persisted intent is off
  (the `effectiveEnabled` read from step 5), call
  `applyToolsetEnabled(pi, spec, false)` immediately after mutating — the
  library's documented immediate-reconcile path — which drops the newcomer
  from the active set in the same prompt. Newly-appearing members of an
  intent-*on* toolset need nothing: they are pi-activated on registration and
  `defaultEnabled: true` unions them.
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
  `extensions/mcp/index.ts:395-398`, `hideTools` at `:403-409`), the scan
  finds zero declarable members but **must not write an empty set** — it
  skips the mutation and leaves the existing `spec.names` untouched (the
  delta gate already skips identical sets; an empty next-set on an existing
  toolset is skipped too). Keeping the hidden members matters for toggling:
  with a non-empty spec whose members are all non-actuatable, masking's
  witness gate (`actuatableNames.length !== spec.names.size`,
  `pi-tool-masking/index.ts:685-695`, `:726-735`) makes `disable()` a
  *persisting* off — a toggle issued while the server is disconnected is
  recorded and holds when the tools return. With an empty spec the gate is
  vacuous (`0 === 0`): the toggle neither applies nor persists, the UI
  reports "Disabled", and the tools come back ON at the next restore once
  the server reconnects. Keeping the members costs nothing: counts and
  classification flow through `isTogglableTool` over `getAllTools()` (step
  4), never through `spec.names`, so hidden members inflate no `n masked`,
  no char-count bucket, and are never declared; the `tbox.mcp@<server>` row
  doubles as the connectivity/toggle-state diagnostic, and prior intent
  (resolution reads `spec.id`, not members) still governs the return path.
  The skip-write must not throw or corrupt the live registry entry.
- Look handles up via `getRegisteredToolsets()` by id rather than caching them,
  so nothing goes stale across `/reload`.

### 4. Togglable classification (`src/chars.ts`, `src/list.ts`)

MCP tools are togglable, so every classification site must treat them as such.
Introduce one shared predicate and use it at all four classification sites:

```ts
export function isTogglableTool(tool: ToolInfo): boolean {
	return isExtensionTool(tool) || isDeclarableMcpTool(tool);
}
```

The resource tools need no extra arm here: `isDeclarableMcpTool` starts with
`isMcpTool`, which never matches them (no `namespace`), so they fall through
to `core`/builtin classification automatically. They are togglable at no site.

The MCP arm must be `isDeclarableMcpTool`, not `isMcpTool`: the counts flow
through `pi.getAllTools()`, which includes `hidden` and `deferred` tools that pi
never activates. Bare `isMcpTool` would count the tools of a `codemode`-exposure
server, a `/mcp`-disabled server, or any `codemode`/`deferred` override as
"masked" forever — they are excluded from toolset membership by design, the user
cannot toggle them, and the plan's own disabled-server risk note would be
contradicted. (Note the asymmetry is deliberate: `formatStatus`'s exclusion
below uses `isMcpTool` because it wants every *per-server* `mcp__*` tool out
of the builtin row — the resource tools, which `isMcpTool` never matches, stay
there by design; the togglable predicate wants only the declarable subset.)

- `computeCharCount` (`src/chars.ts`): `core` = tools that are not togglable
  (`builtin`/`sdk` that are not MCP); `extension` = `isTogglableTool`.
- `extensionToolCounts` (`src/chars.ts:33`): the status bar's `total`/`active`
  counts ("n masked" = `total − active`) flow through `isExtensionTool`, so an
  all-MCP toolset toggled off would leave the slot `○ tbox` pristine with
  `excluded = 0`. Same replacement: count by `isTogglableTool`.
- `activeExtensionChars` (`src/list.ts:77`): replace the
  `if (!isExtensionTool(tool)) continue;` skip with `isTogglableTool` —
  otherwise an all-MCP toolset renders `+0 chars` and `formatByChars`'s
  `charCount === 0` skip (`src/list.ts:324`) drops it entirely, leaving the
  context cost this release exists to expose invisible.
- `formatStatus` (`src/list.ts:546`): the `pi.builtin` row filters
  `source === "builtin"`, which now includes every `mcp__*` tool. Exclude
  per-server MCP tools (`!isMcpTool(t)`) so they appear only under their own
  toolset row — but keep the resource tools: they are builtins by
  classification and render here. Gate them on reachability — include a
  resource tool only while `exposure === "direct"` (`exposure ?? "direct"`) —
  so a deferred/hidden phase (all resource-bearing servers non-direct, or
  none connected) does not list unreachable tools in the row. The row's counts
  derive from the active set, so a gated-out tool contributes no chars and no
  active count either; nothing is hardcoded beyond the names.

Keep `isExtensionTool` unchanged for callers that need the old meaning
(`autoRegisterBuiltinAndOrphans`, the registry scan). The builtin-group branch
in `formatGroupedList` (`src/list.ts:230`) gets the same one gate as
`formatStatus`: per-server MCP tools never reach it (steps 1–2 claim them into
their per-server toolset before rendering), and the resource tools are
intentionally shown there — under the same `exposure === "direct"` gate. This
makes the two views agree by construction and closes the status-vs-list
discrepancy for non-declarable MCP tools.

### 5. Intent vs observation per use site (`src/groups.ts`, `src/list.ts`,
`src/defaults.ts`)

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

  Plumbing: `effectiveEnabled` is the only intent read on the library's
  exported surface — there is no branch-free variant — so `branch` must reach
  functions that today take only `pi`: `describeToolset`, `toggleAll`,
  `actuateToolset` (`src/groups.ts`), `formatStatus` (`src/list.ts`), and
  `handleDefaults` (`src/defaults.ts`). Threading `toggleAll` forces the same
  change on `soloUnit` (`src/focus.ts:180` calls `toggleAll(pi, false)`) and
  its `case "solo"` call site in `index.ts` — add both to the diff.
  `formatGroupedList` needs no `branch`: none of the six sites is inside it
  (`list.ts:538` is inside `formatStatus`), and its step-4 gate is an
  observational exposure check, not an intent read. The pattern
  already exists (`focusOff(pi, ctx.sessionManager.getBranch())` in
  `index.ts`) and `MockPI` exposes `getBranch`, so it is mechanical — but it
  touches every call site and several tests. All six sites consume `.enabled`
  off the `{enabled, persistedEntry}` return, not the object itself.
- **"Is anything actually declared right now?" reads observation** —
  `isEnabled()` (and the active set directly). The char count (step 6)
  already does, and the per-tool glyph (`src/list.ts:405`) stays
  observational: both are declaration-sensitive surfaces, not toolset state —
  switching them to intent would invert the rule the same way reading
  observation for toggle-gating does today. The status-bar slot
  (`src/status-slot.ts`) is in the same bucket and needs no direct change:
  `computeSlotState` reads `extensionToolCounts` (the active set directly;
  "n masked" is `total − active`), so it is declaration-sensitive by
  construction — which only becomes true for MCP tools once step 4 fixes
  `extensionToolCounts` itself; with that fix, an all-MCP toolset toggled off
  correctly raises `n masked`. Two observation-produced edges, cosmetic and
  self-correcting: an intent-on inert toolset inflates `● tbox n masked`
  ("masked" is observationally true though the user enabled them and no mask
  is suppressing them), and a non-empty but inert allowlist renders
  `focus:∅` because `active === 0` though the allowlist itself is not empty —
  both resolve when members become actuatable, and intent-based counts would
  make the slot lie in the other direction (active counts must describe the
  declared set).

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

- Count the `codemode` tool itself like any other builtin — no exclusion. An
  exclusion would have to be applied in both accumulators (`computeCharCount`
  and `formatGroupedList`'s builtin branch) or the two surfaces' `core:` counts
  diverge; and under codemode "on" *every* declared callable's description is
  rewritten anyway, so excluding one tool buys no accuracy. The static note
  carries the honesty instead.
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
- The char count reports tool definitions and does not measure codemode's
  request-time overhead; when codemode is active, a static note states the
  overhead (budgeted catalog + per-tool signature lines) instead of a computed
  estimate.
- MCP: one toolset per server, covering the server's declarable (`direct`)
  tools only. `codemode`/`deferred` MCP tools are managed by pi and
  `/mcp`, and are not listed or toggled here. The three shared resource tools
  (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) have
  no namespace and no per-server owner, so they join no toolset and are never
  togglable — tbox accounts for them as builtins: visible under `pi.builtin` in
  `/tbox list` and `/tbox status` while their exposure is `direct` (i.e. while
  pi declares them), omitted once it drops to `deferred`/`hidden`. Their
  reachability is managed by pi's `/mcp` surface.
- A server that is still connecting at the first prompt has its `direct`
  tools declared for that one prompt despite intent-off (see Risks); the
  create-path reconcile removes them from the next prompt on. State the
  residual; do not paper over it.
- `focus off` and `defaults restore` turn MCP toolsets ON at the packaged
  `defaultEnabled: true` default when no branch entry or settings pin exists —
  the same behavior as any other toolset added after those were captured.
- Sweep the statements this release invalidates, not just append caveats:
  `README.md:63-65` ("core floor (builtins — immutable overhead)"), `:88-89`
  ("n extension tools turned off/active"), `:122` ("disable all non-builtin
  toolsets"), `:170-171` ("Builtins are excluded — they are the non-togglable
  floor"), and `:221-224` ("Pi's builtin tools are always-on and outside
  tbox's scope") all describe the old builtin/extension split. The refined
  rule to write down — here and in `AGENTS.md:109-110` plus `AGENTS.md:49` —
  is **non-declarable ⇒ read-only**: pi-core builtins and host `sdk` tools
  stay read-only because pi does not expose their activation through the
  loadout, while MCP tools are ordinary declarable tools with a real
  `exposure` and are togglable. Without the AGENTS.md update, the next agent
  reading it will "fix" tbox back.

### 8. Dependency and release guarding

- Bump `devDependencies["@earendil-works/pi-coding-agent"]` to `^0.99.1` (the
  current pinned `^0.84.4` types have no `exposure`/`namespace`, so the code
  would not typecheck). `peerDependencies` stay `"*"` — pi requires the `"*"`
  convention and disables peer resolution for managed installs, so a stricter
  range would be non-conventional and unenforced. The bump also breaks
  `npm run typecheck` in `__tests__/mock-pi.ts`, which the touch list must
  include: `ToolInfo.exposure` is required in 0.99.x types
  (`core/extensions/types.ts:2068`) and the mock's `ToolInfo` literal
  (`mock-pi.ts:152-165`) omits it, while `registerTool`'s parameter type
  cannot carry `exposure`/`namespace` — extend the mock to default
  `exposure: info.exposure ?? "direct"`, spread a conditional `namespace`,
  and widen the helper's parameter, so the Validation section's MCP-shaped
  `ToolInfo` fixtures typecheck.
- During development, point `dependencies["pi-tool-masking"]` at
  `file:../pi-tool-masking` so tests run against the local library (npm symlinks;
  the library ships TS source, so no build step). This spec (and its
  `package-lock.json` entry) must **stay uncommitted**: CI runs `npm ci` on a
  clone of this repo alone (`.github/workflows/tests.yml`), so a committed
  `file:` path with no sibling checkout breaks the build.
- **Add a release guard:** `scripts/release.mjs` (and `prepublishOnly`) must fail
  loudly when `dependencies["pi-tool-masking"]` is not a semver range. Publishing
  a `file:` spec would break every consumer.
- Before releasing, restore the spec to `^2.0.0` and **regenerate**
  `package-lock.json` (`npm install --package-lock-only`, or
  `npm i pi-tool-masking@^2.0.0`) once masking 2.0.0 is published — do not
  hand-revert the lock entry: the committed lock records `1.3.0` resolved
  from the registry, and `npm ci` (which CI runs before tests) fails its
  sync check when `package.json` says `^2.0.0` but the lock still points at
  the old version. Commit `package.json` and both lock locations (the root
  `dependencies` entry and the `node_modules/pi-tool-masking` entry), verify
  with a local `npm ci`, then **commit** — `release.mjs` aborts on a dirty
  tree.
- CHANGELOG: draft the `[Unreleased]` entries only — `release.mjs` promotes
  that heading to the version itself, so do not pre-rename it. Then
  `npm run release:minor`.

## Validation

Unit tests (`__tests__`, MockPI, no external services): fabricate MCP-shaped
`ToolInfo` and cover — per-server declared-only toolset creation; a
`codemode`-only server producing no toolset; `entry.spec.names` mutation on a changed server, including the
post-mutation reconcile (a newcomer joining an intent-off toolset is dropped
from the active set in the same prompt, not the next);
a server draining to zero declarable members (the spec keeps its hidden
members instead of emptying, the registry entry stays live; a toggle while
disconnected persists off, and the tools do not come back declared when the
server reconnects);
the re-scan being idempotent from both hook sites (per-prompt, and the
`/tbox` command path — a `/tbox list` issued after the server connects, with
no intervening prompt, shows the per-server toolset and toggle commands
resolve it);
`isTogglableTool` gating on declarable exposure (a `codemode`-exposure server
and a disabled server's `hidden`-re-registered tools are counted neither as
togglable nor as `core` — they inflate no `n masked`, no char-count bucket,
and stay out of `activeExtensionChars`);
the resource tools classifying as builtins (present in the `core` bucket and
the `pi.builtin` rows of both views only while `exposure === "direct"`, absent
from both once it drops to `deferred`/`hidden`, never in any toolset row and
never in `n masked`);
the create-path reconcile (a toolset created mid-session for an intent-off
server is applied off in the same prompt, not the next; an intent-on server's
toolset still actuates normally);
the re-scan being idempotent; a foreign declared toolset (any id that is not
`tbox.mcp@*`/`tbox.tool@*`, including other `tbox.*` ids) registered before
the re-scan having its `spec.names` byte-identical
afterward (the managed-prefix tripwire guards the one mutation site);
the `core`/`extension` split with MCP tools; `activeExtensionChars` including
MCP tools in the char total (a fully-active MCP toolset survives
`formatByChars`' zero-char skip); `formatStatus`'s builtin row excluding
`mcp__*` tools; `extensionToolCounts` including MCP tools (an all-MCP toolset
toggled off raises the slot's `n masked`); the
static codemode note (present when codemode is active, absent otherwise);
the `codemode` tool itself counted as a plain builtin — `core:` agrees between
`/tbox status` (`computeCharCount`) and `/tbox list`'s footer, with no exclusion
divergence; graceful degradation when `exposure`/`namespace` are absent; the step-5 intent
fixes (the toggle guard honors "off" on an intent-on inert toolset;
`defaults capture` persists intent, never a mid-session `isEnabled()`
snapshot).

`npm test` and `npm run typecheck` (typecheck runs in CI before tests).

Live QA against the real `siyuan` server:

1. Run `/tbox list` immediately after session start, before submitting any
   prompt: it shows a `mcp__siyuan` toolset with ~29 members (this confirms
   the command-path re-scan, not just the per-prompt one).
2. Toggling it off removes those tools from the active/declared set and drops the
   extension count; toggling it back on restores them.
3. The char count no longer counts them as `core`, and `/tbox chars` shows a
   non-zero char total for the `mcp__siyuan` toolset (not dropped by the
   zero-char skip).
4. With `"defaultTools": ["+codemode"]`, the count is followed by the static
   codemode note, with no `≥` qualifier.
5. `/tbox status` lists the MCP tools under `mcp__siyuan`, not in the
   `pi.builtin` row.
6. The three resource tools appear under `pi.builtin` in both `/tbox list` and
   `/tbox status` (siyuan is direct-exposure and serves resources), in neither
   view once their exposure drops, and in no toolset row ever.

The live server is the end-to-end criterion; the mock cannot exercise the async
connect or the real provider-side declaration effect.

## Risks and edge cases

- **Async connect ordering** — the primary risk. Tool-list changes are
  unobservable by extension event (`mcp_servers_change` covers only
  `registerMcpServer`/`unregisterMcpServer`, and mcp.json servers never go
  through it), so the per-prompt `before_agent_start` re-scan plus the
  `/tbox` command-path re-scan (step 3, hooks 1–2) are the catch-up: at most
  one prompt of display lag on the status bar, no lag for command surfaces,
  and no missed tools. Verify
  with live QA.
- **Still-connecting servers at the first prompt** — a bounded residual the
  reconcile cannot close: tbox's `before_agent_start` handler runs before the
  mcp extension's, so at first-prompt dispatch a not-yet-connected server has
  no toolset yet; the mcp handler then awaits the connection, pi activates
  the `direct` tools on registration, and `selectedTools` is snapshotted
  after the dispatch (`agent-session.ts:1989-2000`) — so the first prompt
  declares the tools despite intent-off. The create-path reconcile removes
  them from the next prompt on. A `turn_start` hook is not a fix (it fires
  after the loadout snapshot); the residual is one prompt, first connect
  only, and cosmetic.
- **Disabled servers** — their tools are re-registered `hidden`, so they are
  excluded as non-declarable: the server gets no toolset (or loses members),
  and — because step 4's togglable predicate is the same declarable predicate —
  they contribute to no `n masked`/char-count totals either. The classification
  and membership predicates must stay one and the same (`isDeclarableMcpTool`);
  if they ever drift, disabled/codemode-exposure servers inflate the counts
  again.
- **Mid-session membership changes** — handled by raw `entry.spec.names`
  mutation; verify the delta gate keeps an unchanged scan from writing, and that
  `defineToolset`'s warn-and-replace never fires (it would only fire if the
  re-scan re-`defineToolset`s an existing id, which it must not). One leak the
  mutation alone leaves: pi re-activates a reappearing declarable tool
  (`previousActivatedOnRegistration` is computed from pre-refresh definitions,
  and masking's re-assert runs before tbox's mutation in the same turn), so a
  newcomer to an intent-off toolset is declared for one prompt — the
  post-mutation `applyToolsetEnabled` reconcile (step 3) closes it.
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
- **Resource-tool names are upstream-coupled** — detection is by exact bare
  name (`resources.ts:34-35`, `tools.ts:50`). A rename upstream would at worst
  leave a deferred-phase resource tool listed in the builtin rows (the
  exposure gate misses it; cosmetic, one row). Toolsets, toggling, and counts
  are unaffected, since the tools never matched the MCP predicate in the first
  place.
