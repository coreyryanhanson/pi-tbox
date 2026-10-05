// Tests must never run as a deferring child: when the outer session (e.g. a
// pi subagent running `npm test`) carries PI_TOOLMASKING_DEFER, masking's
// defer gate no-ops every toggle and registration and dozens of tests fail.
// Tests that exercise the gate set the var themselves (defer.test.ts).
delete process.env.PI_TOOLMASKING_DEFER;
