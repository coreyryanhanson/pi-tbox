# AGENTS.md

Compact guidance for agents working in `pi-tbox`. A Pi extension: one `/tbox`
command surface for toggling/grouping/focusing tools across all installed Pi
extensions.

## Commands

```sh
npm test            # vitest run (all tests)
npm run typecheck   # tsc --noEmit
npm run test:watch  # vitest watch
npm run release:patch|minor|major  # scripts/release.mjs: bumps, promotes
                   # CHANGELOG [Unreleased], publishes, pushes main + tag.
                   # Draft the [Unreleased] entries first.
```

Run a single test file: `npx vitest run __tests__/groups.test.ts`
Run by name pattern: `npx vitest run -t "focus off"`

`npm publish` runs `prepublishOnly` = `scripts/check-dep.mjs` + `npm test` +
`tsc --noEmit`. The guard aborts unless `dependencies["pi-tool-masking"]` is a
semver range; the `file:../pi-tool-masking` dev spec must not be committed
(restore a range + lockfile before release).

**Typecheck runs in CI** (`.github/workflows/tests.yml` runs `npm run typecheck`
before `npm test`) — strict settings below will catch things vitest won't.

No build, no lint, no format, no codegen. Node 22 (CI matrix).

## This package ships source, not compiled output

`package.json` `exports` points at `./index.ts` directly and `files` ships
`index.ts` + `src/` + `config/`. There is no `dist/`, no emit step, no bundler.
`tsc` is `--noEmit` only. Consumers load the TypeScript source via Pi's loader.

Consequence: **imports use `.js` extensions** (`import ... from "./src/registry.js"`),
even though files are `.ts`. Required by `module: nodenext` +
`allowImportingTsExtensions`. Don't "fix" them to `.ts`.

## TypeScript is stricter than default

`tsconfig.json` enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`isolatedModules`, `moduleDetection: force`, on top of `strict`. Indexed
access returns `T | undefined`; optional props can't be set to `undefined`
explicitly. Respect this — typecheck will fail otherwise.

## Architecture

- **`index.ts`** — the extension factory. `default export tboxFactory(pi)`
  registers the `/tbox` command, the `tbox` status slot, and `session_start` /
  `session_tree` / `session_shutdown` handlers. The only entrypoint; everything
  else is imported by it.
- **`src/`** — domain modules: `registry` (auto-register builtin + orphan
  toolsets; the MCP re-scan), `groups` (actuate/describe/edit/list + focus
  guard), `group-editor` (TUI picker), `focus` (allowlist-mode entry/exit),
  `defaults` (settings-tier pin save/show/clear/restore), `list` (parse +
  format output), `status-slot` (bar slot render/wire), `chars` (context
  char-counting), `mcp` (MCP tool detection predicates), `requires-graph`
  (dependency closure), `reserved` (reserved-word guard), `sync` (the
  `/tbox sync` projector — per-spec `forceToolsetEnabled`, not a toggle flow).
- **`config/settings-reader.ts`** — **the group store**, despite the name.
  Reads/writes `${PI_CODING_AGENT_DIR ?? ~/.pi/agent}/pi-tbox/groups.json`
  (group name → `{ toolsets: string[] }`, no wrapper key — see the file's
  header comment). It is *not* pi-core `settings.json`. Groups are
  user/global-scoped. Writes are atomic (`.tmp` + `renameSync`) and *loud*:
  they throw `GroupsFileCorruptError` on an unparseable file rather than
  overwrite user data, while read paths degrade to an empty table (zero-byte
  file = absent). Route all writes through `writeGroupsFile` and surface the
  error in callers — the read/write asymmetry is deliberate.

## Where persistence actually lives

Per-toolset on/off memory, the `requires` cascade, and allowlist/exclusion
mode are owned by the **`pi-tool-masking`** dependency, not this repo. tbox
operates entirely through that library's events. Do not reimplement masking
state, focus default-resolution, or the `requires` closure here — call into
`pi-tool-masking`. `src/requires-graph.ts` is the local picker view; the
source of truth is the library.

Drift detection is masking's `computeDrift`; tbox renders the mismatched ids
+ fact strings (stats-command warning bubble, status-slot warning glyph). The
repair path, `/tbox sync` (`src/sync.ts`), is a projector: one per-spec
`forceToolsetEnabled` write over only the toolsets the predicate flagged,
verified against post-apply observation — not a toggle flow (no `toggleBatch`,
no refusal surface, no focus guard, persists nothing).

## Deferring children (subagent sessions)

Exactly two defer gates exist, both calling masking's `isDeferredChild()` —
never a hand-rolled `PI_TOOLMASKING_DEFER` presence check (the parent carries
its own pid var; only the foreign-pid check is correct):

