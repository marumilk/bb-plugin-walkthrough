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

/** Argv for `bb walkthrough submit`, with the document passed inline. */
function submitArgs(document: unknown = LOCAL_DOC): string[] {
  return ["submit", "--document", JSON.stringify(document)];
}

/** What sits at every path on the thread's machine, for leak checks. */
const SECRET_FILE = "ghp_SECRETTOKEN0123456789 and the rest of a credential";

async function setup({ holdAnswers = false }: { holdAnswers?: boolean } = {}) {
  const sent: unknown[] = [];
  const fileReads: string[] = [];
  // The walkthrough thread's event log. Sending a question "runs" a turn
  // that answers it, the way BB records a real one. With `holdAnswers`, the
  // turns stay open until `answerAll()`.
  const events: { seq: number; type: string; scope?: object; data?: object }[] =
    [];
  const record = (type: string, data: object, scope?: object) =>
    events.push({
      seq: events.length + 1,
      type,
      data,
      ...(scope ? { scope } : {}),
    });
  const held: (() => void)[] = [];
  let eventsDown = false;
  const answerAll = () => {
    for (const answer of held.splice(0)) answer();
  };
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
        send: async (args: { input: unknown }) => {
          sent.push(args);
          const requestId = `req_${sent.length}`;
          const turn = { kind: "turn", turnId: `t${sent.length}` };
          record("client/turn/requested", { requestId, input: args.input });
          record("turn/input/accepted", { clientRequestId: requestId }, turn);
          const text = `Answer ${sent.length}`;
          const answer = () => {
            record(
              "item/completed",
              { item: { type: "agentMessage", text } },
              turn,
            );
            record("turn/completed", { status: "completed" }, turn);
          };
          if (holdAnswers) held.push(answer);
          else answer();
          return {} as never;
        },
        events: {
          list: async ({
            afterSeq,
            limit,
            order,
            types,
          }: {
            afterSeq?: string;
            limit?: string;
            order?: string;
            types?: readonly string[];
          }) => {
            if (eventsDown) throw new Error("Thread events are unavailable");
            if (Number(limit ?? 100) > 100)
              throw new Error("Thread event limit cannot exceed 100");
            const rows = events.filter(
              (row) =>
                row.seq > Number(afterSeq ?? 0) &&
                (!types || types.includes(row.type)),
            );
            return (order === "desc" ? rows.reverse() : rows) as never;
          },
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
        read: async ({ path }: { path: string }) => {
          fileReads.push(path);
          return {
            content: SECRET_FILE,
            contentEncoding: "utf8",
            path,
          } as never;
        },
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
  const setEventsDown = (down: boolean) => {
    eventsDown = down;
  };
  return { ...host, sent, get, mutate, answerAll, setEventsDown, fileReads };
}

async function submitWalkthrough(
  harness: Awaited<ReturnType<typeof setup>>["harness"],
): Promise<string> {
  const out = await harness.behavior.runCli(submitArgs(), {
    threadId: "thr_1",
  });
  return /id="(wt_[a-z0-9]+)"/.exec(out.stdout ?? "")![1]!;
}

/** Polls until `done` holds, as the app's realtime refresh would. */
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 40 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
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
    const result = await harness.behavior.runCli(submitArgs(), {
      threadId: "thr_1",
    });
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
    const { harness } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const result = await harness.behavior.runCli(
      submitArgs({
        ...LOCAL_DOC,
        comments: [{ path: "src/deliver.ts", line: 99, body: "x" }],
      }),
      { threadId: "thr_1" },
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
    const result = await harness.behavior.runCli(submitArgs());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Run this from a BB thread");
  });
});

