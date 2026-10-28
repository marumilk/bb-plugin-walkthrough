// GitHub access through the `gh` CLI on the BB server, so the plugin uses
// whatever account `gh auth login` set up and never holds a token itself.
import { spawn } from "node:child_process";
import { delimiter } from "node:path";

const EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function ghEnv(): NodeJS.ProcessEnv {
  const path = [process.env.PATH ?? "", ...EXTRA_PATHS]
    .filter(Boolean)
    .join(delimiter);
  // GH_PROMPT_DISABLED keeps gh from waiting on a TTY that does not exist.
  return { ...process.env, PATH: path, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
}

export function runGh(
  args: readonly string[],
  options: { stdin?: string; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: ghEnv(), signal: options.signal });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new GhError(
              "The GitHub CLI (gh) is not installed on the BB server.",
              "",
            )
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GhError(ghFailureMessage(args, stderr), stderr));
    });
    child.stdin.end(options.stdin ?? "");
  });
}

function ghFailureMessage(args: readonly string[], stderr: string): string {
  const text = stderr.trim();
  if (/gh auth login|not logged in/i.test(text)) {
    return "The GitHub CLI is not signed in on the BB server. Run `gh auth login`.";
  }
  if (/one pending review/i.test(text)) {
    return "You already have a pending review on this pull request in GitHub. Submit or discard it there, then try again.";
  }
  return `gh ${args.slice(0, 2).join(" ")} failed: ${text.split("\n").slice(-3).join(" ") || "no output"}`;
}

export interface PrRef {
  repo: string;
  number: number;
}

/**
 * `owner/name` within GitHub's own character rules: owners are letters,
 * digits, and hyphens; names add `.` and `_` but are never `.` or `..`.
 * Repository names go into `gh api` paths, so anything else (a `..`, `?`,
 * `#`, or `%`) could point a call, including the one that posts a review,
 * somewhere else.
 */
export function isRepoName(repo: string): boolean {
  const match = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(repo);
  return match !== null && match[2] !== "." && match[2] !== "..";
}

function prRef(repo: string, number: string | number, text: string): PrRef {
  if (!isRepoName(repo)) {
    throw new Error(
      `"${text}" names the repository "${repo}", which is not a valid owner/name.`,
    );
  }
  const parsed = Number(number);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`"${text}" is not a valid pull request number.`);
  }
  return { repo, number: parsed };
}

/**
 * Accepts a PR URL, `owner/repo#123`, or a bare number when `fallbackRepo`
 * names the repository (usually the BB project's remote).
 */
export function parsePrRef(
  input: string | number,
  fallbackRepo: string | null,
): PrRef {
  const text = String(input).trim();
  const url =
    /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(
      text,
    );
  if (url) return prRef(url[1]!, url[2]!, text);
  const short = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(text);
  if (short) return prRef(short[1]!, short[2]!, text);
  if (/^#?\d+$/.test(text)) {
    if (fallbackRepo === null) {
      throw new Error(
        `"${text}" needs a repository; pass a PR URL or owner/repo#${text.replace("#", "")}.`,
      );
    }
    return prRef(fallbackRepo, text.replace("#", ""), text);
  }
  throw new Error(
    `"${text}" is not a pull request; pass a URL, owner/repo#123, or a number.`,
  );
}

/** `owner/repo` from an SSH or HTTPS GitHub remote, else null. */
export function repoFromRemote(
  remote: string | null | undefined,
): string | null {
  if (!remote) return null;
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
    remote.trim(),
  );
  return match !== null && isRepoName(match[1]!) ? match[1]! : null;
}

export interface PrInfo {
  url: string;
  title: string;
  body: string;
  author: string;
  headSha: string;
  state: string;
}

export async function fetchPr(
  ref: PrRef,
  signal?: AbortSignal,
): Promise<PrInfo> {
  const raw = await runGh(
    [
      "api",
      `repos/${ref.repo}/pulls/${ref.number}`,
      "--jq",
      '{url: .html_url, title, body: (.body // ""), author: .user.login, headSha: .head.sha, state}',
    ],
    { signal },
  );
  return JSON.parse(raw) as PrInfo;
}

export function fetchPrDiff(ref: PrRef, signal?: AbortSignal): Promise<string> {
  return runGh(
    ["pr", "diff", String(ref.number), "--repo", ref.repo, "--color=never"],
    { signal },
  );
}

/**
 * Where a pull request's diff starts: the merge base of its base branch and
 * `headSha`, the commit GitHub's own PR diff compares against.
 */
