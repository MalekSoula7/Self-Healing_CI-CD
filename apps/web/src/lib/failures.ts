// What the failures pages (SPEC §11) read from the URL and from JSON columns. Everything is
// validated: search params come from the visitor, and stored JSON is re-checked on read (SPEC §4).
import {
  failureStatusSchema,
  jobSignalsSchema,
  recentChangesRecordSchema,
  type JobSignals,
  type RecentChangesRecord,
} from "@pipeheal/db";
import { z } from "zod";

export interface FailureFilters {
  repoId?: string;
  status?: z.infer<typeof failureStatusSchema>;
  before?: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The list's filters from the URL. A malformed value is dropped, never an error. */
export function failureFilters(searchParams: SearchParams): FailureFilters {
  const filters: FailureFilters = {};
  const repoId = z.uuid().safeParse(single(searchParams.repo));
  if (repoId.success) filters.repoId = repoId.data;
  const status = failureStatusSchema.safeParse(single(searchParams.status));
  if (status.success) filters.status = status.data;
  const before = z.uuid().safeParse(single(searchParams.before));
  if (before.success) filters.before = before.data;
  return filters;
}

/** The list's URL with these filters (`before` is the page, so a filter change starts over). */
export function failuresHref(org: string, filters: FailureFilters): string {
  const params = new URLSearchParams();
  if (filters.repoId !== undefined) params.set("repo", filters.repoId);
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.before !== undefined) params.set("before", filters.before);
  const query = params.toString();
  return `/${org}/failures${query === "" ? "" : `?${query}`}`;
}

/** A job's stored signals, or null when absent or not what the worker stores. */
export function storedSignals(value: unknown): JobSignals | null {
  const parsed = jobSignalsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A failure's stored recent changes, or null when not resolved yet (or not well-formed). */
export function storedRecentChanges(value: unknown): RecentChangesRecord | null {
  const parsed = recentChangesRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** "TRIAGED" → "triaged", "NEEDS_HUMAN" → "needs human". */
export function label(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A 0..1 confidence as a percentage, or a dash. */
export function percent(confidence: number | null): string {
  return confidence === null ? "–" : `${String(Math.round(confidence * 100))}%`;
}
