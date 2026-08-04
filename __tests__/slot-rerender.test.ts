import { describe, it, expect, beforeEach } from "vitest";
import { MockPI } from "./mock-pi.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tboxFactory from "../index.js";
import { SLOT_NAME } from "../src/status-slot.js";

describe("slot re-render on before_agent_start", () => {
	let mock: MockPI;
	let pi: ExtensionAPI;

	beforeEach(() => {
		MockPI.cleanRegistry();
		mock = new MockPI();
		pi = mock as unknown as ExtensionAPI;
	});

	it("refreshes the slot after a reconciler force-removes an enabled tool via setActiveTools", () => {
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

		// Force-removal: a reconciler drops one tool directly, WITHOUT emitting
		// TOOLSET_EVENTS.changed — the slot cannot know and stays stale.
		mock.setActiveTools(["portal-a"]);
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe("<dim>○</dim> tbox");

		// The orphan toolset is ENABLED, so pi-tool-masking's before_agent_start
		// re-assert (leak-direction only) does NOT restore the removed tool —
		// only tbox's turn-boundary re-render reflects the live active set.
		mock.fireLifecycleEvent("before_agent_start");
		expect(mock.getLastStatus(SLOT_NAME)!.text).toBe(
			"<accent>●</accent> tbox 1 masked",
		);
	});
});
