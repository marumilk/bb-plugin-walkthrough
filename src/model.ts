// Records and small helpers shared by the server and the app. Everything here
// is pure and imports types only, so the app can use it without pulling
// server code into the frontend bundle.
import type { DiffFile, Side } from "./diff";
import type {
  ResolvedChapter,
  ResolvedStop,
  Severity,
  Verdict,
} from "./document";

/** Realtime channel: `{ id, threadId }` after any change to a walkthrough. */
export const WALKTHROUGH_CHANGED = "walkthrough-changed";
/** Realtime channel: `{ id, threadId }` when an agent submits a new walkthrough. */
export const WALKTHROUGH_READY = "walkthrough-ready";

export type LocalDiff =
  | { type: "uncommitted" }
  | { type: "branch_committed"; mergeBaseBranch: string }
  | { type: "all"; mergeBaseBranch: string }
  | { type: "commit"; sha: string };

export type Target =
  | {
      kind: "pr";
      repo: string;
      number: number;
      url: string;
      title: string;
      author: string;
      headSha: string;
      /** The PR description at snapshot time. Absent on older records. */
      body?: string;
    }
  | {
      kind: "local";
      environmentId: string;
      diff: LocalDiff;
      /** e.g. "Uncommitted changes" or "feature/x vs main". */
      label: string;
    };

export type WalkthroughStatus = "open" | "submitted" | "sent";

export interface Walkthrough {
  id: string;
  threadId: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  target: Target;
  title: string;
  focus: string | null;
  chapters: ResolvedChapter[];
  files: DiffFile[];
  summary: string;
  verdict: Verdict;
  status: WalkthroughStatus;
  submittedAt: number | null;
  submittedUrl: string | null;
  currentStopId: string | null;
  /** Files marked Viewed, as `viewedKey` values. Absent on older records. */
  viewed?: string[];
  /** The agent is rewriting the summary; same resumable shape as a question. */
  summaryJob?: { messageId: string; afterSeq: string; visible: string } | null;
  summaryError?: string | null;
  /** The summary before the agent's last rewrite, for Undo. */
  previousSummary?: string | null;
  /** `summaryBasis` of the comments the current summary was written from. */
  summaryBasis?: string | null;
}

/** Viewed is per file within a stop: a file can be split across stops. */
export function viewedKey(stopId: string, path: string): string {
  return `${stopId}\u0000${path}`;
}

export type CommentStatus = "pending" | "kept" | "discarded";

export interface DraftComment {
  id: string;
  walkthroughId: string;
  ord: number;
  /** "agent" drafts need a decision; "you" comments are written by the reviewer. */
  author: "agent" | "you";
  path: string;
  side: Side;
  line: number;
  startLine: number | null;
  severity: Severity | null;
  originalBody: string;
  body: string;
  status: CommentStatus;
  hunkId: string;
  stopId: string;
}

export interface WalkthroughSummary {
  id: string;
  threadId: string;
  title: string;
  target: Target;
  status: WalkthroughStatus;
  createdAt: number;
  updatedAt: number;
  submittedUrl: string | null;
  counts: CommentCounts;
}

export interface CommentCounts {
  pending: number;
  kept: number;
  discarded: number;
}

export function countComments(
  comments: readonly DraftComment[],
): CommentCounts {
  const counts: CommentCounts = { pending: 0, kept: 0, discarded: 0 };
  for (const comment of comments) counts[comment.status] += 1;
  return counts;
}

export function allStops(chapters: readonly ResolvedChapter[]): ResolvedStop[] {
  return chapters.flatMap((chapter) => chapter.stops);
}

/** A comment's or conversation's lines: one line, or `startLine`..`line`. */
export interface LineRange {
  line: number;
  startLine: number | null;
}

export function isMultiLine(range: LineRange): boolean {
  return range.startLine !== null && range.startLine !== range.line;
}

/** "13-15" for a range, "15" for a single line. */
export function lineSpan(range: LineRange, dash = "-"): string {
  return isMultiLine(range)
    ? `${range.startLine}${dash}${range.line}`
    : `${range.line}`;
}

export function describeTarget(target: Target): string {
  return target.kind === "pr"
    ? `${target.repo}#${target.number}`
    : target.label;
}

/** Where a conversation sits: a line range, or a whole stop when null. */
export interface DiscussionAnchor {
  path: string;
  side: Side;
  line: number;
  startLine: number | null;
  hunkId: string;
}

export interface DiscussionMessage {
  id: string;
  author: "you" | "agent";
  body: string;
  at: number;
}

/**
 * A private conversation between the reviewer and the agent, shown inline.
 * It is never posted to GitHub or sent as review feedback.
 */
export interface Discussion {
  id: string;
  walkthroughId: string;
  stopId: string;
  anchor: DiscussionAnchor | null;
  /** The draft or reviewer comment this conversation is about, if any. */
  commentId: string | null;
  messages: DiscussionMessage[];
  /**
   * The question the agent is answering. `afterSeq` is the thread event
   * cursor from just before it was sent, so a reloaded plugin can resume
   * waiting for the answer.
   */
  waiting: { messageId: string; afterSeq: string; visible?: string } | null;
  error: string | null;
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}
