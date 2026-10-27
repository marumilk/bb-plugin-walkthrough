// The walkthrough itself: one stop at a time, then a Finish step that posts
// the review or sends feedback to the agent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  UrlLink,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyStatePanel } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ResolvedChapter, ResolvedStop } from "../src/document";
import {
  countComments,
  describeTarget,
  viewedKey,
  type Discussion,
  type DraftComment,
  type Walkthrough,
} from "../src/model";
import { FinishStep } from "./FinishStep";
import { Hint } from "./Hint";
import { errorMessage, pluralize, useWalkthrough } from "./shared";
import { OverviewStep } from "./OverviewStep";
import { StopCard } from "./StopCard";
import { Timeline, type BehindStatus } from "./Timeline";
import { StopDiff } from "./StopDiff";

const FINISH = "finish";
const OVERVIEW = "overview";

interface Step {
  id: string;
  kind: "overview" | "stop" | "finish";
  chapter: ResolvedChapter | null;
  stop: ResolvedStop | null;
  /** 1-based position among stops, for "Stop 3 of 9". */
  number: number;
}

function buildSteps(
  chapters: readonly ResolvedChapter[],
  withOverview: boolean,
): Step[] {
  const steps: Step[] = [];
  if (withOverview)
    steps.push({
      id: OVERVIEW,
      kind: "overview",
      chapter: null,
      stop: null,
      number: 0,
    });
  let number = 0;
  for (const chapter of chapters) {
    for (const stop of chapter.stops) {
      number += 1;
      steps.push({ id: stop.id, kind: "stop", chapter, stop, number });
    }
  }
  steps.push({
    id: FINISH,
    kind: "finish",
    chapter: null,
    stop: null,
    number: number + 1,
  });
  return steps;
}

