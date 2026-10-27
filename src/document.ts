// The walkthrough document an agent writes, and its resolution against a diff
// snapshot. Everything here is pure so it can be tested without a host.
import { z } from "zod";
import {
  describeRanges,
  findHunkForRange,
  parseHunkId,
  type DiffFile,
  type Side,
} from "./diff";

export const SEVERITIES = [
  "blocker",
  "issue",
  "suggestion",
  "nit",
  "question",
  "praise",
] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERDICTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const targetInputSchema = z.union([
  z
    .object({ pr: z.union([z.string().min(1), z.number().int().positive()]) })
    .strict(),
  z.object({ local: z.enum(["uncommitted", "branch", "all"]) }).strict(),
  z
    .object({
      commit: z.string().regex(/^[0-9a-f]{7,40}$/i, "commit must be a SHA"),
    })
    .strict(),
]);
export type TargetInput = z.infer<typeof targetInputSchema>;

const MAX_HUNKS_PER_STOP = 20;

const stopSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    prose: z.string().trim().min(1).max(2000),
    hunks: z.array(z.string().min(1)).min(1).max(MAX_HUNKS_PER_STOP),
  })
  .strict();

const chapterSchema = z
  .object({
    title: z.string().trim().min(1).max(40),
    blurb: z.string().trim().max(400).optional(),
    stops: z.array(stopSchema).min(1).max(14),
  })
  .strict();

const commentSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
    side: z.enum(["RIGHT", "LEFT"]).default("RIGHT"),
    severity: z.enum(SEVERITIES).default("issue"),
    body: z.string().trim().min(1).max(8000),
  })
  .strict();

