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
import type { CommentStatus, DraftComment } from "../src/model";
import { errorMessage, type Rpc } from "./shared";

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  issue: "Issue",
  suggestion: "Suggestion",
  nit: "Nit",
  question: "Question",
  praise: "Praise",
};

function lineLabel(comment: Pick<DraftComment, "line" | "startLine">): string {
  return comment.startLine !== null && comment.startLine !== comment.line
    ? `Lines ${comment.startLine}–${comment.line}`
    : `Line ${comment.line}`;
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

function CommentEditor({
  initial,
  saveLabel,
  onSave,
  onCancel,
}: {
  initial: string;
  saveLabel: string;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = ref.current;
    if (textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);
  const save = () => {
    if (body.trim() === "" || saving) return;
    setSaving(true);
    onSave(body).finally(() => setSaving(false));
  };
  return (
    <div className="space-y-2">
      <Textarea
        ref={ref}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={editorKeys(save, onCancel)}
        rows={Math.min(12, Math.max(3, body.split("\n").length + 1))}
        aria-label="Comment"
        className="font-sans text-sm"
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={save}
          disabled={saving || body.trim() === ""}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

export function NewCommentCard({
  label,
  onSave,
  onCancel,
}: {
  label: string;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div className="mx-3 my-2 rounded-lg border border-border bg-card p-3 font-sans shadow-xs">
      <p className="mb-2 text-xs text-muted-foreground">
        New comment · {label}
      </p>
      <CommentEditor
        initial=""
        saveLabel="Add comment"
        onSave={onSave}
        onCancel={onCancel}
      />
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
}: {
  comment: DraftComment;
  walkthroughId: string;
  rpc: Rpc;
  readOnly: boolean;
  onChanged: (comment: DraftComment | null) => void;
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
          saveLabel={comment.status === "pending" ? "Save and keep" : "Save"}
          onSave={saveEdit}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Markdown
          content={comment.body}
          className="min-w-0 text-sm leading-6 text-foreground [&_pre]:max-w-full [&_pre]:overflow-x-auto"
        />
      )}

      {readOnly || editing ? null : (
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
        </div>
      )}
    </div>
  );
}