function readId(
  params: ExperimentalThreadActionTabProps["params"],
): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params))
    return null;
  const id = (params as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

function TargetLine({ walkthrough }: { walkthrough: Walkthrough }) {
  const { target } = walkthrough;
  if (target.kind === "pr") {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Icon
          name="GitPullRequest"
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <UrlLink href={target.url} className="truncate">
          {target.repo}#{target.number}
        </UrlLink>
        <span className="truncate">by {target.author}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon name="GitBranch" className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{describeTarget(target)}</span>
    </span>
  );
}

export function WalkthroughTab({ params }: ExperimentalThreadActionTabProps) {
  const id = readId(params);
  const { rpc, data, setData, error } = useWalkthrough(id);
  const [stepId, setStepId] = useState<string | null>(null);
  const [behind, setBehind] = useState<BehindStatus | null>(null);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<string | null>(null);

  const walkthrough = data?.walkthrough ?? null;
  const comments = data?.comments ?? [];
  const discussions = data?.discussions ?? [];
  const chapters = walkthrough?.chapters;
  const isPr = walkthrough?.target.kind === "pr";
  const steps = useMemo(
    () => (chapters ? buildSteps(chapters, isPr) : []),
    [chapters, isPr],
  );
  const current =
    steps.find((step) => step.id === (stepId ?? walkthrough?.currentStopId)) ??
    steps[0] ??
    null;

  const goTo = useCallback(
    (next: string, commentId?: string) => {
      setStepId(next);
      pendingScroll.current = commentId ?? null;
      if (id !== null)
        rpc.call("setProgress", { id, stopId: next }).catch(() => {});
      if (commentId === undefined) scrollRef.current?.scrollTo({ top: 0 });
    },
    [id, rpc],
  );

  // How far the PR has moved since the snapshot, for the timeline's badge.
  useEffect(() => {
    if (id === null || !isPr) return;
    let cancelled = false;
    rpc.call("headStatus", { id }).then(
      (result) => {
        if (!cancelled)
          setBehind({ behindBy: result.behindBy, diverged: result.diverged });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [id, isPr, rpc]);

  const index = current === null ? -1 : steps.indexOf(current);
  const previous = index > 0 ? steps[index - 1]! : null;
  const following =
    index >= 0 && index < steps.length - 1 ? steps[index + 1]! : null;

  // j/k step through the walkthrough unless the reviewer is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target)
      )
        return;
      if (
        !scrollRef.current?.isConnected ||
        scrollRef.current.offsetParent === null
      )
        return;
      if (event.key === "j" && following) goTo(following.id);
      else if (event.key === "k" && previous) goTo(previous.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [following, previous, goTo]);

  // After jumping to a comment, scroll to it once the stop has rendered.
  useEffect(() => {
    const target = pendingScroll.current;
    if (target === null) return;
    const timer = setTimeout(() => {
      const element = scrollRef.current?.querySelector(
        `[data-comment-id="${CSS.escape(target)}"]`,
      );
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
      pendingScroll.current = null;
    }, 150);
    return () => clearTimeout(timer);
  }, [current?.id]);

  const onDiscussionChanged = useCallback(
    (discussionId: string, next: Discussion | null) => {
      setData((previousData) => {
        if (previousData === null) return previousData;
        const rest = previousData.discussions.filter(
          (d) => d.id !== discussionId,
        );
        return {
          ...previousData,
          discussions:
            next === null
              ? rest
              : [...rest, next].sort((a, b) => a.createdAt - b.createdAt),
        };
      });
    },
    [setData],
  );

  const setViewed = useCallback(
    (stopId: string, path: string, viewed: boolean) => {
      if (id === null) return;
      const key = viewedKey(stopId, path);
      // Optimistic: collapse at once, then take the server's list.
      setData((previousData) =>
        previousData === null
          ? previousData
          : {
              ...previousData,
              walkthrough: {
                ...previousData.walkthrough,
                viewed: [
                  ...(previousData.walkthrough.viewed ?? []).filter(
                    (entry) => entry !== key,
                  ),
                  ...(viewed ? [key] : []),
                ],
              },
            },
      );
      rpc
        .call("setViewed", { id, stopId, path, viewed })
        .catch((cause: unknown) => toast.error(errorMessage(cause)));
    },
    [id, rpc, setData],
  );

  const onCommentChanged = useCallback(
    (commentId: string, next: DraftComment | null) => {
      setData((previousData) => {
        if (previousData === null) return previousData;
        const rest = previousData.comments.filter(
          (comment) => comment.id !== commentId,
        );
        const updated =
          next === null ? rest : [...rest, next].sort((a, b) => a.ord - b.ord);
        return { ...previousData, comments: updated };
      });
    },
    [setData],
  );

  if (id === null) {
    return (
      <EmptyStatePanel className="m-4">
        This tab has no walkthrough to show.
      </EmptyStatePanel>
    );
  }
  if (error !== null && data === null) {
    return (
      <EmptyStatePanel className="m-4">
        Could not load the walkthrough: {error}
      </EmptyStatePanel>
    );
  }
  if (walkthrough === null || current === null) {
    return (
      <EmptyStatePanel className="m-4">Loading walkthrough…</EmptyStatePanel>
    );
  }

  const counts = countComments(comments);
  const readOnly = walkthrough.status === "submitted";
  const stopComments = current.stop
    ? comments.filter((comment) => comment.stopId === current.stop!.id)
    : [];
  const stopCount = steps.filter((step) => step.kind === "stop").length;
  const firstStop = steps.find((step) => step.kind === "stop") ?? steps[0]!;
  const stopDiscussions = current.stop
    ? discussions.filter((discussion) => discussion.stopId === current.stop!.id)
    : [];
  const firstOfChapter =
    current.stop !== null && current.chapter!.stops[0]!.id === current.stop.id;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-4 pb-2 pt-3">
        <div className="flex items-start gap-2">
          <h1
            className="min-w-0 flex-1 truncate text-base font-semibold leading-6"
            title={walkthrough.title}
          >
            {walkthrough.title}
          </h1>
          <Hint label={diffStyle === "split" ? "Unified diff" : "Split diff"}>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1.5 -mt-0.5 size-7 shrink-0"
              aria-pressed={diffStyle === "split"}
              aria-label={
                diffStyle === "split" ? "Show unified diff" : "Show split diff"
              }
              onClick={() =>
                setDiffStyle((style) =>
                  style === "split" ? "unified" : "split",
                )
              }
            >
              <Icon name="Columns2" aria-hidden="true" />
            </Button>
          </Hint>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <TargetLine walkthrough={walkthrough} />
          <span className="inline-flex items-center gap-2">
            {counts.pending > 0 ? (
              <span className="font-medium text-foreground">
                {counts.pending} undecided
              </span>
            ) : null}
            <span>{counts.kept} kept</span>
            {counts.discarded > 0 ? (
              <span>{counts.discarded} discarded</span>
            ) : null}
          </span>
          {walkthrough.status !== "open" ? (
            <span className="rounded bg-secondary px-1.5 py-px text-secondary-foreground">
              {walkthrough.status === "submitted" ? "Posted" : "Sent to agent"}
            </span>
          ) : null}
        </div>
        <div className="mt-3">
          <Timeline
            steps={steps}
            currentId={current.id}
            doneStops={doneStops(walkthrough)}
            pendingByStop={pendingByStop(comments)}
            behind={behind}
            onSelect={goTo}
          />
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-4">
          {current.kind === "overview" && walkthrough.target.kind === "pr" ? (
            <OverviewStep
              walkthroughId={walkthrough.id}
              target={walkthrough.target}
              focus={walkthrough.focus}
              rpc={rpc}
            />
          ) : current.kind === "finish" ? (
            <>
              <h2 className="mb-1 text-lg font-semibold">Finish</h2>
              {walkthrough.focus ? (
                <Markdown
                  content={walkthrough.focus}
                  className="mb-4 text-sm text-muted-foreground"
                />
              ) : null}
              <FinishStep
                walkthrough={walkthrough}
                comments={comments}
                rpc={rpc}
                onJumpToComment={(comment) =>
                  goTo(comment.stopId || firstStop.id, comment.id)
                }
              />
            </>
          ) : current.stop !== null ? (
            <>
              {current.number === 1 &&
              walkthrough.target.kind !== "pr" &&
              walkthrough.focus ? (
                <Markdown
                  content={walkthrough.focus}
                  className="mb-4 text-sm text-muted-foreground"
                />
              ) : null}
              {firstOfChapter && current.chapter!.blurb ? (
                <Markdown
                  content={current.chapter!.blurb}
                  className="mb-3 text-sm text-muted-foreground"
                />
              ) : null}
              <StopCard
                stop={current.stop}
                label={`${current.chapter!.title} · Stop ${current.number} of ${stopCount}`}
                commentCount={stopComments.length}
                discussions={stopDiscussions.filter((d) => d.anchor === null)}
                walkthroughId={walkthrough.id}
                rpc={rpc}
                onDiscussionChanged={onDiscussionChanged}
              />
              <p className="mt-4 mb-2 text-xs text-muted-foreground">
                Hover a line and click{" "}
                <span className="font-medium text-foreground">+</span> to
                {readOnly
                  ? " ask the agent about it"
                  : " comment or ask the agent"}
                . Drag for a range.
              </p>
              <StopDiff
                key={current.stop.id}
                files={walkthrough.files}
                stopId={current.stop.id}
                hunkIds={current.stop.hunkIds}
                notes={current.stop.notes}
                comments={stopComments}
                discussions={stopDiscussions.filter((d) => d.anchor !== null)}
                walkthroughId={walkthrough.id}
                rpc={rpc}
                readOnly={readOnly}
                diffStyle={diffStyle}
                onCommentChanged={onCommentChanged}
                onDiscussionChanged={onDiscussionChanged}
                viewedPaths={viewedInStop(walkthrough, current.stop.id)}
                onViewedChange={(path, viewed) =>
                  setViewed(current.stop!.id, path, viewed)
                }
              />
            </>
          ) : null}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={previous === null}
          onClick={() => previous && goTo(previous.id)}
        >
          <Icon name="ChevronLeft" aria-hidden="true" />
          Back
        </Button>
        <div className="flex-1" />
        {following === null ? (
          <span className="w-[72px]" />
        ) : (
          <Hint
            label={`${following.id === FINISH ? "Finish" : "Next"} (j) · Back (k)`}
          >
            <Button size="sm" onClick={() => goTo(following.id)}>
              {following.id === FINISH ? "Finish" : "Next"}
              <Icon name="ChevronRight" aria-hidden="true" />
            </Button>
          </Hint>
        )}
      </footer>
      {error !== null ? (
        <p className="sr-only" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
    </div>
  );
}

function viewedInStop(
  walkthrough: Walkthrough,
  stopId: string,
): ReadonlySet<string> {
  const prefix = viewedKey(stopId, "");
  return new Set(
    (walkthrough.viewed ?? [])
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  );
}

function doneStops(walkthrough: Walkthrough): ReadonlySet<string> {
  const done = new Set<string>();
  for (const stop of walkthrough.chapters.flatMap((chapter) => chapter.stops)) {
    const paths = new Set(
      walkthrough.files
        .filter((file) =>
          file.hunks.some((hunk) => stop.hunkIds.includes(hunk.id)),
        )
        .map((f) => f.path),
    );
    const viewed = viewedInStop(walkthrough, stop.id);
    if (paths.size > 0 && [...paths].every((path) => viewed.has(path)))
      done.add(stop.id);
  }
  return done;
}

function pendingByStop(
  comments: readonly DraftComment[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const comment of comments) {
    if (comment.status === "pending")
      map.set(comment.stopId, (map.get(comment.stopId) ?? 0) + 1);
  }
  return map;
}