export async function fetchMergeBase(
  ref: PrRef,
  headSha: string,
  signal?: AbortSignal,
): Promise<string> {
  const baseSha = await runGh(
    ["api", `repos/${ref.repo}/pulls/${ref.number}`, "--jq", ".base.sha"],
    { signal },
  );
  const mergeBase = await runGh(
    [
      "api",
      `repos/${ref.repo}/compare/${checkSha(baseSha.trim())}...${checkSha(headSha)}`,
      "--jq",
      ".merge_base_commit.sha",
    ],
    { signal },
  );
  return checkSha(mergeBase.trim());
}

/** A file's text at a commit. */
export function fetchFileAt(
  repo: string,
  path: string,
  sha: string,
  signal?: AbortSignal,
): Promise<string> {
  const escaped = path.split("/").map(encodeURIComponent).join("/");
  return runGh(
    [
      "api",
      "-H",
      "Accept: application/vnd.github.raw+json",
      `repos/${repo}/contents/${escaped}?ref=${checkSha(sha)}`,
    ],
    { signal },
  );
}

// Commit ids go into `gh api` paths, so only hex gets through.
function checkSha(sha: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(sha))
    throw new Error(`"${sha}" is not a commit id.`);
  return sha;
}

export interface ReviewRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
}

export async function listReviewRequests(
  signal?: AbortSignal,
): Promise<ReviewRequest[]> {
  const raw = await runGh(
    [
      "search",
      "prs",
      "--review-requested=@me",
      "--state=open",
      "--limit=50",
      "--json",
      "number,title,url,author,isDraft,updatedAt,repository",
    ],
    { signal },
  );
  const rows = JSON.parse(raw) as {
    number: number;
    title: string;
    url: string;
    author: { login: string } | null;
    isDraft: boolean;
    updatedAt: string;
    repository: { nameWithOwner: string };
  }[];
  return rows
    .map((row) => ({
      repo: row.repository.nameWithOwner,
      number: row.number,
      title: row.title,
      url: row.url,
      author: row.author?.login ?? "ghost",
      isDraft: row.isDraft,
      updatedAt: row.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function submitReview(
  ref: PrRef,
  payload: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const raw = await runGh(
    [
      "api",
      "--method",
      "POST",
      `repos/${ref.repo}/pulls/${ref.number}/reviews`,
      "--input",
      "-",
      "--jq",
      ".html_url",
    ],
    { stdin: JSON.stringify(payload), signal },
  );
  return raw.trim();
}

/** The PR description now, with images the BB webview can load. */
export async function fetchPrDescription(
  ref: PrRef,
  signal?: AbortSignal,
): Promise<string> {
  const raw = await runGh(
    [
      "api",
      `repos/${ref.repo}/pulls/${ref.number}`,
      "-H",
      "Accept: application/vnd.github.full+json",
      "--jq",
      '{body: (.body // ""), html: (.body_html // "")}',
    ],
    { signal },
  );
  const { body, html } = JSON.parse(raw) as { body: string; html: string };
  return signImages(body, html);
}

const IMAGE_IN_MARKDOWN =
  /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))|(<img\b[^>]*?\bsrc=")([^"]+)(")/g;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Images attached to a private repository's PR need a GitHub session to load.
 * GitHub's rendered HTML carries short-lived signed URLs for them, in the same
 * order as the Markdown's images; swap those in. When the counts disagree the
 * pairing is unsafe, so the body is returned unchanged.
 */
export function signImages(body: string, html: string): string {
  const signed = [...html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/g)].map(
    (match) => decodeEntities(match[1]!),
  );
  const originals = [...body.matchAll(IMAGE_IN_MARKDOWN)];
  if (signed.length !== originals.length) return body;
  let index = 0;
  return body.replace(
    IMAGE_IN_MARKDOWN,
    (match, mdOpen, mdUrl, mdClose, tagOpen, tagUrl, tagClose) => {
      const replacement = signed[index++]!;
      if (mdOpen !== undefined) return `${mdOpen}${replacement}${mdClose}`;
      return `${tagOpen}${replacement}${tagClose}`;
    },
  );
}

/** Commits on `head` that `base` lacks; diverged after a force-push. */
export async function compareCommits(
  repo: string,
  base: string,
  head: string,
  signal?: AbortSignal,
): Promise<{ aheadBy: number; diverged: boolean }> {
  const raw = await runGh(
    [
      "api",
      `repos/${repo}/compare/${base}...${head}`,
      "--jq",
      "{aheadBy: .ahead_by, status}",
    ],
    { signal },
  );
  const result = JSON.parse(raw) as { aheadBy: number; status: string };
  return { aheadBy: result.aheadBy, diverged: result.status === "diverged" };
}
