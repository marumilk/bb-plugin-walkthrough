// Asking the walkthrough's own agent a question and reading its answer.
//
// The question goes to the thread as an ordinary message, so the agent
// answers with everything it already knows about the change. The answer is
// the last assistant message of the turn that took that message: the
// message's marker identifies its request, the request names its turn.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { questionMarker } from "./conversation";

const WATCHED = [
  "client/turn/requested",
  "turn/input/accepted",
  "item/completed",
  "turn/completed",
  "client/turn/rejected",
] as const;

const POLL_MS = 1500;
/** BB caps one page of thread events at 100. */
const PAGE = 100;
/** Consecutive failed polls tolerated before giving up, e.g. across a server restart. */
const MAX_POLL_FAILURES = 8;
/** Long enough for an agent to read code before answering. */
const TIMEOUT_MS = 30 * 60 * 1000;

type EventRow = {
  seq: number | string;
  type: string;
  scope?: { kind: string; turnId?: string };
  data?: Record<string, unknown>;
};

export class AgentAnswerError extends Error {}

/** The newest event sequence, as the cursor to watch for the answer from. */
export async function latestSeq(
  bb: BbPluginApi,
  threadId: string,
): Promise<string> {
  const rows = (await bb.sdk.threads.events.list({
    threadId,
    order: "desc",
    limit: "1",
  })) as EventRow[];
  return rows[0] === undefined ? "0" : String(rows[0].seq);
}

/**
 * Sends the question as its own turn. Only `visible` shows in the thread's
 * chat; the excerpt and instructions in `context` go to the agent alone.
 */
export async function sendQuestion(
  bb: BbPluginApi,
  threadId: string,
  prompt: { visible: string; context: string },
): Promise<void> {
  await bb.sdk.threads.send({
    threadId,
    mode: "queue-if-active",
    input: [
      { type: "text", text: prompt.visible, mentions: [] },
      {
        type: "text",
        text: prompt.context,
        mentions: [],
        visibility: "agent-only",
      },
    ],
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function inputText(data: Record<string, unknown> | undefined): string {
  const input = data?.input;
  if (!Array.isArray(input)) return "";
  return input
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String(part.text)
        : "",
    )
    .join("\n");
}

/** Waits for the turn that received `messageId` and returns its final reply. */
export async function awaitAnswer(
  bb: BbPluginApi,
  input: {
    threadId: string;
    messageId: string;
    afterSeq: string;
    /** The question as shown in chat, in case agent-only parts are not logged. */
    visible?: string;
    signal: AbortSignal;
  },
): Promise<string> {
  const marker = questionMarker(input.messageId);
  const isQuestion = (text: string) =>
    text.includes(marker) ||
    (input.visible !== undefined && text.includes(input.visible));
  const deadline = Date.now() + TIMEOUT_MS;
  let cursor = input.afterSeq;
  let requestId: string | null = null;
  let turnId: string | null = null;
  let reply = "";
  let failures = 0;

  while (!input.signal.aborted) {
    if (Date.now() > deadline)
      throw new AgentAnswerError("The agent did not answer within 30 minutes.");
    let rows: EventRow[];
    try {
      rows = (await bb.sdk.threads.events.list({
        threadId: input.threadId,
        afterSeq: cursor,
        order: "asc",
        limit: String(PAGE),
        types: [...WATCHED],
        signal: input.signal,
      })) as EventRow[];
      failures = 0;
    } catch (error) {
      if (input.signal.aborted) break;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) throw error;
      await sleep(POLL_MS * failures, input.signal);
      continue;
    }
    for (const row of rows) {
      cursor = String(row.seq);
      const rowTurn = row.scope?.turnId ?? null;
      if (
        row.type === "client/turn/requested" &&
        requestId === null &&
        isQuestion(inputText(row.data))
      ) {
        requestId =
          typeof row.data?.requestId === "string" ? row.data.requestId : null;
      } else if (
        row.type === "client/turn/rejected" &&
        requestId !== null &&
        row.data?.requestId === requestId
      ) {
        throw new AgentAnswerError(
          "The agent's thread did not accept the question.",
        );
      } else if (
        row.type === "turn/input/accepted" &&
        requestId !== null &&
        row.data?.clientRequestId === requestId
      ) {
        turnId = rowTurn;
      } else if (turnId !== null && rowTurn === turnId) {
        if (row.type === "item/completed") {
          const item = row.data?.item as
            { type?: string; text?: string } | undefined;
          if (
            item?.type === "agentMessage" &&
            typeof item.text === "string" &&
            item.text.trim() !== ""
          ) {
            reply = item.text.trim();
          }
        } else if (row.type === "turn/completed") {
          if (
            row.data?.status !== undefined &&
            row.data.status !== "completed"
          ) {
            throw new AgentAnswerError(
              `The agent's turn ended (${String(row.data.status)}) before it answered.`,
            );
          }
          if (reply === "")
            throw new AgentAnswerError("The agent finished without replying.");
          return reply;
        }
      }
    }
    if (rows.length < PAGE) await sleep(POLL_MS, input.signal);
  }
  throw new AgentAnswerError("Stopped waiting for the agent.");
}
