// The walkthrough itself: one stop at a time, then a Finish step that posts
// the review or sends feedback to the agent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  UrlLink,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyStatePanel } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ResolvedChapter, ResolvedStop } from "../src/document";
import {
  countComments,
  describeTarget,
  type DraftComment,
  type Walkthrough,
} from "../src/model";
import { FinishStep } from "./FinishStep";
import { Hint } from "./Hint";
import { errorMessage, pluralize, useWalkthrough } from "./shared";
import { StopDiff } from "./StopDiff";

const FINISH = "finish";

interface Step {
  id: string;
  chapter: ResolvedChapter | null;
  stop: ResolvedStop | null;
  /** 1-based position among stops, for "Stop 3 of 9". */
  number: number;
}

function buildSteps(chapters: readonly ResolvedChapter[]): Step[] {
  const steps: Step[] = [];
  for (const chapter of chapters) {
    for (const stop of chapter.stops) {
      steps.push({ id: stop.id, chapter, stop, number: steps.length + 1 });
    }
  }
  steps.push({
    id: FINISH,
    chapter: null,
    stop: null,
    number: steps.length + 1,
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

function StepMenu({
  steps,
  current,
  comments,
  onSelect,
}: {
  steps: Step[];
  current: Step;
  comments: readonly DraftComment[];
  onSelect: (id: string) => void;
}) {
  const pendingByStop = useMemo(() => {
    const map = new Map<string, number>();
    for (const comment of comments) {
      if (comment.status === "pending")
        map.set(comment.stopId, (map.get(comment.stopId) ?? 0) + 1);
    }
    return map;
  }, [comments]);
  let lastChapter: string | null = null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 min-w-0 max-w-full justify-start gap-1.5 px-2"
        >
          <Icon name="ListView" aria-hidden="true" />
          <span className="truncate">
            {current.stop === null
              ? "Finish"
              : `${current.chapter!.title} · ${current.stop.title}`}
          </span>
          <Icon
            name="ChevronDown"
            className="size-3.5 shrink-0 opacity-60"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[70vh] w-80 overflow-y-auto"
      >
        {steps.map((step) => {
          const header =
            step.chapter !== null && step.chapter.id !== lastChapter ? (
              <DropdownMenuLabel
                key={`${step.chapter.id}-label`}
                className="text-xs text-muted-foreground"
              >
                {step.chapter.title}
              </DropdownMenuLabel>
            ) : null;
          if (step.chapter !== null) lastChapter = step.chapter.id;
          const pending = pendingByStop.get(step.id) ?? 0;
          return [
            step.stop === null ? (
              <DropdownMenuSeparator key="finish-separator" />
            ) : null,
            header,
            <DropdownMenuItem
              key={step.id}
              onSelect={() => onSelect(step.id)}
              className={cn(
                "gap-2",
                step.id === current.id && "bg-state-active",
              )}
            >
              <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {step.stop === null ? "" : step.number}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {step.stop?.title ?? "Finish and publish"}
              </span>
              {pending > 0 ? (
                <span className="shrink-0 rounded bg-secondary px-1.5 text-xs text-secondary-foreground">
                  {pending}
                </span>
              ) : null}
            </DropdownMenuItem>,
          ];
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WalkthroughTab({ params }: ExperimentalThreadActionTabProps) {
  const id = readId(params);
  const { rpc, data, setData, error } = useWalkthrough(id);
  const [stepId, setStepId] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<string | null>(null);

  const walkthrough = data?.walkthrough ?? null;
  const comments = data?.comments ?? [];
  const chapters = walkthrough?.chapters;
  const steps = useMemo(
    () => (chapters ? buildSteps(chapters) : []),
    [chapters],
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
  const stopCount = steps.length - 1;
  const firstOfChapter =
    current.stop !== null && current.chapter!.stops[0]!.id === current.stop.id;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-4 pb-2 pt-3">
        <h1
          className="truncate text-base font-semibold leading-6"
          title={walkthrough.title}
        >
          {walkthrough.title}
        </h1>
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
        <div className="mt-2 flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <StepMenu
              steps={steps}
              current={current}
              comments={comments}
              onSelect={goTo}
            />
          </div>
          <Hint label={diffStyle === "split" ? "Unified diff" : "Split diff"}>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
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
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-4">
          {current.stop === null ? (
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
                  goTo(comment.stopId || steps[0]!.id, comment.id)
                }
              />
            </>
          ) : (
            <>
              {current.number === 1 && walkthrough.focus ? (
                <Markdown
                  content={walkthrough.focus}
                  className="mb-4 text-sm text-muted-foreground"
                />
              ) : null}
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {current.chapter!.title} · Stop {current.number} of {stopCount}
              </p>
              {firstOfChapter && current.chapter!.blurb ? (
                <Markdown
                  content={current.chapter!.blurb}
                  className="mt-1 text-sm text-muted-foreground"
                />
              ) : null}
              <h2 className="mt-1 text-lg font-semibold leading-7">
                {current.stop.title}
              </h2>
              {current.stop.prose ? (
                <Markdown
                  content={current.stop.prose}
                  className="mt-1 text-sm leading-6"
                />
              ) : null}
              {stopComments.length > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {pluralize(stopComments.length, "comment")} on this stop
                </p>
              ) : null}
              <div className="mt-4">
                <StopDiff
                  key={current.stop.id}
                  files={walkthrough.files}
                  hunkIds={current.stop.hunkIds}
                  comments={stopComments}
                  walkthroughId={walkthrough.id}
                  rpc={rpc}
                  readOnly={readOnly}
                  diffStyle={diffStyle}
                  onCommentChanged={onCommentChanged}
                />
              </div>
              {readOnly ? null : (
                <p className="mt-3 text-xs text-muted-foreground">
                  Hover a line and click + to add your own comment. Drag across
                  line numbers for a range.
                </p>
              )}
            </>
          )}
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
        <div
          className="flex min-w-0 flex-1 justify-center gap-1"
          aria-hidden="true"
        >
          {steps.length <= 24
            ? steps.map((step) => (
                <span
                  key={step.id}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    step.id === current.id
                      ? "w-4 bg-foreground"
                      : "w-1.5 bg-border",
                  )}
                />
              ))
            : null}
        </div>
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
