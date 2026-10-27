import { describe, expect, it } from "vitest";
import {
  commentableLines,
  describeRanges,
  findHunkForRange,
  parseHunkId,
  parseUnifiedDiff,
  renderFilePatch,
} from "../src/diff";
import { PR_DIFF } from "./fixtures";

describe("parseUnifiedDiff", () => {
  it("splits files and numbers hunks per file", () => {
    const files = parseUnifiedDiff(PR_DIFF);
    expect(
      files.map((file) => [
        file.path,
        file.status,
        file.hunks.map((h) => h.id),
      ]),
    ).toEqual([
      [
        "src/deliver.ts",
        "modified",
        ["src/deliver.ts:h1", "src/deliver.ts:h2"],
      ],
      ["src/queue.ts", "added", ["src/queue.ts:h1"]],
    ]);
    expect(files[0]!.hunks[0]).toMatchObject({
      oldStart: 10,
      oldLines: 4,
      newStart: 10,
      newLines: 8,
    });
  });

  it("does not mistake a removed line starting with --- for a file header", () => {
    const patch = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,2 +1,1 @@",
      "--- a horizontal rule",
      " text",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch);
    expect(file!.hunks[0]!.lines).toEqual(["--- a horizontal rule", " text"]);
  });

  it("follows renames and quoted paths", () => {
    const patch = [
      'diff --git "a/old name.ts" "b/new name.ts"',
      "similarity index 90%",
      "rename from old name.ts",
      "rename to new name.ts",
      '--- "a/old name.ts"',
      '+++ "b/new name.ts"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch);
    expect(file).toMatchObject({
      path: "new name.ts",
      previousPath: "old name.ts",
      status: "renamed",
    });
    expect(file!.hunks[0]!.id).toBe("new name.ts:h1");
  });

  it("accepts a bare per-file patch with a fallback path", () => {
    const [file] = parseUnifiedDiff("@@ -1,1 +1,2 @@\n a\n+b\n", "lib/a.ts");
    expect(file!.path).toBe("lib/a.ts");
    expect(file!.hunks).toHaveLength(1);
  });

  it("keeps the no-newline marker inside the hunk", () => {
    const [file] = parseUnifiedDiff(
      "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n",
      "x",
    );
    expect(file!.hunks[0]!.lines).toEqual([
      "-a",
      "\\ No newline at end of file",
      "+b",
    ]);
  });

  it("flags binary files with no hunks", () => {
    const [file] = parseUnifiedDiff(
      "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n",
    );
    expect(file).toMatchObject({ path: "logo.png", binary: true, hunks: [] });
  });
});

describe("comment anchoring", () => {
  const [deliver] = parseUnifiedDiff(PR_DIFF);

  it("knows which lines each side may target", () => {
    const lines = commentableLines(deliver!.hunks[0]!);
    expect([...lines.LEFT]).toEqual([10, 11, 12, 13]);
    expect([...lines.RIGHT]).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("finds the hunk holding a whole range, or none", () => {
    expect(findHunkForRange(deliver!, "RIGHT", 11, 15)?.id).toBe(
      "src/deliver.ts:h1",
    );
    expect(findHunkForRange(deliver!, "LEFT", 11, 11)?.id).toBe(
      "src/deliver.ts:h1",
    );
    expect(findHunkForRange(deliver!, "RIGHT", 18, 43)).toBeNull();
    expect(findHunkForRange(deliver!, "RIGHT", 30, 30)).toBeNull();
  });

  it("describes commentable ranges for error messages", () => {
    expect(describeRanges(deliver!, "RIGHT")).toBe("10-17, 44-48");
  });

  it("round-trips hunk ids with colons in the path", () => {
    expect(parseHunkId("a:b/c.ts:h12")).toEqual({
      path: "a:b/c.ts",
      ordinal: 12,
    });
    expect(parseHunkId("nope")).toBeNull();
  });
});

describe("renderFilePatch", () => {
  it("rebuilds a parseable patch holding only the chosen hunks", () => {
    const [deliver] = parseUnifiedDiff(PR_DIFF);
    const patch = renderFilePatch(deliver!, [deliver!.hunks[1]!]);
    const [reparsed] = parseUnifiedDiff(patch);
    expect(reparsed!.hunks.map((h) => h.header)).toEqual([
      deliver!.hunks[1]!.header,
    ]);
  });
});
