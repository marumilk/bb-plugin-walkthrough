// The message a reviewer's private question becomes in the agent's thread.
// Pure, so the exact wording is unit-tested.
import { commentableLines, type DiffFile } from "./diff";
import type { Discussion, DraftComment, Walkthrough } from "./model";

/** Wraps the question so its answer can be found in the thread's events. */
export function questionMarker(messageId: string): string {
  return `walkthrough-question id="${messageId}"`;
}

/**
 * The anchored lines with a little context, numbered on the commented side
 * and prefixed as in a diff, so the agent sees exactly what the reviewer saw.
 */
export function anchorExcerpt(
  files: readonly DiffFile[],
  discussion: Discussion,
  context = 3,
): string | null {
  const anchor = discussion.anchor;
  if (anchor === null) return null;
  const hunk = files
    .find((file) => file.path === anchor.path)
    ?.hunks.find((h) => h.id === anchor.hunkId);
  if (hunk === undefined) return null;
  const first = (anchor.startLine ?? anchor.line) - context;
  const last = anchor.line + context;
  const sideLines = commentableLines(hunk)[anchor.side];
  const out: string[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    const marker = line[0];
    if (marker === "\\") continue;
    const number = anchor.side === "LEFT" ? oldLine : newLine;
    const onSide = anchor.side === "LEFT" ? marker !== "+" : marker !== "-";
    if (onSide && sideLines.has(number) && number >= first && number <= last) {
      out.push(`${String(number).padStart(5)} ${line}`);
    }
    if (marker !== "+") oldLine += 1;
    if (marker !== "-") newLine += 1;
  }
  return out.length === 0 ? null : out.join("\n");
}

function describeAnchor(discussion: Discussion): string {
  const anchor = discussion.anchor;
  if (anchor === null) return "this stop as a whole";
  const lines =
    anchor.startLine !== null && anchor.startLine !== anchor.line
      ? `lines ${anchor.startLine}-${anchor.line}`
      : `line ${anchor.line}`;
  return `\`${anchor.path}\` ${lines}${anchor.side === "LEFT" ? " of the old file (removed lines)" : ""}`;
}

export function buildQuestionPrompt(input: {
  walkthrough: Walkthrough;
  discussion: Discussion;
  comment: DraftComment | null;
  messageId: string;
}): { visible: string; context: string } {
  const { walkthrough, discussion, comment, messageId } = input;
  const stop = walkthrough.chapters
    .flatMap((chapter) => chapter.stops)
    .find((s) => s.id === discussion.stopId);
  const question = discussion.messages.find(
    (message) => message.id === messageId,
  );
  if (question === undefined)
    throw new Error(`No message ${messageId} in ${discussion.id}`);
  const earlier = discussion.messages.slice(
    0,
    discussion.messages.indexOf(question),
  );

  const visible = `Walkthrough question about ${describeAnchor(discussion)}: ${question.body}`;
  const out = [
    `<${questionMarker(messageId)}>`,
    `The reviewer asked the question above privately in the walkthrough "${walkthrough.title}" (${walkthrough.id}), ` +
      `at the stop "${stop?.title ?? discussion.stopId}".`,
  ];
  const excerpt = anchorExcerpt(walkthrough.files, discussion);
  if (excerpt !== null) out.push("", "```diff", excerpt, "```");
  if (comment !== null) {
    out.push(
      "",
      `It is about this ${comment.author === "agent" ? "draft review comment" : "review comment the reviewer wrote"}:`,
      ...comment.body.split("\n").map((line) => `> ${line}`),
    );
  }
  if (earlier.length > 0) {
    out.push("", "Earlier in this conversation:");
    for (const message of earlier) {
      out.push(
        `${message.author === "you" ? "Reviewer" : "You"}: ${message.body}`,
      );
    }
  }
  out.push(
    "",
    "Answer in a short Markdown reply; it is shown inline beside that code in the walkthrough. " +
      "This conversation is private: it is never posted to GitHub or included in the review. " +
      "Do not edit files, post, or submit anything unless the question explicitly asks you to.",
    `</walkthrough-question>`,
  );
  return { visible, context: out.join("\n") };
}

/** Asks the agent to rewrite the review summary from the comments kept. */
export function buildSummaryPrompt(input: {
  walkthrough: Walkthrough;
  kept: readonly DraftComment[];
  messageId: string;
}): { visible: string; context: string } {
  const { walkthrough, kept, messageId } = input;
  const count = `${kept.length} kept comment${kept.length === 1 ? "" : "s"}`;
  const out = [
    `<${questionMarker(messageId)}>`,
    `Rewrite the top-level summary of the review for "${walkthrough.title}" (${walkthrough.id}), ` +
      `which posts with the verdict ${walkthrough.verdict}.`,
    "",
    kept.length === 0
      ? "The reviewer kept no inline comments."
      : "The inline comments the reviewer kept, as they will post:",
  ];
  kept.forEach((comment, index) => {
    const lines =
      comment.startLine !== null && comment.startLine !== comment.line
        ? `${comment.startLine}-${comment.line}`
        : `${comment.line}`;
    out.push(
      `${index + 1}. ${comment.path}:${lines}`,
      ...comment.body
        .trim()
        .split("\n")
        .map((line) => `   ${line}`),
    );
  });
  out.push(
    "",
    "The current summary:",
    walkthrough.summary.trim() === "" ? "(empty)" : walkthrough.summary.trim(),
    "",
    "Write the summary the reviewer will post, in their voice, to the PR author: one short paragraph or a few bullets " +
      "that give the overall take and point at the comments that matter most, without repeating each one. " +
      "Mention only what the kept comments and the diff support. " +
      "Reply with the summary text alone, in Markdown, with no heading or preamble. " +
      "Do not post, approve, or submit anything; the reviewer publishes it.",
    "</walkthrough-question>",
  );
  return {
    visible: `Walkthrough: rewrite the review summary from the ${count}.`,
    context: out.join("\n"),
  };
}
