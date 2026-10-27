import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AgentAnswerError, awaitAnswer } from "../src/agent";
import { questionMarker } from "../src/conversation";

type Row = {
  seq: number;
  type: string;
  scope?: { kind: string; turnId?: string };
  data?: Record<string, unknown>;
};

/** A bb whose thread event log is `rows`, filtered like the real API. */
function fakeBb(rows: Row[]): BbPluginApi {
  const list = async ({
    afterSeq,
    limit,
    types,
  }: {
    afterSeq?: string;
    limit?: string;
    types?: readonly string[];
  }) => {
    // The real API refuses pages over 100 events.
    if (Number(limit ?? 100) > 100)
      throw new Error("Thread event limit cannot exceed 100");
    return rows.filter(
      (row) =>
        row.seq > Number(afterSeq ?? 0) && (!types || types.includes(row.type)),
    );
  };
  return { sdk: { threads: { events: { list } } } } as unknown as BbPluginApi;
}

const turn = (turnId: string) => ({ kind: "turn", turnId });

describe("awaitAnswer", () => {
  it("returns the final message of the turn that took the question", async () => {
    const bb = fakeBb([
      {
        seq: 5,
        type: "item/completed",
        scope: turn("t0"),
        data: { item: { type: "agentMessage", text: "old" } },
      },
      {
        seq: 11,
        type: "client/turn/requested",
        data: { requestId: "r1", input: [{ text: "other message" }] },
      },
      {
        seq: 12,
        type: "client/turn/requested",
        data: {
          requestId: "r2",
          input: [{ text: "q" }, { text: `<${questionMarker("dm_1")}>` }],
        },
      },
      {
        seq: 13,
        type: "turn/input/accepted",
        scope: turn("t1"),
        data: { clientRequestId: "r1" },
      },
      {
        seq: 14,
        type: "item/completed",
        scope: turn("t1"),
        data: { item: { type: "agentMessage", text: "not mine" } },
      },
      {
        seq: 15,
        type: "turn/completed",
        scope: turn("t1"),
        data: { status: "completed" },
      },
      {
        seq: 16,
        type: "turn/input/accepted",
        scope: turn("t2"),
        data: { clientRequestId: "r2" },
      },
      {
        seq: 17,
        type: "item/completed",
        scope: turn("t2"),
        data: { item: { type: "agentMessage", text: "Let me check." } },
      },
      {
        seq: 18,
        type: "item/completed",
        scope: turn("t2"),
        data: { item: { type: "commandExecution", text: "" } },
      },
      {
        seq: 19,
        type: "item/completed",
        scope: turn("t2"),
        data: {
          item: { type: "agentMessage", text: " It retries on timeout. " },
        },
      },
      {
        seq: 20,
        type: "turn/completed",
        scope: turn("t2"),
        data: { status: "completed" },
      },
    ]);
    const answer = await awaitAnswer(bb, {
      threadId: "thr_1",
      messageId: "dm_1",
      afterSeq: "10",
      signal: new AbortController().signal,
    });
    expect(answer).toBe("It retries on timeout.");
  });

  it("finds the question by its visible text when agent-only parts are not logged", async () => {
    const bb = fakeBb([
      {
        seq: 2,
        type: "client/turn/requested",
        data: {
          requestId: "r1",
          input: [{ text: "Walkthrough question about x: why?" }],
        },
      },
      {
        seq: 3,
        type: "turn/input/accepted",
        scope: turn("t1"),
        data: { clientRequestId: "r1" },
      },
      {
        seq: 4,
        type: "item/completed",
        scope: turn("t1"),
        data: { item: { type: "agentMessage", text: "Because." } },
      },
      {
        seq: 5,
        type: "turn/completed",
        scope: turn("t1"),
        data: { status: "completed" },
      },
    ]);
    await expect(
      awaitAnswer(bb, {
        threadId: "t",
        messageId: "dm_1",
        afterSeq: "0",
        visible: "Walkthrough question about x: why?",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("Because.");
  });

  it("reports an interrupted turn", async () => {
    const bb = fakeBb([
      {
        seq: 2,
        type: "client/turn/requested",
        data: {
          requestId: "r1",
          input: [{ text: `<${questionMarker("dm_1")}>` }],
        },
      },
      {
        seq: 3,
        type: "turn/input/accepted",
        scope: turn("t1"),
        data: { clientRequestId: "r1" },
      },
      {
        seq: 4,
        type: "turn/completed",
        scope: turn("t1"),
        data: { status: "interrupted" },
      },
    ]);
    await expect(
      awaitAnswer(bb, {
        threadId: "t",
        messageId: "dm_1",
        afterSeq: "0",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(AgentAnswerError);
  });

  it("reports a rejected question", async () => {
    const bb = fakeBb([
      {
        seq: 2,
        type: "client/turn/requested",
        data: {
          requestId: "r1",
          input: [{ text: `<${questionMarker("dm_1")}>` }],
        },
      },
      {
        seq: 3,
        type: "client/turn/rejected",
        data: { requestId: "r1", reason: "x", message: "x" },
      },
    ]);
    await expect(
      awaitAnswer(bb, {
        threadId: "t",
        messageId: "dm_1",
        afterSeq: "0",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("did not accept");
  });
});
