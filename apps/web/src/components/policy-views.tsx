// Read-only pieces of the policy pages (P3.8): the effective policy with provenance, and a layer's
// version history.
import { layerLabel, type PolicyRow } from "@/lib/policy";

export function EffectivePolicyTable({ rows }: { rows: PolicyRow[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 pr-4 font-medium">Field</th>
          <th className="py-1 pr-4 font-medium">Effective value</th>
          <th className="py-1 font-medium">From</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.field} className="border-t align-top">
            <td className="py-1 pr-4 font-mono">{row.field}</td>
            <td className="py-1 pr-4 font-mono break-all">{row.value}</td>
            <td className="py-1">{row.sources.map(layerLabel).join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface HistoryEntry {
  id: string;
  version: number;
  createdAt: Date;
  author: string;
}

export function PolicyHistory({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No versions saved yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {entries.map((entry) => (
        <li key={entry.id}>
          Version {entry.version}, {entry.createdAt.toISOString().slice(0, 16).replace("T", " ")}{" "}
          UTC, by {entry.author}
        </li>
      ))}
    </ol>
  );
}
