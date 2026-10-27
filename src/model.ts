// Records shared by the server and the app. The app imports these as types
// only; nothing here may pull server code into the frontend bundle.
import type { DiffFile, Side } from "./diff";
import type { ResolvedChapter, Severity, Verdict } from "./document";

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

export function describeTarget(target: Target): string {
  return target.kind === "pr"
    ? `${target.repo}#${target.number}`
    : target.label;
}
