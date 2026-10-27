// The walkthrough as a row of steps under the PR details: one node per stop,
// grouped by chapter, from the PR description to Finish. Every node is a
// button, so the timeline is also the way to jump around.
import { Fragment, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ResolvedChapter, ResolvedStop } from "../src/document";
import { CHAPTER_ICONS, inferChapterIcon } from "../src/icons";
import { Hint } from "./Hint";
import { pluralize } from "./shared";

export interface TimelineStep {
  id: string;
  kind: "overview" | "stop" | "finish";
  chapter: ResolvedChapter | null;
  stop: ResolvedStop | null;
  /** 1-based position among stops, for "Stop 3 of 9". */
  number: number;
}

/** How far the PR has moved since the walkthrough's snapshot. */
export interface HeadStatus {
  moved: boolean;
  /** Commits the PR gained; null for local changes. */
  behindBy: number | null;
  /** The branch was rewritten (force-pushed). */
  diverged: boolean;
}

/** Node icons take the node's colour; host icon tints would hide them. */
const NODE_ICON = { color: "inherit" } as const;

function chapterIcon(chapter: ResolvedChapter): string {
  return CHAPTER_ICONS[chapter.icon ?? inferChapterIcon(chapter.title)];
}

function GroupLabel({ icon, title }: { icon: string; title: string }) {
  return (
    <Hint label={title.length > 14 ? title : undefined}>
      <span className="flex h-4 max-w-[9rem] items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon name={icon} className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{title}</span>
      </span>
    </Hint>
  );
}

/**
 * A line between two circles, inset a little from each. Lines leaving a
 * chapter stretch to reach the next chapter's first circle.
 */
function Connector({
  dashed = false,
  stretch = false,
}: {
  dashed?: boolean;
  stretch?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mx-1 self-center border-t-2",
        stretch ? "min-w-5 flex-1" : "w-3 shrink-0",
        dashed ? "border-dashed border-border" : "border-border",
      )}
    />
  );
}

function Node({
  label,
  current,
  done,
  critical,
  pending,
  onSelect,
  children,
}: {
  label: string;
  current: boolean;
  done: boolean;
  critical: boolean;
  pending: number;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        onClick={onSelect}
        aria-label={label}
        aria-current={current ? "step" : undefined}
        data-step-current={current ? "" : undefined}
        className={cn(
          "relative inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          current
            ? "bg-primary text-primary-foreground ring-4 ring-primary/25"
            : done
              ? "bg-success text-background hover:opacity-90"
              : "border border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
          // A dashed red ring marks the stops to read closely.
          critical &&
            "outline outline-2 outline-offset-2 outline-dashed outline-destructive",
        )}
      >
        {children}
        {pending > 0 && !current ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-foreground ring-2 ring-background"
          />
        ) : null}
      </button>
    </Hint>
  );
}

function BehindBadge({ status }: { status: HeadStatus }) {
  if (status.behindBy === null) return null;
  if (status.behindBy === 0 && !status.diverged) {
    return (
      <Hint label="The pull request has no commits since this walkthrough was made.">
        <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-[11px] text-muted-foreground">
          <Icon name="Check" className="size-3" aria-hidden="true" />
          Up to date
        </span>
      </Hint>
    );
  }
  const text = status.diverged
    ? "Branch rewritten"
    : `${status.behindBy} commit${status.behindBy === 1 ? "" : "s"} behind`;
  const hint = status.diverged
    ? "The branch was force-pushed since this walkthrough was made. Ask the agent for a fresh walkthrough."
    : `The pull request has ${pluralize(status.behindBy, "new commit")} since this walkthrough was made. ` +
      "Comments still post against the commit you reviewed.";
  return (
    <Hint label={hint}>
      <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-warning/50 px-2 text-[11px] font-medium text-warning">
        <Icon name="GitBranch" className="size-3" aria-hidden="true" />
        {text}
      </span>
    </Hint>
  );
}

