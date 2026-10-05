// Release guard: the published package must declare pi-tool-masking as a
// semver range. The development spec (`file:../pi-tool-masking`, uncommitted)
// would break every consumer if it were ever published. Wired into
// `prepublishOnly`, which `npm publish` (and therefore scripts/release.mjs)
// triggers. Exit code is the contract: 0 = safe to publish, 1 = abort.

import { readFileSync } from "node:fs";

try {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const spec = pkg.dependencies?.["pi-tool-masking"];

	// A semver range: optional ^ or ~, then x.y.z (prerelease/build parts allowed).
	const SEMVER_RANGE = /^[~^]?\d+\.\d+\.\d+(?:[-+][\w.-]+)?/;

	if (typeof spec !== "string" || !SEMVER_RANGE.test(spec)) {
		console.error(
			`\nRelease aborted: dependencies["pi-tool-masking"] is ${JSON.stringify(spec) ?? "missing"}, not a semver range.\n` +
				"The development `file:` spec must never be published. Restore the\n" +
				"semver range and regenerate package-lock.json before publishing:\n" +
				"  npm i pi-tool-masking@^2.0.0\n",
		);
		process.exit(1);
	}

	console.log(`pi-tool-masking spec OK: ${spec}`);
} catch (err) {
	// An unreadable or malformed package.json is itself an abort condition:
	// npm publish would fail anyway, but the guard names the cause.
	console.error(`\nRelease aborted: cannot read package.json — ${err?.message ?? err}\n`);
	process.exit(1);
}
