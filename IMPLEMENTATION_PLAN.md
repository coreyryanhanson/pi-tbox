# Implementation Plan — pi-tbox 0.3.0

Make MCP tools visible and togglable, stop miscounting them as non-togglable
"core", and make the char count honest about codemode.

**Depends on `pi-tool-masking@^1.4.0`** (`Toolset.setMembers`, `hidden`-exposure
fix). That release ships first — see `pi-tool-masking/IMPLEMENTATION_PLAN.md`,
which is the source of truth for the API contract. MCP support cannot land before
it, because tbox's CI clones only this repo and would otherwise resolve the old
published library.

## Why

Pi 0.99.0 added MCP servers. Their tools are registered by the builtin `mcp`
extension, so `sourceInfo.source === "builtin"` — and `isExtensionTool`
(`src/chars.ts`) excludes `builtin` and `sdk`. Consequences today:

- MCP tools are never registered as toolsets: they cannot be listed, grouped,
  focused, or toggled, even though they are ordinary togglable tools.
- `computeCharCount` classifies them as `core` ("non-togglable floor"), so the
  status line mislabels them.

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
- Char-count bucket classification and the codemode lower-bound label.
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

- `direct` MCP tools are activated by pi at registration (`defaultActive` is unset,
  so `_isActivatedOnRegistration` is true). The set is therefore **homogeneous**
  and `defaultEnabled: true` unions already-active members — a no-op. Nothing can
  be force-declared, so no library default change is needed.
- The alternative — one toolset over the whole server — cannot express the mixed
  default: `defaultEnabled: true` would declare the `codemode` tools,
  `false` would undeclare the `direct` ones. Masking's restore actuates every
  registered toolset, so neither value is a no-op.
- "off" for a `direct` tool is a real off: an inactive `direct` tool is neither
  declared nor callable.
- A server with **no** declarable members (the `codemode` default) gets no
  toolset at all — it has nothing tbox can meaningfully toggle.

## Steps

### 1. Detect MCP tools (`src/chars.ts` or a new `src/mcp.ts`)

```ts
export function isMcpTool(tool: ToolInfo): boolean {
	return tool.namespace?.name.startsWith("mcp__") === true;
}
```

Fallback when `namespace` is absent: `sourceInfo.path === "builtin:mcp"` and the
name starts with `mcp__`. Read `namespace`/`exposure` defensively so the code
compiles against the current `^0.84.4` types:

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

- **Primary hook:** `pi.on("mcp_servers_change", ...)` → re-scan, then re-render
  the status slot. Registered once, from `session_start` (like the existing
  `before_agent_start` re-render), so it runs after extensions are bound.
- **Defensive hook:** the existing `before_agent_start` re-render already fires
  every turn; make it call the (cheap, idempotent) re-scan too. It cannot catch
  turn-1 tools: builtin extensions load after user extensions
  (`package-manager.ts` appends `builtin:*` last), so within a turn's
  `before_agent_start` dispatch this handler runs *before* the mcp extension's
  handler — the one that awaits startup connections (bounded by
  `startupWaitMs`, default 10 s). That is fine: the primary
  `mcp_servers_change` hook fires as each startup connection completes, and
  `direct` MCP tools are activated by pi on registration regardless, so at
  worst the status listing lags one turn.
- **New server** → `defineToolset` + `actuateNewToolsets`.
- **Existing server whose declarable set changed** → `toolset.setMembers(pi, next)`.
  Delta-gate on set inequality so an unchanged scan does nothing.
- Look handles up via `getRegisteredToolsets()` by id rather than caching them,
  so nothing goes stale across `/reload`.
- Registering the event handler on older pi is harmless: the event never fires.

### 4. Bucket fix (`src/chars.ts`)

MCP tools are togglable, so they must not be counted as `core`.

- `core` = tools that are neither extension tools nor MCP tools
  (`builtin`/`sdk` that are not MCP).
- `extension` = `isExtensionTool(tool) || isMcpTool(tool)`.

Keep `isExtensionTool` unchanged for callers that need the old meaning.

