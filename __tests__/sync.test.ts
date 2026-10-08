/**
 * Drift surfaces — the stats-command warning seam, /tbox sync, residual
 * honesty, and the slot's drift marker.
 *
 * The predicate itself (masking's computeDrift) is tested in masking's
 * suite; these tests drive drifted fixtures through the real factory and
 * MockPI and assert tbox's surfaces: the warning bubble, the sync projector,
 * the slot marker, and the post-write residual report.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	MockPI,
	branchOf,
	useTempAgentDir,
	pinSettingsDefaultsForTests,
} from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tboxFactory from "../index.js";
import { syncToolsets } from "../src/sync.js";
import {
	SLOT_NAME,
	setDriftProvider,
	setFocusUnit,
	render,
	rerenderSlot,
	wireSlot,
	type SlotCtx,
} from "../src/status-slot.js";
import {
	computeDrift,
	forceToolsetEnabled,
	getRegisteredToolsets,
	TOOLSET_EVENTS,
	type ToolsetSpec,
} from "pi-tool-masking";

// File-wide temp settings dirs — never touches the developer's ~/.pi
// (computeDrift and formatStatus both read merged settings defaults).
useTempAgentDir();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The static durability tail every warning must end with — one string
 *  regardless of drift class or branch mode. */
const DURABILITY_SUFFIX =
	"— if you do nothing, leaks and allowlist drift re-heal at the next " +
	"turn and force-removal at the next session start; either way, sync's " +
	"alignment holds only until the next foreign write.";

function registerExtTool(mock: MockPI, name: string): void {
	mock.registerTool({
		name,
		description: name,
		sourceInfo: {
			path: "portal.ts",
			source: "extension",
			scope: "user",
			origin: "top-level",
		},
	});
}

function defineTboxToolset(
	mock: MockPI,
	id: string,
	names: string[],
	opts: { requires?: string[] } = {},
): void {
	mock.defineFakeToolset({
		id,
		names: new Set(names),
		persistKey: `toolset-state:${id}`,
		defaultEnabled: true,
		...(opts.requires ? { requires: opts.requires } : {}),
	});
}

/** Append a chat-branch intent entry (the mock's branch is shared across
 *  contexts, so dispatchCommand and branchOf both see it). */
function pinIntent(mock: MockPI, id: string, enabled: boolean): void {
	mock.appendEntry(`toolset-state:${id}`, { enabled });
}

/** Append an allowlist-mode branch entry. */
function pinMode(mock: MockPI, allowlist: string[]): void {
	mock.appendEntry("toolset-resolution-mode", {
		mode: "allowlist",
		allowlist,
	});
}

function warningRecords(mock: MockPI) {
	return mock.getNotifyRecords().filter((r) => r.level === "warning");
}

function specOf(id: string): ToolsetSpec {
	const entry = getRegisteredToolsets().find((e) => e.spec.id === id);
	if (!entry) throw new Error(`toolset ${id} not registered`);
	return entry.spec;
}

/** Fresh mock with masking's globals reset — the common core of every
 *  fixture here. Callers add their own tools, toolsets, and factory wiring. */
function freshMock(): { mock: MockPI; pi: ExtensionAPI } {
	MockPI.cleanRegistry();
	const mock = new MockPI();
	setFocusUnit(null);
	setDriftProvider(null);
	return { mock, pi: mock as unknown as ExtensionAPI };
}

/** freshMock + the two-toolset session through the factory, as the seam and
 *  slot-marker tests see it right after session_start. */
function freshSession(): { mock: MockPI; pi: ExtensionAPI } {
	const { mock, pi } = freshMock();
	registerExtTool(mock, "web-fetch");
	registerExtTool(mock, "web-learn");
	defineTboxToolset(mock, "portal.web", ["web-fetch"]);
	defineTboxToolset(mock, "portal.learn", ["web-learn"]);
	tboxFactory(pi);
	mock.fireLifecycleEvent("session_start");
	mock.clearUiRecords();
	return { mock, pi };
}

// ---------------------------------------------------------------------------
// Warning seam
// ---------------------------------------------------------------------------