describe("reviewing a local walkthrough", () => {
  it("keeps, edits, adds, and sends only kept comments back to the thread", async () => {
    const { harness, sent, get, mutate } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const out = await harness.behavior.runCli(submitArgs(), {
      threadId: "thr_1",
    });
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
    const out = await harness.behavior.runCli(submitArgs(), {
      threadId: "thr_1",
    });
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

describe("private conversations with the agent", () => {
  it("asks the walkthrough's thread and records its answer, never as a comment", async () => {
    const { harness, get, sent } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const out = await harness.behavior.runCli(submitArgs(), {
      threadId: "thr_1",
    });
    const id = /id="(wt_[a-z0-9]+)"/.exec(out.stdout ?? "")![1]!;
    const { comments } = await get(id);

    const asked = (await harness.behavior.callRpc("ask", {
      id,
      body: "Is five retries enough?",
      target: {
        stopId: "c1s1",
        commentId: comments[0]!.id,
        anchor: {
          path: "src/deliver.ts",
          side: "RIGHT",
          line: 15,
          startLine: 13,
        },
      },
    })) as { discussion: { id: string; waiting: unknown } };
    expect(asked.discussion.waiting).not.toBeNull();

    const message = sent[0] as {
      threadId: string;
      mode: string;
      input: { text: string; visibility?: string }[];
    };
    expect(message).toMatchObject({
      threadId: "thr_1",
      mode: "queue-if-active",
    });
    expect(message.input[0]).toMatchObject({
      text: "Walkthrough question about `src/deliver.ts` lines 13-15: Is five retries enough?",
    });
    expect(message.input[1]!.visibility).toBe("agent-only");

    let discussion;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = (await harness.behavior.callRpc("get", { id })) as {
        discussions: {
          waiting: unknown;
          messages: { author: string; body: string }[];
        }[];
      };
      discussion = result.discussions[0]!;
      if (discussion.waiting === null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(discussion!.messages.map((m) => [m.author, m.body])).toEqual([
      ["you", "Is five retries enough?"],
      ["agent", "Answer 1"],
    ]);

    // Conversations never reach the review: only comments do.
    expect((await get(id)).comments).toHaveLength(1);
  });

  it("refuses an anchor outside the diff", async () => {
    const { harness } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const out = await harness.behavior.runCli(submitArgs(), {
      threadId: "thr_1",
    });
    const id = /id="(wt_[a-z0-9]+)"/.exec(out.stdout ?? "")![1]!;
    await expect(
      harness.behavior.callRpc("ask", {
        id,
        body: "?",
        target: {
          stopId: "c1s1",
          commentId: null,
          anchor: {
            path: "src/deliver.ts",
            side: "RIGHT",
            line: 30,
            startLine: null,
          },
        },
      }),
    ).rejects.toThrow(/not in this walkthrough's diff/);
  });
});

describe("viewed files", () => {
  it("records Viewed per file within a stop", async () => {
    const { harness, get } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const out = await harness.behavior.runCli(submitArgs(), {
      threadId: "thr_1",
    });
    const id = /id="(wt_[a-z0-9]+)"/.exec(out.stdout ?? "")![1]!;
    await harness.behavior.callRpc("setViewed", {
      id,
      stopId: "c1s1",
      path: "src/deliver.ts",
      viewed: true,
    });
    await harness.behavior.callRpc("setViewed", {
      id,
      stopId: "rest1",
      path: "src/queue.ts",
      viewed: true,
    });
    await harness.behavior.callRpc("setViewed", {
      id,
      stopId: "rest1",
      path: "src/queue.ts",
      viewed: false,
    });
    expect((await get(id)).walkthrough.viewed).toEqual([
      "c1s1\u0000src/deliver.ts",
    ]);
  });
});

describe("rewriting the review summary", () => {
  it("asks the agent, puts its summary in place, and can undo", async () => {
    const { harness, get, sent } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const out = await harness.behavior.runCli(submitArgs(), {
      threadId: "thr_1",
    });
    const id = /id="(wt_[a-z0-9]+)"/.exec(out.stdout ?? "")![1]!;
    const { comments } = await get(id);
    await harness.behavior.callRpc("setCommentStatus", {
      id,
      commentId: comments[0]!.id,
      status: "kept",
    });
    await harness.behavior.callRpc("setReview", {
      id,
      summary: "Draft summary.",
      verdict: "COMMENT",
    });

    await harness.behavior.callRpc("rewriteSummary", { id });
    const message = sent.at(-1) as { input: { text: string }[] };
    expect(message.input[0]!.text).toBe(
      "Walkthrough: rewrite the review summary from the 1 kept comment.",
    );

    let walkthrough;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      walkthrough = (await get(id)).walkthrough;
      if (!walkthrough.summaryJob) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(walkthrough).toMatchObject({
      summary: "Answer 1",
      previousSummary: "Draft summary.",
      summaryError: null,
    });
    expect(walkthrough!.summaryBasis).toBeTruthy();

    await harness.behavior.callRpc("undoSummaryRewrite", { id });
    expect((await get(id)).walkthrough).toMatchObject({
      summary: "Draft summary.",
      previousSummary: null,
    });
  });
});

describe("late and concurrent changes", () => {
  const STOP_QUESTION = {
    body: "Why a queue?",
    target: { stopId: "c1s1", commentId: null, anchor: null },
  };

  /** Collects unhandled promise rejections while `run` executes. */
  async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
    const rejections: unknown[] = [];
    const listener = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await run();
    } finally {
      process.off("unhandledRejection", listener);
    }
    return rejections;
  }

  /** Long enough for the answer poll to see an answer released just before. */
  const nextPoll = () => new Promise((resolve) => setTimeout(resolve, 1800));

  it("drops the answer to a conversation deleted while the agent answered", async () => {
    const { harness, get, answerAll } = await setup({ holdAnswers: true });
    dispose = () => harness.lifecycle.dispose();
    const id = await submitWalkthrough(harness);
    const { discussion } = (await harness.behavior.callRpc("ask", {
      id,
      ...STOP_QUESTION,
    })) as { discussion: { id: string } };

    const rejections = await unhandledDuring(async () => {
      await harness.behavior.callRpc("deleteDiscussion", {
        id,
        discussionId: discussion.id,
      });
      answerAll();
      await nextPoll();
    });
    expect(rejections).toEqual([]);
    expect(
      ((await get(id)) as unknown as { discussions: unknown[] }).discussions,
    ).toEqual([]);
  });

  it("drops a summary rewrite whose walkthrough was deleted meanwhile", async () => {
    const { harness, answerAll } = await setup({ holdAnswers: true });
    dispose = () => harness.lifecycle.dispose();
    const id = await submitWalkthrough(harness);
    await harness.behavior.callRpc("rewriteSummary", { id });

    const rejections = await unhandledDuring(async () => {
      const deleted = await harness.behavior.runCli(["delete", id]);
      expect(deleted.exitCode).toBe(0);
      answerAll();
      await nextPoll();
    });
    expect(rejections).toEqual([]);
  });

  it("takes one question at a time in a conversation", async () => {
    const { harness, get, sent } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const id = await submitWalkthrough(harness);
    const { discussion } = (await harness.behavior.callRpc("ask", {
      id,
      ...STOP_QUESTION,
    })) as { discussion: { id: string } };
    await eventually(
      () => get(id) as Promise<{ discussions?: { waiting: unknown }[] }>,
      (data) => data.discussions?.[0]?.waiting === null,
    );

    const reply = () =>
      harness.behavior.callRpc("ask", {
        id,
        discussionId: discussion.id,
        body: "And the retry limit?",
      });
    const results = await Promise.allSettled([reply(), reply()]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(sent).toHaveLength(2);
  });

  it("rewrites the summary once when asked twice at once", async () => {
    const { harness, sent } = await setup({ holdAnswers: true });
    dispose = () => harness.lifecycle.dispose();
    const id = await submitWalkthrough(harness);
    const rewrite = () => harness.behavior.callRpc("rewriteSummary", { id });
    const results = await Promise.allSettled([rewrite(), rewrite()]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(sent).toHaveLength(1);
  });

  it("sends feedback once when submitted twice at once", async () => {
    const { harness, get, sent } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const id = await submitWalkthrough(harness);
    const { comments } = await get(id);
    await harness.behavior.callRpc("setCommentStatus", {
      id,
      commentId: comments[0]!.id,
      status: "kept",
    });
    const submit = () => harness.behavior.callRpc("submit", { id });
    const results = await Promise.allSettled([submit(), submit()]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(sent).toHaveLength(1);
  });

  it("starts no conversation when the agent's thread cannot be read", async () => {
    const { harness, get, setEventsDown } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const id = await submitWalkthrough(harness);
    setEventsDown(true);
    await expect(
      harness.behavior.callRpc("ask", { id, ...STOP_QUESTION }),
    ).rejects.toThrow();
    expect(
      ((await get(id)) as unknown as { discussions: unknown[] }).discussions,
    ).toEqual([]);
  });
});

describe("what an agent can reach through the CLI", () => {
  it("never reads a file for the agent, so sandboxed files stay out of reach", async () => {
    const { harness, fileReads } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const result = await harness.behavior.runCli(
      ["submit", "--file", "/home/me/.config/gh/hosts.yml"],
      { threadId: "thr_1" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).not.toContain(
      "ghp_",
    );
    expect(fileReads).toEqual([]);
  });

  it("reports a document that is not JSON", async () => {
    const { harness } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const result = await harness.behavior.runCli(
      ["submit", "--document", "{ not json"],
      { threadId: "thr_1" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("The walkthrough is not valid JSON");
  });

  it("keeps each thread's walkthroughs to that thread", async () => {
    const { harness, get } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const id = await submitWalkthrough(harness);
    const elsewhere = { threadId: "thr_2" };

    const shown = await harness.behavior.runCli(["show", id], elsewhere);
    expect(shown.exitCode).not.toBe(0);
    expect(shown.stderr).toContain(`No walkthrough with id ${id}`);
    expect(shown.stdout ?? "").not.toContain("Retry failed deliveries");

    const deleted = await harness.behavior.runCli(["delete", id], elsewhere);
    expect(deleted.exitCode).not.toBe(0);
    await expect(get(id)).resolves.toBeDefined();

    const listed = await harness.behavior.runCli(["list"], elsewhere);
    expect(listed.stdout).toBe("No walkthroughs yet.");

    // Its own thread, and you at a terminal outside any thread, still can.
    const own = await harness.behavior.runCli(["show", id], {
      threadId: "thr_1",
    });
    expect(own.exitCode).toBe(0);
    const terminal = await harness.behavior.runCli(["list"]);
    expect(terminal.stdout).toContain(id);
  });
});