- **Command dispatch** — first line of the `/tbox` handler in `index.ts`,
  message-producing: a deferring child gets a notify refusal and no command
  surface. Also the only protection for the settings-writer flows (`defaults
  save`/`clear`/`restore`), which masking's defer rule leaves live (the
  settings tier is outside it).
- **`captureAndRender`** — first line of the `session_start`/`session_tree`
  handler in `index.ts`, silent early-return: no registration, no actuation,
  no MCP sync, no focus restore, no slot render, no per-prompt re-scan wiring,
  no post-start connect poll.

**No per-flow or function-level defer gates exist, on purpose.** Every
governance-writing flow is reachable only through these two gates. A new tbox
entry point must sit beneath one of them rather than grow its own predicate.

## Actuation: unconditional calls, one seam, one reader

- **Intent, not observation.** State shown or acted on outside a toggle call
  reads persisted **intent** (`effectiveEnabled` — chat-branch entry,
  allowlist-aware → settings pin → packaged default), never the live
  `isEnabled()` observation: an inert toolset (members hidden or MCP server
  not yet connected) has an empty observation, which would corrupt pins,
  describe output, the status glyph, and orphan restore. Used by
  `actuateNewToolsets`, `defaultsSave`, `describeToolset`, `formatStatus`.
  Diagnostic carve-out: the drift displays (stats warning bubble, status
  warning glyph) read masking's `computeDrift` — diagnostic-only; no pin,
  describe output, or actuation decision reads them.
