import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/diff";
import { documentSchema, formatIssues, resolveDocument } from "../src/document";
import { PR_DIFF } from "./fixtures";

const files = parseUnifiedDiff(PR_DIFF);

function doc(overrides: Record<string, unknown> = {}) {
  return documentSchema.parse({
    target: { pr: 42 },
    title: "Retry failed deliveries",
    chapters: [
      {
        title: "Delivery",
        stops: [
          {
            title: "Queue failures",
            prose: "Catches errors.",
            hunks: ["src/deliver.ts:h1", "src/queue.ts:h1"],
          },
        ],
      },
    ],
    comments: [
      {
        path: "src/deliver.ts",
        line: 15,
        startLine: 13,
        body: "Duplicate sends?",
      },
    ],
    ...overrides,
  });
}

describe("documentSchema", () => {
  it("applies defaults for side and severity", () => {
    expect(doc().comments[0]).toMatchObject({
      side: "RIGHT",
      severity: "issue",
    });
  });

  it("reports unknown fields with their path", () => {
    const result = documentSchema.safeParse({ ...doc(), extra: true });
    expect(result.success).toBe(false);
    expect(formatIssues(result.error!)).toEqual([
      expect.stringContaining("(root)"),
    ]);
  });
});

describe("resolveDocument", () => {
  it("assigns comments to the stop showing their hunk and gathers leftovers", () => {
    const result = resolveDocument(doc(), files);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const { chapters, comments } = result.walkthrough;
    expect(
      chapters.map((c) => [
        c.id,
        c.title,
        c.generated,
        c.stops.map((s) => s.hunkIds),
      ]),
    ).toEqual([
      ["c1", "Delivery", false, [["src/deliver.ts:h1", "src/queue.ts:h1"]]],
      ["rest", "Other changes", true, [["src/deliver.ts:h2"]]],
    ]);
    expect(comments[0]).toMatchObject({
      hunkId: "src/deliver.ts:h1",
      stopId: "c1s1",
      startLine: 13,
    });
    expect(result.walkthrough.verdict).toBe("COMMENT");
  });

  it("packs leftover files into as few stops as the hunk limit allows", () => {
    const result = resolveDocument(
      doc({
        chapters: [
          {
            title: "A",
            stops: [{ title: "One", prose: "x", hunks: ["src/deliver.ts:h1"] }],
          },
        ],
        comments: [],
      }),
      files,
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.walkthrough.chapters[1]!.stops).toEqual([
      {
        id: "rest1",
        title: "2 files",
        prose: "",
        hunkIds: ["src/deliver.ts:h2", "src/queue.ts:h1"],
      },
    ]);
  });

  it("puts comments on leftover hunks in the Other changes stop", () => {
    const result = resolveDocument(
      doc({ comments: [{ path: "src/deliver.ts", line: 45, body: "Nit" }] }),
      files,
    );
    expect(result.ok && result.walkthrough.comments[0]!.stopId).toBe("rest1");
  });

  it("rejects unknown and reused hunks", () => {
    const result = resolveDocument(
      doc({
        chapters: [
          {
            title: "A",
            stops: [
              {
                title: "One",
                prose: "x",
                hunks: ["src/deliver.ts:h1", "src/deliver.ts:h9"],
              },
              { title: "Two", prose: "x", hunks: ["src/deliver.ts:h1"] },
            ],
          },
        ],
      }),
      files,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      'chapters.0.stops.0.hunks.1: "src/deliver.ts:h9" does not exist; src/deliver.ts has hunks h1-h2',
      'chapters.0.stops.1.hunks.0: "src/deliver.ts:h1" is already used by stop c1s1; use each hunk once',
    ]);
  });

  it("rejects comments GitHub could not anchor, listing valid ranges", () => {
    const result = resolveDocument(
      doc({
        comments: [
          { path: "src/deliver.ts", line: 30, body: "Outside" },
          { path: "src/other.ts", line: 1, body: "Unchanged file" },
          {
            path: "src/deliver.ts",
            line: 16,
            startLine: 17,
            body: "Backwards",
          },
          {
            path: "src/deliver.ts",
            line: 44,
            startLine: 15,
            body: "Spans hunks",
          },
        ],
      }),
      files,
    );
    expect(!result.ok && result.errors).toEqual([
      "comments.0: src/deliver.ts line 30 (RIGHT) is outside the diff; GitHub only anchors comments inside one hunk. RIGHT lines in the diff: 10-17, 44-48",
      'comments.1.path: "src/other.ts" is not changed in this diff',
      "comments.2.startLine: must not be after line 16",
      "comments.3: src/deliver.ts lines 15-44 (RIGHT) is outside the diff; GitHub only anchors comments inside one hunk. RIGHT lines in the diff: 10-17, 44-48",
    ]);
  });
});
