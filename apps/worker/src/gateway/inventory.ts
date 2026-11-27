// Test inventories from the runner's JUnit reports (SPEC §8.6): the server parses the raw reports
// itself (packages/policy's parseJunit, which refuses anything it can't read whole) and stores the
// inventory, never the XML. At step 1 it is the attempt's baseline; with the submission, the
// inventory after the fix (P5.1).
import type { TestInventoryRecord } from "@pipeheal/db";
import { mergeInventories, parseJunit, type TestInventory } from "@pipeheal/policy";

/** The reports' tests merged into one inventory, or why there is none. */
export function inventoryRecord(
  reports: readonly { path: string; xml: string }[],
): TestInventoryRecord {
  if (reports.length === 0) return { available: false, reason: "no JUnit report was found" };
  const inventories: TestInventory[] = [];
  for (const report of reports) {
    const read = parseJunit(report.xml);
    // The parser's message stays out: it is about untrusted XML, and the reason is shown.
    if (!read.ok) return { available: false, reason: "a JUnit report couldn't be read" };
    inventories.push(read.inventory);
  }
  const merged = mergeInventories(inventories);
  return {
    available: true,
    tests: [...merged.tests].map(([id, outcomes]) => [id, [...outcomes]]),
  };
}

/** A stored inventory, back in packages/policy's shape; null when there was none. */
export function inventoryOf(record: TestInventoryRecord): TestInventory | null {
  return record.available ? { tests: new Map(record.tests) } : null;
}