export const documentSchema = z
  .object({
    target: targetInputSchema,
    title: z.string().trim().min(1).max(120),
    focus: z.string().trim().max(600).optional(),
    chapters: z.array(chapterSchema).min(1).max(8),
    comments: z.array(commentSchema).max(80).default([]),
    review: z
      .object({
        summary: z.string().trim().max(20000).optional(),
        verdict: z.enum(VERDICTS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WalkthroughDocument = z.infer<typeof documentSchema>;

export interface ResolvedStop {
  id: string;
  title: string;
  prose: string;
  hunkIds: string[];
}

export interface ResolvedChapter {
  id: string;
  title: string;
  blurb: string | null;
  /** True for the chapter the plugin adds for hunks no stop covered. */
  generated: boolean;
  stops: ResolvedStop[];
}

export interface ResolvedComment {
  path: string;
  side: Side;
  line: number;
  startLine: number | null;
  severity: Severity;
  body: string;
  hunkId: string;
  stopId: string;
}

export interface ResolvedWalkthrough {
  title: string;
  focus: string | null;
  chapters: ResolvedChapter[];
  comments: ResolvedComment[];
  summary: string;
  verdict: Verdict;
}

export type Resolution =
  | { ok: true; walkthrough: ResolvedWalkthrough }
  | { ok: false; errors: string[] };

/** Formats zod issues as `path: message` lines an agent can act on. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
}

/**
 * Checks every hunk reference and comment anchor against `files` and assigns
 * each comment to the stop that shows its hunk. Hunks no stop mentions are
 * gathered into a final "Other changes" chapter so nothing in the diff is
 * hidden from the reviewer.
 */
export function resolveDocument(
  doc: WalkthroughDocument,
  files: readonly DiffFile[],
): Resolution {
  const errors: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const knownHunks = new Set(
    files.flatMap((file) => file.hunks.map((h) => h.id)),
  );
  const hunkToStop = new Map<string, string>();

  const chapters: ResolvedChapter[] = doc.chapters.map((chapter, c) => ({
    id: `c${c + 1}`,
    title: chapter.title,
    blurb: chapter.blurb ?? null,
    generated: false,
    stops: chapter.stops.map((stop, s) => {
      const id = `c${c + 1}s${s + 1}`;
      const hunkIds: string[] = [];
      stop.hunks.forEach((ref, h) => {
        const where = `chapters.${c}.stops.${s}.hunks.${h}`;
        if (!knownHunks.has(ref)) {
          const parsed = parseHunkId(ref);
          const file = parsed ? byPath.get(parsed.path) : undefined;
          errors.push(
            file
              ? `${where}: "${ref}" does not exist; ${file.path} has hunks h1-h${file.hunks.length}`
              : `${where}: "${ref}" is not a hunk in this diff (run \`bb walkthrough hunks\` for ids)`,
          );
          return;
        }
        const owner = hunkToStop.get(ref);
        if (owner !== undefined) {
          errors.push(
            `${where}: "${ref}" is already used by stop ${owner}; use each hunk once`,
          );
          return;
        }
        hunkToStop.set(ref, id);
        hunkIds.push(ref);
      });
      return { id, title: stop.title, prose: stop.prose, hunkIds };
    }),
  }));

  const leftover = files
    .flatMap((file) => file.hunks.map((h) => h.id))
    .filter((id) => !hunkToStop.has(id));
  if (leftover.length > 0) {
    // Leftovers are usually mechanical (locales, lockfiles, generated code),
    // so pack whole files into as few stops as the per-stop hunk limit allows.
    const byFile = new Map<string, string[]>();
    for (const id of leftover) {
      const path = parseHunkId(id)!.path;
      byFile.set(path, [...(byFile.get(path) ?? []), id]);
    }
    const groups: string[][][] = [];
    for (const hunkIds of byFile.values()) {
      const last = groups.at(-1);
      const size =
        last?.reduce((sum, file) => sum + file.length, 0) ?? Infinity;
      if (last !== undefined && size + hunkIds.length <= MAX_HUNKS_PER_STOP)
        last.push(hunkIds);
      else groups.push([hunkIds]);
    }
    const stops: ResolvedStop[] = groups.map((group, index) => {
      const id = `rest${index + 1}`;
      const hunkIds = group.flat();
      for (const hunk of hunkIds) hunkToStop.set(hunk, id);
      const title =
        group.length === 1
          ? parseHunkId(group[0]![0]!)!.path
          : `${group.length} files`;
      return { id, title, prose: "", hunkIds };
    });
    chapters.push({
      id: "rest",
      title: "Other changes",
      blurb: null,
      generated: true,
      stops,
    });
  }

  const comments: ResolvedComment[] = [];
  doc.comments.forEach((comment, index) => {
    const where = `comments.${index}`;
    const file = byPath.get(comment.path);
    if (file === undefined) {
      errors.push(
        `${where}.path: "${comment.path}" is not changed in this diff`,
      );
      return;
    }
    const start = comment.startLine ?? comment.line;
    if (start > comment.line) {
      errors.push(`${where}.startLine: must not be after line ${comment.line}`);
      return;
    }
    const hunk = findHunkForRange(file, comment.side, start, comment.line);
    if (hunk === null) {
      const range =
        start === comment.line
          ? `line ${comment.line}`
          : `lines ${start}-${comment.line}`;
      errors.push(
        `${where}: ${comment.path} ${range} (${comment.side}) is outside the diff; ` +
          `GitHub only anchors comments inside one hunk. ${comment.side} lines in the diff: ${describeRanges(file, comment.side)}`,
      );
      return;
    }
    comments.push({
      path: comment.path,
      side: comment.side,
      line: comment.line,
      startLine: comment.startLine ?? null,
      severity: comment.severity,
      body: comment.body,
      hunkId: hunk.id,
      stopId: hunkToStop.get(hunk.id)!,
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    walkthrough: {
      title: doc.title,
      focus: doc.focus ?? null,
      chapters,
      comments,
      summary: doc.review?.summary ?? "",
      verdict: doc.review?.verdict ?? "COMMENT",
    },
  };
}
