// What leaves BB when the reviewer finishes: a GitHub review for a pull
// request, or a feedback message to the agent for local changes. Pure, so the
// exact payloads are unit-tested.
import type { DraftComment, Walkthrough } from "./model";

export interface GitHubReviewPayload {
  commit_id: string;
  event: Walkthrough["verdict"];
  body: string;
  comments: {
    path: string;
    body: string;
    line: number;
    side: "LEFT" | "RIGHT";
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
  }[];
}

export function keptComments(
  comments: readonly DraftComment[],
): DraftComment[] {
  return comments.filter(
    (comment) => comment.status === "kept" && comment.body.trim() !== "",
  );
}

export function buildReviewPayload(
  walkthrough: Walkthrough,
  comments: readonly DraftComment[],
): GitHubReviewPayload {
  if (walkthrough.target.kind !== "pr")
    throw new Error("Only pull request walkthroughs post to GitHub.");
  return {
    // The snapshot's head, so every anchor matches the lines the reviewer saw
    // even if the branch moved on since.
    commit_id: walkthrough.target.headSha,
    event: walkthrough.verdict,
    body: walkthrough.summary.trim(),
    comments: keptComments(comments).map((comment) => ({
      path: comment.path,
      body: comment.body.trim(),
      line: comment.line,
      side: comment.side,
      ...(comment.startLine !== null && comment.startLine !== comment.line
        ? { start_line: comment.startLine, start_side: comment.side }
        : {}),
    })),
  };
}

/**
 * A fingerprint of what the summary should reflect: the kept comments and
 * their wording. When it changes, the summary may be out of date.
 */
export function summaryBasis(comments: readonly DraftComment[]): string {
  const text = keptComments(comments)
    .map((comment) => `${comment.path}:${comment.line}:${comment.body.trim()}`)
    .sort()
    .join("\n");
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1)
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${keptComments(comments).length}:${(hash >>> 0).toString(36)}`;
}

/** Problems that would make GitHub reject the review, shown before posting. */
export function reviewBlockers(
  walkthrough: Walkthrough,
  comments: readonly DraftComment[],
): string[] {
  const blockers: string[] = [];
  const kept = keptComments(comments);
  if (
    walkthrough.verdict === "REQUEST_CHANGES" &&
    walkthrough.summary.trim() === ""
  ) {
    blockers.push("GitHub needs a summary to request changes.");
  }
  if (
    walkthrough.verdict === "COMMENT" &&
    walkthrough.summary.trim() === "" &&
    kept.length === 0
  ) {
    blockers.push("Keep at least one comment or write a summary.");
  }
  return blockers;
}

function location(comment: DraftComment): string {
  const lines =
    comment.startLine !== null && comment.startLine !== comment.line
      ? `${comment.startLine}-${comment.line}`
      : `${comment.line}`;
  return `${comment.path}:${lines}${comment.side === "LEFT" ? " (removed lines)" : ""}`;
}

/** The message sent to the authoring thread for a local walkthrough. */
export function formatLocalFeedback(
  walkthrough: Walkthrough,
  comments: readonly DraftComment[],
): string {
  const kept = keptComments(comments);
  const out = [
    `Review feedback on the walkthrough "${walkthrough.title}" (${walkthrough.id}).`,
    "",
  ];
  if (kept.length > 0) {
    out.push("Address each comment:", "");
    kept.forEach((comment, index) => {
      const body = comment.body.trim().replace(/\n/g, "\n   ");
      out.push(`${index + 1}. \`${location(comment)}\`: ${body}`);
    });
  }
  if (walkthrough.summary.trim() !== "") {
    out.push("", "Overall:", walkthrough.summary.trim());
  }
  return out.join("\n");
}
