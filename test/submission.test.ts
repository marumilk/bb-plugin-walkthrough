import { describe, expect, it } from "vitest";
import type { DraftComment, Walkthrough } from "../src/model";
import {
  buildReviewPayload,
  formatLocalFeedback,
  reviewBlockers,
} from "../src/submission";

function comment(overrides: Partial<DraftComment>): DraftComment {
  return {
    id: "cm_1",
    walkthroughId: "wt_1",
    ord: 0,
    author: "agent",
    path: "src/deliver.ts",
    side: "RIGHT",
    line: 15,
    startLine: null,
    severity: "issue",
    originalBody: "Body",
    body: "Body",
    status: "kept",
    hunkId: "src/deliver.ts:h1",
    stopId: "c1s1",
    ...overrides,
  };
}

const prWalkthrough = {
  id: "wt_1",
  title: "Retry",
  target: {
    kind: "pr",
    repo: "acme/app",
    number: 42,
    url: "",
    title: "",
    author: "a",
    headSha: "abc123",
  },
  summary: "  Looks good.  ",
  verdict: "COMMENT",
} as Walkthrough;

describe("buildReviewPayload", () => {
  it("posts only kept comments against the reviewed commit", () => {
    const payload = buildReviewPayload(prWalkthrough, [
      comment({ id: "a", body: " Keep me \n" }),
      comment({ id: "b", status: "pending" }),
      comment({ id: "c", status: "discarded" }),
      comment({ id: "d", line: 18, startLine: 16, side: "LEFT" }),
    ]);
    expect(payload).toEqual({
      commit_id: "abc123",
      event: "COMMENT",
      body: "Looks good.",
      comments: [
        { path: "src/deliver.ts", body: "Keep me", line: 15, side: "RIGHT" },
        {
          path: "src/deliver.ts",
          body: "Body",
          line: 18,
          side: "LEFT",
          start_line: 16,
          start_side: "LEFT",
        },
      ],
    });
  });
});

describe("reviewBlockers", () => {
  it("requires a summary to request changes", () => {
    expect(
      reviewBlockers(
        { ...prWalkthrough, verdict: "REQUEST_CHANGES", summary: " " },
        [comment({})],
      ),
    ).toEqual(["GitHub needs a summary to request changes."]);
  });

  it("requires something to say for a plain comment review", () => {
    expect(reviewBlockers({ ...prWalkthrough, summary: "" }, [])).toHaveLength(
      1,
    );
    expect(
      reviewBlockers({ ...prWalkthrough, verdict: "APPROVE", summary: "" }, []),
    ).toEqual([]);
  });
});

describe("formatLocalFeedback", () => {
  it("lists kept comments with locations, then the overall note", () => {
    const text = formatLocalFeedback(
      { ...prWalkthrough, summary: "Mostly fine." },
      [
        comment({ body: "Rename this.\nIt reads oddly." }),
        comment({ status: "discarded", body: "Ignored" }),
        comment({
          side: "LEFT",
          line: 12,
          startLine: 11,
          body: "Keep this removed line.",
        }),
      ],
    );
    expect(text).toBe(
      [
        'Review feedback on the walkthrough "Retry" (wt_1).',
        "",
        "Address each comment:",
        "",
        "1. `src/deliver.ts:15`: Rename this.",
        "   It reads oddly.",
        "2. `src/deliver.ts:11-12 (removed lines)`: Keep this removed line.",
        "",
        "Overall:",
        "Mostly fine.",
      ].join("\n"),
    );
  });
});