export function Timeline({
  steps,
  currentId,
  doneStops,
  pendingByStop,
  behind,
  onSelect,
}: {
  steps: readonly TimelineStep[];
  currentId: string;
  doneStops: ReadonlySet<string>;
  pendingByStop: ReadonlyMap<string, number>;
  behind: HeadStatus | null;
  onSelect: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the current step in view as the reviewer moves through.
  useEffect(() => {
    scrollRef.current?.querySelector("[data-step-current]")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [currentId]);

  // Consecutive stops of one chapter form a group under its label.
  const groups: {
    key: string;
    icon: string;
    title: string;
    steps: TimelineStep[];
  }[] = [];
  for (const step of steps) {
    const key = step.kind === "stop" ? step.chapter!.id : step.kind;
    const last = groups.at(-1);
    if (last?.key === key) {
      last.steps.push(step);
      continue;
    }
    groups.push({
      key,
      icon:
        step.kind === "overview"
          ? "FileText"
          : step.kind === "finish"
            ? "Sent"
            : chapterIcon(step.chapter!),
      title:
        step.kind === "overview"
          ? "PR"
          : step.kind === "finish"
            ? "Finish"
            : step.chapter!.title,
      steps: [step],
    });
  }

  const nodeFor = (step: TimelineStep) => {
    const current = step.id === currentId;
    if (step.kind === "overview") {
      return (
        <Node
          key={step.id}
          label="Pull request description"
          current={current}
          done={false}
          critical={false}
          pending={0}
          onSelect={() => onSelect(step.id)}
        >
          <Icon
            name="FileText"
            className="size-3.5"
            style={NODE_ICON}
            aria-hidden="true"
          />
        </Node>
      );
    }
    if (step.kind === "finish") {
      return (
        <Node
          key={step.id}
          label="Finish and publish"
          current={current}
          done={false}
          critical={false}
          pending={0}
          onSelect={() => onSelect(step.id)}
        >
          <Icon
            name="Sent"
            className="size-3.5"
            style={NODE_ICON}
            aria-hidden="true"
          />
        </Node>
      );
    }
    const stop = step.stop!;
    const done = doneStops.has(step.id);
    const pending = pendingByStop.get(step.id) ?? 0;
    const label = [
      `Stop ${step.number}: ${stop.title}`,
      stop.priority === "critical" ? "Critical" : null,
      pending > 0 ? pluralize(pending, "undecided draft") : null,
      done ? "Viewed" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <Node
        key={step.id}
        label={label}
        current={current}
        done={done}
        critical={stop.priority === "critical"}
        pending={pending}
        onSelect={() => onSelect(step.id)}
      >
        {done && !current ? (
          <Icon
            name="Check"
            className="size-3.5"
            style={NODE_ICON}
            aria-hidden="true"
          />
        ) : (
          step.number
        )}
      </Node>
    );
  };

  return (
    <nav
      aria-label="Walkthrough steps"
      ref={scrollRef}
      className="-mx-1 overflow-x-auto px-1 pb-1 pt-1"
    >
      <div className="flex w-max items-end">
        {behind !== null && behind.behindBy !== null ? (
          <div className="mr-3 flex h-7 items-center self-end">
            <BehindBadge status={behind} />
          </div>
        ) : null}
        {groups.map((group, index) => {
          const next = groups[index + 1];
          return (
            <div key={group.key} className="flex flex-col gap-2">
              {/* Right padding keeps labels apart; the line below fills it. */}
              <div className="pr-5">
                <GroupLabel icon={group.icon} title={group.title} />
              </div>
              <div className="flex items-center">
                {group.steps.map((step, stepIndex) => (
                  <Fragment key={step.id}>
                    {stepIndex > 0 ? <Connector /> : null}
                    {nodeFor(step)}
                  </Fragment>
                ))}
                {next !== undefined ? (
                  <Connector stretch dashed={next.key === "finish"} />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
