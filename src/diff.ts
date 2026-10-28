// Unified-diff parsing shared by the server (validation, snapshots) and the
// app (rendering). Hunk ids are `<path>:h<ordinal>`, 1-based within a file,
// so an agent can anchor a walkthrough stop to the exact hunks it means.

export type Side = "LEFT" | "RIGHT";

export interface DiffHunk {
  id: string;
  /** The `@@ … @@` line, including any trailing section heading. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Body lines, each still prefixed with ` `, `+`, `-`, or `\`. */
  lines: string[];
}

export interface DiffFile {
  path: string;
  previousPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  /** Header lines from `diff --git` up to (not including) the first hunk. */
  header: string[];
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function hunkId(path: string, ordinal: number): string {
  return `${path}:h${ordinal}`;
}

/** Splits `path:h3` into its parts; null when the id is not hunk-shaped. */
export function parseHunkId(
  id: string,
): { path: string; ordinal: number } | null {
  const match = /^(.+):h(\d+)$/.exec(id);
  if (match === null) return null;
  return { path: match[1]!, ordinal: Number(match[2]) };
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function unquote(value: string): string {
  // git quotes paths with unusual characters: "a/with space.txt"
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

/**
 * Parses a multi-file unified diff (`git diff`, `gh pr diff`). A patch for a
 * single file without a `diff --git` line is accepted when `fallbackPath` is
 * given, which is how BB's environment diff API returns per-file patches.
 */
export function parseUnifiedDiff(
  patch: string,
  fallbackPath?: string,
): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  // Remaining body lines in the current hunk, so a `--- ` deletion line is
  // never mistaken for the next file's header.
  let oldLeft = 0;
  let newLeft = 0;

  const startFile = (path: string): DiffFile => {
    const next: DiffFile = {
      path,
      previousPath: null,
      status: "modified",
      binary: false,
      header: [],
      hunks: [],
    };
    files.push(next);
    hunk = null;
    return next;
  };

  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      if (
        marker === " " ||
        marker === "+" ||
        marker === "-" ||
        marker === "\\" ||
        line === ""
      ) {
        const body = line === "" ? " " : line;
        hunk.lines.push(body);
        if (marker === "\\") continue;
        if (marker !== "+") oldLeft -= 1;
        if (marker !== "-") newLeft -= 1;
        continue;
      }
    }
    if (hunk !== null && line.startsWith("\\")) {
      hunk.lines.push(line);
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      file = startFile(
        match ? unquote(match[2]!) : line.slice("diff --git ".length),
      );
      file.header.push(line);
      continue;
    }
    const headerMatch = HUNK_HEADER.exec(line);
    if (headerMatch !== null) {
      if (file === null) {
        if (fallbackPath === undefined)
          throw new Error("Patch has a hunk before any file header.");
        file = startFile(fallbackPath);
      }
      const current: DiffHunk = {
        id: hunkId(file.path, file.hunks.length + 1),
        header: line,
        oldStart: Number(headerMatch[1]),
        oldLines: headerMatch[2] === undefined ? 1 : Number(headerMatch[2]),
        newStart: Number(headerMatch[3]),
        newLines: headerMatch[4] === undefined ? 1 : Number(headerMatch[4]),
        lines: [],
      };
      file.hunks.push(current);
      hunk = current;
      oldLeft = current.oldLines;
      newLeft = current.newLines;
      continue;
    }
    if (file === null) {
      if (fallbackPath === undefined) continue;
      file = startFile(fallbackPath);
    }
    hunk = null;
    file.header.push(line);
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.previousPath = unquote(line.slice("rename from ".length));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.path = unquote(line.slice("rename to ".length));
    } else if (
      line.startsWith("Binary files ") ||
      line === "GIT binary patch"
    ) {
      file.binary = true;
    } else if (line.startsWith("+++ ") && !line.endsWith("/dev/null")) {
      file.path = stripPrefix(unquote(line.slice(4)), "b/");
    } else if (line.startsWith("--- ") && line.endsWith("/dev/null")) {
      file.status = "added";
    } else if (line.startsWith("+++ ") && line.endsWith("/dev/null")) {
      file.status = "deleted";
    }
  }
  // Hunk ids were minted before a later `rename to`/`+++` line could correct
  // the path; recompute them from the final path.
  for (const parsed of files) {
    parsed.hunks.forEach((h, index) => {
      h.id = hunkId(parsed.path, index + 1);
    });
  }
  return files;
}

