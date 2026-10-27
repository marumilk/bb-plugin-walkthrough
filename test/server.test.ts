import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { DraftComment, Walkthrough } from "../src/model";
import plugin from "../server";
import { PR_DIFF } from "./fixtures";

const LOCAL_DOC = {
  target: { local: "uncommitted" },
  title: "Retry failed deliveries",
  chapters: [
    {
      title: "Delivery",
      stops: [
        { title: "Queue failures", prose: "x", hunks: ["src/deliver.ts:h1"] },
      ],
    },
  ],
  comments: [
    {
      path: "src/deliver.ts",
      line: 15,
      startLine: 13,
      body: "Should this retry forever?",
    },
  ],
};

// Per-file patches the way BB's environment diff API returns them.
const deliverPatch = PR_DIFF.slice(
  0,
  PR_DIFF.indexOf("diff --git a/src/queue.ts"),
);
const queuePatch = PR_DIFF.slice(PR_DIFF.indexOf("diff --git a/src/queue.ts"));

async function setup(document: unknown = LOCAL_DOC) {
  const sent: unknown[] = [];
  const host = createFakePluginHost({
    pluginId: "walkthrough",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "proj_1",
            environmentId: "env_1",
          }),
        send: async (args: unknown) => {
          sent.push(args);
          return {} as never;
        },
      },
      projects: {
        get: async () =>
          ({
            id: "proj_1",
            gitRemoteUrl: "git@github.com:acme/app.git",
          }) as never,
      },
      environments: {
        get: async () =>
          ({
            id: "env_1",
            hostId: "host_1",
            mergeBaseBranch: null,
            defaultBranch: "main",
            branchName: "retry",
          }) as never,
        diffFiles: async () =>
          ({
            outcome: "available",
            files: [
              {
                path: "src/deliver.ts",
                previousPath: null,
                changeKind: "modified",
                binary: false,
              },
              {
                path: "src/queue.ts",
                previousPath: null,
                changeKind: "added",
                binary: false,
              },
            ],
            initialPatches: [
              { path: "src/deliver.ts", patch: deliverPatch, truncated: false },
            ],
          }) as never,
        diffPatch: async () =>
          ({
            outcome: "available",
            patches: [
              { path: "src/queue.ts", patch: queuePatch, truncated: false },
            ],
          }) as never,
      },
      files: {
        read: async ({ path }: { path: string }) =>
          ({
            content: JSON.stringify(document),
            contentEncoding: "utf8",
            path,
          }) as never,
      },
    },
  });
  await plugin(host.bb);
  // The harness returns `unknown`; the contract's types are what the app sees.
  const get = (id: string) =>
    host.harness.behavior.callRpc("get", { id }) as Promise<{
      walkthrough: Walkthrough;
      comments: DraftComment[];
    }>;
  const mutate = (method: string, input: unknown) =>
    host.harness.behavior.callRpc(method, input) as Promise<{
      comment: DraftComment;
    }>;
  return { ...host, sent, get, mutate };
}

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

describe("bb walkthrough submit", () => {
  it("snapshots local changes, stores drafts, and announces the walkthrough", async () => {
    const { harness, get } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const result = await harness.behavior.runCli(
      ["submit", "--file", "/tmp/w.json"],
      { threadId: "thr_1" },
    );
    expect(result.exitCode).toBe(0);
    const id = /::walkthrough\{id="(wt_[a-z0-9]+)"\}/.exec(
      result.stdout ?? "",
    )?.[1];
    expect(id).toBeDefined();
    expect(
      harness.inspection.realtimeSignals.map((signal) => signal.channel),
    ).toContain("walkthrough-ready");

    const { walkthrough, comments } = await get(id!);
    expect(walkthrough.target).toEqual({
      kind: "local",
      environmentId: "env_1",
      diff: { type: "uncommitted" },
      label: "Uncommitted changes",
    });
    expect(
      walkthrough.chapters.map((chapter: { title: string }) => chapter.title),
    ).toEqual(["Delivery", "Other changes"]);
    expect(comments).toMatchObject([
      { status: "pending", author: "agent", startLine: 13, stopId: "c1s1" },
    ]);
  });

  it("returns every anchoring problem instead of opening anything", async () => {
    const { harness } = await setup({
      ...LOCAL_DOC,
      comments: [{ path: "src/deliver.ts", line: 99, body: "x" }],
    });
    dispose = () => harness.lifecycle.dispose();
    const result = await harness.behavior.runCli(
      ["submit", "--file", "w.json"],
      { threadId: "thr_1", cwd: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("line 99 (RIGHT) is outside the diff");
    expect(await harness.behavior.callRpc("list", null)).toEqual({
      walkthroughs: [],
    });
  });

  it("requires a thread", async () => {
    const { harness } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const result = await harness.behavior.runCli([
      "submit",
      "--file",
      "/tmp/w.json",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Run this from a BB thread");
  });
});

describe("reviewing a local walkthrough", () => {
  it("keeps, edits, adds, and sends only kept comments back to the thread", async () => {
    const { harness, sent, get, mutate } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const out = await harness.behavior.runCli(
      ["submit", "--file", "/tmp/w.json"],
      { threadId: "thr_1" },
    );
    const id = /id="(wt_[a-z0-9]+)"/.exec(out.stdout ?? "")![1]!;
    const { comments } = await get(id!);

    const edited = await mutate("editComment", {
      id,
      commentId: comments[0]!.id,
      body: "Cap retries at five.",
    });
    expect(edited.comment).toMatchObject({
      status: "kept",
      originalBody: "Should this retry forever?",
    });

    await expect(
      harness.behavior.callRpc("addComment", {
        id,
        path: "src/deliver.ts",
        side: "RIGHT",
        line: 30,
        startLine: null,
        body: "x",
      }),
    ).rejects.toThrow(/outside the diff/);
    const added = await mutate("addComment", {
      id,
      path: "src/queue.ts",
      side: "RIGHT",
      line: 2,
      startLine: 1,
      body: "Log the error too.",
    });
    expect(added.comment).toMatchObject({
      author: "you",
      status: "kept",
      stopId: "rest1",
      startLine: 1,
    });

    await harness.behavior.callRpc("setReview", {
      id,
      summary: "Nearly there.",
      verdict: "COMMENT",
    });
    await harness.behavior.callRpc("submit", { id });

    expect(sent).toHaveLength(1);
    const message = sent[0] as { threadId: string; input: { text: string }[] };
    expect(message.threadId).toBe("thr_1");
    expect(message.input[0]!.text).toContain(
      "1. `src/deliver.ts:13-15`: Cap retries at five.",
    );
    expect(message.input[0]!.text).toContain(
      "2. `src/queue.ts:1-2`: Log the error too.",
    );
    expect(message.input[0]!.text).toContain("Nearly there.");
    const after = await get(id!);
    expect(after.walkthrough.status).toBe("sent");
  });

  it("only lets the reviewer delete their own comments", async () => {
    const { harness, get } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const out = await harness.behavior.runCli(
      ["submit", "--file", "/tmp/w.json"],
      { threadId: "thr_1" },
    );
    const id = /id="(wt_[a-z0-9]+)"/.exec(out.stdout ?? "")![1]!;
    const { comments } = await get(id!);
    await expect(
      harness.behavior.callRpc("deleteComment", {
        id,
        commentId: comments[0]!.id,
      }),
    ).rejects.toThrow(/discard a draft instead/);
  });
});
