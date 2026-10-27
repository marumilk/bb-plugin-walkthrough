// The head of a stop: what it is about, how closely to read it, and any
// private conversations about the stop as a whole.
import { useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Priority, ResolvedStop } from "../src/document";
import type { Discussion } from "../src/model";
import { CommentEditor } from "./CommentCard";
import { DiscussionCard } from "./DiscussionCard";
import { errorMessage, pluralize, type Rpc } from "./shared";

export function PriorityBadge({
  priority,
  className,
}: {
  priority: Priority;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        priority === "critical"
          ? "bg-destructive/15 text-destructive"
          : "bg-secondary text-secondary-foreground",
        className,
      )}
    >
      {priority === "critical" ? "Critical" : "Review"}
    </span>
  );
}

export function StopCard({
  stop,
  label,
  commentCount,
  discussions,
  walkthroughId,
  rpc,
  onDiscussionChanged,
}: {
  stop: ResolvedStop;
  label: string;
  commentCount: number;
  discussions: readonly Discussion[];
  walkthroughId: string;
  rpc: Rpc;
  onDiscussionChanged: (id: string, discussion: Discussion | null) => void;
}) {
  const [asking, setAsking] = useState(false);

  const ask = async (body: string) => {
    try {
      const result = await rpc.call("ask", {
        id: walkthroughId,
        body,
        target: { stopId: stop.id, commentId: null, anchor: null },
      });
      onDiscussionChanged(result.discussion.id, result.discussion);
      setAsking(false);
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };

  return (
    <section
      className={cn(
        "w-full rounded-lg border bg-card p-4",
        stop.priority === "critical"
          ? "border-destructive/40"
          : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <h2 className="mt-1 text-lg font-semibold leading-7">{stop.title}</h2>
        </div>
        <PriorityBadge priority={stop.priority} className="mt-0.5" />
      </div>
      {stop.prose ? (
        <Markdown content={stop.prose} className="mt-2 text-sm leading-6" />
      ) : null}

      {discussions.length > 0 ? (
        <div className="-mx-3 mt-2">
          {discussions.map((discussion) => (
            <DiscussionCard
              key={discussion.id}
              discussion={discussion}
              walkthroughId={walkthroughId}
              rpc={rpc}
              onChanged={(next) => onDiscussionChanged(discussion.id, next)}
            />
          ))}
        </div>
      ) : null}

      {asking ? (
        <div className="mt-3">
          <CommentEditor
            initial=""
            placeholder="Ask the agent about this stop…"
            label="Ask the agent"
            actions={[
              { label: "Ask agent", icon: "MessageQuestion", run: ask },
            ]}
            onCancel={() => setAsking(false)}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Private. Never posted.
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 text-muted-foreground"
            onClick={() => setAsking(true)}
          >
            <Icon name="MessageQuestion" aria-hidden="true" />
            Ask agent about this stop
          </Button>
          {commentCount > 0 ? (
            <span className="ml-auto">
              {pluralize(commentCount, "comment")} on this stop
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}
