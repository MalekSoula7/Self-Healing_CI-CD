// JUnit XML into a test inventory (SPEC §8.6). Reports come from the customer's runner: untrusted.
// Written before the implementation.
import { describe, expect, it } from "vitest";
import { JEST_BASELINE, PYTEST_BASELINE, VITEST_BASELINE } from "../../fixtures/junit";
import {
  MAX_REPORT_CHARS,
  MAX_TESTS,
  mergeInventories,
  parseJunit,
  testCount,
  type TestInventory,
  type TestOutcome,
} from "./junit";

function inventory(xml: string): Record<string, string> {
  const parsed = parseJunit(xml);
  if (!parsed.ok) throw new Error(parsed.error);
  return Object.fromEntries(
    [...parsed.inventory.tests].map(([id, outcomes]) => [id, outcomes.join(",")]),
  );
}

describe("parseJunit", () => {
  it("reads jest-junit", () => {
    expect(inventory(JEST_BASELINE)).toEqual({
      "total adds prices::total adds prices": "passed",
      "total is zero when empty::total is zero when empty": "failed",
      "total rounds::total rounds": "skipped",
    });
  });

  it("reads Vitest's junit reporter, decoding entities", () => {
    expect(inventory(VITEST_BASELINE)).toEqual({
      "src/cart.test.ts::total > adds prices": "passed",
      "src/cart.test.ts::total > is zero when empty": "failed",
    });
  });

  it("reads pytest --junitxml, errors as failures", () => {
    expect(inventory(PYTEST_BASELINE)).toEqual({
      "tests.test_cart::test_adds_prices": "passed",
      "tests.test_cart::test_rejects_negative": "failed",
      "tests.test_cart::test_db": "failed",
      "tests.test_cart::test_param[2-3]": "skipped",
    });
  });

  it("accepts a lone testsuite, nested suites, CDATA, comments and numeric entities", () => {
    const xml = `<testsuite><!-- a > b --><testsuite name="inner">
      <testcase name="caf&#233; &#x2713;"><system-out><![CDATA[<failure/>]]></system-out></testcase>
      <testcase name='single "quoted"' classname="a>b"/>
    </testsuite></testsuite>`;

    expect(inventory(xml)).toEqual({
      "café ✓": "passed",
      'a>b::single "quoted"': "passed",
    });
  });

  it("keeps every outcome of a repeated ID, in report order", () => {
    const xml = `<testsuites><testsuite><testcase name="t"/><testcase name="t"><failure/></testcase></testsuite></testsuites>`;

    expect(inventory(xml)).toEqual({ t: "passed,failed" });
  });

  it("keeps a failure over a skip in the same test case", () => {
    expect(
      inventory(`<testsuite><testcase name="t"><skipped/><error/></testcase></testsuite>`),
    ).toEqual({ t: "failed" });
  });

  it("caps very long names, keeping two of them apart", () => {
    const long = "x".repeat(5000);
    const ids = Object.keys(
      inventory(`<testsuite><testcase name="${long}a"/><testcase name="${long}b"/></testsuite>`),
    );

    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(1000);
  });

  it.each([
    ["not XML", "hello"],
    ["another root", "<html><testcase name='t'/></html>"],
    ["a DOCTYPE", '<!DOCTYPE x [<!ENTITY a "b">]><testsuite/>'],
    ["an unknown entity", '<testsuite><testcase name="&xxe;"/></testsuite>'],
    ["mismatched tags", "<testsuite><testcase name='t'></testsuite></testcase>"],
    ["an unclosed element", "<testsuite><testcase name='t'>"],
    ["an unterminated tag", "<testsuite><testcase name='t"],
    ["an unterminated comment", "<testsuite><!-- x"],
    ["a testcase without a name", "<testsuite><testcase/></testsuite>"],
    ["text after the root", "<testsuite/><testsuite/>"],
    [
      "a testcase in a testcase",
      "<testsuite><testcase name='a'><testcase name='b'/></testcase></testsuite>",
    ],
    ["a failure outside a testcase", "<testsuite><failure/></testsuite>"],
    ["a namespaced element", "<testsuite><x:testcase name='a'/></testsuite>"],
    ["deep nesting", `${"<testsuite>".repeat(200)}${"</testsuite>".repeat(200)}`],
  ])("refuses %s", (_, xml) => {
    expect(parseJunit(xml).ok).toBe(false);
  });

  it("refuses reports past the size and test limits", () => {
    expect(parseJunit(`<testsuite>${" ".repeat(MAX_REPORT_CHARS)}</testsuite>`).ok).toBe(false);
    const many = '<testcase name="t"/>'.repeat(MAX_TESTS + 1);
    expect(parseJunit(`<testsuite>${many}</testsuite>`).ok).toBe(false);
  });
});

describe("mergeInventories", () => {
  it("joins reports, keeping every outcome of an ID in two reports", () => {
    const a: TestInventory = { tests: new Map([["t", ["passed"]]]) };
    const b: TestInventory = {
      tests: new Map<string, TestOutcome[]>([
        ["t", ["failed"]],
        ["u", ["skipped"]],
      ]),
    };
    const merged = mergeInventories([a, b]);

    expect(Object.fromEntries(merged.tests)).toEqual({ t: ["passed", "failed"], u: ["skipped"] });
    expect(testCount(merged)).toBe(3);
  });
});

describe("parseJunit attributes", () => {
  it.each([
    ["spaces around =", `<testsuite><testcase  classname = 'c'\tname= "t" /></testsuite>`, "c::t"],
    ["a bare attribute", `<testsuite><testcase disabled name="t"/></testsuite>`, "t"],
    ["an unquoted value", `<testsuite><testcase x=1 name="t"/></testsuite>`, "t"],
    ["an attribute without a name", `<testsuite><testcase ="x" name="t"/></testsuite>`, "t"],
    ["a value that isn't quoted", `<testsuite><testcase y= name="t"/></testsuite>`, "t"],
    ["trailing junk", `<testsuite><testcase name="t" junk /></testsuite>`, "t"],
  ])("reads %s", (_, xml, id) => {
    const read = parseJunit(xml);

    expect(read.ok && [...read.inventory.tests.keys()]).toEqual([id]);
  });

  it("refuses a tag whose value never closes", () => {
    expect(parseJunit(`<testsuite><testcase name="t" x="1/></testsuite>`).ok).toBe(false);
  });
});
