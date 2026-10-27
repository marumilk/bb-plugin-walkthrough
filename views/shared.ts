// Small app-side helpers shared by the tab, header button, directive, and
// Reviews page.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRpc,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import {
  WALKTHROUGH_CHANGED,
  type Discussion,
  type DraftComment,
  type Walkthrough,
} from "../src/model";
import type { rpcContract } from "../server";

/** The thread action tab id registered in app.tsx. */
export const WALKTHROUGH_TAB = "walkthrough";

export type Rpc = PluginRpcClient<typeof rpcContract>;

export function useWalkthroughRpc(): Rpc {
  return useRpc<typeof rpcContract>();
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function readChangePayload(
  payload: unknown,
): { id: string; threadId: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { id, threadId } = payload as Record<string, unknown>;
  return typeof id === "string" && typeof threadId === "string"
    ? { id, threadId }
    : null;
}

export type WalkthroughData = {
  walkthrough: Walkthrough;
  comments: DraftComment[];
  discussions: Discussion[];
};

/**
 * Reuses unchanged parts of the previous fetch. The diff snapshot never
 * changes after submission, and keeping its identity stops every realtime
 * refresh from re-rendering (and re-measuring) every diff on screen.
 */
function keepStableParts(
  previous: WalkthroughData | null,
  next: WalkthroughData,
): WalkthroughData {
  if (previous === null || previous.walkthrough.id !== next.walkthrough.id)
    return next;
  const reuse = <T extends { id: string }>(
    old: readonly T[],
    next: T[],
  ): T[] => {
    const before = new Map(old.map((item) => [item.id, item]));
    return next.map((item) => {
      const kept = before.get(item.id);
      return kept !== undefined && JSON.stringify(kept) === JSON.stringify(item)
        ? kept
        : item;
    });
  };
  return {
    walkthrough: {
      ...next.walkthrough,
      files: previous.walkthrough.files,
      chapters: previous.walkthrough.chapters,
    },
    comments: reuse(previous.comments, next.comments),
    discussions: reuse(previous.discussions, next.discussions),
  };
}

/** One walkthrough and its comments, kept current over realtime. */
export function useWalkthrough(id: string | null) {
  const rpc = useWalkthroughRpc();
  const [data, setData] = useState<WalkthroughData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);
  const refetch = useCallback(() => {
    if (id === null) return;
    // Realtime refreshes can overlap; only the newest request may land.
    const request = ++latestRequest.current;
    rpc.call("get", { id }).then(
      (result) => {
        if (request !== latestRequest.current) return;
        setData((previous) => keepStableParts(previous, result));
        setError(null);
      },
      (cause: unknown) => {
        if (request === latestRequest.current) setError(errorMessage(cause));
      },
    );
  }, [rpc, id]);
  useEffect(refetch, [refetch]);
  useRealtime(WALKTHROUGH_CHANGED, (payload) => {
    if (readChangePayload(payload)?.id === id) refetch();
  });
  return { rpc, data, setData, error, refetch };
}

/**
 * Walkthroughs to open once BB shows their thread. The Reviews page leaves an
 * entry here and navigates; the thread's header button opens the tab when it
 * mounts, because only thread surfaces can open thread panels.
 */
export const pendingOpens = new Map<string, string>();

export function relativeTime(at: number | string): string {
  const then = typeof at === "number" ? at : Date.parse(at);
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
