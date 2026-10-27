import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/diff";
import {
  anchorExcerpt,
  buildQuestionPrompt,
  buildSummaryPrompt,
  questionMarker,
} from "../src/conversation";
import type { Discussion, DraftComment, Walkthrough } from "../src/model";
import { PR_DIFF } from "./fixtures";

const files = parseUnifiedDiff(PR_DIFF);

const walkthrough = {
  id: "wt_1",
  title: "Retry failed deliveries",
  files,
  chapters: [
    {
      id: "c1",
      title: "Delivery",
      blurb: null,
      generated: false,
      stops: [
        {
          id: "c1s1",
          title: "Queue failures",
          prose: "",
          hunkIds: ["src/deliver.ts:h1"],
          priority: "review",
          notes: [],
        },
      ],
    },
  ],
} as unknown as Walkthrough;

function discussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: "dc_1",
    walkthroughId: "wt_1",
    stopId: "c1s1",
    anchor: {
      path: "src/deliver.ts",
      side: "RIGHT",
      line: 13,
      startLine: 12,
      hunkId: "src/deliver.ts:h1",
    },
    commentId: null,
    messages: [{ id: "dm_1", author: "you", body: "Why catch here?", at: 0 }],
    waiting: null,
    error: null,
    resolved: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("anchorExcerpt", () => {
  it("shows the anchored lines with context, numbered on the commented side", () => {
    expect(anchorExcerpt(files, discussion().anchor, 1)).toBe(
      [
        "   11 -  await post(event.url, body);",
        "   11 +  try {",
        "   12 +    await post(event.url, body);",
        "   13 +  } catch (error) {",
        "   14 +    await enqueueRetry(event, error);",
      ]
        .filter((line) => !line.includes(" -  "))
        .join("\n"),
    );
  });

  it("is null for a stop-level conversation", () => {
    expect(anchorExcerpt(files, null)).toBeNull();
  });
});

describe("buildQuestionPrompt", () => {
  it("shows only the question in chat and gives the agent the context", () => {
    const prompt = buildQuestionPrompt({
      walkthrough,
      discussion: discussion(),
      comment: null,
      messageId: "dm_1",
    });
    expect(prompt.visible).toBe(
      "Walkthrough question about `src/deliver.ts` lines 12-13: Why catch here?",
    );
    expect(prompt.context).toContain(`<${questionMarker("dm_1")}>`);
    expect(prompt.context).toContain('at the stop "Queue failures"');
    expect(prompt.context).toContain("never posted to GitHub");
  });

  it("includes the comment under discussion and the earlier exchange", () => {
    const comment = {
      author: "agent",
      body: "Retries may duplicate.\nUse a key.",
    } as DraftComment;
    const prompt = buildQuestionPrompt({
      walkthrough,
      comment,
      messageId: "dm_3",
      discussion: discussion({
        commentId: "cm_1",
        messages: [
          { id: "dm_1", author: "you", body: "Why?", at: 0 },
          { id: "dm_2", author: "agent", body: "Because timeouts.", at: 1 },
          { id: "dm_3", author: "you", body: "Which timeouts?", at: 2 },
        ],
      }),
    });
    expect(prompt.context).toContain(
      "It is about this draft review comment:\n> Retries may duplicate.\n> Use a key.",
    );
    expect(prompt.context).toContain(
      "Earlier in this conversation:\nReviewer: Why?\nYou: Because timeouts.",
    );
    expect(prompt.visible).toContain("Which timeouts?");
    expect(prompt.context).not.toContain("Which timeouts?");
  });
});

describe("buildSummaryPrompt", () => {
  it("lists the kept comments and asks for the summary text alone", () => {
    const kept = [
      {
        path: "src/deliver.ts",
        line: 15,
        startLine: 13,
        body: "Cap retries.\nFive is plenty.",
      },
      {
        path: "src/queue.ts",
        line: 2,
        startLine: null,
        body: "Log the error.",
      },
    ] as DraftComment[];
    const prompt = buildSummaryPrompt({
      walkthrough: {
        ...walkthrough,
        verdict: "COMMENT",
        summary: "Looks fine.",
      },
      kept,
      messageId: "dm_9",
    });
    expect(prompt.visible).toBe(
      "Walkthrough: rewrite the review summary from the 2 kept comments.",
    );
    expect(prompt.context).toContain(`<${questionMarker("dm_9")}>`);
    expect(prompt.context).toContain(
      "1. src/deliver.ts:13-15\n   Cap retries.\n   Five is plenty.\n2. src/queue.ts:2\n   Log the error.",
    );
    expect(prompt.context).toContain("The current summary:\nLooks fine.");
    expect(prompt.context).toContain("Reply with the summary text alone");
  });
});
