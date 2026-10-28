// Both versions of a changed file, so the diff can expand its unchanged lines
// and show the whole file. Pull requests read GitHub at the merge base and the
// reviewed head commit, the two ends of the PR's own diff; local changes read
// the checkout through BB's environment diff API. Versions that no longer
// match the snapshot's hunks (the checkout moved on, or the base branch was
// rewritten) are dropped, and the diff stays as the snapshot cut it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hunksMatch } from "./diff";
import { fetchFileAt, fetchMergeBase } from "./github";
import type { FileVersions, LocalDiff, Target, Walkthrough } from "./model";

/** Larger files stay collapsed rather than ship megabytes to the app. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Null when there is nothing to expand (an added or deleted file is already
 * whole in its patch), nothing to show (binary), or no matching versions.
 */
export async function fileVersions(
  bb: BbPluginApi,
  walkthrough: Walkthrough,
  path: string,
  mergeBase: () => Promise<string>,
  signal?: AbortSignal,
): Promise<FileVersions | null> {
  const file = walkthrough.files.find((candidate) => candidate.path === path);
  if (
    file === undefined ||
    file.binary ||
    file.status === "added" ||
    file.status === "deleted"
  )
    return null;
  const oldPath = file.previousPath ?? file.path;
  const { target } = walkthrough;
  const versions =
    target.kind === "pr"
      ? await prVersions(target, oldPath, path, mergeBase, signal)
      : await localVersions(bb, target, oldPath, path, signal);
  if (versions === null) return null;
  if (versions.old.length + versions.new.length > MAX_BYTES) return null;
  return hunksMatch(file.hunks, versions.old, versions.new) ? versions : null;
}

async function prVersions(
  target: Extract<Target, { kind: "pr" }>,
  oldPath: string,
  path: string,
  mergeBase: () => Promise<string>,
  signal?: AbortSignal,
): Promise<FileVersions> {
  const base = await mergeBase();
  const [old, next] = await Promise.all([
    fetchFileAt(target.repo, oldPath, base, signal),
    fetchFileAt(target.repo, path, target.headSha, signal),
  ]);
  return { old, new: next };
}

async function localVersions(
  bb: BbPluginApi,
  target: Extract<Target, { kind: "local" }>,
  oldPath: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileVersions | null> {
  const read = async (side: "old" | "new", sidePath: string) => {
    const file = await bb.sdk.environments.diffFile({
      environmentId: target.environmentId,
      ...diffFileQuery(target.diff),
      path: sidePath,
      side,
      signal,
    });
    return file.contentEncoding === "utf8" ? file.content : null;
  };
  const [old, next] = await Promise.all([
    read("old", oldPath),
    read("new", path),
  ]);
  return old === null || next === null ? null : { old, new: next };
}

function diffFileQuery(diff: LocalDiff) {
  return diff.type === "uncommitted"
    ? ({ target: "uncommitted" } as const)
    : diff.type === "commit"
      ? ({ target: "commit", sha: diff.sha } as const)
      : ({ target: diff.type, mergeBaseRef: diff.mergeBaseBranch } as const);
}

/** One merge-base lookup per pull request walkthrough, shared by its files. */
export function mergeBaseCache() {
  const cache = new Map<string, Promise<string>>();
  return (walkthrough: Walkthrough): (() => Promise<string>) =>
    () => {
      const { target } = walkthrough;
      if (target.kind !== "pr")
        return Promise.reject(
          new Error("Only pull requests have a merge base."),
        );
      let found = cache.get(walkthrough.id);
      if (found === undefined) {
        found = fetchMergeBase(target, target.headSha);
        // A failed lookup is retried next time rather than remembered.
        found.catch(() => cache.delete(walkthrough.id));
        cache.set(walkthrough.id, found);
      }
      return found;
    };
}