describe("drift warning seam (list | chars | status)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		({ mock, pi } = freshSession());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Leak fixture: portal.web pinned off with its member still active. */
	function makeLeak(): void {
		pinIntent(mock, "portal.web", false);
		// web-fetch stays active over the intent-off toolset — the leak.
		// (A leak is not a mask, so the slot stays pristine underneath.)
		mock.setActiveTools(["web-fetch", "web-learn"]);
	}

	it("fires one warning on /tbox status when drifted, stats output still delivered", async () => {
		makeLeak();
		await mock.dispatchCommand("status");

		const warns = warningRecords(mock);
		expect(warns).toHaveLength(1);
		expect(warns[0]!.message).toContain("portal.web (intent off, 1 active)");
		expect(warns[0]!.message).toContain("/tbox sync");

		// The stats output still arrives via its own info notify, and the
		// warning never rides inside it.
		const infos = mock.getNotifyRecords().filter((r) => r.level === "info");
		expect(infos.length).toBeGreaterThanOrEqual(1);
		expect(infos.some((r) => r.message.includes("intent mismatch"))).toBe(
			false,
		);
	});

	it("fires on list and chars too", async () => {
		makeLeak();
		await mock.dispatchCommand("list");
		expect(warningRecords(mock)).toHaveLength(1);
		await mock.dispatchCommand("chars");
		expect(warningRecords(mock)).toHaveLength(2);
	});

	it("does not fire on non-stats subcommands", async () => {
		makeLeak();
		await mock.dispatchCommand("all"); // bare → usage, no predicate run
		expect(warningRecords(mock)).toHaveLength(0);
	});

	it("does not fire when clean", async () => {
		await mock.dispatchCommand("status");
		expect(warningRecords(mock)).toHaveLength(0);
	});

	it("a help request carries no drift diagnostics", async () => {
		makeLeak();
		await mock.dispatchCommand("list --help");

		expect(warningRecords(mock)).toHaveLength(0);
		// The seam skipped entirely — nothing repainted after the drift
		// appeared, so no status record exists at all.
		expect(mock.getLastStatus(SLOT_NAME)).toBeUndefined();
		// The help output itself still arrives.
		expect(mock.getLastNotify()!.level).toBe("info");
	});

	it("never fires per prompt (force-removal survives the turn boundary)", async () => {
		// Force-removal, not a leak: the re-assert is leak-only, so the drift
		// is still live at the next prompt — and still no bubble.
		mock.setActiveTools(["web-learn"]);
		await mock.dispatchCommand("status");
		const afterStats = warningRecords(mock).length;
		mock.fireLifecycleEvent("before_agent_start");
		expect(warningRecords(mock)).toHaveLength(afterStats);
	});

	it("the bar and the bubble report from the same observation (rerenderSlot at the seam)", async () => {
		makeLeak();
		// The slot's last render was session_start (pre-drift, no marker);
		// only the seam's rerenderSlot could have produced this.
		await mock.dispatchCommand("status");
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<warning>○</warning> tbox",
		);
	});

	it("one body for every class and mode — only the fact segment differs", async () => {
		makeLeak();
		await mock.dispatchCommand("status");
		const leakMsg = warningRecords(mock)[0]!.message;
		expect(leakMsg.endsWith(DURABILITY_SUFFIX)).toBe(true);
		mock.clearUiRecords();

		// Allowlist × force-removal cross case: web allowlisted but its member
		// removed (force-removal); learn suppressed but active (leak).
		pinMode(mock, ["portal.web"]);
		mock.setActiveTools(["web-learn"]);
		await mock.dispatchCommand("chars");
		const crossMsg = warningRecords(mock)[0]!.message;
		expect(crossMsg).toContain("portal.web (intent on, 0 of 1 active)");
		expect(crossMsg.endsWith(DURABILITY_SUFFIX)).toBe(true);
		// Identical static body after the fact segment.
		expect(crossMsg.slice(crossMsg.indexOf(" — "))).toBe(
			leakMsg.slice(leakMsg.indexOf(" — ")),
		);

		// No copy asserts a cause the check cannot observe.
		expect(leakMsg).not.toContain("another extension");
		expect(crossMsg).not.toContain("another extension");
	});

	it("joins multiple mismatches on one line, ids in registry order", async () => {
		pinIntent(mock, "portal.web", false); // web: leak
		mock.setActiveTools(["web-fetch"]); // learn: force-removed
		await mock.dispatchCommand("status");

		const msg = warningRecords(mock)[0]!.message;
		const iWeb = msg.indexOf("portal.web (intent off, 1 active)");
		const iLearn = msg.indexOf("portal.learn (intent on, 0 of 1 active)");
		expect(iWeb).toBeGreaterThanOrEqual(0);
		expect(iLearn).toBeGreaterThan(iWeb);
	});
});

