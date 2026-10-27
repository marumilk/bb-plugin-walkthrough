// bb-plugin-walkthrough — server entry.
//
// An agent reviews a change and submits a walkthrough document with
// `bb walkthrough submit`. The server snapshots the diff, validates every hunk
// and comment anchor against it, and stores the result. The app renders it as
// a guided, stop-by-stop review in a thread tab where the reviewer keeps,
// edits, or discards each draft comment, then posts one GitHub review (pull
// requests) or sends the feedback back to the agent (local changes).
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { findHunkForRange, hunkStats, type DiffFile } from "./src/diff";
import {
  documentSchema,
  formatIssues,
  resolveDocument,
  VERDICTS,
  type TargetInput,
} from "./src/document";
import {
  GhError,
  fetchPr,
  listReviewRequests,
  repoFromRemote,
  submitReview,
} from "./src/github";
import {
  countComments,
  describeTarget,
  type DraftComment,
  type Walkthrough,
  type WalkthroughSummary,
} from "./src/model";
import { createStore, NotFoundError } from "./src/store";
import {
  buildReviewPayload,
  formatLocalFeedback,
  reviewBlockers,
} from "./src/submission";
import { snapshotTarget, threadContext } from "./src/targets";

/** Realtime channel: `{ id, threadId }` after any change to a walkthrough. */
export const WALKTHROUGH_CHANGED = "walkthrough-changed";
/** Realtime channel: `{ id, threadId }` when an agent submits a new walkthrough. */
export const WALKTHROUGH_READY = "walkthrough-ready";

export interface InboxEntry {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  projectId: string | null;
  walkthrough: WalkthroughSummary | null;
}

const walkthroughId = z.object({ id: z.string().min(1) }).strict();

