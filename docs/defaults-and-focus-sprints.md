# Sprints: `/tbox defaults` + allowlist-mode focus

**Status:** Ready for implementation
**Companion:** [`defaults-and-focus-unified-plan.md`](./defaults-and-focus-unified-plan.md) — the *what* and *why*. This doc is the *when* and *done-when*.
**Hard dependency:** `pi-tool-masking@1.2.0` on the `feat/stored-settings-and-allowlist` branch (see plan "Depends on"). Nothing below starts until that branch's reader/writer/clearer, `getEffectiveDefault`, the `"allowlist"` resolution mode + `getActiveAllowlist()`, null-tombstone restore, `clearToolsetEntry` / `clearAllToolsetEntries`, and `applyToolsetEnabled` are all present.

## How to read this doc

Each sprint is a shippable slice that **leaves `npm test` green**. The sprints map onto the plan's "Implementation order" steps 0–7; step boundaries are noted so a dev can cross-reference the plan's code snippets and rationale. Acceptance criteria are the **done-when** checks for the sprint to close — every box must pass. Unless a criterion says otherwise, run `npm test` *and* `npm run typecheck` (typecheck is not in CI; catch it yourself).

### Conventions (apply every sprint, from the plan)

- `.js` extensions on relative imports — don't "fix" to `.ts` (`module: nodenext`).
- Strict TS: `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. Guard `.enabled` with `typeof === "boolean"`; never assign `undefined` to an optional prop — omit the key.
- `MockPI.cleanRegistry()` in every `beforeEach` — the `pi-tool-masking` registry is process-global.
- Settings-override shape is **wrapped** (`{ [persistKey]: { enabled: boolean } }`), not flattened.
- No real-disk reads/writes in seam tests except the `show` attribution round-trips (Sprint 3).
- Ponytail posture: `/tbox defaults` is a thin dispatch over library functions. No settings schema validator, cache, path-arg overload, per-toolset pin subcommand, or `/tbox list` pin column — all deferred.

---

## Sprint 0 — Baseline & cross-repo links (plan steps 0 + 5-docs + plan-doc)

**Goal:** Establish a green baseline on the masking branch *before* any behavior changes, and fix the broken cross-doc chain so the companion plan is reachable.

### Scope

- Fix the 4 settings-pinned tests written against the old flattened shape: `{ [key]: false }` → `{ [key]: { enabled: false } }` in `__tests__/focus.test.ts` (2) and `__tests__/integration.test.ts` (2). 4-line fix.
- Repoint the broken cross-repo links in the masking plan to `docs/defaults-and-focus-unified-plan.md`: `pi-tool-masking/plans/settings-tier-and-allowlist-mode.md:24` and `d7-branch-access-gap.md:66,166,180`.
- Keep `docs/settings-tier-and-focus-suppression-retrospective.md` (cited by the masking plan; retrospectives don't go stale).
- No behavior changes, no new modules.

### Acceptance criteria

- [ ] `npm test` is green with only the 4 shape fixes applied — no other source/test edits.
- [ ] `npm run typecheck` is green.
- [ ] The 4 pinned tests pass with the wrapped shape; `setSettingsOverrideForTests` calls in those tests use `{ [key]: { enabled: false } }`.
- [ ] All three repointed links resolve to `docs/defaults-and-focus-unified-plan.md` (verified by grep — no dangling `settings-tier-and-allowlist-mode` / `d7-branch-access-gap` references remain in the masking plan's link lines).
- [ ] `docs/settings-tier-and-focus-suppression-retrospective.md` is untouched.
- [ ] `package.json` still points at `"pi-tool-masking": "file:./pi-tool-masking"` (local checkout) — no version bump yet.

---

## Sprint 1 — Allowlist-mode focus core (plan steps 1, 2, 3)

**Goal:** Pivot focus from `inclusion` mode to `allowlist` mode, swap the no-cascade apply path into `focusOff`, and add `focus release` (retain live set). This is the largest behavior change in the release.

### Scope

- **`src/registry.ts` — `actuateNewToolsets` allowlist branch (step 1):** consult `getActiveAllowlist()` *before* the `getEffectiveDefault` fallback. In-allowlist → on; not-in-allowlist → off. Read `readMergedToolsetDefaults()` once outside the loop (already there). Tests in `__tests__/integration.test.ts` and `__tests__/restore-timing.test.ts`.
- **`src/focus.ts` — `focusUnit` allowlist-mode rewrite (step 2):** replace the two-pass enable/disable + per-toolset `appendEntry` with `setDefaultResolutionMode(pi, "allowlist", ids)` + a per-toolset `applyToolsetEnabled` loop. No per-toolset entries during enter — the array is the authority. Delete the `ponytail:` two-pass comment and the "already-enabled → persist `{enabled:true}`" branch. New return message: `Focus on "<label>" — allowlist of N toolset(s).` (still `toContain("Focus on")` for existing assertions).
- **`src/focus.ts` — `focusOff` swap (step 2):** `enable()/disable()` → `applyToolsetEnabled`, plus `clearAllToolsetEntries` tombstone + `setDefaultResolutionMode(pi, "exclusion")`. Drop the cascade `ponytail:` comment.
- **`src/focus.ts` — `focusRelease` (step 3):** new, per D3. Guard against no-focus call (`getActiveAllowlist()` returns `undefined`) *before any state mutation* — return the hint message, write nothing. Otherwise: `setFocusUnit(null)` + `persistFocusUnit(null)`, flush per-toolset `{enabled: allowSet.has(spec.id)}` entries, `setDefaultResolutionMode(pi, "exclusion")`, `rerenderSlot`. `ponytail:` comment naming the tombstone-accumulation ceiling + pi-core compact-op upgrade path.
- **Breaking-test updates done *in step 2* (not deferred):**
  - **B1** mode-string swaps: `__tests__/focus.test.ts:217,387,515` (+ inline `inclusion mode` comments `:541,:544`); `__tests__/focus-exit.test.ts:97`; `__tests__/integration.test.ts:490` (retitle + assert `getActiveAllowlist()` returns the closure-resolved ids).
  - **B2** delete `__tests__/focus-exit.test.ts` and fold the "`focusOff` must re-actuate, not just flip the mode" regression guard into the `focusOff` block in `focus.test.ts`. (Option 2 from the plan — Option 1 is incoherent under allowlist mode.)
  - **B3** remove `__tests__/focus.test.ts:593` ("already-enabled allowlisted toolset persists entry...") — the deleted `focusUnit` branch it guarded is gone; the property is now covered by the allowlist array.
- **`src/focus.ts` header doc** rewrite: allowlist-mode description, the array-is-authority point, and the two exits (`off` = defaults, `release` = retain).

### Acceptance criteria

- [ ] `npm test` green; `npm run typecheck` green.
- [ ] `focusUnit` calls `setDefaultResolutionMode(pi, "allowlist", ids)` with forward-closure-resolved ids; `getActiveAllowlist()` returns them; live state = allowlist members on, others off across all registered toolsets.
- [ ] Non-toolset tools preserved: a `pi.getActiveTools()` name not owned by any toolset stays active after `focusUnit` (guards that pi-tbox uses `applyToolsetEnabled`, not a hand-rolled `setActiveTools` rebuild).
- [ ] No per-toolset `appendEntry` during `focusUnit` enter (array is the authority).
- [ ] Future-install: register a toolset *after* `focusUnit`, call `actuateNewToolsets` → not in array → off. Outside focus, `actuateNewToolsets` falls back to `getEffectiveDefault` (Step-0 tests still pass).
- [ ] `focusOff`: every toolset at `getEffectiveDefault`; mode `exclusion`; `getActiveAllowlist()` `undefined`; a dependent's `enable()` does **not** re-enable a pinned-off dependency (old item-3 guard, now via `applyToolsetEnabled`); settings-pinned-on/off override `defaultEnabled` in both directions.
- [ ] `focusRelease`: live state unchanged from focus-era; mode `exclusion`; branch has `{enabled:true}` for allowlist members and `{enabled:false}` for the rest; `getActiveAllowlist()` `undefined`; `/reload` (restore handler) keeps the selection.
- [ ] `focusRelease` no-focus guard: calling it with no active focus returns the hint message and mutates **nothing** — no per-toolset entries, mode unchanged, no toolset disabled.
- [ ] B1/B2/B3 complete: no `"inclusion"` string assertions remain in the touched tests; `focus-exit.test.ts` is deleted; the `:593` test is removed; the `focusOff` re-actuate regression guard exists in `focus.test.ts`.
- [ ] `src/focus.ts` header doc rewritten; the deleted `ponytail:` two-pass comment and the `{enabled:true}` branch are gone.
- [ ] **Focus guard unchanged for actuation:** `all on|off`, `<group> on|off`, `+<toolset> on|off` still refused during focus. (`save`/`show`/`clear`/`restore` don't exist yet — N/A this sprint.)

---

## Sprint 2 — `/tbox defaults` command surface (plan steps 4, 5)

**Goal:** Ship the `save` / `show` / `clear` / `restore` subcommands and the bare-`restore` hint dispatch. No focus-guard refusal for any of them (D1 + D4).

### Scope

- **New `src/defaults.ts`:** handlers for `save`, `show`, `clear`, `restore`. Thin dispatch over library functions; `index.ts` just parses + delegates.
- **`index.ts`:** `case "defaults":` dispatching the four subcommands; `case "restore":` (sibling) emitting the redirect hint `"restore" is a defaults subcommand. Use /tbox defaults restore to apply settings defaults to live state (lifts focus).` (the N2 guard — does not delegate, does not call `describeGroup`).
- **`src/reserved.ts`:** add `defaults`, `release`, `restore` to `RESERVED_WORDS` (`release` reserved belt-and-suspenders as a `focus` subcommand; `restore` reserved top-level so the bare typo hits the hint case, not the group fallback).
- **Flag handling — mirror `src/list.ts`:** `KNOWN_DEFAULTS_FLAGS = new Set(["global", "help"])` (no `--project`; project is the default, `--project` is an unknown-flag error). `--help` prints `DEFAULTS_HELP` first; any other `--` flag → `Error: unknown flag --foo. See: /tbox defaults --help.`
- **Scope resolution:** `resolveScope(flags)` → `flags.has("global") ? "global" : "project"`. `show`/`restore` ignore scope.
- **`save` (D1 — live-state-diff, mode-agnostic):** snapshot `readMergedToolsetDefaults()` once; for each registered toolset, pin where `live !== getEffectiveDefault(spec, snapshot)`. `writeToolsetDefaults(pins, scope)` merges — does not remove absent keys (stale-pin cleanup is `clear`'s job). Works mid-focus (no guard).
- **`show` (D6 — pins only):** merged view + per-scope attribution via `readToolsetDefaults("global")` / `readToolsetDefaults("project")`. Project pin shadowing a global pin for the same `persistKey` → `(overrides global)`. Empty state → the no-pins message. No mode row. Rows sorted by `persistKey`.
- **`clear`:** `clearToolsetDefaults(scope)`; `true`/`false` wording naming the file path.
- **`restore` (D4 — lifts focus):** `clearAllToolsetEntries(pi, getBranch())` (dedup'd tombstone) → `setDefaultResolutionMode(pi, "exclusion")` → per-toolset `applyToolsetEnabled(pi, spec, getEffectiveDefault(spec, snapshot))`. Output `Restored N toolset(s) to settings defaults.`
- **Output path resolution:** global → `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/settings.json`, project → `<cwd/.pi>/settings.json` (`settings.json` filename is load-bearing). `ponytail:` note with upgrade path "promote `settingsPath` in the library."
- **Malformed-file surfacing:** `save`/`clear` catch `MalformedSettingsError` with `instanceof` (not string-match) → `ctx.ui.notify(..., "error")` naming the file. Never crash on a corrupt `settings.json`.
- **New `__tests__/defaults.test.ts`:** uses both seams (`setSettingsOverrideForTests` + `setSettingsWriterOverrideForTests`); mirror the `setGroupsOverrideForTests` pattern from `__tests__/picker.test.ts`; round-trips clear **both** overrides or they mask each other. `show` attribution round-trips use the real-disk pattern (mkdtemp + `PI_CODING_AGENT_DIR` + `chdir`) — neither seam set.

### Acceptance criteria

- [ ] `npm test` green; `npm run typecheck` green.
- [ ] `save` live-state-diff: only toolsets where `live !== getEffectiveDefault` are pinned; written map shape is wrapped `{ [key]: { enabled } }`.
- [ ] `save` during focus: captures the allowlist selection as exclusion pins (members on → `{enabled:true}` if their default is off; others off → `{enabled:false}` if their default is on). Not refused.
- [ ] `save` scope: bare → project; `--global` → global; `--project` → usage error, no write. Success message names the correct file path.
- [ ] `show`: merged view + attribution — global-only pin → `[global]`; project pin shadowing global → `[project] (overrides global)`; empty state prints the no-pins message; rows sorted by `persistKey` (deterministic).
- [ ] `clear`: removes the block; `true`/`false` wording correct; preserves other keys in `settings.json`; `MalformedSettingsError` surfaced as `error`-level notify naming the file (caught with `instanceof`).
- [ ] `restore`: tombstones per-toolset entries; appends `exclusion` mode; applies `getEffectiveDefault` live via `applyToolsetEnabled`; **lifts focus** (`getActiveAllowlist()` `undefined` after). Dedup: repeat restore with no intervening toggle writes zero tombstones.
- [ ] `/tbox restore` (bare) returns the redirect hint containing `defaults restore`; does **not** call `describeGroup`; mutates no toolset state.
- [ ] `--help` prints `DEFAULTS_HELP` before any other check; an unknown `--` flag is rejected with the pointed error.
- [ ] `defaults`, `release`, `restore` are in `RESERVED_WORDS`; a group named `restore` is rejected at creation with the reserved-word error.
- [ ] `src/defaults.ts` exists; `index.ts` `defaults`/`restore` cases delegate/emit correctly; `index.ts` is still thin (no handler logic inlined).
- [ ] Seam tests never hit disk; the only disk-touching tests are the `show` attribution round-trips (mkdtemp + env + chdir, cleaned in `afterEach`).
- [ ] Strict-TS guards present (`.enabled` `typeof` checks; no explicit-`undefined` on optional props).

---

## Sprint 3 — Docs, CHANGELOG, release prep & flatten to main (plan steps 6, 7)

**Goal:** Land the documentation updates, write the changelog, and flip the local library link to the published `^1.2.0` pin with full-suite verification against the real package. This is the release gate.

### Scope

- **`AGENTS.md`:**
  - Under the focus rule, add: "`save`/`show`/`clear`/`restore` are not actuation commands and are not refused during focus; `restore` lifts focus."
  - Update the focus description from "inclusion mode" to "allowlist mode."
  - "Where persistence actually lives": add `allowlist` to the list of modes owned by `pi-tool-masking` (pi-tbox now actively uses it).
  - Fix the pre-existing focus-guard location: the rule says "Enforced in `src/focus.ts`" but `checkFocusGuard` lives in `src/groups.ts` (called by `toggleAll` / `actuateToolset` / `actuateGroup`) — correct the reference.
- **`src/focus.ts` header doc:** already rewritten in Sprint 1; verify it's coherent with the shipped behavior.
- **`CHANGELOG.md` `[Unreleased]`** covering: new `/tbox defaults` (`save`/`show`/`clear`/`restore`, project-default + `--global`); allowlist-mode focus rewrite (`focus off` = defaults, `focus release` = retain); `actuateNewToolset` allowlist consultation; `defaults` + `release` reserved words; `pi-tool-masking@^1.2.0` dependency bump.
- **Flatten to main:**
  1. `package.json` → `"pi-tool-masking": "^1.2.0"` (published); `npm install` to regenerate `package-lock.json`; confirm `node_modules/pi-tool-masking` is no longer a symlink into `./pi-tool-masking`.
  2. `.gitignore` the local `./pi-tool-masking` checkout if not already (dev artifact, must not commit). Confirm with maintainer whether to keep the clone or remove it.
  3. Full-suite verification against published `1.2.0`: `npm test` + `npm run typecheck`.

### Acceptance criteria

- [ ] `npm test` green against published `pi-tool-masking@^1.2.0`; `npm run typecheck` green.
- [ ] `node_modules/pi-tool-masking` is the published package, **not** a symlink into `./pi-tool-masking` (verify with `ls -la`).
- [ ] `package.json` reads `"pi-tool-masking": "^1.2.0"`; `package-lock.json` regenerated.
- [ ] `./pi-tool-masking` does not appear in `git status` (gitignored or removed).
- [ ] `AGENTS.md`: focus rule has the `save`/`show`/`clear`/`restore`-not-refused line; focus described as "allowlist mode"; `allowlist` listed among the masking-owned modes; focus-guard reference points at `src/groups.ts` (not `src/focus.ts`).
- [ ] `src/focus.ts` header doc matches shipped behavior (allowlist mode, array-is-authority, two exits).
- [ ] `CHANGELOG.md` `[Unreleased]` covers all five bullet points above.
- [ ] No regression from Sprint 2's acceptance criteria when run against the published package (re-run the Sprint 2 checks).

---

## Sprint map → plan steps

| Sprint | Plan steps | Leaves `npm test` green? |
|--------|-----------|--------------------------|
| 0 — Baseline & links | 0 + 5-docs + plan-doc | Yes (baseline established) |
| 1 — Allowlist-mode focus core | 1, 2, 3 | Yes |
| 2 — `/tbox defaults` surface | 4, 5 | Yes |
| 3 — Docs, CHANGELOG, flatten | 6, 7 | Yes (against published `^1.2.0`) |

## Cross-sprint ordering rules

- **Sprint 0 must land first.** No other sprint starts on a red baseline.
- **Sprint 1 must land before Sprint 2.** `save` during focus (Sprint 2 D1) depends on the allowlist-mode `focusUnit` (Sprint 1); `restore` lifts focus (Sprint 2 D4) depends on the allowlist mode existing.
- **Sprint 3 must land last.** The flatten-to-main pin swap is the release gate and can only run once Sprints 0–2 are merged behavior-complete.
- **Within Sprint 1, the breaking-test updates (B1/B2/B3) ship in step 2** alongside the `focusUnit` rewrite — the rewrite is what breaks them, so step 2 does not close until they're done. Don't defer them to a follow-up.
