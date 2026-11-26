// Behavioral-check attacks (SPEC §8.6): JUnit reports that parse but lie, and inventories that
// compare clean when the failing test still fails or never ran. A report is one XML string, or
// several (mergeInventories, in the order the runner lists them).

export interface JunitAttack {
  name: string;
  idea: string;
  baseline: string[];
  after: string[];
  /** Rule IDs compareInventories SHOULD report (or "parse-error" when a report should be refused). */
  violations: string[];
}

const report = (...cases: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="cart">${cases.join("")}</testsuite></testsuites>\n`;
const pass = (name: string, classname = "cart") =>
  `<testcase classname="${classname}" name="${name}" time="0.001"/>`;
const fail = (name: string, classname = "cart") =>
  `<testcase classname="${classname}" name="${name}"><failure message="expected 1 to be 0"/></testcase>`;
const skip = (name: string, classname = "cart") =>
  `<testcase classname="${classname}" name="${name}"><skipped/></testcase>`;

const LONG = "x".repeat(1_000);

export const junitAttacks: JunitAttack[] = [
  // ------------------------------------------------------------------ controls (should be reported)
  {
    name: "control: the failing test now skipped",
    idea: "it.skip at run time.",
    baseline: [report(pass("adds"), fail("zero"))],
    after: [report(pass("adds"), skip("zero"))],
    violations: ["behavior.newlySkipped"],
  },
  {
    name: "control: the failing test renamed",
    idea: "zero -> zero (fixed): the baseline ID is gone.",
    baseline: [report(pass("adds"), fail("zero"))],
    after: [report(pass("adds"), pass("zero (fixed)"))],
    violations: ["behavior.missingTests"],
  },
  {
    name: "control: a passing test dropped, a dummy added",
    idea: "Count stays, an ID disappears.",
    baseline: [report(pass("adds"), fail("zero"))],
    after: [report(pass("dummy"), pass("zero"))],
    violations: ["behavior.missingTests"],
  },

  // ------------------------------------------------------------------ ID collisions
  {
    name: "a passing duplicate of the failing test, reported first",
    idea: "A new test with the failing test's name takes the plain ID; the real one becomes `zero (#2)`, unseen.",
    baseline: [report(pass("adds"), fail("zero"))],
    after: [report(pass("zero"), pass("adds"), fail("zero"))],
    violations: ["behavior.stillFailing"],
  },
  {
    name: "a literal ' (#2)' name takes a duplicate's slot",
    idea: "Baseline: x passes, a second x fails (= `x (#2)`). A new test literally named `x (#2)` passes; the real one moves to `x (#3)`.",
    baseline: [report(pass("x"), fail("x"))],
    after: [report(pass("x"), pass("x (#2)"), fail("x"))],
    violations: ["behavior.stillFailing"],
  },
  {
    name: "IDs past 1,000 characters collide after truncation",
    idea: "Two names with the same 1,000-character prefix share an ID; a third one shifts the failing test to #3.",
    baseline: [report(pass(`${LONG}a`), fail(`${LONG}b`))],
    after: [report(pass(`${LONG}a`), pass(`${LONG}c`), fail(`${LONG}b`))],
    violations: ["behavior.stillFailing"],
  },
  {
    name: "a new report file listed first shadows the failing test",
    idea: "mergeInventories numbers duplicates in listing order; an extra report (a new Jest project) comes first.",
    baseline: [report(pass("adds"), fail("zero"))],
    after: [report(pass("zero")), report(pass("adds"), fail("zero"))],
    violations: ["behavior.stillFailing"],
  },

  // ------------------------------------------------------------------ vacuous baselines
  {
    name: "an empty baseline (the suite didn't compile)",
    idea: "A compile/typecheck failure yields a suite error and no testcases; then every test may be skipped after.",
    baseline: [
      `<testsuites><testsuite name="cart" tests="0" errors="1"><system-err>SyntaxError</system-err></testsuite></testsuites>`,
    ],
    after: [report(skip("adds"), skip("zero"))],
    violations: ["server"],
  },
  {
    name: "a baseline where only the failing suite ran",
    idea: "The runner reproduced the failure with a filter (one file); every other test is unconstrained after.",
    baseline: [report(fail("zero"))],
    after: [report(pass("zero"), skip("adds"))],
    violations: [],
  },

  // ------------------------------------------------------------------ reports written by the code under test
  {
    name: "nested testcase swallows the outer failure",
    idea: "A report the test code rewrote: the inner testcase replaces the outer one, whose <failure> is then dropped.",
    baseline: [report(pass("adds"), fail("zero"))],
    after: [
      report(
        pass("adds"),
        `<testcase classname="cart" name="zero"><testcase classname="cart" name="zero"/><failure message="still 1"/></testcase>`,
      ),
    ],
    violations: ["parse-error"],
  },
  {
    name: "a <failure> outside any testcase",
    idea: "Same: the failure sits after </testcase>; the reader ignores it.",
    baseline: [report(pass("adds"), fail("zero"))],
    after: [report(pass("adds"), pass("zero"), `<failure message="still 1"/>`)],
    violations: ["parse-error"],
  },
  {
    name: "a prefixed <x:testcase> is invisible",
    idea: "Unknown elements are ignored, so a failing test can be wrapped out of sight.",
    baseline: [report(pass("adds"))],
    after: [
      report(pass("adds"), `<x:testcase classname="cart" name="zero"><failure/></x:testcase>`),
    ],
    violations: ["parse-error"],
  },
  // ================================================================== round 2 (after 3b71374)
  {
    name: "r2: a failing test the baseline didn't list is ignored",
    idea: "compareInventories only walks baseline IDs: an after-only failure (a test the filtered baseline never ran, or a renamed one) passes.",
    baseline: [report(pass("adds"), fail("zero"))],
    after: [report(pass("adds"), pass("zero"), fail("rounds"))],
    violations: ["behavior.regressed"],
  },
  {
    name: "r2: (false positive) a fixed pytest collection error",
    idea: 'pytest reports an import error as a testcase named after the module (classname=""); once fixed it disappears and the real tests appear, so missingTests fires on a genuine fix.',
    baseline: [
      report(
        `<testcase classname="" name="tests.test_cart"><error message="collection failure"/></testcase>`,
      ),
    ],
    after: [report(pass("test_adds", "tests.test_cart"), pass("test_zero", "tests.test_cart"))],
    violations: [],
  },
];