// ---------------------------------------------------------------------------
// syncToolsets — the projector
// ---------------------------------------------------------------------------

describe("syncToolsets", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		({ mock, pi } = freshMock());

		registerExtTool(mock, "web-fetch");
		registerExtTool(mock, "web-learn");
		defineTboxToolset(mock, "portal.web", ["web-fetch"]);
		// The requires edge is inert to sync (no cascade — sync is a
		// projector), so it rides along in every fixture in this describe.
		defineTboxToolset(mock, "portal.learn", ["web-learn"], {
			requires: ["portal.web"],
		});

		// Clean baseline: everything on and active.
		mock.setActiveTools(["web-fetch", "web-learn"]);
	});

	it("a clean registry is a no-op: no writes, no events, no entries", () => {
		const spy = vi.spyOn(mock, "setActiveTools");
		const changed: unknown[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (d) => changed.push(d));
		const before = mock.getEntries().length;

		expect(syncToolsets(pi, branchOf(mock)).message).toBe(
			"Already in the desired state.",
		);
		expect(spy).not.toHaveBeenCalled();
		expect(changed).toEqual([]);
		expect(mock.getEntries()).toHaveLength(before);
	});

	it("honors a settings-tier pin (no branch entry) when projecting", () => {
		pinSettingsDefaultsForTests({
			"toolset-state:portal.web": { enabled: false },
		});
		// Both members stay active: web's member is the leak; learn stays
		// clean so the settings pin is the only drift in the fixture.
		mock.setActiveTools(["web-fetch", "web-learn"]);

		const { message: reply } = syncToolsets(pi, branchOf(mock));

		expect(mock.getActiveTools()).toEqual(["web-learn"]);
		expect(reply).toBe("aligned: +portal.web: stripped 1");
	});

	it("strips a leaked intent-off toolset and reports the delta", () => {
		pinIntent(mock, "portal.web", false);
		const entriesBefore = mock.getEntries().length;

		const { message: reply } = syncToolsets(pi, branchOf(mock));

		expect(mock.getActiveTools()).toEqual(["web-learn"]);
		expect(reply).toBe("aligned: +portal.web: stripped 1");
		// Persists nothing.
		expect(mock.getEntries()).toHaveLength(entriesBefore);
	});

	it("re-adds a force-removed intent-on toolset (all-members-removed clobber)", () => {
		mock.setActiveTools([]);

		const { message: reply } = syncToolsets(pi, branchOf(mock));

		expect(mock.getActiveTools()).toEqual(["web-fetch", "web-learn"]);
		expect(reply).toBe(
			"aligned: +portal.web: re-added 1; +portal.learn: re-added 1",
		);
	});

	it("one write per drifted toolset, never a merged batch; changed only for drifted specs", () => {
		pinIntent(mock, "portal.web", false);
		mock.setActiveTools(["web-fetch"]); // learn force-removed too

		const spy = vi.spyOn(mock, "setActiveTools");
		const changed: { id: string; enabled: boolean }[] = [];
		mock.events.on(TOOLSET_EVENTS.changed, (d) =>
			changed.push(d as { id: string; enabled: boolean }),
		);

		const { message: reply } = syncToolsets(pi, branchOf(mock));

		// Two per-id writes in registry order — strip, then re-add.
		expect(spy.mock.calls).toEqual([[[]], [["web-learn"]]]);
		expect(changed).toEqual([
			{ id: "portal.web", enabled: false },
			{ id: "portal.learn", enabled: true },
		]);
		expect(reply).toBe(
			"aligned: +portal.web: stripped 1; +portal.learn: re-added 1",
		);
	});

	it("partial force-removal re-adds only the missing member", () => {
		registerExtTool(mock, "pair-a");
		registerExtTool(mock, "pair-b");
		defineTboxToolset(mock, "portal.pair", ["pair-a", "pair-b"]);
		// One of the two members stripped from an intent-on toolset; every
		// other toolset stays clean so only this one drifts.
		mock.setActiveTools(["web-fetch", "web-learn", "pair-a"]);

		const { message: reply } = syncToolsets(pi, branchOf(mock));

		expect(mock.getActiveTools()).toEqual([
			"web-fetch",
			"web-learn",
			"pair-a",
			"pair-b",
		]);
		expect(reply).toBe("aligned: +portal.pair: re-added 1");
	});

	it("projects incoherent declared state faithfully — no cascade, no throw", () => {
		// portal.learn requires portal.web, yet resolves on over web pinned
		// off. Sync projects the declared state as-is: re-adds learn's
		// member, never touches web.
		pinIntent(mock, "portal.web", false);
		mock.setActiveTools([]); // learn's member drifted off; web already clean

		const spy = vi.spyOn(mock, "setActiveTools");
		const { message: reply } = syncToolsets(pi, branchOf(mock));

		expect(mock.getActiveTools()).toEqual(["web-learn"]);
		expect(reply).toBe("aligned: +portal.learn: re-added 1");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("under focus: enforces the focus list for drifted toolsets, no refusal", () => {
		pinMode(mock, ["portal.web"]);
		// web (allowlisted) force-removed; learn (suppressed) leaked active.
		mock.setActiveTools(["web-learn"]);
		const modeBefore = mock.getEntries("toolset-resolution-mode");
		const entriesBefore = mock.getEntries().length;

		const { message: reply } = syncToolsets(pi, branchOf(mock));

		expect(mock.getActiveTools()).toEqual(["web-fetch"]);
		expect(reply).toBe(
			"aligned to the active focus list: +portal.web: re-added 1; " +
				"+portal.learn: stripped 1",
		);
		// Focus membership unchanged; nothing persisted of any kind.
		expect(mock.getEntries("toolset-resolution-mode")).toEqual(modeBefore);
		expect(mock.getEntries()).toHaveLength(entriesBefore);
	});

	it("corrupt allowlist: fail-closed enforce, reply names the corruption", () => {
		pinMode(mock, []); // empty allowlist under allowlist mode
		const entriesBefore = mock.getEntries().length;

		const { message: reply, level } = syncToolsets(pi, branchOf(mock));

		// Enforced as empty — the same resolution the re-assert applies —
		// but the reply refuses to present the empty list as intent.
		expect(mock.getActiveTools()).toEqual([]);
		expect(level).toBe("warning");
		expect(reply).toContain("mode entry is corrupt");
		expect(reply).toContain("/tbox focus off or /tbox defaults restore");
		expect(reply).not.toContain("aligned");
		expect(mock.getEntries()).toHaveLength(entriesBefore);
	});

	it("corrupt allowlist with zero drift: still named, not 'already in the desired state'", () => {
		pinMode(mock, []); // empty allowlist under allowlist mode
		mock.setActiveTools([]); // live already matches the corrupt empty list
		const entriesBefore = mock.getEntries().length;

		const { message: reply, level } = syncToolsets(pi, branchOf(mock));

		expect(mock.getActiveTools()).toEqual([]);
		expect(level).toBe("warning");
		expect(reply).toContain("mode entry is corrupt");
		expect(reply).not.toContain("Already in the desired state");
		// The zero-drift early return persists nothing.
		expect(mock.getEntries()).toHaveLength(entriesBefore);
	});
});

