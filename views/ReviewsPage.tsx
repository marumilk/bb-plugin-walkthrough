// The Reviews page: pull requests waiting on you, and recent walkthroughs.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyStatePanel } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import {
  WALKTHROUGH_CHANGED,
  describeTarget,
  type WalkthroughSummary,
} from "../src/model";
import type { InboxEntry } from "../server";
import { Hint } from "./Hint";
import {
  errorMessage,
  pendingOpens,
  relativeTime,
  useWalkthroughRpc,
} from "./shared";

function StatusText({ summary }: { summary: WalkthroughSummary }) {
  if (summary.status === "submitted")
    return <>Posted {relativeTime(summary.updatedAt)}</>;
  if (summary.status === "sent")
    return <>Sent to agent {relativeTime(summary.updatedAt)}</>;
  const { pending, kept } = summary.counts;
  return (
    <>
      {pending > 0 ? (
        <span className="font-medium text-foreground">{pending} undecided</span>
      ) : (
        "All decided"
      )}
      {" · "}
      {kept} kept
    </>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ReviewsPage() {
  const rpc = useWalkthroughRpc();
  const navigate = useBbNavigate();
  const [inbox, setInbox] = useState<{
    entries: InboxEntry[];
    error: string | null;
  } | null>(null);
  const [recent, setRecent] = useState<WalkthroughSummary[] | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const loadRecent = useCallback(() => {
    rpc.call("list").then(
      (result) => setRecent(result.walkthroughs),
      (cause: unknown) => toast.error(errorMessage(cause)),
    );
  }, [rpc]);
  const loadInbox = useCallback(() => {
    setInbox(null);
    rpc
      .call("inbox")
      .then(setInbox, (cause: unknown) =>
        setInbox({ entries: [], error: errorMessage(cause) }),
      );
  }, [rpc]);
  useEffect(() => {
    loadRecent();
    loadInbox();
  }, [loadRecent, loadInbox]);
  useRealtime(WALKTHROUGH_CHANGED, loadRecent);

  const open = (summary: WalkthroughSummary) => {
    pendingOpens.set(summary.threadId, summary.id);
    navigate.toThread(summary.threadId);
  };

  const start = async (entry: InboxEntry) => {
    const key = `${entry.repo}#${entry.number}`;
    setStarting(key);
    try {
      const { threadId } = await rpc.call("startReview", {
        repo: entry.repo,
        number: entry.number,
      });
      toast.success(
        `Reviewing ${key}. The walkthrough opens beside the thread when it is ready.`,
      );
      navigate.toThread(threadId);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setStarting(null);
    }
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-6 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <Section
          title="Waiting for your review"
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={loadInbox}
              disabled={inbox === null}
            >
              <Icon name="ArrowReloadHorizontal" aria-hidden="true" />
              Refresh
            </Button>
          }
        >
          {inbox === null ? (
            <EmptyStatePanel>Loading pull requests…</EmptyStatePanel>
          ) : inbox.error !== null ? (
            <EmptyStatePanel>{inbox.error}</EmptyStatePanel>
          ) : inbox.entries.length === 0 ? (
            <EmptyStatePanel>
              No pull requests are waiting for your review.
            </EmptyStatePanel>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {inbox.entries.map((entry) => {
                const key = `${entry.repo}#${entry.number}`;
                return (
                  <li key={key} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <UrlLink
                          href={entry.url}
                          className="truncate text-sm font-medium text-foreground"
                        >
                          {entry.title}
                        </UrlLink>
                        {entry.isDraft ? (
                          <span className="shrink-0 rounded bg-secondary px-1.5 text-xs text-secondary-foreground">
                            Draft
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {key} · {entry.author} · updated{" "}
                        {relativeTime(entry.updatedAt)}
                        {entry.walkthrough ? (
                          <>
                            {" · "}
                            <StatusText summary={entry.walkthrough} />
                          </>
                        ) : null}
                      </p>
                    </div>
                    {entry.walkthrough ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0"
                        onClick={() => open(entry.walkthrough!)}
                      >
                        Open
                      </Button>
                    ) : (
                      <Hint
                        label={
                          entry.projectId === null
                            ? `Add ${entry.repo} as a BB project to review it here`
                            : undefined
                        }
                      >
                        {/* A span keeps the hint reachable while the button is disabled. */}
                        <span
                          className="shrink-0"
                          tabIndex={entry.projectId === null ? 0 : undefined}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={
                              entry.projectId === null || starting !== null
                            }
                            onClick={() => void start(entry)}
                          >
                            {starting === key ? "Starting…" : "Start review"}
                          </Button>
                        </span>
                      </Hint>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Recent walkthroughs">
          {recent === null ? (
            <EmptyStatePanel>Loading…</EmptyStatePanel>
          ) : recent.length === 0 ? (
            <EmptyStatePanel>
              No walkthroughs yet. Ask an agent to <code>/walkthrough</code> a
              pull request or your changes.
            </EmptyStatePanel>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {recent.map((summary) => (
                <li key={summary.id}>
                  <button
                    type="button"
                    onClick={() => open(summary)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-state-hover"
                  >
                    <Icon
                      name={
                        summary.target.kind === "pr"
                          ? "GitPullRequest"
                          : "GitBranch"
                      }
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {summary.title}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {describeTarget(summary.target)} ·{" "}
                        <StatusText summary={summary} />
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {relativeTime(summary.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
