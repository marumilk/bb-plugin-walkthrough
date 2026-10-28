import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseUnifiedDiff } from "../src/diff";
import type { Walkthrough } from "../src/model";
import { fileVersions } from "../src/versions";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -2,2 +2,2 @@",
  " b",
  "-c",
  "+C",
  "",
].join("\n");
const OLD = "a\nb\nc\nd\n";
const NEW = "a\nb\nC\nd\n";

function walkthrough(status: "modified" | "added" = "modified"): Walkthrough {
  const [file] = parseUnifiedDiff(PATCH);
  return {
    id: "wt_1",
    target: {
      kind: "local",
      environmentId: "env_1",
      diff: { type: "branch_committed", mergeBaseBranch: "main" },
      label: "Local",
    },
    files: [{ ...file!, status }],
  } as unknown as Walkthrough;
}

/** Records each read and answers with `contents[side]`. */
function fakeBb(contents: { old: string; new: string }, encoding = "utf8") {
  const reads: object[] = [];
  const bb = {
    sdk: {
      environments: {
        diffFile: async (args: { side: "old" | "new" }) => {
          const { signal: _signal, ...rest } = args as typeof args & {
            signal?: AbortSignal;
          };
          reads.push(rest);
          return { content: contents[args.side], contentEncoding: encoding };
        },
      },
    },
  } as unknown as BbPluginApi;
  return { bb, reads };
}

const noMergeBase = () => Promise.reject(new Error("not a pull request"));

describe("fileVersions", () => {
  it("reads both sides of a local diff the way it was snapshotted", async () => {
    const { bb, reads } = fakeBb({ old: OLD, new: NEW });
    await expect(
      fileVersions(bb, walkthrough(), "src/a.ts", noMergeBase),
    ).resolves.toEqual({ old: OLD, new: NEW });
    expect(reads).toEqual([
      {
        environmentId: "env_1",
        target: "branch_committed",
        mergeBaseRef: "main",
        path: "src/a.ts",
        side: "old",
      },
      {
        environmentId: "env_1",
        target: "branch_committed",
        mergeBaseRef: "main",
        path: "src/a.ts",
        side: "new",
      },
    ]);
  });

  it("drops versions that no longer match the snapshot", async () => {
    const { bb } = fakeBb({ old: OLD, new: "a\nb\nD\nd\n" });
    await expect(
      fileVersions(bb, walkthrough(), "src/a.ts", noMergeBase),
    ).resolves.toBeNull();
  });

  it("skips files with nothing to expand or show", async () => {
    const { bb, reads } = fakeBb({ old: OLD, new: NEW });
    // An added file is already whole in its patch.
    await expect(
      fileVersions(bb, walkthrough("added"), "src/a.ts", noMergeBase),
    ).resolves.toBeNull();
    await expect(
      fileVersions(bb, walkthrough(), "src/missing.ts", noMergeBase),
    ).resolves.toBeNull();
    expect(reads).toEqual([]);
    // Binary content arrives base64-encoded.
    const binary = fakeBb({ old: OLD, new: NEW }, "base64");
    await expect(
      fileVersions(binary.bb, walkthrough(), "src/a.ts", noMergeBase),
    ).resolves.toBeNull();
  });
});