### 5. Char count: lower bound + note (`src/chars.ts`)

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

Both are bounded but not computable without reproducing codemode's rendering
(`@earendil-works/pi-codemode`, not a host-provided package). So:

- Exclude the `codemode` tool itself from the count.
- When `getActiveTools()` includes `codemode`, render the total as `≥ N` and add
  a one-line note; read `pi.getSettings().codemode?.mode` to tailor it.
- Do **not** attempt a max/range: the per-tool cap is `DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000`,
  so a loose upper bound would be useless.

### 6. README

- "off" means not declared and not counted; codemode/deferred-exposure tools stay
  script-callable while off, so tbox is context hygiene, not a security boundary.
- The char count reports tool definitions and is a **lower bound** when codemode
  is active; it excludes the codemode description.
- MCP: one toolset per server, covering the server's declarable (`direct`/
  `model-only`) tools only. `codemode`/`deferred` MCP tools are managed by pi and
  `/mcp`, and are not listed or toggled here.

### 7. Dependency and release guarding

- Bump `devDependencies["@earendil-works/pi-coding-agent"]` to `^0.99.0` (the
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
- In the release commit, restore the spec to `^1.4.0` and revert the
  `package-lock.json` entry that recorded the file path.
- CHANGELOG `[Unreleased]` → `0.3.0`; `npm run release:minor`.

## Validation

Unit tests (`__tests__`, MockPI, no external services): fabricate MCP-shaped
`ToolInfo` and cover — per-server declared-only toolset creation; a
`codemode`-only server producing no toolset; `setMembers` on a changed server;
the re-scan being idempotent; the `core`/`extension` split with MCP tools; the
`≥ N` label and note; graceful degradation when `exposure`/`namespace` are absent.

`npm test` and `npm run typecheck` (typecheck runs in CI before tests).

Live QA against the real `siyuan` server:

1. `/tbox list` shows a `mcp__siyuan` toolset with ~29 members.
2. Toggling it off removes those tools from the active/declared set and drops the
   extension count; toggling it back on restores them.
3. The char count no longer counts them as `core`.
4. With `"defaultTools": ["+codemode"]`, the count renders as `≥ N` with the note.

The live server is the end-to-end criterion; the mock cannot exercise the async
connect or the real provider-side declaration effect.

## Risks and edge cases

- **Async connect ordering** — the primary risk. Mitigated by re-scanning on
  `mcp_servers_change` plus the per-turn defensive scan; verify with live QA.
- **Disabled servers** — their tools are re-registered `hidden`, so they are
  excluded as non-declarable and the server gets no toolset (or loses members).
- **Mid-session membership changes** — handled by `setMembers`; verify no warning
  and no stale handle.
- **Focus/allowlist captured before MCP toolsets existed** — the new toolset ids
  are absent from a pre-existing allowlist, so they resolve off; self-heals on the
  next `focus off` / `defaults restore`, matching the documented pattern for
  toolsets added later.
- **Intent vs observation must be decided before this plan is executed — and
  will be settled in this release.** Masking 1.4.0's inert-toolset contract
  splits "the toolset is on" into persisted *intent* (branch entry,
  `effectiveEnabled`) and *observation* (`isEnabled()`); the two diverge for
  inert toolsets (members `hidden`, or the MCP server not yet connected — the
  exact case this release introduces). Each tbox use site must pick the right
  one — display and toggle-gating want intent (an observation-gated guard
  refuses "off" on an intent-on inert toolset; `src/groups.ts` does this
  today), "is anything declared" (char count) wants observation, and
  `defaults capture` (`src/defaults.ts`) must capture intent, never a
  mid-session snapshot. The per-site breakdown and those fixes are in scope
  for this release; the decision must land before execution so the MCP
  toolset work doesn't ship with observation-gated guards that misbehave on
  inert toolsets.
- **Name overlap** — the masking guard means each tool can belong to one toolset;
  MCP tools are claimed only by their per-server toolset.
- **Codemode stays untested live** — codemode is not enabled in this environment;
  its paths are unit-tested only unless a QA pass enables it.
