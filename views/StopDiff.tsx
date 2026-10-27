// The hunks of one stop, file by file, with review comments and private
// conversations inline under their lines. bb's own diff component has no
// annotation slot, so this renders through the host-shimmed @pierre/diffs
// directly and borrows bb's code theme.
import { Fragment, memo, useMemo, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import {
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  renderFilePatch,
  type DiffFile,
  type DiffHunk,
  type Side,
} from "../src/diff";
import type { Discussion, DraftComment } from "../src/model";
import { CommentCard, newCommentLabel, NewCommentCard } from "./CommentCard";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { DiscussionCard } from "./DiscussionCard";
import { errorMessage, type Rpc } from "./shared";

/** An open comment box: on a gutter range, or under a comment to ask about it. */
interface Composer {
  path: string;
  side: Side;
  start: number;
  end: number;
  /** Set when asking about an existing comment; only asking is offered. */
  commentId: string | null;
}

type Annotation =
  | { kind: "comment"; comment: DraftComment }
  | { kind: "discussion"; discussion: Discussion }
  | { kind: "composer"; composer: Composer };

function useDiffTheme() {
  const { mode } = useCodeTheme();
  // bb publishes the active code themes on the root element for renderers
  // like this one; Pierre ships the same theme names.
  const dark = document.documentElement.dataset.bbCodeThemeDark;
  const light = document.documentElement.dataset.bbCodeThemeLight;
  return {
    theme: dark && light ? { dark, light } : undefined,
    themeType: mode,
  };
}

const FIT_TO_PANEL = `pre, [data-code] {
  --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
}`;

function toSide(side: SelectedLineRange["side"]): Side {
  return side === "deletions" ? "LEFT" : "RIGHT";
}

function annotationSide(side: Side): "deletions" | "additions" {
  return side === "LEFT" ? "deletions" : "additions";
}

const FileBlock = memo(function FileBlock({
  file,
  hunks,
  stopId,
  comments,
  discussions,
  composer,
  walkthroughId,
  rpc,
  readOnly,
  diffStyle,
  onComposer,
  onCommentChanged,
  onDiscussionChanged,
  viewed,
  onViewedChange,
}: {
  file: DiffFile;
  hunks: DiffHunk[];
  stopId: string;
  comments: DraftComment[];
  discussions: Discussion[];
  composer: Composer | null;
  walkthroughId: string;
  rpc: Rpc;
  readOnly: boolean;
  diffStyle: "unified" | "split";
  onComposer: (composer: Composer | null) => void;
  onCommentChanged: (id: string, comment: DraftComment | null) => void;
  onDiscussionChanged: (id: string, discussion: Discussion | null) => void;
  viewed: boolean;
  onViewedChange: (viewed: boolean) => void;
}) {
  const { theme, themeType } = useDiffTheme();
  // Viewed files collapse; the reviewer can open one again without
  // unchecking it. Checking Viewed always collapses.
  const [reopened, setReopened] = useState(false);
  const collapsed = viewed && !reopened;
  const fileDiff = useMemo<FileDiffMetadata | undefined>(
    () => parsePatchFiles(renderFilePatch(file, hunks))[0]?.files[0],
    [file, hunks],
  );

  // At one line: each comment, then the conversations about it, then any
  // other conversations, then an open composer.
  const annotations = useMemo(() => {
    const list: DiffLineAnnotation<Annotation>[] = [];
    const about = (commentId: string) =>
      discussions.filter((d) => d.commentId === commentId);
    for (const comment of comments) {
      const side = annotationSide(comment.side);
      list.push({
        side,
        lineNumber: comment.line,
        metadata: { kind: "comment", comment },
      });
      for (const discussion of about(comment.id)) {
        list.push({
          side,
          lineNumber: comment.line,
          metadata: { kind: "discussion", discussion },
        });
      }
      if (composer?.commentId === comment.id) {
        list.push({
          side,
          lineNumber: comment.line,
          metadata: { kind: "composer", composer },
        });
      }
    }
    const shownWithComment = new Set(comments.map((comment) => comment.id));
    for (const discussion of discussions) {
      if (discussion.anchor === null) continue;
      if (
        discussion.commentId !== null &&
        shownWithComment.has(discussion.commentId)
      )
        continue;
      list.push({
        side: annotationSide(discussion.anchor.side),
        lineNumber: discussion.anchor.line,
        metadata: { kind: "discussion", discussion },
      });
    }
    if (composer !== null && composer.commentId === null) {
      list.push({
        side: annotationSide(composer.side),
        lineNumber: composer.end,
        metadata: { kind: "composer", composer },
      });
    }
    return list;
  }, [comments, discussions, composer]);

  if (fileDiff === undefined) return null;

  const addComment = async (draft: Composer, body: string) => {
    try {
      const result = await rpc.call("addComment", {
        id: walkthroughId,
        path: draft.path,
        side: draft.side,
        line: draft.end,
        startLine: draft.start === draft.end ? null : draft.start,
        body,
      });
      onCommentChanged(result.comment.id, result.comment);
      onComposer(null);
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };

  const ask = async (draft: Composer, body: string) => {
    try {
      const result = await rpc.call("ask", {
        id: walkthroughId,
        body,
        target: {
          stopId,
          commentId: draft.commentId,
          anchor: {
            path: draft.path,
            side: draft.side,
            line: draft.end,
            startLine: draft.start === draft.end ? null : draft.start,
          },
        },
      });
      onDiscussionChanged(result.discussion.id, result.discussion);
      onComposer(null);
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <FileDiff<Annotation>
        fileDiff={fileDiff}
        lineAnnotations={annotations}
        options={{
          ...(theme ? { theme } : {}),
          themeType,
          diffStyle,
          overflow: "wrap",
          // Wrapped code must never grow wider than the panel, even when a
          // comment below a line holds something wide like a code block.
          unsafeCSS: FIT_TO_PANEL,
          hunkSeparators: "line-info",
          lineDiffType: "word",
          collapsed,
          // Asking the agent stays possible after the review is posted.
          enableGutterUtility: true,
          onGutterUtilityClick: (range) => {
            onComposer({
              path: file.path,
              side: toSide(range.endSide ?? range.side),
              start: Math.min(range.start, range.end),
              end: Math.max(range.start, range.end),
              commentId: null,
            });
          },
        }}
        renderHeaderPrefix={() =>
          viewed ? (
            <button
              type="button"
              className="mr-1 inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
              aria-label={collapsed ? `Show ${file.path}` : `Hide ${file.path}`}
              aria-expanded={!collapsed}
              onClick={() => setReopened((open) => !open)}
            >
              <Icon
                name={collapsed ? "ChevronRight" : "ChevronDown"}
                className="size-4"
                aria-hidden="true"
              />
            </button>
          ) : null
        }
        renderHeaderMetadata={() => (
          <label className="ml-2 inline-flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-2 font-sans text-xs leading-none text-muted-foreground hover:bg-state-hover hover:text-foreground">
            <Checkbox
              className="size-3 rounded-[3px] [&_[data-icon-root]]:size-2.5"
              checked={viewed}
              onCheckedChange={(checked) => {
                setReopened(false);
                onViewedChange(checked === true);
              }}
              aria-label={`Mark ${file.path} viewed`}
            />
            Viewed
          </label>
        )}
        renderAnnotation={(annotation) => (
          // Annotations inherit the wrapped diff's `white-space: pre-wrap`,
          // which turns every newline in rendered Markdown into a blank line.
          <div className="whitespace-normal">
            {renderCard(annotation.metadata)}
          </div>
        )}
      />
    </div>
  );

  function renderCard(data: Annotation) {
    if (data.kind === "composer") {
      const draft = data.composer;
      return (
        <NewCommentCard
          label={newCommentLabel(draft.start, draft.end)}
          askOnly={readOnly || draft.commentId !== null}
          onCancel={() => onComposer(null)}
          onComment={(body) => addComment(draft, body)}
          onAsk={(body) => ask(draft, body)}
        />
      );
    }
    if (data.kind === "discussion") {
      return (
        <DiscussionCard
          discussion={data.discussion}
          walkthroughId={walkthroughId}
          rpc={rpc}
          onChanged={(next) => onDiscussionChanged(data.discussion.id, next)}
        />
      );
    }
    const comment = data.comment;
    return (
      <CommentCard
        comment={comment}
        walkthroughId={walkthroughId}
        rpc={rpc}
        readOnly={readOnly}
        onChanged={(next) => onCommentChanged(comment.id, next)}
        onAsk={() =>
          onComposer({
            path: comment.path,
            side: comment.side,
            start: comment.startLine ?? comment.line,
            end: comment.line,
            commentId: comment.id,
          })
        }
      />
    );
  }
});

export function StopDiff({
  viewedPaths,
  onViewedChange,
  files,
  stopId,
  hunkIds,
  notes,
  comments,
  discussions,
  walkthroughId,
  rpc,
  readOnly,
  diffStyle,
  onCommentChanged,
  onDiscussionChanged,
}: {
  files: readonly DiffFile[];
  stopId: string;
  hunkIds: readonly string[];
  /** The agent's asides, shown as quotes above the file they are about. */
  notes: readonly { hunkId: string; body: string }[];
  comments: readonly DraftComment[];
  discussions: readonly Discussion[];
  walkthroughId: string;
  rpc: Rpc;
  readOnly: boolean;
  diffStyle: "unified" | "split";
  onCommentChanged: (id: string, comment: DraftComment | null) => void;
  onDiscussionChanged: (id: string, discussion: Discussion | null) => void;
  /** Paths marked Viewed in this stop. */
  viewedPaths: ReadonlySet<string>;
  onViewedChange: (path: string, viewed: boolean) => void;
}) {
  const [composer, setComposer] = useState<Composer | null>(null);

  // Group the stop's hunks by file, keeping the order the agent chose for
  // files and the patch order within each file.
  const groups = useMemo(() => {
    const wanted = new Set(hunkIds);
    const order: string[] = [];
    for (const id of hunkIds) {
      const path = files.find((file) =>
        file.hunks.some((hunk) => hunk.id === id),
      )?.path;
      if (path !== undefined && !order.includes(path)) order.push(path);
    }
    return order.map((path) => {
      const file = files.find((candidate) => candidate.path === path)!;
      return { file, hunks: file.hunks.filter((hunk) => wanted.has(hunk.id)) };
    });
  }, [files, hunkIds]);

  return (
    <div className="space-y-4">
      {groups.map(({ file, hunks }) => {
        const ids = new Set(hunks.map((hunk) => hunk.id));
        const fileNotes = notes.filter((note) => ids.has(note.hunkId));
        return (
          <Fragment key={file.path}>
            {fileNotes.map((note) => (
              <NoteQuote key={note.hunkId} body={note.body} />
            ))}
            <FileBlock
              file={file}
              hunks={hunks}
              stopId={stopId}
              comments={comments.filter(
                (comment) =>
                  comment.path === file.path && ids.has(comment.hunkId),
              )}
              discussions={discussions.filter(
                (discussion) =>
                  discussion.anchor?.path === file.path &&
                  ids.has(discussion.anchor.hunkId),
              )}
              composer={composer?.path === file.path ? composer : null}
              walkthroughId={walkthroughId}
              rpc={rpc}
              readOnly={readOnly}
              diffStyle={diffStyle}
              onComposer={setComposer}
              onCommentChanged={onCommentChanged}
              onDiscussionChanged={onDiscussionChanged}
              viewed={viewedPaths.has(file.path)}
              onViewedChange={(viewed) => onViewedChange(file.path, viewed)}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

/** An aside from the agent between files, set off like a block quote. */
function NoteQuote({ body }: { body: string }) {
  return (
    <aside className="rounded-r-lg border-l-[3px] border-foreground/40 bg-secondary/40 px-4 py-2.5">
      <Markdown
        content={body}
        className="min-w-0 text-sm leading-6 text-foreground"
      />
    </aside>
  );
}
