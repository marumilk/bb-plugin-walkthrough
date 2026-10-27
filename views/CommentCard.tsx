// One draft or reviewer comment, rendered inline under its diff line.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Severity } from "../src/document";
import {
  isMultiLine,
  lineSpan,
  type CommentStatus,
  type DraftComment,
  type LineRange,
} from "../src/model";
import { errorMessage, type Rpc } from "./shared";

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  issue: "Issue",
  suggestion: "Suggestion",
  nit: "Nit",
  question: "Question",
  praise: "Praise",
};

/** "Line 15" or "Lines 13–15". */
export function lineLabel(range: LineRange): string {
  return `${isMultiLine(range) ? "Lines" : "Line"} ${lineSpan(range, "–")}`;
}

/** ⌘/Ctrl+Enter saves and Escape cancels, as in GitHub's comment boxes. */
function editorKeys(onSave: () => void, onCancel: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
}

export interface EditorAction {
  label: string;
  icon?: string;
  variant?: "default" | "outline";
  run: (body: string) => Promise<void>;
}

/**
 * A comment box. ⌘/Ctrl+Enter runs the last action; with `reset`, the box
 * empties after an action succeeds, for reply fields that stay open.
 */
export function CommentEditor({
  initial,
  actions,
  onCancel,
  placeholder,
  reset = false,
  autoFocus = true,
  label = "Comment",
}: {
  initial: string;
  actions: readonly EditorAction[];
  onCancel?: () => void;
  placeholder?: string;
  reset?: boolean;
  autoFocus?: boolean;
  label?: string;
}) {
  const [body, setBody] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = ref.current;
    if (textarea === null || !autoFocus) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [autoFocus]);
  const run = (action: EditorAction | undefined) => {
    if (action === undefined || body.trim() === "" || saving) return;
    setSaving(true);
    action
      .run(body)
      .then(() => {
        if (reset) setBody("");
      })
      .catch(() => {})
      .finally(() => setSaving(false));
  };
  const cancel = onCancel ?? (() => setBody(""));
  return (
    <div className="space-y-2">
      <Textarea
        ref={ref}
        value={body}
        placeholder={placeholder}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={editorKeys(() => run(actions.at(-1)), cancel)}
        rows={Math.min(
          12,
          Math.max(reset ? 2 : 3, body.split("\n").length + 1),
        )}
        aria-label={label}
        className="font-sans text-sm"
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {actions.map((action, index) => (
          <Button
            key={action.label}
            size="sm"
            variant={
              action.variant ??
              (index === actions.length - 1 ? "default" : "outline")
            }
            onClick={() => run(action)}
            disabled={saving || body.trim() === ""}
          >
            {action.icon ? (
              <Icon name={action.icon} aria-hidden="true" />
            ) : null}
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * The box the diff gutter opens. A reviewer can turn what they wrote into a
 * review comment, or ask the agent about those lines privately.
 */
export function NewCommentCard({
  label,
  askOnly,
  onComment,
  onAsk,
  onCancel,
}: {
  label: string;
  /** Only asking is possible, e.g. after the review is posted. */
  askOnly: boolean;
  onComment: (body: string) => Promise<void>;
  onAsk: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const ask: EditorAction = {
    label: "Ask agent",
    icon: "MessageQuestion",
    variant: "outline",
    run: onAsk,
  };
  return (
    <div className="mx-3 my-2 rounded-lg border border-border bg-card p-3 font-sans shadow-xs">
      <p className="mb-2 text-xs text-muted-foreground">
        {label} ·{" "}
        {askOnly
          ? "Ask the agent privately"
          : "Add a review comment, or ask the agent privately"}
      </p>
      <CommentEditor
        initial=""
        placeholder={
          askOnly ? "Ask about these lines…" : "Write a comment or a question…"
        }
        actions={
          askOnly
            ? [{ ...ask, variant: "default" }]
            : [ask, { label: "Add comment", run: onComment }]
        }
        onCancel={onCancel}
      />
      {askOnly ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          Questions to the agent stay private and are never posted.
        </p>
      )}
    </div>
  );
}

export function newCommentLabel(start: number, end: number): string {
  return lineLabel({ line: end, startLine: start === end ? null : start });
}

export function CommentCard({
  comment,
  walkthroughId,
  rpc,
  readOnly,
  onChanged,
  onAsk,
}: {
  comment: DraftComment;
  walkthroughId: string;
  rpc: Rpc;
  readOnly: boolean;
  onChanged: (comment: DraftComment | null) => void;
  /** Opens a private conversation with the agent about this comment. */
  onAsk: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const setStatus = (status: CommentStatus) => {
    setBusy(true);
    rpc
      .call("setCommentStatus", {
        id: walkthroughId,
        commentId: comment.id,
        status,
      })
      .then(
        (result) => onChanged(result.comment),
        (cause: unknown) => toast.error(errorMessage(cause)),
      )
      .finally(() => setBusy(false));
  };

  const saveEdit = async (body: string) => {
    try {
      const result = await rpc.call("editComment", {
        id: walkthroughId,
        commentId: comment.id,
        body,
      });
      onChanged(result.comment);
      setEditing(false);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  const remove = () => {
    setBusy(true);
    rpc
      .call("deleteComment", { id: walkthroughId, commentId: comment.id })
      .then(
        () => onChanged(null),
        (cause: unknown) => toast.error(errorMessage(cause)),
      )
      .finally(() => setBusy(false));
  };

  if (comment.status === "discarded" && !editing) {
    return (
      <div className="mx-3 my-2 flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 font-sans text-xs text-muted-foreground">
        <Icon name="EyeOff" className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          Discarded:{" "}
          <span className="line-through">{comment.body.split("\n")[0]}</span>
        </span>
        {readOnly ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => setStatus("pending")}
          >
            Restore
          </Button>
        )}
      </div>
    );
  }

  const fromAgent = comment.author === "agent";
  const edited = fromAgent && comment.body !== comment.originalBody;
  return (
    <div
      data-comment-id={comment.id}
      className={cn(
        "mx-3 my-2 rounded-lg border bg-card p-3 font-sans shadow-xs",
        comment.status === "pending"
          ? "border-l-[3px] border-border border-l-foreground/60"
          : "border-border",
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {comment.severity !== null ? (
          <span
            className={cn(
              "rounded px-1.5 py-px font-medium",
              comment.severity === "blocker"
                ? "bg-destructive/15 text-destructive"
                : "bg-secondary text-secondary-foreground",
            )}
          >
            {SEVERITY_LABEL[comment.severity]}
          </span>
        ) : null}
        <span>
          {fromAgent
            ? edited
              ? "Agent draft, edited"
              : "Agent draft"
            : "Your comment"}
        </span>
        <span aria-hidden="true">·</span>
        <span>{lineLabel(comment)}</span>
        {comment.status === "kept" ? (
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-foreground">
            <Icon name="Check" className="size-3.5" aria-hidden="true" />
            Will post
          </span>
        ) : null}
      </div>

      {editing ? (
        <CommentEditor
          initial={comment.body}
          actions={[
            {
              label: comment.status === "pending" ? "Save and keep" : "Save",
              run: saveEdit,
            },
          ]}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Markdown
          content={comment.body}
          className="min-w-0 text-sm leading-6 text-foreground [&_pre]:max-w-full [&_pre]:overflow-x-auto"
        />
      )}

      {editing ? null : readOnly ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <AskButton onAsk={onAsk} />
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {comment.status === "pending" ? (
            <>
              <Button
                size="sm"
                className="h-7"
                disabled={busy}
                onClick={() => setStatus("kept")}
              >
                <Icon name="Check" aria-hidden="true" />
                Keep
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                <Icon name="Edit" aria-hidden="true" />
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                disabled={busy}
                onClick={() => setStatus("discarded")}
              >
                <Icon name="X" aria-hidden="true" />
                Discard
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                <Icon name="Edit" aria-hidden="true" />
                Edit
              </Button>
              {fromAgent ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  disabled={busy}
                  onClick={() => setStatus("discarded")}
                >
                  <Icon name="X" aria-hidden="true" />
                  Discard
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  disabled={busy}
                  onClick={remove}
                >
                  <Icon name="Trash2" aria-hidden="true" />
                  Delete
                </Button>
              )}
              {edited ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-muted-foreground"
                  disabled={busy}
                  onClick={() => void saveEdit(comment.originalBody)}
                >
                  Revert edit
                </Button>
              ) : null}
            </>
          )}
          <AskButton onAsk={onAsk} />
        </div>
      )}
    </div>
  );
}

function AskButton({ onAsk }: { onAsk: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="ml-auto h-7 text-muted-foreground"
      onClick={onAsk}
    >
      <Icon name="MessageQuestion" aria-hidden="true" />
      Ask agent
    </Button>
  );
}
