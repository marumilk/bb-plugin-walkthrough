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
 * Accepts a PR URL, `owner/repo#123`, or a bare number when `fallbackRepo`
 * names the repository (usually the BB project's remote).
 */
export function parsePrRef(
  input: string | number,
  fallbackRepo: string | null,
): PrRef {
  const text = String(input).trim();
  const url = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i.exec(
    text,
  );
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
  if (short) return { repo: short[1]!, number: Number(short[2]) };
  if (/^#?\d+$/.test(text)) {
    if (fallbackRepo === null) {
      throw new Error(
        `"${text}" needs a repository; pass a PR URL or owner/repo#${text.replace("#", "")}.`,
      );
    }
    return { repo: fallbackRepo, number: Number(text.replace("#", "")) };
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
  return match ? match[1]! : null;
}

export interface PrInfo {
  url: string;
  title: string;
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
      "{url: .html_url, title, author: .user.login, headSha: .head.sha, state}",
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
