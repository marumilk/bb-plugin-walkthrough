// bb-plugin-walkthrough — server entry.
//
// An agent reviews a change and submits a walkthrough document with
// `bb walkthrough submit`. The server snapshots the diff, validates every hunk
// and comment anchor against it, and stores the result. The app renders it as
// a guided, stop-by-stop review in a thread tab where the reviewer keeps,
// edits, or discards each draft comment, then posts one GitHub review (pull
// requests) or sends the feedback back to the agent (local changes).
import { randomUUID } from "node:crypto";
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
  fetchPrDescription,
  compareCommits,
  listReviewRequests,
  repoFromRemote,
  submitReview,
} from "./src/github";
import {
  AgentAnswerError,
  awaitAnswer,
  latestSeq,
  sendQuestion,
} from "./src/agent";
import { buildQuestionPrompt, buildSummaryPrompt } from "./src/conversation";
import {
  countComments,
  describeTarget,
  viewedKey,
  type Discussion,
  type DraftComment,
  type Walkthrough,
  type WalkthroughSummary,
} from "./src/model";
import { createStore, NotFoundError } from "./src/store";
import {
  buildReviewPayload,
  formatLocalFeedback,
  keptComments,
  reviewBlockers,
  summaryBasis,
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
      discussions: z.array(z.custom<Discussion>()),
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
  setViewed: {
    input: z
      .object({
        id: z.string(),
        stopId: z.string(),
        path: z.string(),
        viewed: z.boolean(),
      })
      .strict(),
    output: z.object({ viewed: z.array(z.string()) }),
  },
  setProgress: {
    input: z.object({ id: z.string(), stopId: z.string().max(40) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  headStatus: {
    input: walkthroughId,
    output: z.object({
      moved: z.boolean(),
      /** Commits the PR gained since the snapshot; null for local changes. */
      behindBy: z.number().int().nullable(),
      /** The branch was rewritten (force-pushed) since the snapshot. */
      diverged: z.boolean(),
    }),
  },
  submit: {
    input: walkthroughId,
    output: z.object({ url: z.string().nullable() }),
  },

  // Private conversations with the agent. Never posted or sent as feedback.
  ask: {
    input: z
      .object({
        id: z.string(),
        body: z.string().trim().min(1).max(20000),
        /** Continue this conversation, or start one at `target`. */
        discussionId: z.string().optional(),
        target: z
          .object({
            stopId: z.string(),
            commentId: z.string().nullable(),
            anchor: z
              .object({
                path: z.string().min(1),
                side: z.enum(["LEFT", "RIGHT"]),
                line: z.number().int().positive(),
                startLine: z.number().int().positive().nullable(),
              })
              .strict()
              .nullable(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    output: z.object({ discussion: z.custom<Discussion>() }),
  },
  prDescription: {
    input: walkthroughId,
    output: z.object({ body: z.string().nullable() }),
  },
  rewriteSummary: {
    input: walkthroughId,
    output: z.object({ ok: z.literal(true) }),
  },
  undoSummaryRewrite: {
    input: walkthroughId,
    output: z.object({ ok: z.literal(true) }),
  },
  resolveDiscussion: {
    input: z
      .object({
        id: z.string(),
        discussionId: z.string(),
        resolved: z.boolean(),
      })
      .strict(),
    output: z.object({ discussion: z.custom<Discussion>() }),
  },
  deleteDiscussion: {
    input: z.object({ id: z.string(), discussionId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }),
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

  // ── Conversations with the agent ──────────────────────────────────────
  const conversations = new AbortController();
  bb.onDispose(() => conversations.abort());

  /** Waits for the agent's answer and records it, or the failure. */
  const collectAnswer = (walkthrough: Walkthrough, discussion: Discussion) => {
    const waiting = discussion.waiting;
    if (waiting === null) return;
    void awaitAnswer(bb, {
      threadId: walkthrough.threadId,
      messageId: waiting.messageId,
      afterSeq: waiting.afterSeq,
      ...(waiting.visible !== undefined ? { visible: waiting.visible } : {}),
      signal: conversations.signal,
    }).then(
      (answer) => {
        store.updateDiscussion(walkthrough.id, discussion.id, (draft) => {
          draft.messages.push({
            id: newMessageId(),
            author: "agent",
            body: answer,
            at: Date.now(),
          });
          draft.waiting = null;
          draft.error = null;
        });
        changed(walkthrough);
      },
      (error: unknown) => {
        // A reload aborts the wait; the next load resumes it from the cursor.
        if (conversations.signal.aborted) return;
        bb.log.warn(`conversation ${discussion.id}: ${String(error)}`);
        store.updateDiscussion(walkthrough.id, discussion.id, (draft) => {
          draft.waiting = null;
          draft.error =
            error instanceof AgentAnswerError
              ? error.message
              : "Could not get the agent's answer.";
        });
        changed(walkthrough);
      },
    );
  };

  /** Waits for the agent's rewritten summary and puts it in place. */
  const collectSummary = (walkthrough: Walkthrough) => {
    const job = walkthrough.summaryJob;
    if (!job) return;
    void awaitAnswer(bb, {
      threadId: walkthrough.threadId,
      messageId: job.messageId,
      afterSeq: job.afterSeq,
      visible: job.visible,
      signal: conversations.signal,
    }).then(
      (answer) => {
        const updated = store.update(walkthrough.id, (draft) => {
          draft.previousSummary = draft.summary;
          draft.summary = answer;
          draft.summaryBasis = summaryBasis(store.get(walkthrough.id).comments);
          draft.summaryJob = null;
          draft.summaryError = null;
        });
        changed(updated);
      },
      (error: unknown) => {
        if (conversations.signal.aborted) return;
        bb.log.warn(`summary ${walkthrough.id}: ${String(error)}`);
        const updated = store.update(walkthrough.id, (draft) => {
          draft.summaryJob = null;
          draft.summaryError =
            error instanceof AgentAnswerError
              ? error.message
              : "Could not get the agent's summary.";
        });
        changed(updated);
      },
    );
  };

  for (const walkthrough of store.rewritingSummaries())
    collectSummary(walkthrough);

  for (const discussion of store.waitingDiscussions()) {
    try {
      collectAnswer(
        store.get(discussion.walkthroughId).walkthrough,
        discussion,
      );
    } catch {
      // Its walkthrough was deleted; nothing to resume.
    }
  }

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
    get: ({ id }) => ({ ...store.get(id), discussions: store.discussions(id) }),

    ask: async ({ id, body, discussionId, target }) => {
      const { walkthrough, comments } = store.get(id);
      const message = {
        id: newMessageId(),
        author: "you" as const,
        body,
        at: Date.now(),
      };
      let discussion: Discussion;
      if (discussionId !== undefined) {
        const existing = store.getDiscussion(id, discussionId);
        if (existing.waiting !== null) {
          throw new Error("The agent is still answering the last question.");
        }
        discussion = existing;
      } else if (target !== undefined) {
        discussion = store.createDiscussion({
          walkthroughId: id,
          stopId: target.stopId,
          anchor: resolveAnchor(walkthrough, target.anchor),
          commentId: target.commentId,
          messages: [],
          waiting: null,
          error: null,
          resolved: false,
        });
      } else {
        throw new Error(
          "Pass a conversation to continue or a place to start one.",
        );
      }
      const comment =
        comments.find((candidate) => candidate.id === discussion.commentId) ??
        null;
      const prompt = buildQuestionPrompt({
        walkthrough,
        discussion: {
          ...discussion,
          messages: [...discussion.messages, message],
        },
        comment,
        messageId: message.id,
      });
      const afterSeq = await latestSeq(bb, walkthrough.threadId);
      discussion = store.updateDiscussion(id, discussion.id, (draft) => {
        draft.messages.push(message);
        draft.waiting = {
          messageId: message.id,
          afterSeq,
          visible: prompt.visible,
        };
        draft.error = null;
        draft.resolved = false;
      });
      try {
        await sendQuestion(bb, walkthrough.threadId, prompt);
      } catch (error) {
        store.updateDiscussion(id, discussion.id, (draft) => {
          draft.waiting = null;
          draft.error = "Could not reach the agent's thread.";
        });
        changed(walkthrough);
        throw error;
      }
      collectAnswer(walkthrough, discussion);
      changed(walkthrough);
      return { discussion };
    },

    prDescription: async ({ id }) => {
      const { walkthrough } = store.get(id);
      if (walkthrough.target.kind !== "pr") return { body: null };
      const ref = {
        repo: walkthrough.target.repo,
        number: walkthrough.target.number,
      };
      try {
        return { body: await fetchPrDescription(ref) };
      } catch {
        // Offline or signed out: fall back to the copy taken at submission.
        return { body: walkthrough.target.body ?? null };
      }
    },

    rewriteSummary: async ({ id }) => {
      const walkthrough = openWalkthrough(id);
      if (walkthrough.summaryJob)
        throw new Error("The agent is already rewriting the summary.");
      const kept = keptComments(store.get(id).comments);
      const messageId = newMessageId();
      const prompt = buildSummaryPrompt({ walkthrough, kept, messageId });
      const afterSeq = await latestSeq(bb, walkthrough.threadId);
      const job = { messageId, afterSeq, visible: prompt.visible };
      store.update(id, (draft) => {
        draft.summaryJob = job;
        draft.summaryError = null;
      });
      try {
        await sendQuestion(bb, walkthrough.threadId, prompt);
      } catch (error) {
        changed(
          store.update(id, (draft) => {
            draft.summaryJob = null;
            draft.summaryError = "Could not reach the agent's thread.";
          }),
        );
        throw error;
      }
      collectSummary({ ...walkthrough, summaryJob: job });
      changed(walkthrough);
      return { ok: true as const };
    },

    undoSummaryRewrite: ({ id }) => {
      openWalkthrough(id);
      const updated = store.update(id, (draft) => {
        if (draft.previousSummary == null) return;
        draft.summary = draft.previousSummary;
        draft.previousSummary = null;
        draft.summaryBasis = null;
      });
      changed(updated);
      return { ok: true as const };
    },

    resolveDiscussion: ({ id, discussionId, resolved }) => {
      const { walkthrough } = store.get(id);
      const discussion = store.updateDiscussion(id, discussionId, (draft) => {
        draft.resolved = resolved;
      });
      changed(walkthrough);
      return { discussion };
    },

    deleteDiscussion: ({ id, discussionId }) => {
      const { walkthrough } = store.get(id);
      store.deleteDiscussion(id, discussionId);
      changed(walkthrough);
      return { ok: true as const };
    },
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
        // Editing by hand after a rewrite makes that edit the one to keep.
        if (summary !== draft.summary) draft.previousSummary = null;
        draft.summary = summary;
        draft.verdict = verdict;
      });
      changed(walkthrough);
      return { ok: true as const };
    },

    setViewed: ({ id, stopId, path, viewed }) => {
      const key = viewedKey(stopId, path);
      const walkthrough = store.update(id, (draft) => {
        const rest = (draft.viewed ?? []).filter((entry) => entry !== key);
        draft.viewed = viewed ? [...rest, key] : rest;
      });
      changed(walkthrough);
      return { viewed: walkthrough.viewed ?? [] };
    },

    setProgress: ({ id, stopId }) => {
      store.update(id, (draft) => {
        draft.currentStopId = stopId;
      });
      return { ok: true as const };
    },

    headStatus: async ({ id }) => {
      const { walkthrough } = store.get(id);
      const target = walkthrough.target;
      if (target.kind !== "pr")
        return { moved: false, behindBy: null, diverged: false };
      const info = await fetchPr({ repo: target.repo, number: target.number });
      if (info.headSha === target.headSha)
        return { moved: false, behindBy: 0, diverged: false };
      const comparison = await compareCommits(
        target.repo,
        target.headSha,
        info.headSha,
      ).catch(() => null);
      // GitHub cannot compare against a commit a force-push orphaned, so a
      // failed comparison means the branch was rewritten.
      return comparison === null
        ? { moved: true, behindBy: 0, diverged: true }
        : {
            moved: true,
            behindBy: comparison.aheadBy,
            diverged: comparison.diverged,
          };
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

function newMessageId(): string {
  return `dm_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Checks a conversation's line range against the snapshot it is about. */
function resolveAnchor(
  walkthrough: Walkthrough,
  anchor: {
    path: string;
    side: "LEFT" | "RIGHT";
    line: number;
    startLine: number | null;
  } | null,
): Discussion["anchor"] {
  if (anchor === null) return null;
  const file = walkthrough.files.find(
    (candidate) => candidate.path === anchor.path,
  );
  const start = anchor.startLine ?? anchor.line;
  const hunk =
    file === undefined || start > anchor.line
      ? null
      : findHunkForRange(file, anchor.side, start, anchor.line);
  if (hunk === null)
    throw new Error(
      `${anchor.path}:${anchor.line} is not in this walkthrough's diff.`,
    );
  return {
    path: anchor.path,
    side: anchor.side,
    line: anchor.line,
    startLine: start !== anchor.line ? start : null,
    hunkId: hunk.id,
  };
}