- **No intent pre-gates.** No "already enabled/disabled" guards — no toggle
  path reads intent before calling. Masking's delta gate no-ops redundant
  toggles (returns `[]`), repairs clobbered loadouts, and persists intent-off
  toggles on inert toolsets; "already in the desired state" messages render
  from the returned `[]`. Documented exceptions:
  - `syncMcpToolsets`' reconcile gate (`src/registry.ts`) reads intent before
    `forceToolsetEnabled` — that apply path always emits, so an ungated call
    repaints on every unchanged scan. A re-scan reconcile, not a toggle path.
  - `focusRelease`'s corrupt/empty-allowlist fail-fast (`src/focus.ts`) is a
    *corrupt-state refusal*, not a desired-state pre-gate — the input is
    unrepresentable through any sanctioned writer. It reads no intent, and
    every non-corrupt release proceeds ungated into `toggleBatch`.
  - Projection paths (masking's restore, `/tbox sync`) read `effectiveEnabled`
    as a projection input; their gate is the drift predicate, not a same-value
    pre-gate, and they persist nothing.
- **One batch per command.** Multi-op flows (`all`, `<group> on|off`,
  `solo <unit>`, `focus release`) go through masking's `toggleBatch` over
  `ctx.sessionManager`, not wrapper loops — one branch read, one settings
  read, atomic pre-write plan. Only `actuateToolset` keeps the single-op
  wrapper.
- **Refusal architecture:** domain functions (`toggleAll`, `actuateToolset`,
  `actuateGroup`, `soloUnit`, `focusUnit`, `focusRelease`) throw raw and catch
  nothing — one exception: `focusRelease` catches solely to compensate
  (restore the pre-release mode entry and focus unit, best-effort) and
  rethrows; catch for compensation, never for copy. The dispatch seam
  (`runToggle`/`toggleRefusalMessage` in `index.ts`) owns all refusal copy,
  matched by `err?.name` (`AllowlistModeError`, `CycleError`,
  `ContradictionError`, tbox-owned `CorruptModeStateError` in `src/focus.ts`)
  — never `instanceof`, because handles may come from another physical copy of
  the library off the shared `globalThis` registry. A refusal message inside a
  domain function is a bug. Under allowlist every toggle throws
  `AllowlistModeError` (mode-global on `toggleBatch`; `actuateToolset` sets
  `specId`) before any entry is appended. A refused `focusRelease` compensates
  to net-zero; a corrupt/empty allowlist refuses before any mutation
  (`CorruptModeStateError`). `focusRelease` deliberately tears down a foreign
  allowlist.
- **Branch reader, not branch value.** Actuation and release paths receive
  `ctx.sessionManager` (the reader object — never a `getBranch()` array or
  the bare `getBranch` method reference, which the reader type makes a
  compile error). The library re-reads the branch at each call's boundary,
  so one reader per command covers any number of calls and cascades.

## Tests

- Vitest with **globals on** (`describe`/`it`/`expect` available without
  import, though most files import them explicitly from `vitest` — either is
  fine). `types: ["node", "vitest/globals"]` in tsconfig.
- All tests live in `__tests__/**/*.test.ts`. `testTimeout: 15_000`.
- Tests exercise the real `tboxFactory` against **`MockPI`**
  (`__tests__/mock-pi.ts`), a hand-rolled `ExtensionAPI` stub backed by
  `node:events`. **Call `MockPI.cleanRegistry()` in `beforeEach`** — the
  `pi-tool-masking` registry is process-global and leaks across tests
  otherwise. Follow the pattern in existing test files.
- The picker tests drive the TUI component via `handleInput`/`render` on a
  mount state, not real key events.
- `vitest.config.ts` `setupFiles` runs `__tests__/scrub-defer-env.ts`, which
  deletes `PI_TOOLMASKING_DEFER` — without it a test run launched from a
  deferring subagent no-ops every toggle/registration. `defer.test.ts` sets
  the var itself to exercise the gate.
- Settings tests call `MockPI.useTempAgentDir()` (mkdtemp + `PI_CODING_AGENT_DIR`
  + `chdir`), writing real `settings.json` files under a temp dir.
- No external services, no committed fixtures, no snapshots.

## Conventions worth keeping

- `+` prefix = toolset, bare name = group — load-bearing in `index.ts`'s
  command dispatch and `reserved.ts`. Don't blur it.
- Reserved words (`status`, `focus`, `solo`, `all`, `list`, `group`, `on`,
  `off`, `edit`, `remove`, `chars`, `defaults`, `release`, `restore`, `sync`)
  are rejected as group names in `reserved.ts`; keep the list in sync if
  subcommands change.
- While focus is active, actuation commands (`all on|off`, `<group> on|off`,
  `+<toolset> on|off`, `solo <unit>`) must be refused via `checkFocusGuard`
  in `src/groups.ts` — don't bypass it. Exempt by one shared principle: a
  command may act under focus only when its desired state is *derived from*
  focus itself. `focusRelease` (the commanded teardown, also an actuation
  path) and `/tbox sync` (desired state resolves through mode-aware
  `effectiveEnabled` to focus-list membership) qualify.
- Focus exits three ways: `focus off` and `/tbox defaults restore` share
  `applyEffectiveDefaults` (tombstone + re-actuate); `focus release` flips to
  exclusion mode first, then runs one delta-based `toggleBatch` over the
  registry (only drifted ids get entries, no tombstone, no full re-actuation).
  It can refuse (`ContradictionError`, `CycleError`, `CorruptModeStateError`)
  and compensates to net-zero. Don't reinvent a fourth.
- **Non-declarable tools are read-only; declarable extension and MCP tools
  are togglable.**
  The declaration predicate is `isDeclarableTool` (`src/chars.ts`): exposure
  `direct`/`model-only`, missing exposure degrading to `direct` — pi core's
  own `_isDeclarable` rule. It applies on both axes: extension tools (the
  orphan scan claims only declarable ones, so a codemode/deferred/hidden
  extension tool is never claimed and actuated at session start) and
  MCP tools (ordinary declarable tools despite their builtin `sourceInfo`;
  `syncMcpToolsets` gives each server one `tbox.mcp@<server>` toolset over
  its `direct`-exposure tools, re-scanned from the per-prompt
  `before_agent_start` hook, `/tbox` dispatch, and the bounded post-start
  connect poll (`scheduleMcpConnectRescan` in `index.ts`; a name-set diff,
  not a toggle flow)). Membership/classification for MCP goes through
  `isDeclarableMcpTool` (`src/mcp.ts`) — never bare `isMcpTool` for those
  decisions; `isTogglableTool` (`src/chars.ts`) wraps both axes for every
  count site. Bare `isMcpTool` is correct where the broader set is the
  point: the orphan-exclusion filter (`src/registry.ts`, so non-declarable
  MCP tools never become `tbox.tool@builtin` orphans) and pi-managed
  routing (`src/list.ts`). The three shared resource tools, tool_search-
  loaded `codemode`/`deferred` MCP tools, and active non-declarable
  extension tools render read-only under `pi-managed` (presentation only —
  no ledger bucket); of the latter two classes, inactive ones show nowhere
  (zero declared context). Toggling is context hygiene, not a security
  boundary: non-declarable tools stay script-callable. `isTogglableTool`
  deliberately answers "does activation cost declared context", not "can a
  toolset mask it": a third-party toolset explicitly claiming a
  non-declarable extension tool can mask it, but the tool still drops out
  of `n masked` and books to `core` — no in-tree caller creates that shape,
  and claim-awareness would fork the predicate's meaning.
- Builtin tools and `sdk`-source (host `customTools`) tools are out of scope:
  read-only in `--flat` listings, never togglable (MCP is the exception; see
  above). `isExtensionTool` keeps its narrow meaning so the orphan scan never
  creates a `tbox.tool@builtin` toolset.