// ---------------------------------------------------------------------------
// /tbox sync via dispatch — argument surface
// ---------------------------------------------------------------------------

describe("/tbox sync via dispatch", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		({ mock, pi } = freshMock());

		registerExtTool(mock, "web-fetch");
		defineTboxToolset(mock, "portal.web", ["web-fetch"]);

		tboxFactory(pi);
		mock.fireLifecycleEvent("session_start");
		mock.clearUiRecords();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects trailing arguments", async () => {
		await mock.dispatchCommand("sync extra");
		expect(mock.getLastNotify()!.message).toContain("Usage: /tbox sync");
	});

	it("rejects unknown flags", async () => {
		await mock.dispatchCommand("sync --foo");
		expect(mock.getLastNotify()!.message).toContain("unknown flag");
	});

	it("--help prints usage instead of performing an alignment", async () => {
		// Drifted fixture: without the help branch, --help would fall through
		// to the alignment and reply "aligned", not usage.
		pinIntent(mock, "portal.web", false);
		mock.setActiveTools(["web-fetch"]);
		await mock.dispatchCommand("sync --help");
		expect(mock.getLastNotify()!.message).toContain("Usage: /tbox sync");
		expect(mock.getLastNotify()!.message).not.toContain("aligned");
	});

	it("a clean run replies already-in-desired-state via info", async () => {
		await mock.dispatchCommand("sync");
		const notify = mock.getLastNotify()!;
		expect(notify.level).toBe("info");
		expect(notify.message).toBe("Already in the desired state.");
	});

	it("corrupt mode rides warning through the dispatch seam", async () => {
		pinMode(mock, []); // empty allowlist under allowlist mode
		await mock.dispatchCommand("sync");
		// The corruption report must arrive at the user as a warning-level
		// notify, not the info level the ordinary replies ride.
		expect(mock.getLastNotify()!.level).toBe("warning");
		expect(mock.getLastNotify()!.message).toContain("mode entry is corrupt");
	});
});

