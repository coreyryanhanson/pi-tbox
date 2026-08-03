# AGENTS.md

Compact guidance for agents working in `pi-tbox`. A Pi extension: one `/tbox`
command surface for toggling/grouping/focusing tools across all installed Pi
extensions.

## Commands

```sh
npm test            # vitest run (all tests)
npm run typecheck   # tsc --noEmit
npm run test:watch  # vitest watch
```

Run a single test file: `npx vitest run __tests__/groups.test.ts`
Run by name pattern: `npx vitest run -t "focus off"`

**Typecheck is not in CI** (`.github/workflows/tests.yml` only runs `npm test`).
Run `npm run typecheck` yourself before shipping — strict settings below
will catch things vitest won't.

No build, no lint, no format, no codegen. Node 22 (CI matrix).

## This package ships source, not compiled output

`package.json` `exports` points at `./index.ts` directly and `files` ships
`index.ts` + `src/` + `config/`. There is no `dist/`, no emit step, no bundler.
`tsc` is `--noEmit` only. Consumers load the TypeScript source via Pi's loader.

Consequence: **imports use `.js` extensions** (`import ... from "./src/registry.js"`),
even though files are `.ts`. This is required by `module: nodenext` +
`allowImportingTsExtensions`. Don't "fix" them to `.ts`.

## TypeScript is stricter than default

`tsconfig.json` enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`isolatedModules`, `moduleDetection: force`, on top of `strict`. Indexed
access returns `T | undefined`; optional props can't be set to `undefined`
explicitly. Respect this in new code — typecheck will fail otherwise.

## Architecture

- **`index.ts`** — the extension factory. `default export tboxFactory(pi)`
  registers the `/tbox` command, the `tbox` status slot, and `session_start` /
  `session_tree` / `session_shutdown` handlers. This is the only entrypoint;
  everything else is imported by it.
- **`src/`** — domain modules: `registry` (auto-register builtin + orphan
  toolsets), `groups` (actuate/describe/edit/list + focus guard),
  `group-editor` (TUI picker), `focus` (allowlist-mode entry/exit),
  `defaults` (settings-tier pin save/show/clear/restore), `list` (parse +
  format output), `status-slot` (bar slot render/wire), `chars` (context
  char-counting), `requires-graph` (dependency closure), `reserved`
  (reserved-word guard).
- **`config/settings-reader.ts`** — **the group store**, despite the name.
  Reads/writes `~/.pi/agent/pi-tbox/groups.json` (a bare `{ toolsets: string[] }`
  table, no wrapper key). It is *not* pi-core `settings.json` — see the file's
  header comment. Groups are user/global-scoped: defined once, usable from any
  directory.

## Where persistence actually lives

Per-toolset on/off memory, the `requires` cascade, and inclusion/exclusion
mode are owned by the **`pi-tool-masking`** dependency, not this repo. tbox
operates entirely through that library's events. Do not reimplement masking
state, focus default-resolution, or the `requires` closure here — call into
`pi-tool-masking`. The `requires-graph` module in `src/` is the local view
used for the picker; the source of truth is the library.

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
- `integration.test.ts` and `picker.test.ts` are the largest; the picker
  tests drive the TUI component via `handleInput`/`render` on a mount state,
  not real key events.
- No external services, no fixtures on disk, no snapshots.

## Conventions worth keeping

- `+` prefix = toolset, bare name = group — this addressability rule is
  load-bearing in `index.ts`'s command dispatch and `reserved.ts`. Don't
  blur it.
- Reserved words (`status`, `focus`, `all`, `list`, `group`, `on`, `off`,
  `edit`, `remove`, `chars`, `defaults`, `release`, `restore`) are rejected
  as group names in `reserved.ts`; keep that list in sync if subcommands
  change.
- While focus is active, actuation commands (`all on|off`, `<group> on|off`,
  `+<toolset> on|off`) must be refused. Enforced via `checkFocusGuard` in
  `src/groups.ts` (every actuation path calls it) — don't bypass it.
- Focus exits three ways: `focus off` and `/tbox defaults restore` share
  `applyEffectiveDefaults` (tombstone + re-actuate); `focus release` has a
  separate flush path — it writes the live selection to per-toolset `{enabled}`
  entries, no tombstone, no re-actuation. Don't reinvent a fourth.
- Builtin tools and `sdk`-source (host `customTools`) tools are out of scope:
  read-only in `--flat` listings, never togglable.
