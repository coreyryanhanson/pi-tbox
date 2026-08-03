import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tboxFactory from "../index.js";
import { getRegisteredToolsets, type RegistryEntry } from "pi-tool-masking";
import { SLOT_NAME } from "../src/status-slot.js";

describe("slot re-render on before_agent_start", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("refreshes the slot after a reconciler leaks tools via setActiveTools", () => {
		// Two extension tools sharing the "extension" source → one orphan toolset.
		for (const name of ["portal-a", "portal-b"]) {
			mock.registerTool({
				name,
				description: `Tool ${name}`,
				sourceInfo: {
					path: "portal.ts",
					source: "extension",
					scope: "user",
					origin: "top-level",
				},
			});
		}

		tboxFactory(pi);

		// session_start captures lastCtx and renders the slot (both enabled → pristine).
		mock.fireLifecycleEvent("session_start");
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe("<dim>○</dim> tbox");

		// Establish a masked baseline: disable the orphan toolset → 2 excluded.
		const entry = getRegisteredToolsets().find(
			(e: RegistryEntry) => e.spec.id === "tbox.tool@extension",
		)!;
		entry.toolset.disable(pi);
		const baseline = mock.getLastStatus(SLOT_NAME)!.text;
		expect(baseline).toBe("<accent>●</accent> tbox 2 masked");

		// Leak: a reconciler re-adds both tools directly, WITHOUT emitting
		// TOOLSET_EVENTS.changed — the slot cannot know and stays stale.
		mock.setActiveTools(["portal-a", "portal-b"]);
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(baseline);

		// before_agent_start re-renders from the live active set.
		mock.fireLifecycleEvent("before_agent_start");
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe("<dim>○</dim> tbox");
	});
});
