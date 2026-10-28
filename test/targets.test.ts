import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Target, Walkthrough } from "../src/model";
import { fileLinks } from "../src/targets";

/** Just the lookups `fileLinks` makes; a rejection stands for a removed record. */
function fakeBb({
  threadEnvironment = "env_review" as string | null,
  branchName = "feat/retry" as string | null,
  environmentGone = false,
  remote = "git@github.com:acme/app.git" as string | null,
} = {}): BbPluginApi {
  return {
    sdk: {
      threads: { get: async () => ({ environmentId: threadEnvironment }) },
      environments: {
        get: async () => {
          if (environmentGone) throw new Error("No such environment");
          return { branchName };
        },
      },
      projects: { get: async () => ({ gitRemoteUrl: remote }) },
    },
  } as unknown as BbPluginApi;
}

function walkthrough(target: Target): Walkthrough {
  return { threadId: "thr_1", projectId: "proj_1", target } as Walkthrough;
}

const PR: Target = {
  kind: "pr",
  repo: "acme/app",
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  title: "Retry",
  author: "octocat",
  headSha: "abc123",
};

const local = (diff: Extract<Target, { kind: "local" }>["diff"]): Target => ({
  kind: "local",
  environmentId: "env_1",
  diff,
  label: "Local",
});

describe("fileLinks", () => {
  it("opens a pull request from the reviewing thread's checkout, at its head commit", async () => {
    await expect(fileLinks(fakeBb(), walkthrough(PR))).resolves.toEqual({
      environmentId: "env_review",
      browse: { repo: "acme/app", ref: "abc123" },
    });
  });

  it("still browses a pull request whose thread has no checkout", async () => {
    await expect(
      fileLinks(fakeBb({ threadEnvironment: null }), walkthrough(PR)),
    ).resolves.toEqual({
      environmentId: null,
      browse: { repo: "acme/app", ref: "abc123" },
    });
  });

  it("browses local changes on their branch", async () => {
    await expect(
      fileLinks(fakeBb(), walkthrough(local({ type: "uncommitted" }))),
    ).resolves.toEqual({
      environmentId: "env_1",
      browse: { repo: "acme/app", ref: "feat/retry" },
    });
  });

  it("browses a single commit at that commit", async () => {
    await expect(
      fileLinks(
        fakeBb({ branchName: null }),
        walkthrough(local({ type: "commit", sha: "def456" })),
      ),
    ).resolves.toEqual({
      environmentId: "env_1",
      browse: { repo: "acme/app", ref: "def456" },
    });
  });

  it("drops only the links it cannot make", async () => {
    // A detached checkout has no branch to browse.
    await expect(
      fileLinks(
        fakeBb({ branchName: null }),
        walkthrough(local({ type: "uncommitted" })),
      ),
    ).resolves.toEqual({ environmentId: "env_1", browse: null });
    // A project outside GitHub has nothing to browse.
    await expect(
      fileLinks(
        fakeBb({ remote: "git@gitlab.com:acme/app.git" }),
        walkthrough(local({ type: "uncommitted" })),
      ),
    ).resolves.toEqual({ environmentId: "env_1", browse: null });
    // A removed checkout has nothing to open or browse.
    await expect(
      fileLinks(
        fakeBb({ environmentGone: true }),
        walkthrough(local({ type: "uncommitted" })),
      ),
    ).resolves.toEqual({ environmentId: null, browse: null });
  });
});
