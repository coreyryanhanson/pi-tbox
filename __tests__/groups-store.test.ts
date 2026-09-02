/**
 * Tests for the dedicated global groups store (`config/settings-reader.ts`).
 *
 * Groups are user-scoped: they live in one global file
 * (`~/.pi/agent/pi-tbox/groups.json`), not per-project, so a group
 * defined in one directory is usable from any other. These tests
 * exercise the real disk path through temp files (the override is kept
 * null) and assert the default path is not derived from `process.cwd()`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
	GROUPS_FILE_PATH,
	readGroups,
	writeGroup,
	removeGroup,
	setGroupsOverrideForTests,
	GroupsFileCorruptError,
} from "../config/settings-reader.js";

describe("groups store — global, cross-directory", () => {
	let tmp: string;

	beforeEach(() => {
		// Production disk path: no override.
		setGroupsOverrideForTests(null);
		tmp = mkdtempSync(join(tmpdir(), "tbox-groups-"));
	});

	afterEach(() => {
		setGroupsOverrideForTests(null);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("GROUPS_FILE_PATH is the global user path, not cwd-derived", () => {
		// The whole point: groups follow the user, not the repo.
		expect(GROUPS_FILE_PATH).toBe(
			join(homedir(), ".pi", "agent", "pi-tbox", "groups.json"),
		);
		// Belt-and-braces: it never references the current working dir.
		expect(GROUPS_FILE_PATH.includes(process.cwd())).toBe(false);
	});

	it("writeGroup then readGroups round-trips through a real file", () => {
		const file = join(tmp, "groups.json");
		writeGroup("research", { toolsets: ["portal.web", "portal.learn"] }, file);

		const groups = readGroups(file);
		expect(groups["research"]).toEqual({
			toolsets: ["portal.web", "portal.learn"],
		});
	});

	it("writeGroup preserves existing groups in the file", () => {
		const file = join(tmp, "groups.json");
		writeGroup("research", { toolsets: ["portal.web"] }, file);
		writeGroup("host", { toolsets: ["host.api"] }, file);

		const groups = readGroups(file);
		expect(Object.keys(groups).sort()).toEqual(["host", "research"]);
		expect(groups["research"]!.toolsets).toEqual(["portal.web"]);
	});

	it("readGroups returns {} for a missing or malformed file", () => {
		expect(readGroups(join(tmp, "nope.json"))).toEqual({});
		const bad = join(tmp, "bad.json");
		writeFileSync(bad, "{not json");
		expect(readGroups(bad)).toEqual({});
	});

	it("writeGroup writes to the given path, never into process.cwd", () => {
		const file = join(tmp, "groups.json");
		writeGroup("research", { toolsets: ["portal.web"] }, file);

		// The file landed at the temp path, not under process.cwd.
		expect(existsSync(file)).toBe(true);
		expect(file.startsWith(process.cwd())).toBe(false);

		const raw = JSON.parse(readFileSync(file, "utf-8"));
		expect(raw["research"].toolsets).toEqual(["portal.web"]);
	});

	it("the file shape is the groups table directly — no tbox/groups wrapper", () => {
		const file = join(tmp, "groups.json");
		writeGroup("research", { toolsets: ["portal.web"] }, file);

		const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<
			string,
			unknown
		>;
		// Top-level keys are group names, not namespace wrappers.
		expect(raw.tbox).toBeUndefined();
		expect(raw.groups).toBeUndefined();
		expect(raw["research"]).toEqual({ toolsets: ["portal.web"] });
	});

	describe("removeGroup", () => {
		let tmp: string;

		beforeEach(() => {
			setGroupsOverrideForTests(null);
			tmp = mkdtempSync(join(tmpdir(), "tbox-groups-"));
		});

		afterEach(() => {
			setGroupsOverrideForTests(null);
			rmSync(tmp, { recursive: true, force: true });
		});

		it("deletes an existing group", () => {
			const file = join(tmp, "groups.json");
			writeGroup("research", { toolsets: ["portal.web"] }, file);
			writeGroup("host", { toolsets: ["host.api"] }, file);

			const removed = removeGroup("research", file);
			expect(removed).toBe(true);

			const groups = readGroups(file);
			expect(groups["research"]).toBeUndefined();
			expect(groups["host"]).toBeDefined();
		});

		it("returns false for a non-existent group", () => {
			const file = join(tmp, "groups.json");
			writeGroup("research", { toolsets: ["portal.web"] }, file);

			expect(removeGroup("ghost", file)).toBe(false);
			// existing group untouched
			expect(readGroups(file)["research"]).toBeDefined();
		});

		it("preserves other groups on remove", () => {
			const file = join(tmp, "groups.json");
			writeGroup("a", { toolsets: [] }, file);
			writeGroup("b", { toolsets: [] }, file);

			removeGroup("a", file);
			const groups = readGroups(file);
			expect(Object.keys(groups)).toEqual(["b"]);
		});
	});

	describe("writeGroup validation", () => {
		it("rejects reserved keywords", () => {
			expect(() => writeGroup("focus", { toolsets: [] })).toThrow("reserved word");
			expect(() => writeGroup("list", { toolsets: [] })).toThrow("reserved word");
			expect(() => writeGroup("on", { toolsets: [] })).toThrow("reserved word");
			expect(() => writeGroup("remove", { toolsets: [] })).toThrow(
				"reserved word",
			);
		});

		it("rejects names containing +", () => {
			expect(() => writeGroup("tool+set", { toolsets: [] })).toThrow(
				"must not contain",
			);
			expect(() => writeGroup("+portal", { toolsets: [] })).toThrow(
				"must not contain",
			);
		});

		it("allows valid names including toolset ids", () => {
			const file = join(tmp, "groups.json");
			expect(() => writeGroup("research", { toolsets: [] }, file)).not.toThrow();
			expect(() => writeGroup("portal.web", { toolsets: [] }, file)).not.toThrow();
			expect(() => writeGroup("my-group", { toolsets: [] }, file)).not.toThrow();
		});
	});

	describe("corrupt-file safety", () => {
		let tmp: string;

		beforeEach(() => {
			setGroupsOverrideForTests(null);
			tmp = mkdtempSync(join(tmpdir(), "tbox-groups-"));
		});

		afterEach(() => {
			setGroupsOverrideForTests(null);
			rmSync(tmp, { recursive: true, force: true });
		});

		it("writeGroup refuses to overwrite an unparseable file, preserving bytes", () => {
			const file = join(tmp, "groups.json");
			const corrupt = '{"research": {"toolsets": ["portal.web'; // truncated
			writeFileSync(file, corrupt);

			expect(() => writeGroup("host", { toolsets: ["host.api"] }, file)).toThrow(
				GroupsFileCorruptError,
			);
			// The original (corrupt) bytes are untouched — no silent wipe.
			expect(readFileSync(file, "utf-8")).toBe(corrupt);
		});

		it("removeGroup refuses to proceed on a corrupt file", () => {
			const file = join(tmp, "groups.json");
			const corrupt = '[{"nope"}]'; // valid JSON, wrong shape
			writeFileSync(file, corrupt);

			expect(() => removeGroup("host", file)).toThrow(GroupsFileCorruptError);
			expect(readFileSync(file, "utf-8")).toBe(corrupt);
		});

		it("readGroups degrades to {} on a corrupt file — reads stay harmless", () => {
			const file = join(tmp, "groups.json");
			writeFileSync(file, "{not json");
			expect(readGroups(file)).toEqual({});
		});

		it("an empty (zero-byte) file is treated as absent, not corrupt", () => {
			const file = join(tmp, "groups.json");
			writeFileSync(file, "");
			expect(readGroups(file)).toEqual({});
			expect(() =>
				writeGroup("research", { toolsets: ["portal.web"] }, file),
			).not.toThrow();
		});

		it("writes are atomic — no .tmp leftover after a successful save", () => {
			const file = join(tmp, "groups.json");
			writeGroup("research", { toolsets: ["portal.web"] }, file);
			expect(existsSync(`${file}.tmp`)).toBe(false);
			const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<
				string,
				unknown
			>;
			expect(raw["research"]).toEqual({ toolsets: ["portal.web"] });
		});
	});
});