/** Line numbers a review comment may target on each side of one hunk. */
export function commentableLines(hunk: DiffHunk): {
  LEFT: Set<number>;
  RIGHT: Set<number>;
} {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    const marker = line[0];
    if (marker === "\\") continue;
    if (marker === "-") {
      left.add(oldLine);
      oldLine += 1;
    } else if (marker === "+") {
      right.add(newLine);
      newLine += 1;
    } else {
      left.add(oldLine);
      right.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return { LEFT: left, RIGHT: right };
}

/** The hunk of `file` that contains every line in [start, end] on `side`. */
export function findHunkForRange(
  file: DiffFile,
  side: Side,
  start: number,
  end: number,
): DiffHunk | null {
  for (const candidate of file.hunks) {
    const lines = commentableLines(candidate)[side];
    let all = true;
    for (let line = start; line <= end; line += 1) {
      if (!lines.has(line)) {
        all = false;
        break;
      }
    }
    if (all) return candidate;
  }
  return null;
}

/** Human-readable commentable ranges, for validation errors. */
export function describeRanges(file: DiffFile, side: Side): string {
  const ranges: string[] = [];
  for (const candidate of file.hunks) {
    const lines = [...commentableLines(candidate)[side]].sort((a, b) => a - b);
    if (lines.length === 0) continue;
    let from = lines[0]!;
    let previous = from;
    for (const line of lines.slice(1)) {
      if (line !== previous + 1) {
        ranges.push(from === previous ? `${from}` : `${from}-${previous}`);
        from = line;
      }
      previous = line;
    }
    ranges.push(from === previous ? `${from}` : `${from}-${previous}`);
  }
  return ranges.length === 0 ? "none" : ranges.join(", ");
}

/** Rebuilds a single-file patch holding only `hunks`, for rendering. */
export function renderFilePatch(
  file: DiffFile,
  hunks: readonly DiffHunk[],
): string {
  const oldPath =
    file.status === "added"
      ? "/dev/null"
      : `a/${file.previousPath ?? file.path}`;
  const newPath = file.status === "deleted" ? "/dev/null" : `b/${file.path}`;
  const out = [
    `diff --git a/${file.previousPath ?? file.path} b/${file.path}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
  ];
  for (const h of hunks) {
    out.push(h.header, ...h.lines);
  }
  return `${out.join("\n")}\n`;
}

export function hunkStats(hunk: DiffHunk): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of hunk.lines) {
    if (line[0] === "+") additions += 1;
    else if (line[0] === "-") deletions += 1;
  }
  return { additions, deletions };
}

/** The new-side line of a hunk's first change, where an editor should open. */
export function firstChangedLine(hunk: DiffHunk): number {
  let line = hunk.newStart;
  for (const text of hunk.lines) {
    if (text[0] === "+" || text[0] === "-") break;
    if (text[0] === " ") line += 1;
  }
  // A hunk that deletes a whole file's start begins at new line 0.
  return Math.max(1, line);
}

/**
 * True when every hunk's lines sit where its header says in the two
 * versions, so the versions are the ones the hunks were cut from.
 */
export function hunksMatch(
  hunks: readonly DiffHunk[],
  oldText: string,
  newText: string,
): boolean {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  return hunks.every((hunk) => {
    // A hunk with no lines on a side starts after line `start`, not at it.
    let oldAt = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    let newAt = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === "\\") continue;
      if (marker !== "+" && oldLines[oldAt++] !== text) return false;
      if (marker !== "-" && newLines[newAt++] !== text) return false;
    }
    return true;
  });
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
