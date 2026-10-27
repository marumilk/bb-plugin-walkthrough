// Turns a target the agent named into a diff snapshot. Pull requests come
// from `gh`; local changes come from BB's environment diff API, which runs on
// whichever machine hosts the thread's checkout.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseUnifiedDiff, type DiffFile } from "./diff";
import type { TargetInput } from "./document";
import { fetchPr, fetchPrDiff, parsePrRef, repoFromRemote } from "./github";
import type { LocalDiff, Target } from "./model";

/** Diffs above this size are refused rather than rendered slowly. */
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export interface ThreadContext {
  threadId: string;
  projectId: string | null;
  environmentId: string | null;
  hostId: string | null;
  repo: string | null;
}

export async function threadContext(
  bb: BbPluginApi,
  threadId: string,
): Promise<ThreadContext> {
  const thread = await bb.sdk.threads.get({ threadId });
  const environmentId = thread.environmentId ?? null;
  const [environment, project] = await Promise.all([
    environmentId ? bb.sdk.environments.get({ environmentId }) : null,
    thread.projectId
      ? bb.sdk.projects.get({ projectId: thread.projectId })
      : null,
  ]);
  return {
    threadId,
    projectId: thread.projectId ?? null,
    environmentId,
    hostId: environment?.hostId ?? null,
    repo: repoFromRemote(project?.gitRemoteUrl ?? null),
  };
}

export interface Snapshot {
  target: Target;
  files: DiffFile[];
}

export async function snapshotTarget(
  bb: BbPluginApi,
  context: ThreadContext,
  input: TargetInput,
  signal?: AbortSignal,
): Promise<Snapshot> {
  if ("pr" in input) {
    const ref = parsePrRef(input.pr, context.repo);
    const [info, patch] = await Promise.all([
      fetchPr(ref, signal),
      fetchPrDiff(ref, signal),
    ]);
    if (patch.length > MAX_PATCH_BYTES) {
      throw new Error(
        `${ref.repo}#${ref.number} has a ${Math.round(patch.length / 1e6)} MB diff, too large to walk through.`,
      );
    }
    return {
      target: {
        kind: "pr",
        repo: ref.repo,
        number: ref.number,
        url: info.url,
        title: info.title,
        author: info.author,
        headSha: info.headSha,
        body: info.body,
      },
      files: parseUnifiedDiff(patch),
    };
  }

  if (context.environmentId === null) {
    throw new Error(
      "This thread has no checkout, so it has no local changes to walk through.",
    );
  }
  const environment = await bb.sdk.environments.get({
    environmentId: context.environmentId,
  });
  let diff: LocalDiff;
  let label: string;
  if ("commit" in input) {
    diff = { type: "commit", sha: input.commit };
    label = `Commit ${input.commit.slice(0, 8)}`;
  } else if (input.local === "uncommitted") {
    diff = { type: "uncommitted" };
    label = "Uncommitted changes";
  } else {
    const base = environment.mergeBaseBranch ?? environment.defaultBranch;
    if (!base)
      throw new Error("Could not work out the base branch for this checkout.");
    diff = {
      type: input.local === "branch" ? "branch_committed" : "all",
      mergeBaseBranch: base,
    };
    const branch = environment.branchName ?? "HEAD";
    label =
      input.local === "branch"
        ? `${branch} vs ${base}`
        : `${branch} vs ${base}, with uncommitted changes`;
  }
  return {
    target: {
      kind: "local",
      environmentId: context.environmentId,
      diff,
      label,
    },
    files: await localFiles(bb, context.environmentId, diff, signal),
  };
}

// BB's environment diff APIs name the same target two ways: diffFiles takes
// it flattened under `target`, diffPatch nested with `type`.
function filesQuery(diff: LocalDiff) {
  return diff.type === "uncommitted"
    ? ({ target: "uncommitted" } as const)
    : diff.type === "commit"
      ? ({ target: "commit", sha: diff.sha } as const)
      : ({ target: diff.type, mergeBaseBranch: diff.mergeBaseBranch } as const);
}

function patchTarget(diff: LocalDiff) {
  return diff.type === "uncommitted"
    ? ({ type: "uncommitted" } as const)
    : diff.type === "commit"
      ? ({ type: "commit", sha: diff.sha } as const)
      : ({ type: diff.type, mergeBaseBranch: diff.mergeBaseBranch } as const);
}

async function localFiles(
  bb: BbPluginApi,
  environmentId: string,
  diff: LocalDiff,
  signal?: AbortSignal,
): Promise<DiffFile[]> {
  const listing = await bb.sdk.environments.diffFiles({
    environmentId,
    ...filesQuery(diff),
    signal,
  });
  if (listing.outcome !== "available") {
    throw new Error(
      listing.outcome === "not_applicable"
        ? listing.message
        : listing.failure.message,
    );
  }
  if (listing.files.length === 0) return [];
  const paths = listing.files
    .filter((file) => !file.binary)
    .map((file) => file.path);
  const patches = new Map(
    listing.initialPatches.map((entry) => [entry.path, entry.patch]),
  );
  const missing = paths.filter((path) => !patches.has(path));
  if (missing.length > 0) {
    const fetched = await bb.sdk.environments.diffPatch({
      environmentId,
      target: patchTarget(diff),
      paths: missing,
      signal,
    });
    if (fetched.outcome !== "available") {
      throw new Error(
        fetched.outcome === "not_applicable"
          ? fetched.message
          : fetched.failure.message,
      );
    }
    for (const entry of fetched.patches) patches.set(entry.path, entry.patch);
  }
  let bytes = 0;
  const files: DiffFile[] = [];
  for (const entry of listing.files) {
    const patch = patches.get(entry.path) ?? "";
    bytes += patch.length;
    if (bytes > MAX_PATCH_BYTES)
      throw new Error("These changes are too large to walk through.");
    const parsed = parseUnifiedDiff(patch, entry.path).find(
      (file) => file.path === entry.path,
    );
    files.push(
      parsed ?? {
        path: entry.path,
        previousPath: entry.previousPath,
        status:
          entry.changeKind === "added"
            ? "added"
            : entry.changeKind === "deleted"
              ? "deleted"
              : "modified",
        binary: entry.binary,
        header: [],
        hunks: [],
      },
    );
  }
  return files;
}
