// Ways into a walkthrough from a thread: the header button (which also opens
// the tab when an agent submits one) and the chat card agents print.
import { useCallback, useEffect, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  type PluginMessageDirectiveProps,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Hint } from "./Hint";
import {
  countComments,
  describeTarget,
  type WalkthroughSummary,
} from "../src/model";
import {
  WALKTHROUGH_CHANGED,
  WALKTHROUGH_READY,
  WALKTHROUGH_TAB,
  pendingOpens,
  pluralize,
  readChangePayload,
  useWalkthrough,
  useWalkthroughRpc,
} from "./shared";

function useOpenTab() {
  const navigate = useBbNavigate();
  return useCallback(
    (id: string) =>
      navigate.openThreadPanel({
        actionId: WALKTHROUGH_TAB,
        title: "Walkthrough",
        params: { id },
      }),
    [navigate],
  );
}

export function WalkthroughHeaderButton({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const rpc = useWalkthroughRpc();
  const openTab = useOpenTab();
  const [summary, setSummary] = useState<WalkthroughSummary | null>(null);

  const refetch = useCallback(() => {
    rpc.call("latestForThread", { threadId }).then(
      (result) => setSummary(result.summary),
      () => {},
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);

  useEffect(() => {
    const id = pendingOpens.get(threadId);
    if (id === undefined) return;
    pendingOpens.delete(threadId);
    openTab(id);
  }, [threadId, openTab]);

  useRealtime(WALKTHROUGH_CHANGED, (payload) => {
    if (readChangePayload(payload)?.threadId === threadId) refetch();
  });
  useRealtime(WALKTHROUGH_READY, (payload) => {
    const change = readChangePayload(payload);
    if (change?.threadId === threadId) openTab(change.id);
  });

  if (summary === null) return null;
  const pending = summary.counts.pending;
  const label =
    pending > 0
      ? `Walkthrough, ${pluralize(pending, "undecided draft")}`
      : "Walkthrough";
  return (
    <Hint label={label}>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2"
        aria-label={label}
        onClick={() => openTab(summary.id)}
      >
        <Icon name="FileDiff" aria-hidden="true" />
        {isCompactViewport ? null : <span>Walkthrough</span>}
        {pending > 0 ? (
          <span className="rounded bg-secondary px-1 text-xs tabular-nums text-secondary-foreground">
            {pending}
          </span>
        ) : null}
      </Button>
    </Hint>
  );
}

export function WalkthroughDirective({
  attributes,
}: PluginMessageDirectiveProps) {
  const id =
    typeof attributes.id === "string" && /^wt_[a-z0-9]+$/.test(attributes.id)
      ? attributes.id
      : null;
  const { data, error } = useWalkthrough(id);
  const openTab = useOpenTab();
  if (id === null) return null;
  const walkthrough = data?.walkthrough;
  const counts = data ? countComments(data.comments) : null;
  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <Icon
        name="FileDiff"
        className="size-5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {walkthrough?.title ??
            (error ? "Walkthrough unavailable" : "Walkthrough")}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {walkthrough && counts
            ? `${describeTarget(walkthrough.target)} · ${walkthrough.chapters.reduce((n, c) => n + c.stops.length, 0)} stops · ` +
              (walkthrough.status === "submitted"
                ? "posted"
                : walkthrough.status === "sent"
                  ? "sent to agent"
                  : `${pluralize(counts.pending, "draft")} to decide`)
            : (error ?? "Loading…")}
        </p>
      </div>
      <Button
        size="sm"
        className="h-7 shrink-0"
        disabled={!walkthrough}
        onClick={() => openTab(id)}
      >
        Open
      </Button>
    </div>
  );
}