// ---------------------------------------------------------------------------
// Residual honesty
// ---------------------------------------------------------------------------

describe("sync residual honesty", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		({ mock, pi } = freshMock());

		registerExtTool(mock, "web-a");
		registerExtTool(mock, "web-b");
		defineTboxToolset(mock, "portal.web", ["web-a", "web-b"]);
		mock.setActiveTools([]); // clobber: intent on, zero active
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("a silently-dropped write is reported as a residual, not a success", () => {
		// MockPI cannot model pi's _applyToolLoadout gate, so the stub stands
		// in for it: the write lands, but one re-added name is silently
		// dropped instead of activated.
		const orig = mock.setActiveTools.bind(mock);
		const spy = vi.spyOn(mock, "setActiveTools");
		spy.mockImplementation((names: string[]) => {
			orig(names.filter((n) => n !== "web-a"));
		});

		const { message: reply } = syncToolsets(pi, branchOf(mock));

		expect(reply).toBe(
			"+portal.web: wrote 2, 1 still inactive after the write " +
				"(possibly not activatable under your --tools filter)",
		);
		// An observation, never a diagnosis: the cause is offered as a
		// possibility, and no alignment is claimed while a residual stands.
		expect(reply).toContain("possibly");
		expect(reply).not.toMatch(/not named by|is excluded|are excluded/);
		expect(reply).not.toContain("aligned");
	});

	it("without the stub the write lands and a follow-up predicate read is clean", () => {
		const { message: reply } = syncToolsets(pi, branchOf(mock));

		expect(reply).toBe("aligned: +portal.web: re-added 2");
		expect(computeDrift(pi, branchOf(mock))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Slot drift marker
// ---------------------------------------------------------------------------

describe("slot drift marker (factory-wired provider)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		({ mock, pi } = freshSession());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("a drifted render followed by sync's own changed repaint clears the warning glyph", async () => {
		mock.setActiveTools(["web-learn"]); // force-removal on web

		await mock.dispatchCommand("status"); // seam: warning + rerenderSlot
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<warning>●</warning> tbox 1 masked",
		);

		// sync's writes emit changed → the fanout repaint re-invokes the
		// provider, which now reads clean — no cached flag survives.
		await mock.dispatchCommand("sync");
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe("<dim>○</dim> tbox");
	});

	it("a re-assert-style write clears the warning glyph through the same fanout", async () => {
		// Leak fixture: portal.web pinned off with its member still active.
		pinIntent(mock, "portal.web", false);
		await mock.dispatchCommand("status"); // marker lit on pristine
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<warning>○</warning> tbox",
		);

		// The same write+emit shape masking's turn re-assert uses to strip a
		// leak — the fanout repaint must re-evaluate, not reuse the verdict.
		forceToolsetEnabled(pi, specOf("portal.web"), false);
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<accent>●</accent> tbox 1 masked",
		);
	});

	it("a stats command strips a stale marker after a silent foreign clear (no bubble)", async () => {
		// Marker lit, then drift cleared by a silent setActiveTools — no
		// TOOLSET_EVENTS fanout, so the bar keeps the warning glyph. The
		// next stats command must repaint (clean verdict → no marker) and
		// stay silent — bar and bubble agree in the clean direction too.
		pinIntent(mock, "portal.web", false);
		mock.setActiveTools(["web-fetch", "web-learn"]); // leak → marker
		await mock.dispatchCommand("status");
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<warning>○</warning> tbox",
		);
		const warningsBefore = warningRecords(mock).length;

		mock.setActiveTools(["web-learn"]); // silent foreign clear
		await mock.dispatchCommand("chars");
		// web-learn is still active (intent-on, clean) → count state, but
		// the drift marker is gone.
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<accent>●</accent> tbox 1 masked",
		);
		expect(warningRecords(mock)).toHaveLength(warningsBefore);
	});

	it("status --help serves usage instead of the stats output (no drift bubble)", async () => {
		// The seam skips --help on the assumption help was actually served;
		// status now handles the flag itself, so that assumption holds.
		pinIntent(mock, "portal.web", false);
		mock.setActiveTools(["web-fetch", "web-learn"]); // leak → drift live
		const warningsBefore = warningRecords(mock).length;

		await mock.dispatchCommand("status --help");
		const records = mock.getNotifyRecords();
		const last = records[records.length - 1]!;
		expect(last.level).toBe("info");
		expect(last.message).toMatch(/^Usage: \/tbox status/);
		expect(warningRecords(mock)).toHaveLength(warningsBefore);
	});

	it("a clean sync strips a stale marker after a silent foreign clear (no bubble)", async () => {
		// The no-op sync path performs no write, so no changed event fires —
		// the sync case must repaint itself for the stale marker to clear,
		// like the stats seam does.
		pinIntent(mock, "portal.web", false);
		mock.setActiveTools(["web-fetch", "web-learn"]); // leak → marker
		await mock.dispatchCommand("status");
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<warning>○</warning> tbox",
		);
		const warningsBefore = warningRecords(mock).length;

		mock.setActiveTools(["web-learn"]); // silent foreign clear
		await mock.dispatchCommand("sync"); // no-op: "Already in the desired state."
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<accent>●</accent> tbox 1 masked",
		);
		expect(warningRecords(mock)).toHaveLength(warningsBefore);
	});

	it("hook-1 ordering: the marker is fresh after the per-prompt repair", () => {
		// Leak fixture created after session_start's restore ran.
		pinIntent(mock, "portal.web", false);

		// masking's re-assert (registered before tbox's hook 1) strips the
		// leak; tbox's hook-1 render must reflect the repaired state — no
		// marker one event behind — and no render path notifies.
		mock.fireLifecycleEvent("before_agent_start");
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<accent>●</accent> tbox 1 masked",
		);
		expect(mock.getNotifyRecords()).toEqual([]);
	});
});

