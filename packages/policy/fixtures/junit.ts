// JUnit XML reports as the three supported runners write them (SPEC §8.6): jest-junit, Vitest's
// junit reporter and pytest --junitxml. Each runner's baseline (the failure reproduced) and a
// report after a good fix.

export const JEST_BASELINE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="3" failures="1" errors="0" time="1.204">
  <testsuite name="total" errors="0" failures="1" skipped="1" timestamp="2026-11-25T10:00:00" time="0.812" tests="3">
    <testcase classname="total adds prices" name="total adds prices" time="0.002">
    </testcase>
    <testcase classname="total is zero when empty" name="total is zero when empty" time="0.001">
      <failure>Error: expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 1
    at Object.&lt;anonymous&gt; (/home/runner/work/shop/src/cart.test.ts:10:24)</failure>
    </testcase>
    <testcase classname="total rounds" name="total rounds" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>
`;

export const JEST_FIXED = JEST_BASELINE.replace(/<failure>[\s\S]*<\/failure>/, "");

export const VITEST_BASELINE = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="1" errors="0" time="0.5">
    <testsuite name="src/cart.test.ts" timestamp="2026-11-25T10:00:00.000Z" hostname="runner" tests="2" failures="1" errors="0" skipped="0" time="0.01">
        <testcase classname="src/cart.test.ts" name="total &gt; adds prices" time="0.001">
        </testcase>
        <testcase classname="src/cart.test.ts" name="total &gt; is zero when empty" time="0.002">
            <failure message="expected 1 to be +0 // Object.is equality" type="AssertionError">
AssertionError: expected 1 to be +0 // Object.is equality
 ❯ src/cart.test.ts:10:24
            </failure>
        </testcase>
    </testsuite>
</testsuites>
`;

export const VITEST_FIXED = VITEST_BASELINE.replace(/<failure[\s\S]*<\/failure>/, "");

export const PYTEST_BASELINE = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4" time="0.05" timestamp="2026-11-25T10:00:00" hostname="runner"><testcase classname="tests.test_cart" name="test_adds_prices" time="0.001" /><testcase classname="tests.test_cart" name="test_rejects_negative" time="0.002"><failure message="Failed: DID NOT RAISE &lt;class 'ValueError'&gt;">def test_rejects_negative():
&gt;       with pytest.raises(ValueError):
E       Failed: DID NOT RAISE &lt;class 'ValueError'&gt;</failure></testcase><testcase classname="tests.test_cart" name="test_db" time="0.001"><error message="failed on setup with &quot;ConnectionError&quot;">conftest.py:12: ConnectionError</error></testcase><testcase classname="tests.test_cart" name="test_param[2-3]" time="0.001"><skipped type="pytest.skip" message="later">tests/test_cart.py:20: later</skipped></testcase></testsuite></testsuites>`;

export const PYTEST_FIXED = PYTEST_BASELINE.replace(/<failure[\s\S]*?<\/failure>/, "").replace(
  /<error[\s\S]*?<\/error>/,
  "",
);
