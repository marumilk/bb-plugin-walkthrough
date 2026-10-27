// A private conversation with the agent, shown inline where it was started.
// Styled apart from review comments: it is never posted anywhere.
import { useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Discussion } from "../src/model";
import { CommentEditor } from "./CommentCard";
import { errorMessage, type Rpc } from "./shared";

/** Markdown with chat-like density: short line height and small block gaps. */
const COMPACT_PROSE =
  "min-w-0 text-sm leading-5 text-foreground [&_p]:mb-1.5 [&_ul]:mb-1.5 [&_ul]:pl-4 [&_ol]:mb-1.5 [&_ol]:pl-4 [&_li]:mb-0.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&>*:last-child]:mb-0";

function anchorLabel(discussion: Discussion): string {
  const anchor = discussion.anchor;
  if (anchor === null) return "This stop";
  return anchor.startLine !== null && anchor.startLine !== anchor.line
    ? `Lines ${anchor.startLine}–${anchor.line}`
    : `Line ${anchor.line}`;
}

export function DiscussionCard({
  discussion,
  walkthroughId,
  rpc,
  onChanged,
  className,
}: {
  discussion: Discussion;
  walkthroughId: string;
  rpc: Rpc;
  onChanged: (discussion: Discussion | null) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const waiting = discussion.waiting !== null;

  const setResolved = (resolved: boolean) => {
    setBusy(true);
    rpc
      .call("resolveDiscussion", {
        id: walkthroughId,
        discussionId: discussion.id,
        resolved,
      })
      .then(
        (result) => onChanged(result.discussion),
        (cause: unknown) => toast.error(errorMessage(cause)),
      )
      .finally(() => setBusy(false));
  };

  const remove = () => {
    setBusy(true);
    rpc
      .call("deleteDiscussion", {
        id: walkthroughId,
        discussionId: discussion.id,
      })
      .then(
        () => onChanged(null),
        (cause: unknown) => toast.error(errorMessage(cause)),
      )
      .finally(() => setBusy(false));
  };

  const reply = async (body: string) => {
    try {
      const result = await rpc.call("ask", {
        id: walkthroughId,
        discussionId: discussion.id,
        body,
      });
      onChanged(result.discussion);
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };

  if (discussion.resolved) {
    const first = discussion.messages[0]?.body.split("\n")[0] ?? "";
    return (
      <div
        className={cn(
          "mx-3 my-2 flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 font-sans text-xs text-muted-foreground",
          className,
        )}
      >
        <Icon
          name="MessageQuestion"
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">Resolved: {first}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => setResolved(false)}
        >
          Reopen
        </Button>
      </div>
    );
  }

  return (
    <div
      data-discussion-id={discussion.id}
      className={cn(
        "mx-3 my-2 rounded-lg border border-dashed border-border bg-secondary/40 p-3 font-sans",
        className,
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Icon name="Lock" className="size-3.5" aria-hidden="true" />
          Private
        </span>
        <span aria-hidden="true">·</span>
        <span>Conversation with the agent</span>
        <span aria-hidden="true">·</span>
        <span>{anchorLabel(discussion)}</span>
        <span className="ml-auto inline-flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => setResolved(true)}
          >
            Resolve
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={remove}
          >
            Delete
          </Button>
        </span>
      </div>

      <ol className="space-y-2">
        {discussion.messages.map((message) => (
          <li key={message.id}>
            <p className="text-xs font-medium text-muted-foreground">
              {message.author === "you" ? "You" : "Agent"}
            </p>
            <Markdown content={message.body} className={COMPACT_PROSE} />
          </li>
        ))}
      </ol>

      {waiting ? (
        <p
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
        >
          <Icon
            name="Loading"
            className="size-3.5 animate-spin"
            aria-hidden="true"
          />
          The agent is answering in its thread…
        </p>
      ) : discussion.error !== null ? (
        <p
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-destructive"
          role="alert"
        >
          <Icon name="AlertCircle" className="size-3.5" aria-hidden="true" />
          {discussion.error} Ask again below.
        </p>
      ) : null}

      {waiting ? null : (
        <div className="mt-3">
          <CommentEditor
            initial=""
            reset
            autoFocus={false}
            label="Reply to the agent"
            placeholder="Reply to the agent…"
            actions={[{ label: "Send", icon: "Sent", run: reply }]}
          />
        </div>
      )}
    </div>
  );
}
