# Sprint 3 — Docs, CHANGELOG, release prep & flatten to main

**Status:** Sprints 0–2 of this plan are merged; `pi-tool-masking@1.2.0` is
released and documented in its own repo. This doc now covers **Sprint 3 only**
— the docs/changelog/release-gate slice. For the *what* and *why* behind the
whole effort, see
[`defaults-and-focus-unified-plan.md`](./defaults-and-focus-unified-plan.md).
For the library side (stored settings, `getEffectiveDefault`, `"allowlist"`
resolution mode, `getActiveAllowlist()`, tombstone restore, `clearToolsetEntry`
/ `clearAllToolsetEntries`, `applyToolsetEnabled`), see the `pi-tool-masking`
repo — it is shipped and out of scope here.

**Current baseline:** `npm test` (269 passed) and `npm run typecheck` both
green against the published `pi-tool-masking@^1.2.0` (already pinned in
`package.json`; `node_modules/pi-tool-masking` is the real package, not a
symlink into `./pi-tool-masking`).

### Conventions (still apply)

- `.js` extensions on relative imports — don't "fix" to `.ts` (`module: nodenext`).
- Strict TS: `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.
- `MockPI.cleanRegistry()` in every `beforeEach` — the `pi-tool-masking`
  registry is process-global.
- Ponytail posture: `/tbox defaults` is a thin dispatch over library
  functions. No settings schema validator, cache, path-arg overload,
  per-toolset pin subcommand, or `/tbox list` pin column — all deferred.

---

## Sprint 3 — Docs, CHANGELOG, release prep & flatten (plan steps 6, 7)

**Goal:** Land the documentation updates, write the changelog, and confirm the
release gate against the published `^1.2.0` pin. The pin swap itself is
already done — this sprint verifies it and closes the remaining doc/guard
gaps.

### What's already shipped (verify, don't redo)

- `package.json` → `"pi-tool-masking": "^1.2.0"`; `node_modules/pi-tool-masking`
  is the published package, not a symlink into `./pi-tool-masking`. ✓
- `src/focus.ts` header doc rewritten (allowlist mode, array-is-authority;
  describes **three exits**: `off` = defaults, `release` = retain, and
  `/tbox defaults restore` = apply settings while ending focus). Verify it
  stays coherent with shipped behavior.
- `defaults`, `release`, `restore`, `chars` are in `src/reserved.ts`. ✓

### Remaining scope

- **`AGENTS.md`** (5 edits):
  - Under the focus rule, add: "`save`/`show`/`clear`/`restore` are not
    actuation commands and are not refused during focus; `restore` lifts
    focus."
  - Update the focus description from "inclusion mode" to "allowlist mode"
    (the `src/` module list line that calls `focus` "inclusion-mode focus",
    and the "Where persistence actually lives" line that lists
    "inclusion/exclusion" as the modes `pi-tool-masking` owns).
  - "Where persistence actually lives": add `allowlist` to the list of modes
    owned by `pi-tool-masking` (pi-tbox now actively uses it).
  - Fix the pre-existing focus-guard location: the rule says "Enforced in
    `src/focus.ts`" but `checkFocusGuard` lives in `src/groups.ts` (called by
    `toggleAll` / `actuateToolset` / `actuateGroup`) — correct the reference.
  - Sync the reserved-words list in the doc with `src/reserved.ts`: add
    `defaults`, `release`, `restore`, `chars`. Keep the doc list as the
    source of truth for what's reserved.
- **`CHANGELOG.md` `[Unreleased]`** covering: new `/tbox defaults`
  (`save`/`show`/`clear`/`restore`, project-default + `--global`); allowlist-mode
  focus rewrite (`focus off` = defaults, `focus release` = retain);
  `actuateNewToolset` allowlist consultation; `defaults` + `release` reserved
  words; `pi-tool-masking@^1.2.0` dependency bump.
- **`.gitignore` the local `./pi-tool-masking` checkout** (dev artifact, must
  not commit). Confirm with maintainer whether to keep the clone or remove it;
  either way it should not appear in `git status` as an untracked dir.

### Acceptance criteria

- [ ] `npm test` green against published `pi-tool-masking@^1.2.0`; `npm run
  typecheck` green.
- [ ] `node_modules/pi-tool-masking` is the published package, **not** a
  symlink into `./pi-tool-masking` (verify with `ls -la`).
- [ ] `package.json` reads `"pi-tool-masking": "^1.2.0"`.
- [ ] `./pi-tool-masking` does not appear in `git status` (gitignored or
  removed).
- [ ] `AGENTS.md`: focus rule has the `save`/`show`/`clear`/`restore`-not-refused
  line; focus described as "allowlist mode"; `allowlist` listed among the
  masking-owned modes; focus-guard reference points at `src/groups.ts` (not
  `src/focus.ts`); reserved-words list matches `src/reserved.ts` (includes
  `defaults`, `release`, `restore`, `chars`).
- [ ] `src/focus.ts` header doc matches shipped behavior (allowlist mode,
  array-is-authority, the three exits: `off` = defaults, `release` = retain,
  `defaults restore` = apply settings + end focus).
- [ ] `CHANGELOG.md` `[Unreleased]` covers all five bullet points above.
- [ ] No regression from Sprints 0–2's behavior when run against the
  published package (the test/typecheck run above is the check).