export const rpcContract = defineRpcContract({
  get: {
    input: walkthroughId,
    output: z.object({
      walkthrough: z.custom<Walkthrough>(),
      comments: z.array(z.custom<DraftComment>()),
    }),
  },
  latestForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ summary: z.custom<WalkthroughSummary>().nullable() }),
  },
  list: {
    input: z.null(),
    output: z.object({ walkthroughs: z.array(z.custom<WalkthroughSummary>()) }),
  },
  inbox: {
    input: z.null(),
    output: z.object({
      entries: z.array(z.custom<InboxEntry>()),
      error: z.string().nullable(),
    }),
  },
  startReview: {
    input: z
      .object({ repo: z.string().min(3), number: z.number().int().positive() })
      .strict(),
    output: z.object({ threadId: z.string() }),
  },
  setCommentStatus: {
    input: z
      .object({
        id: z.string(),
        commentId: z.string(),
        status: z.enum(["pending", "kept", "discarded"]),
      })
      .strict(),
    output: z.object({ comment: z.custom<DraftComment>() }),
  },
  editComment: {
    input: z
      .object({
        id: z.string(),
        commentId: z.string(),
        body: z.string().trim().min(1).max(20000),
      })
      .strict(),
    output: z.object({ comment: z.custom<DraftComment>() }),
  },
  addComment: {
    input: z
      .object({
        id: z.string(),
        path: z.string().min(1),
        side: z.enum(["LEFT", "RIGHT"]),
        line: z.number().int().positive(),
        startLine: z.number().int().positive().nullable(),
        body: z.string().trim().min(1).max(20000),
      })
      .strict(),
    output: z.object({ comment: z.custom<DraftComment>() }),
  },
  deleteComment: {
    input: z.object({ id: z.string(), commentId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setReview: {
    input: z
      .object({
        id: z.string(),
        summary: z.string().max(20000),
        verdict: z.enum(VERDICTS),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setProgress: {
    input: z.object({ id: z.string(), stopId: z.string().max(40) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  headStatus: {
    input: walkthroughId,
    output: z.object({ moved: z.boolean() }),
  },
  submit: {
    input: walkthroughId,
    output: z.object({ url: z.string().nullable() }),
  },
});

const DEFAULT_REVIEW_INSTRUCTIONS =
  "Review it with the /code-review skill if you have it (without --comment or --fix), " +
  "then turn the findings that hold up into draft comments.";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    reviewInstructions: {
      type: "string",
      label: "How review threads should review",
      description:
        "Added to the prompt when you start a review from the Reviews page. Name the review skills or checks you want run.",
      experimental_multiline: true,
      default: DEFAULT_REVIEW_INSTRUCTIONS,
    },
  });

  const store = createStore(bb);

  const changed = (walkthrough: Pick<Walkthrough, "id" | "threadId">) => {
    bb.realtime.publish(WALKTHROUGH_CHANGED, {
      id: walkthrough.id,
      threadId: walkthrough.threadId,
    });
  };

  /** A walkthrough the reviewer may still change. */
  const openWalkthrough = (id: string): Walkthrough => {
    const { walkthrough } = store.get(id);
    if (walkthrough.status === "submitted") {
      throw new Error(
        "This review is already posted to GitHub and can no longer change.",
      );
    }
    return walkthrough;
  };

  const projectForRepo = async (repo: string) => {
    const projects = await bb.sdk.projects.list();
    return projects.find(
      (project) =>
        repoFromRemote(project.gitRemoteUrl)?.toLowerCase() ===
        repo.toLowerCase(),
    );
  };

  // ── RPC (the app) ─────────────────────────────────────────────────────
  bb.rpc.register(rpcContract, {
    get: ({ id }) => store.get(id),
    latestForThread: ({ threadId }) => ({
      summary: store.latestForThread(threadId),
    }),
    list: () => ({ walkthroughs: store.list(50) }),

    inbox: async () => {
      let requests;
      try {
        requests = await listReviewRequests();
      } catch (error) {
        return {
          entries: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const projects = await bb.sdk.projects.list();
      const projectByRepo = new Map<string, string>();
      for (const project of projects) {
        const repo = repoFromRemote(project.gitRemoteUrl);
        if (repo !== null) projectByRepo.set(repo.toLowerCase(), project.id);
      }
      return {
        error: null,
        entries: requests.map((request) => ({
          ...request,
          projectId: projectByRepo.get(request.repo.toLowerCase()) ?? null,
          walkthrough: store.latestForPr(request.repo, request.number),
        })),
      };
    },

    startReview: async ({ repo, number }) => {
      const project = await projectForRepo(repo);
      if (project === undefined) {
        throw new Error(
          `No BB project points at ${repo}. Add the repository as a project first.`,
        );
      }
      const { reviewInstructions } = await settings.get();
      const thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        // A fresh worktree, so checking out the PR never disturbs your own checkout.
        environment: {
          type: "host",
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        },
        title: `Review ${repo}#${number}`,
        prompt: [
          `Review pull request https://github.com/${repo}/pull/${number} and hand me a walkthrough with draft comments.`,
          "",
          "Use the walkthrough skill. Check out the PR in this worktree with `gh pr checkout` so you can read the surrounding code.",
          reviewInstructions.trim() || DEFAULT_REVIEW_INSTRUCTIONS,
          "Never post, approve, or request changes on GitHub yourself; I publish from the walkthrough.",
        ].join("\n"),
        pluginMetadata: { pr: `${repo}#${number}` },
      });
      return { threadId: thread.id };
    },

    setCommentStatus: ({ id, commentId, status }) => {
      const walkthrough = openWalkthrough(id);
      const comment = store.updateComment(id, commentId, (draft) => {
        draft.status = status;
      });
      changed(walkthrough);
      return { comment };
    },

    editComment: ({ id, commentId, body }) => {
      const walkthrough = openWalkthrough(id);
      const comment = store.updateComment(id, commentId, (draft) => {
        draft.body = body;
        // Saving an edit is a decision to keep the comment.
        draft.status = "kept";
      });
      changed(walkthrough);
      return { comment };
    },

    addComment: ({ id, path, side, line, startLine, body }) => {
      const walkthrough = openWalkthrough(id);
      const file = walkthrough.files.find(
        (candidate) => candidate.path === path,
      );
      const start = startLine ?? line;
      const hunk =
        file === undefined || start > line
          ? null
          : findHunkForRange(file, side, start, line);
      if (hunk === null) {
        throw new Error(
          `${path}:${line} is outside the diff, so GitHub cannot anchor a comment there.`,
        );
      }
      const stop = walkthrough.chapters
        .flatMap((chapter) => chapter.stops)
        .find((candidate) => candidate.hunkIds.includes(hunk.id));
      const comment = store.addComment(id, {
        author: "you",
        path,
        side,
        line,
        startLine: start !== line ? start : null,
        severity: null,
        originalBody: body,
        body,
        status: "kept",
        hunkId: hunk.id,
        stopId: stop?.id ?? "",
      });
      changed(walkthrough);
      return { comment };
    },

    deleteComment: ({ id, commentId }) => {
      const walkthrough = openWalkthrough(id);
      const comment = store
        .get(id)
        .comments.find((candidate) => candidate.id === commentId);
      if (comment?.author !== "you")
        throw new Error(
          "Only your own comments can be deleted; discard a draft instead.",
        );
      store.deleteComment(id, commentId);
      changed(walkthrough);
      return { ok: true as const };
    },

    setReview: ({ id, summary, verdict }) => {
      openWalkthrough(id);
      const walkthrough = store.update(id, (draft) => {
        draft.summary = summary;
        draft.verdict = verdict;
      });
      changed(walkthrough);
      return { ok: true as const };
    },

    setProgress: ({ id, stopId }) => {
      store.update(id, (draft) => {
        draft.currentStopId = stopId;
      });
      return { ok: true as const };
    },

    headStatus: async ({ id }) => {
      const { walkthrough } = store.get(id);
      if (walkthrough.target.kind !== "pr" || walkthrough.status !== "open")
        return { moved: false };
      const info = await fetchPr({
        repo: walkthrough.target.repo,
        number: walkthrough.target.number,
      });
      return { moved: info.headSha !== walkthrough.target.headSha };
    },

    submit: async ({ id }) => {
      const walkthrough = openWalkthrough(id);
      const { comments } = store.get(id);
      if (walkthrough.target.kind === "pr") {
        const blockers = reviewBlockers(walkthrough, comments);
        if (blockers.length > 0) throw new Error(blockers.join(" "));
        let url: string;
        try {
          url = await submitReview(
            {
              repo: walkthrough.target.repo,
              number: walkthrough.target.number,
            },
            buildReviewPayload(walkthrough, comments),
          );
        } catch (error) {
          throw error instanceof GhError ? new Error(error.message) : error;
        }
        const updated = store.update(id, (draft) => {
          draft.status = "submitted";
          draft.submittedAt = Date.now();
          draft.submittedUrl = url || null;
        });
        changed(updated);
        return { url: updated.submittedUrl };
      }
      if (
        countComments(comments).kept === 0 &&
        walkthrough.summary.trim() === ""
      ) {
        throw new Error(
          "Keep at least one comment or write a summary before sending feedback.",
        );
      }
      await bb.sdk.threads.send({
        threadId: walkthrough.threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: formatLocalFeedback(walkthrough, comments),
            mentions: [],
          },
        ],
      });
      const updated = store.update(id, (draft) => {
        draft.status = "sent";
        draft.submittedAt = Date.now();
      });
      changed(updated);
      return { url: null };
    },
  });

  // ── CLI (the agent) ───────────────────────────────────────────────────
  const requireThread = (threadId: string | undefined): string => {
    if (threadId === undefined) {
      throw new PluginCliError(
        "Run this from a BB thread; the walkthrough opens beside it.",
        {
          code: "thread_required",
          hint: "Agents run `bb walkthrough` inside their thread, where BB_THREAD_ID is set.",
        },
      );
    }
    return threadId;
  };

  const asCliError = (error: unknown): never => {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(
      error instanceof Error ? error.message : String(error),
      { code: "failed" },
    );
  };

  bb.cli.register(
    defineCli({
      name: "walkthrough",
      summary:
        "Hand the user a guided review walkthrough with draft comments they publish",
      commands: {
        hunks: cliCommand({
          summary:
            "List the hunk ids of a diff, to anchor walkthrough stops and comments",
          options: {
            pr: {
              type: "string",
              description:
                "Pull request: URL, owner/repo#123, or a number in this project's repo",
            },
            local: {
              type: "enum",
              values: ["uncommitted", "branch", "all"],
              description:
                "This thread's checkout: uncommitted changes, branch commits vs base, or both",
            },
            commit: {
              type: "string",
              description: "One commit SHA in this thread's checkout",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          constraints: [
            { kind: "exactly-one", options: ["pr", "local", "commit"] },
          ],
          async run(input, ctx) {
            const threadId = requireThread(ctx.threadId);
            const target: TargetInput =
              input.options.pr !== undefined
                ? { pr: input.options.pr }
                : input.options.commit !== undefined
                  ? { commit: input.options.commit }
                  : { local: input.options.local! };
            const snapshot = await threadContext(bb, threadId)
              .then((context) =>
                snapshotTarget(bb, context, target, ctx.signal),
              )
              .catch(asCliError);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  target: snapshot.target,
                  files: snapshot.files.map((file) => ({
                    path: file.path,
                    status: file.status,
                    binary: file.binary,
                    hunks: file.hunks.map((h) => ({
                      id: h.id,
                      header: h.header,
                      ...hunkStats(h),
                    })),
                  })),
                }),
              };
            }
            return {
              exitCode: 0,
              stdout: formatHunks(
                describeTarget(snapshot.target),
                snapshot.files,
              ),
            };
          },
        }),

        submit: cliCommand({
          summary:
            "Validate a walkthrough JSON file and open it beside this thread",
          options: {
            file: {
              type: "string",
              required: true,
              description: "Path to the walkthrough JSON",
            },
          },
          async run(input, ctx) {
            const threadId = requireThread(ctx.threadId);
            const context = await threadContext(bb, threadId).catch(asCliError);
            const path = isAbsolute(input.options.file)
              ? input.options.file
              : resolvePath(ctx.cwd ?? "/", input.options.file);
            // The file lives on the machine running the thread, which may not be the server.
            const file = await bb.sdk.files
              .read({
                path,
                ...(context.hostId ? { hostId: context.hostId } : {}),
              })
              .catch(asCliError);
            if (file.contentEncoding !== "utf8") {
              throw new PluginCliError(`${path} is not a UTF-8 text file.`, {
                code: "invalid_file",
              });
            }
            let raw: unknown;
            try {
              raw = JSON.parse(file.content);
            } catch (error) {
              throw new PluginCliError(
                `${path} is not valid JSON: ${(error as Error).message}`,
                {
                  code: "invalid_json",
                },
              );
            }
            const parsed = documentSchema.safeParse(raw);
            if (!parsed.success) {
              return {
                exitCode: 1,
                stderr: [
                  "The walkthrough does not match the schema:",
                  ...formatIssues(parsed.error),
                ].join("\n"),
              };
            }
            const snapshot = await snapshotTarget(
              bb,
              context,
              parsed.data.target,
              ctx.signal,
            ).catch(asCliError);
            if (snapshot.files.length === 0) {
              throw new PluginCliError(
                `${describeTarget(snapshot.target)} has no changes.`,
                { code: "empty_diff" },
              );
            }
            const resolution = resolveDocument(parsed.data, snapshot.files);
            if (!resolution.ok) {
              return {
                exitCode: 1,
                stderr: [
                  `The walkthrough does not match ${describeTarget(snapshot.target)}:`,
                  ...resolution.errors,
                ].join("\n"),
              };
            }
            const walkthrough = store.create({
              threadId,
              projectId: context.projectId,
              target: snapshot.target,
              files: snapshot.files,
              resolved: resolution.walkthrough,
            });
            bb.realtime.publish(WALKTHROUGH_READY, {
              id: walkthrough.id,
              threadId,
            });
            changed(walkthrough);
            const stops = walkthrough.chapters.reduce(
              (sum, chapter) => sum + chapter.stops.length,
              0,
            );
            return {
              exitCode: 0,
              stdout: [
                `Walkthrough ${walkthrough.id} is open beside this thread: ${walkthrough.chapters.length} chapters, ` +
                  `${stops} stops, ${resolution.walkthrough.comments.length} draft comments on ${describeTarget(snapshot.target)}.`,
                "End your reply with this line, on its own, so the user can open it:",
                "",
                `::walkthrough{id="${walkthrough.id}"}`,
              ].join("\n"),
            };
          },
        }),

        show: cliCommand({
          summary: "Show a walkthrough's comments and the reviewer's decisions",
          positionals: [
            {
              name: "id",
              description: "Walkthrough id (wt_…)",
              required: true,
            },
          ],
          options: {
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input) {
            let result;
            try {
              result = store.get(input.positionals.id);
            } catch (error) {
              if (error instanceof NotFoundError) {
                throw new PluginCliError(error.message, {
                  code: "not_found",
                  hint: "Run `bb walkthrough list` for ids.",
                });
              }
              throw error;
            }
            const { walkthrough, comments } = result;
            if (input.options.json) {
              const { files: _files, ...rest } = walkthrough;
              return {
                exitCode: 0,
                stdout: JSON.stringify({ walkthrough: rest, comments }),
              };
            }
            const counts = countComments(comments);
            const lines = [
              `${walkthrough.id}  ${walkthrough.title}`,
              `${describeTarget(walkthrough.target)} · ${walkthrough.status}${walkthrough.submittedUrl ? ` · ${walkthrough.submittedUrl}` : ""}`,
              `${counts.kept} kept · ${counts.pending} undecided · ${counts.discarded} discarded`,
              "",
              ...comments.map(
                (comment) =>
                  `[${comment.status}] ${comment.author === "you" ? "(reviewer) " : ""}${comment.path}:${comment.line}  ` +
                  comment.body.split("\n")[0]!.slice(0, 120),
              ),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),

        delete: cliCommand({
          summary: "Delete a walkthrough and its draft comments",
          positionals: [
            {
              name: "id",
              description: "Walkthrough id (wt_…)",
              required: true,
            },
          ],
          async run(input) {
            const { threadId } = (() => {
              try {
                return store.get(input.positionals.id).walkthrough;
              } catch {
                throw new PluginCliError(
                  `No walkthrough with id ${input.positionals.id}`,
                  {
                    code: "not_found",
                    hint: "Run `bb walkthrough list` for ids.",
                  },
                );
              }
            })();
            store.remove(input.positionals.id);
            changed({ id: input.positionals.id, threadId });
            return { exitCode: 0, stdout: `Deleted ${input.positionals.id}` };
          },
        }),

        list: cliCommand({
          summary: "List recent walkthroughs",
          options: {
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input) {
            const walkthroughs = store.list(50);
            if (input.options.json)
              return { exitCode: 0, stdout: JSON.stringify(walkthroughs) };
            if (walkthroughs.length === 0)
              return { exitCode: 0, stdout: "No walkthroughs yet." };
            return {
              exitCode: 0,
              stdout: walkthroughs
                .map(
                  (entry) =>
                    `${entry.id}  ${entry.status.padEnd(9)} ${describeTarget(entry.target)}  ${entry.title}`,
                )
                .join("\n"),
            };
          },
        }),
      },
    }),
  );
}

function formatHunks(label: string, files: readonly DiffFile[]): string {
  if (files.length === 0) return `${label}: no changes.`;
  const out = [`${label}: ${files.length} files`];
  for (const file of files) {
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      const stat = hunkStats(hunk);
      additions += stat.additions;
      deletions += stat.deletions;
    }
    const rename = file.previousPath ? ` (from ${file.previousPath})` : "";
    out.push(
      "",
      `${file.path}${rename}  ${file.status}${file.binary ? ", binary" : ""}  +${additions} -${deletions}`,
    );
    for (const hunk of file.hunks) {
      const stat = hunkStats(hunk);
      out.push(
        `  ${hunk.id}  ${hunk.header}  (+${stat.additions} -${stat.deletions})`,
      );
    }
  }
  return out.join("\n");
}
