// The hunks of one stop, file by file, with review comments and private
// conversations inline under their lines. bb's own diff component has no
// annotation slot, so this renders through the host-shimmed @pierre/diffs
// directly and borrows bb's code theme.
import { Fragment, memo, useEffect, useMemo, useState } from "react";
import {
  Markdown,
  UrlLink,
  experimental_useCodeTheme as useCodeTheme,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import {
  parsePatchFiles,
  processFile,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import {
  findHunkForRange,
  firstChangedLine,
  renderFilePatch,
  type DiffFile,
  type DiffHunk,
  type Side,
} from "../src/diff";
import {
  githubFileUrl,
  type Discussion,
  type DraftComment,
  type FileLinks,
  type FileVersions,
} from "../src/model";
import { CommentCard, newCommentLabel, NewCommentCard } from "./CommentCard";
import { DiscussionCard } from "./DiscussionCard";
import { Hint } from "./Hint";
import { errorMessage, useFileVersions, type Rpc } from "./shared";

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

// The header's file name is plain text, and bb's copy of Pierre has no slot
// after it. So FileName draws a linked name in the prefix slot, the slot's
// wrapper steps out of the layout, and `order` puts the name back after
// Pierre's change icon and rename arrow (FILE_NAME_ORDER and up).
const LINKED_FILE_NAME = `[data-header-content] [data-title] {
  display: none;
}
::slotted([slot="header-prefix"]) {
  display: contents;
}
[data-change-icon] { order: 1; }
[data-prev-name] { order: 2; }
[data-rename-icon] { order: 3; }`;
const FILE_NAME_ORDER = 4;

function toSide(side: SelectedLineRange["side"]): Side {
  return side === "deletions" ? "LEFT" : "RIGHT";
}

function annotationSide(side: Side): "deletions" | "additions" {
  return side === "LEFT" ? "deletions" : "additions";
}

/**
 * The diff Pierre draws. With both versions of the file, its unchanged lines
 * can expand, but only when every hunk in view is every hunk in the file: a
 * hidden hunk would otherwise expand as unchanged lines. A stop that shows
 * part of a file expands by showing the whole file.
 */
function buildFileDiff(
  file: DiffFile,
  hunks: readonly DiffHunk[],
  versions: FileVersions | null,
): FileDiffMetadata | undefined {
  const patch = renderFilePatch(file, hunks);
  if (versions === null || hunks.length !== file.hunks.length)
    return parsePatchFiles(patch)[0]?.files[0];
  return processFile(patch, {
    isGitDiff: true,
    oldFile: { name: file.previousPath ?? file.path, contents: versions.old },
    newFile: { name: file.path, contents: versions.new },
  });
}

/**
 * Props are unchanged when every value is, comparing arrays item by item.
 * The comment lists are filtered afresh on each render, but their items keep
 * their identity until they change (see `keepStableParts`), so a realtime
 * refresh only re-renders the files whose comments actually changed.
 */
function sameProps<P extends object>(previous: P, next: P): boolean {
  return (Object.keys(next) as (keyof P)[]).every((key) => {
    const before = previous[key];
    const after = next[key];
    if (Array.isArray(before) && Array.isArray(after)) {
      return (
        before.length === after.length &&
        before.every((item, index) => Object.is(item, after[index]))
      );
    }
    return Object.is(before, after);
  });
}

const FileBlock = memo(function FileBlock({
  file,
  hunks,
  stopId,
  comments: fileComments,
  discussions: fileDiscussions,
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
  links,
}: {
  file: DiffFile;
  hunks: DiffHunk[];
  stopId: string;
  /** This file's comments from every stop; only those on shown hunks show. */
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
  onViewedChange: (stopId: string, path: string, viewed: boolean) => void;
  links: FileLinks | null;
}) {
  const { theme, themeType } = useDiffTheme();
  // Viewed files collapse; the reviewer can open one again without
  // unchecking it. Checking Viewed always collapses.
  const [reopened, setReopened] = useState(false);
  const collapsed = viewed && !reopened;
  const versions = useFileVersions(rpc, walkthroughId, file.path);
  // The whole file: every line, and every hunk, including other stops'.
  const [wholeFile, setWholeFile] = useState(false);
  const shownHunks = wholeFile ? file.hunks : hunks;
  // The highlighted lines follow a drag, then stay on the lines an open
  // comment box is about; closing the box clears them.
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  useEffect(() => {
    if (composer === null) setSelection(null);
  }, [composer]);
  const fileDiff = useMemo(
    () => buildFileDiff(file, shownHunks, versions),
    [file, shownHunks, versions],
  );

  // At one line: each comment, then the conversations about it, then any
  // other conversations, then an open composer.
  const annotations = useMemo(() => {
    const list: DiffLineAnnotation<Annotation>[] = [];
    const shown = new Set(shownHunks.map((hunk) => hunk.id));
    const comments = fileComments.filter((comment) =>
      shown.has(comment.hunkId),
    );
    const discussions = fileDiscussions.filter(
      (discussion) =>
        discussion.anchor !== null && shown.has(discussion.anchor.hunkId),
    );
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
  }, [fileComments, fileDiscussions, composer, shownHunks]);

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
        selectedLines={selection}
        options={{
          ...(theme ? { theme } : {}),
          themeType,
          diffStyle,
          overflow: "wrap",
          // Wrapped code must never grow wider than the panel, even when a
          // comment below a line holds something wide like a code block.
          unsafeCSS: `${FIT_TO_PANEL}\n${LINKED_FILE_NAME}`,
          hunkSeparators: "line-info",
          lineDiffType: "word",
          collapsed,
          expandUnchanged: wholeFile,
          // Asking the agent stays possible after the review is posted.
          enableGutterUtility: true,
          // Without line selection, bb's Pierre keeps the + under the pointer
          // while dragging and ignores it, so a drag never got past its first
          // line. With it, the + waits at the selection's end.
          enableLineSelection: true,
          onLineSelectionChange: setSelection,
          onGutterUtilityClick: (range) => {
            const side = toSide(range.endSide ?? range.side);
            const start = Math.min(range.start, range.end);
            const end = Math.max(range.start, range.end);
            // Expanded lines are outside the diff, where GitHub cannot
            // anchor a comment and a question has no stop to belong to.
            if (findHunkForRange(file, side, start, end) === null) {
              setSelection(null);
              toast.info(
                "Comments and questions go on the diff's own lines, not on lines you expanded.",
              );
              return;
            }
            onComposer({ path: file.path, side, start, end, commentId: null });
          },
        }}
        renderHeaderPrefix={() => (
          <>
            {viewed ? (
              <button
                type="button"
                className="mr-1 inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
                aria-label={
                  collapsed ? `Show ${file.path}` : `Hide ${file.path}`
                }
                aria-expanded={!collapsed}
                onClick={() => setReopened((open) => !open)}
              >
                <Icon
                  name={collapsed ? "ChevronRight" : "ChevronDown"}
                  className="size-4"
                  aria-hidden="true"
                />
              </button>
            ) : null}
            <FileName
              path={file.path}
              // A deleted file has nothing left to open.
              links={file.status === "deleted" ? null : links}
              line={hunks[0] ? firstChangedLine(hunks[0]) : null}
            />
          </>
        )}
        renderHeaderMetadata={() => (
          <>
            {versions !== null ? (
              <Hint
                label={
                  wholeFile
                    ? hunks.length === file.hunks.length
                      ? "Hide unchanged lines"
                      : "Show only this stop's changes"
                    : "Show the whole file"
                }
              >
                <button
                  type="button"
                  className="ml-2 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground aria-pressed:bg-state-hover aria-pressed:text-foreground"
                  aria-label={`Show all of ${file.path}`}
                  aria-pressed={wholeFile}
                  onClick={() => {
                    // Reading the whole file is reading it, so open it if
                    // Viewed had collapsed it.
                    setReopened(true);
                    setWholeFile((whole) => !whole);
                  }}
                >
                  <Icon
                    name="ArrowUpDown"
                    className="size-4"
                    aria-hidden="true"
                  />
                </button>
              </Hint>
            ) : null}
            <label className="ml-2 inline-flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-2 font-sans text-xs leading-none text-muted-foreground hover:bg-state-hover hover:text-foreground">
              <Checkbox
                className="size-3 rounded-[3px] [&_[data-icon-root]]:size-2.5"
                checked={viewed}
                onCheckedChange={(checked) => {
                  setReopened(false);
                  onViewedChange(stopId, file.path, checked === true);
                }}
                aria-label={`Mark ${file.path} viewed`}
              />
              Viewed
            </label>
          </>
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
}, sameProps);

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
  links,
}: {
  files: readonly DiffFile[];
  stopId: string;
  hunkIds: readonly string[];
  /** The agent's asides, shown as quotes above the file they are about. */
  notes: readonly { hunkId: string; body: string }[];
  /** Every comment and anchored conversation; each file shows its own. */
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
  onViewedChange: (stopId: string, path: string, viewed: boolean) => void;
  /** Where files open outside the diff; null shows plain names. */
  links: FileLinks | null;
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
            {fileNotes.map((note, index) => (
              // A hunk may carry more than one note.
              <NoteQuote key={index} body={note.body} />
            ))}
            <FileBlock
              file={file}
              hunks={hunks}
              stopId={stopId}
              comments={comments.filter(
                (comment) => comment.path === file.path,
              )}
              discussions={discussions.filter(
                (discussion) => discussion.anchor?.path === file.path,
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
              onViewedChange={onViewedChange}
              links={links}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The file's path, which opens the file in your editor, and a GitHub mark
 * that opens it in the browser. Both land on the stop's first change.
 */
function FileName({
  path,
  links,
  line,
}: {
  path: string;
  links: FileLinks | null;
  line: number | null;
}) {
  const navigate = useBbNavigate();
  // Paths truncate from the left, keeping the file name in view.
  const name = <bdi>{path}</bdi>;
  const environmentId = links?.environmentId ?? null;
  const browse = links?.browse ?? null;

  const openInEditor = (environmentId: string) => {
    const opened = navigate.experimental_openFileExternally({
      target: { kind: "workspace", environmentId, path },
      location: line === null ? null : { kind: "line", line, column: null },
    });
    if (!opened) toast.error(`Could not open ${path} in your editor.`);
  };

  // Each part is its own item in Pierre's header row; see LINKED_FILE_NAME.
  return (
    <>
      {environmentId === null ? (
        <span
          className="min-w-0 truncate [direction:rtl]"
          style={{ order: FILE_NAME_ORDER }}
        >
          {name}
        </span>
      ) : (
        <Hint label="Open in your editor">
          <button
            type="button"
            className="min-w-0 cursor-pointer truncate rounded-sm underline-offset-2 [direction:rtl] hover:underline focus-visible:underline focus-visible:outline-none"
            style={{ order: FILE_NAME_ORDER }}
            onClick={() => openInEditor(environmentId)}
          >
            {name}
          </button>
        </Hint>
      )}
      {browse !== null ? (
        <Hint label="Open on GitHub">
          <UrlLink
            href={githubFileUrl(browse, path, line)}
            aria-label={`Open ${path} on GitHub`}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground"
            style={{ order: FILE_NAME_ORDER + 1 }}
          >
            <Icon name="Github" className="size-3.5" aria-hidden="true" />
          </UrlLink>
        </Hint>
      ) : null}
    </>
  );
}

/** An aside from the agent between files, set off like a block quote. */
function NoteQuote({ body }: { body: string }) {
  return (
    <aside className="rounded-r-lg border-l-[3px] border-foreground/40 bg-secondary/40 px-4 py-2.5">
      <Markdown
        content={body}
        className="min-w-0 overflow-x-clip text-sm leading-6 text-foreground"
      />
    </aside>
  );
}
