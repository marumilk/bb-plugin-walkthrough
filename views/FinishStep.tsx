// The last step: write the summary, pick a verdict, and publish.
import { useEffect, useRef, useState } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Verdict } from "../src/document";
import {
  countComments,
  type DraftComment,
  type Walkthrough,
} from "../src/model";
import { keptComments, reviewBlockers, summaryBasis } from "../src/submission";
import { errorMessage, pluralize, type Rpc } from "./shared";

const VERDICTS: { value: Verdict; label: string; hint: string }[] = [
  { value: "COMMENT", label: "Comment", hint: "No verdict" },
  { value: "APPROVE", label: "Approve", hint: "Ready to merge" },
  {
    value: "REQUEST_CHANGES",
    label: "Request changes",
    hint: "Blocks merging",
  },
];

export function FinishStep({
  walkthrough,
  comments,
  rpc,
  onJumpToComment,
}: {
  walkthrough: Walkthrough;
  comments: readonly DraftComment[];
  rpc: Rpc;
  onJumpToComment: (comment: DraftComment) => void;
}) {
  const isPr = walkthrough.target.kind === "pr";
  const readOnly = walkthrough.status === "submitted";
  const [summary, setSummary] = useState(walkthrough.summary);
  const [verdict, setVerdict] = useState<Verdict>(walkthrough.verdict);
  const [submitting, setSubmitting] = useState(false);
  const [headMoved, setHeadMoved] = useState(false);
  const saved = useRef({
    summary: walkthrough.summary,
    verdict: walkthrough.verdict,
  });
  const rewriting = Boolean(walkthrough.summaryJob);

  // Take summaries written elsewhere (the agent's rewrite, an undo) unless
  // the reviewer has unsaved typing in the box.
  useEffect(() => {
    if (walkthrough.summary === saved.current.summary) return;
    setSummary((local) =>
      local === saved.current.summary ? walkthrough.summary : local,
    );
    saved.current = { ...saved.current, summary: walkthrough.summary };
  }, [walkthrough.summary]);

  useEffect(() => {
    if (!isPr || readOnly) return;
    rpc.call("headStatus", { id: walkthrough.id }).then(
      (result) => setHeadMoved(result.moved),
      () => {},
    );
  }, [rpc, walkthrough.id, isPr, readOnly]);

  const persist = async (next: { summary: string; verdict: Verdict }) => {
    if (
      next.summary === saved.current.summary &&
      next.verdict === saved.current.verdict
    )
      return;
    await rpc.call("setReview", { id: walkthrough.id, ...next });
    saved.current = next;
  };

  // Save the summary shortly after typing stops, so nothing is lost when the
  // tab closes before Submit.
  useEffect(() => {
    if (readOnly) return;
    const timer = setTimeout(() => {
      persist({ summary, verdict }).catch((cause: unknown) =>
        toast.error(errorMessage(cause)),
      );
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, verdict, readOnly]);

  const counts = countComments(comments);
  const kept = keptComments(comments).sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line,
  );
  const pending = comments.filter((comment) => comment.status === "pending");
  const blockers = isPr
    ? reviewBlockers({ ...walkthrough, summary, verdict }, comments)
    : [];
  const localEmpty = !isPr && kept.length === 0 && summary.trim() === "";

  const summaryStale =
    isPr &&
    kept.length > 0 &&
    walkthrough.summaryBasis !== summaryBasis(comments);

  const rewrite = async () => {
    try {
      // The agent reads the saved summary, so save any typing first.
      await persist({ summary, verdict });
      await rpc.call("rewriteSummary", { id: walkthrough.id });
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  const undoRewrite = () => {
    rpc
      .call("undoSummaryRewrite", { id: walkthrough.id })
      .catch((cause: unknown) => toast.error(errorMessage(cause)));
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      await persist({ summary, verdict });
      const result = await rpc.call("submit", { id: walkthrough.id });
      toast.success(
        isPr ? "Review posted to GitHub" : "Feedback sent to the agent",
      );
      if (result.url) window.open(result.url, "_blank", "noopener");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  if (walkthrough.status !== "open") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon name="CircleCheck" className="size-4" aria-hidden="true" />
          {walkthrough.status === "submitted"
            ? "Review posted to GitHub"
            : "Feedback sent to the agent"}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {pluralize(kept.length, "comment")}
          {walkthrough.status === "submitted"
            ? ` · ${VERDICTS.find((v) => v.value === walkthrough.verdict)?.label}`
            : ""}
        </p>
        {walkthrough.submittedUrl ? (
          <UrlLink
            href={walkthrough.submittedUrl}
            className="mt-2 inline-block text-sm"
          >
            Open on GitHub
          </UrlLink>
        ) : null}
        {walkthrough.status === "sent" ? (
          <p className="mt-2 text-xs text-muted-foreground">
            You can keep refining comments and send again; the agent gets the
            full list each time.
          </p>
        ) : null}
        {walkthrough.status === "sent" ? (
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            disabled={submitting}
            onClick={submit}
          >
            Send again
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="walkthrough-summary"
            className="mr-auto text-sm font-medium"
          >
            {isPr ? "Review summary" : "Overall note for the agent"}
          </label>
          {isPr && walkthrough.previousSummary != null && !rewriting ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              onClick={undoRewrite}
            >
              Undo rewrite
            </Button>
          ) : null}
          {isPr ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={rewriting}
              onClick={() => void rewrite()}
            >
              <Icon
                name={rewriting ? "Loading" : "AiContentGenerator01"}
                className={cn(rewriting && "animate-spin")}
                aria-hidden="true"
              />
              {rewriting ? "Rewriting…" : "Rewrite with agent"}
            </Button>
          ) : null}
        </div>
        {rewriting ? (
          <p className="text-xs text-muted-foreground" role="status">
            The agent is rewriting the summary from your{" "}
            {pluralize(kept.length, "kept comment")} in its thread.
          </p>
        ) : walkthrough.summaryError ? (
          <p className="text-xs text-destructive" role="alert">
            {walkthrough.summaryError}
          </p>
        ) : summaryStale ? (
          <p className="text-xs text-muted-foreground">
            Your comments changed since this summary was written. Rewrite it to
            match what you are posting.
          </p>
        ) : null}
        <Textarea
          id="walkthrough-summary"
          disabled={rewriting}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          rows={Math.min(14, Math.max(4, summary.split("\n").length + 1))}
          placeholder={isPr ? "Optional for Comment and Approve" : "Optional"}
          className="font-sans text-sm"
        />
      </section>

      {isPr ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Verdict</legend>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
            {VERDICTS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={verdict === option.value}
                onClick={() => setVerdict(option.value)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  verdict === option.value
                    ? "border-foreground bg-state-active"
                    : "border-border hover:bg-state-hover",
                )}
              >
                <span className="block text-sm font-medium">
                  {option.label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {option.hint}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">
          {isPr ? "Comments to post" : "Comments to send"} ({kept.length})
        </h3>
        {kept.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments kept yet.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {kept.map((comment) => (
              <li key={comment.id}>
                <button
                  type="button"
                  onClick={() => onJumpToComment(comment)}
                  className="flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-state-hover"
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {comment.path.split("/").pop()}:{comment.line}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {comment.body.split("\n")[0]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pending.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
          <Icon
            name="AlertCircle"
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            {pluralize(pending.length, "draft")} still undecided.{" "}
            {isPr ? "They won't be posted." : "They won't be sent."}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0"
            onClick={() => onJumpToComment(pending[0]!)}
          >
            Review them
          </Button>
        </div>
      ) : null}

      {headMoved ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
          <Icon
            name="AlertTriangle"
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div>
            The pull request has new commits since this walkthrough. Comments
            still post against the commit you reviewed; GitHub marks any whose
            lines changed as outdated.
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {blockers.length > 0 ? (
          <p className="mr-auto text-xs text-muted-foreground">{blockers[0]}</p>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {counts.discarded > 0 ? `${counts.discarded} discarded` : null}
        </span>
        <Button
          onClick={submit}
          disabled={submitting || blockers.length > 0 || localEmpty}
        >
          <Icon name={isPr ? "Sent" : "MessageSquare"} aria-hidden="true" />
          {submitting
            ? isPr
              ? "Posting…"
              : "Sending…"
            : isPr
              ? `Post review${kept.length > 0 ? ` with ${pluralize(kept.length, "comment")}` : ""}`
              : `Send ${pluralize(kept.length, "comment")} to the agent`}
        </Button>
      </div>
    </div>
  );
}