describe("drift provider (unit, status-slot module)", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	function slotCtx(): SlotCtx {
		// SAFETY: SlotCtx reads only ui.setStatus and ui.theme.fg.
		return mock.createContext() as unknown as SlotCtx;
	}

	beforeEach(() => {
		({ mock, pi } = freshMock());
		registerExtTool(mock, "web-fetch");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("the provider runs fresh on every render path and no path notifies", () => {
		const provider = vi.fn(() => true);
		setDriftProvider(provider);
		wireSlot(pi, () => slotCtx());

		render(pi, slotCtx()); // direct render
		rerenderSlot(pi); // out-of-band repaint
		mock.emit(TOOLSET_EVENTS.changed, { id: "portal.web", enabled: false });
		mock.emit(TOOLSET_EVENTS.restored, { id: "portal.web", enabled: true });

		expect(provider).toHaveBeenCalledTimes(4);
		// Diagnostics render, they never talk.
		expect(mock.getNotifyRecords()).toEqual([]);
	});

	it("a false-returning provider renders clean", () => {
		setDriftProvider(() => false);

		mock.setActiveTools([]);
		render(pi, slotCtx());
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<accent>●</accent> tbox 1 masked",
		);
	});

	it("the warning glyph coexists with all four base states when drift persists", () => {
		setDriftProvider(() => true);

		mock.setActiveTools(["web-fetch"]);
		render(pi, slotCtx());
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<warning>○</warning> tbox",
		);

		mock.setActiveTools([]);
		render(pi, slotCtx());
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<warning>●</warning> tbox 1 masked",
		);

		setFocusUnit("portal.web");
		mock.setActiveTools(["web-fetch"]);
		render(pi, slotCtx());
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<warning>●</warning> focus:portal.web (1)",
		);

		mock.setActiveTools([]);
		render(pi, slotCtx());
		// Focus-empty renders error red — error outranks the drift warning,
		// a broken focus is the louder fact; the bubble still reports drift.
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<error>●</error> focus:∅",
		);
	});
});
