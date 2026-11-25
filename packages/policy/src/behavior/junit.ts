// JUnit XML reports into a test inventory (SPEC §8.6). Reports come from the customer's runner,
// so they are untrusted: a small XML reader for this one format, not a general parser. No DOCTYPE
// or entity declarations (so no entity expansion), only the predefined and numeric entities, and
// bounded size, depth and test count. Pure.

export type TestOutcome = "passed" | "failed" | "skipped";

/**
 * Test ID (`classname::name`, or `name`) to the outcome of every test case with that ID, in report
 * order. IDs repeat (parametrized names, retries, a test in two reports): comparing them as
 * multisets means no renaming or reordering can move a failure onto an ID the baseline lacks.
 */
export interface TestInventory {
  tests: ReadonlyMap<string, readonly TestOutcome[]>;
}

export type JunitRead = { ok: true; inventory: TestInventory } | { ok: false; error: string };

export const MAX_REPORT_CHARS = 20_000_000;
export const MAX_TESTS = 50_000;
const MAX_DEPTH = 64;
const MAX_ID_CHARS = 1000;

class JunitError extends Error {}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decode(value: string): string {
  return value.replace(/&([^;&\s]{1,10});/g, (_, entity: string) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) return named;
    const code = /^#x[0-9a-f]{1,6}$/i.test(entity)
      ? Number.parseInt(entity.slice(2), 16)
      : /^#[0-9]{1,7}$/.test(entity)
        ? Number.parseInt(entity.slice(1), 10)
        : Number.NaN;
    if (!Number.isInteger(code) || code > 0x10ffff)
      throw new JunitError(`unknown entity &${entity};`);
    return String.fromCodePoint(code);
  });
}

function attributes(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    found.set(match[1] ?? "", decode(match[2] ?? match[3] ?? ""));
  }
  return found;
}

/** Index just past `marker` at or after `from`, or an error naming what was left open. */
function after(xml: string, from: number, marker: string, what: string): number {
  const index = xml.indexOf(marker, from);
  if (index === -1) throw new JunitError(`unterminated ${what}`);
  return index + marker.length;
}

/** End of a tag starting at `start` (the `>`), skipping `>` inside quoted values. */
function tagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  throw new JunitError("unterminated tag");
}

interface OpenCase {
  id: string;
  outcome: TestOutcome;
}

/** FNV-1a, 32 bits: enough to keep two long IDs apart; not a security boundary. */
function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result.toString(16).padStart(8, "0");
}

function caseId(attrs: Map<string, string>): string {
  const name = attrs.get("name");
  if (name === undefined || name === "") throw new JunitError("a testcase without a name");
  const classname = attrs.get("classname") ?? "";
  const id = classname === "" ? name : `${classname}::${name}`;
  // Past the cap, keep a hash of the whole ID so two long IDs never collide.
  return id.length <= MAX_ID_CHARS ? id : `${id.slice(0, MAX_ID_CHARS - 20)}... #${hash(id)}`;
}

class InventoryBuilder {
  readonly tests = new Map<string, TestOutcome[]>();
  size = 0;

  add(id: string, outcome: TestOutcome): void {
    const outcomes = this.tests.get(id);
    if (outcomes === undefined) this.tests.set(id, [outcome]);
    else outcomes.push(outcome);
    this.size += 1;
  }
}

/** One pass over a report: an element stack and the test case being read. */
class JunitReader {
  readonly inventory = new InventoryBuilder();
  private readonly stack: string[] = [];
  private current: OpenCase | null = null;
  private rootSeen = false;

  constructor(private readonly xml: string) {}

  read(): TestInventory {
    const { xml } = this;
    if (xml.length > MAX_REPORT_CHARS) throw new JunitError("report too large");
    let index = 0;
    while (index < xml.length) {
      const lt = xml.indexOf("<", index);
      if (lt === -1) break;
      if (this.stack.length === 0 && this.rootSeen && xml.slice(index, lt).trim() !== "") {
        throw new JunitError("text after the report");
      }
      index = this.markup(lt);
    }
    if (!this.rootSeen) throw new JunitError("not a JUnit report");
    if (this.stack.length > 0) throw new JunitError(`unclosed <${this.stack.at(-1) ?? ""}>`);
    return { tests: this.inventory.tests };
  }

  /** Reads the markup starting at `lt`; returns where reading resumes. */
  private markup(lt: number): number {
    const { xml } = this;
    if (xml.startsWith("<?", lt)) return after(xml, lt, "?>", "declaration");
    if (xml.startsWith("<!--", lt)) return after(xml, lt, "-->", "comment");
    if (xml.startsWith("<![CDATA[", lt)) return after(xml, lt, "]]>", "CDATA section");
    if (xml.startsWith("<!", lt)) {
      throw new JunitError("DOCTYPE and entity declarations aren't allowed");
    }
    const end = tagEnd(xml, lt);
    const body = xml.slice(lt + 1, end);
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      if (this.stack.pop() !== name) throw new JunitError(`unexpected </${name}>`);
      this.close(name);
    } else {
      const name = /^[^\s/>]+/.exec(body)?.[0] ?? "";
      this.open(name, attributes(body.slice(name.length)), body.endsWith("/"));
    }
    return end + 1;
  }

  private open(name: string, attrs: Map<string, string>, selfClosing: boolean): void {
    if (this.stack.length === 0) {
      if (this.rootSeen || (name !== "testsuites" && name !== "testsuite")) {
        throw new JunitError("not a JUnit report");
      }
      this.rootSeen = true;
    }
    // Refuse shapes no runner writes rather than guess what they mean.
    if (name.includes(":")) throw new JunitError(`namespaced element <${name}>`);
    const current = this.current;
    if (name === "testcase") {
      if (current !== null) throw new JunitError("a testcase inside a testcase");
      this.current = { id: caseId(attrs), outcome: "passed" };
    } else if (name === "failure" || name === "error" || name === "skipped") {
      if (current === null) throw new JunitError(`<${name}> outside a testcase`);
      if (name !== "skipped") current.outcome = "failed";
      else if (current.outcome === "passed") current.outcome = "skipped";
    }
    if (selfClosing) this.close(name);
    else if (this.stack.push(name) > MAX_DEPTH) throw new JunitError("nested too deeply");
  }

  private close(name: string): void {
    if (name !== "testcase" || this.current === null) return;
    this.inventory.add(this.current.id, this.current.outcome);
    if (this.inventory.size > MAX_TESTS) throw new JunitError("too many tests");
    this.current = null;
  }
}

export function parseJunit(xml: string): JunitRead {
  try {
    return { ok: true, inventory: new JunitReader(xml).read() };
  } catch (error) {
    if (error instanceof JunitError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Several reports (a junit glob can match more than one) as one inventory. */
export function mergeInventories(inventories: readonly TestInventory[]): TestInventory {
  const merged = new InventoryBuilder();
  for (const inventory of inventories) {
    for (const [id, outcomes] of inventory.tests) {
      for (const outcome of outcomes) merged.add(id, outcome);
    }
  }
  return { tests: merged.tests };
}

/** How many test cases an inventory holds. */
export function testCount(inventory: TestInventory): number {
  let count = 0;
  for (const outcomes of inventory.tests.values()) count += outcomes.length;
  return count;
}
