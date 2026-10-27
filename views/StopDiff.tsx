// The hunks of one stop, file by file, with comments inline under their lines.
// bb's own diff component has no annotation slot, so this renders through the
// host-shimmed @pierre/diffs directly and borrows bb's code theme.
import { memo, useMemo, useState } from "react";
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
import type { DraftComment } from "../src/model";
import { CommentCard, newCommentLabel, NewCommentCard } from "./CommentCard";
import { errorMessage, type Rpc } from "./shared";

type Annotation =
  | { kind: "comment"; comment: DraftComment }
  | { kind: "composer"; path: string; side: Side; start: number; end: number };

interface Composer {
  path: string;
  side: Side;
  start: number;
  end: number;
}

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

const FileBlock = memo(function FileBlock({
  file,
  hunks,
  comments,
  composer,
  walkthroughId,
  rpc,
  readOnly,
  diffStyle,
  onComposer,
  onCommentChanged,
}: {
  file: DiffFile;
  hunks: DiffHunk[];
  comments: DraftComment[];
  composer: Composer | null;
  walkthroughId: string;
  rpc: Rpc;
  readOnly: boolean;
  diffStyle: "unified" | "split";
  onComposer: (composer: Composer | null) => void;
  onCommentChanged: (id: string, comment: DraftComment | null) => void;
}) {
  const { theme, themeType } = useDiffTheme();
  const fileDiff = useMemo<FileDiffMetadata | undefined>(
    () => parsePatchFiles(renderFilePatch(file, hunks))[0]?.files[0],
    [file, hunks],
  );

  const annotations = useMemo(() => {
    const list: DiffLineAnnotation<Annotation>[] = comments.map((comment) => ({
      side: comment.side === "LEFT" ? "deletions" : "additions",
      lineNumber: comment.line,
      metadata: { kind: "comment", comment },
    }));
    if (composer !== null) {
      list.push({
        side: composer.side === "LEFT" ? "deletions" : "additions",
        lineNumber: composer.end,
        metadata: { kind: "composer", ...composer },
      });
    }
    return list;
  }, [comments, composer]);

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
          enableGutterUtility: !readOnly,
          onGutterUtilityClick: (range) => {
            const start = Math.min(range.start, range.end);
            const end = Math.max(range.start, range.end);
            onComposer({
              path: file.path,
              side: toSide(range.endSide ?? range.side),
              start,
              end,
            });
          },
        }}
        renderAnnotation={(annotation) => {
          const data = annotation.metadata;
          if (data.kind === "composer") {
            return (
              <NewCommentCard
                label={newCommentLabel(data.start, data.end)}
                onCancel={() => onComposer(null)}
                onSave={(body) => addComment(data, body)}
              />
            );
          }
          return (
            <CommentCard
              comment={data.comment}
              walkthroughId={walkthroughId}
              rpc={rpc}
              readOnly={readOnly}
              onChanged={(next) => onCommentChanged(data.comment.id, next)}
            />
          );
        }}
      />
    </div>
  );
});

export function StopDiff({
  files,
  hunkIds,
  comments,
  walkthroughId,
  rpc,
  readOnly,
  diffStyle,
  onCommentChanged,
}: {
  files: readonly DiffFile[];
  hunkIds: readonly string[];
  comments: readonly DraftComment[];
  walkthroughId: string;
  rpc: Rpc;
  readOnly: boolean;
  diffStyle: "unified" | "split";
  onCommentChanged: (id: string, comment: DraftComment | null) => void;
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
        return (
          <FileBlock
            key={file.path}
            file={file}
            hunks={hunks}
            comments={comments.filter(
              (comment) =>
                comment.path === file.path && ids.has(comment.hunkId),
            )}
            composer={composer?.path === file.path ? composer : null}
            walkthroughId={walkthroughId}
            rpc={rpc}
            readOnly={readOnly}
            diffStyle={diffStyle}
            onComposer={setComposer}
            onCommentChanged={onCommentChanged}
          />
        );
      })}
    </div>
  );
}
