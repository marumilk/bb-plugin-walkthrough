// Walkthroughs and their draft comments in the plugin's own SQLite database.
// Rows keep their payload as JSON; the columns exist only for lookups.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { DiffFile } from "./diff";
import type { ResolvedWalkthrough } from "./document";
import {
  countComments,
  type Discussion,
  type DraftComment,
  type Target,
  type Walkthrough,
  type WalkthroughSummary,
} from "./model";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

const MIGRATIONS = [
  `CREATE TABLE walkthroughs (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX walkthroughs_thread ON walkthroughs (thread_id, created_at)`,
  `CREATE TABLE comments (
     id TEXT PRIMARY KEY,
     walkthrough_id TEXT NOT NULL REFERENCES walkthroughs (id) ON DELETE CASCADE,
     ord INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX comments_walkthrough ON comments (walkthrough_id, ord)`,
  `CREATE TABLE discussions (
     id TEXT PRIMARY KEY,
     walkthrough_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     waiting INTEGER NOT NULL DEFAULT 0,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX discussions_walkthrough ON discussions (walkthrough_id, created_at)`,
];

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class NotFoundError extends Error {}

export function createStore(bb: BbPluginApi) {
  const db: Database = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const readWalkthrough = (id: string): Walkthrough => {
    const row = db
      .prepare("SELECT data FROM walkthroughs WHERE id = ?")
      .get(id) as { data: string } | undefined;
    if (row === undefined)
      throw new NotFoundError(`No walkthrough with id ${id}`);
    return JSON.parse(row.data) as Walkthrough;
  };

  const writeWalkthrough = (walkthrough: Walkthrough): void => {
    db.prepare(
      "UPDATE walkthroughs SET updated_at = ?, data = ? WHERE id = ?",
    ).run(walkthrough.updatedAt, JSON.stringify(walkthrough), walkthrough.id);
  };

  const readComments = (walkthroughId: string): DraftComment[] => {
    const rows = db
      .prepare(
        "SELECT data FROM comments WHERE walkthrough_id = ? ORDER BY ord",
      )
      .all(walkthroughId) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as DraftComment);
  };

  const writeComment = (comment: DraftComment): void => {
    db.prepare(
      `INSERT INTO comments (id, walkthrough_id, ord, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
    ).run(
      comment.id,
      comment.walkthroughId,
      comment.ord,
      JSON.stringify(comment),
    );
  };

  const touch = (id: string): void => {
    const now = Date.now();
    db.prepare(
      "UPDATE walkthroughs SET updated_at = ?, data = json_set(data, '$.updatedAt', ?) WHERE id = ?",
    ).run(now, now, id);
  };

  const readDiscussion = (
    walkthroughId: string,
    discussionId: string,
  ): Discussion => {
    const row = db
      .prepare(
        "SELECT data FROM discussions WHERE walkthrough_id = ? AND id = ?",
      )
      .get(walkthroughId, discussionId) as { data: string } | undefined;
    if (row === undefined) {
      throw new NotFoundError(`No conversation with id ${discussionId}`);
    }
    return JSON.parse(row.data) as Discussion;
  };

  const summarize = (walkthrough: Walkthrough): WalkthroughSummary => ({
    id: walkthrough.id,
    threadId: walkthrough.threadId,
    title: walkthrough.title,
    target: walkthrough.target,
    status: walkthrough.status,
    createdAt: walkthrough.createdAt,
    updatedAt: walkthrough.updatedAt,
    submittedUrl: walkthrough.submittedUrl,
    counts: countComments(readComments(walkthrough.id)),
  });

  return {
    create(input: {
      threadId: string;
      projectId: string | null;
      target: Target;
      files: DiffFile[];
      resolved: ResolvedWalkthrough;
    }): Walkthrough {
      const now = Date.now();
      const walkthrough: Walkthrough = {
        id: newId("wt"),
        threadId: input.threadId,
        projectId: input.projectId,
        createdAt: now,
        updatedAt: now,
        target: input.target,
        title: input.resolved.title,
        focus: input.resolved.focus,
        chapters: input.resolved.chapters,
        files: input.files,
        summary: input.resolved.summary,
        verdict: input.resolved.verdict,
        status: "open",
        submittedAt: null,
        submittedUrl: null,
        currentStopId: null,
      };
      db.transaction(() => {
        db.prepare(
          "INSERT INTO walkthroughs (id, thread_id, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)",
        ).run(
          walkthrough.id,
          walkthrough.threadId,
          now,
          now,
          JSON.stringify(walkthrough),
        );
        input.resolved.comments.forEach((comment, ord) => {
          writeComment({
            id: newId("cm"),
            walkthroughId: walkthrough.id,
            ord,
            author: "agent",
            path: comment.path,
            side: comment.side,
            line: comment.line,
            startLine: comment.startLine,
            severity: comment.severity,
            originalBody: comment.body,
            body: comment.body,
            status: "pending",
            hunkId: comment.hunkId,
            stopId: comment.stopId,
          });
        });
      })();
      return walkthrough;
    },

    get(id: string): { walkthrough: Walkthrough; comments: DraftComment[] } {
      return { walkthrough: readWalkthrough(id), comments: readComments(id) };
    },

    update(
      id: string,
      change: (walkthrough: Walkthrough) => void,
    ): Walkthrough {
      const walkthrough = readWalkthrough(id);
      change(walkthrough);
      walkthrough.updatedAt = Date.now();
      writeWalkthrough(walkthrough);
      return walkthrough;
    },

    latestForThread(threadId: string): WalkthroughSummary | null {
      const row = db
        .prepare(
          "SELECT data FROM walkthroughs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(threadId) as { data: string } | undefined;
      return row === undefined
        ? null
        : summarize(JSON.parse(row.data) as Walkthrough);
    },

    list(limit: number): WalkthroughSummary[] {
      const rows = db
        .prepare(
          "SELECT data FROM walkthroughs ORDER BY updated_at DESC LIMIT ?",
        )
        .all(limit) as { data: string }[];
      return rows.map((row) => summarize(JSON.parse(row.data) as Walkthrough));
    },

    /** The newest walkthrough of one pull request, for the inbox. */
    latestForPr(repo: string, number: number): WalkthroughSummary | null {
      const row = db
        .prepare(
          `SELECT data FROM walkthroughs
           WHERE json_extract(data, '$.target.kind') = 'pr'
             AND lower(json_extract(data, '$.target.repo')) = lower(?)
             AND json_extract(data, '$.target.number') = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(repo, number) as { data: string } | undefined;
      return row === undefined
        ? null
        : summarize(JSON.parse(row.data) as Walkthrough);
    },

    updateComment(
      walkthroughId: string,
      commentId: string,
      change: (comment: DraftComment) => void,
    ): DraftComment {
      const comment = readComments(walkthroughId).find(
        (candidate) => candidate.id === commentId,
      );
      if (comment === undefined)
        throw new NotFoundError(`No comment with id ${commentId}`);
      change(comment);
      writeComment(comment);
      touch(walkthroughId);
      return comment;
    },

    addComment(
      walkthroughId: string,
      comment: Omit<DraftComment, "id" | "walkthroughId" | "ord">,
    ): DraftComment {
      const existing = readComments(walkthroughId);
      const created: DraftComment = {
        ...comment,
        id: newId("cm"),
        walkthroughId,
        ord:
          existing.reduce(
            (max, candidate) => Math.max(max, candidate.ord),
            -1,
          ) + 1,
      };
      writeComment(created);
      touch(walkthroughId);
      return created;
    },

    /** Removes a walkthrough and its comments; false when it did not exist. */
    remove(id: string): boolean {
      // Comments go first; the foreign key cascade needs PRAGMA foreign_keys.
      return db.transaction(() => {
        db.prepare("DELETE FROM comments WHERE walkthrough_id = ?").run(id);
        db.prepare("DELETE FROM discussions WHERE walkthrough_id = ?").run(id);
        return (
          db.prepare("DELETE FROM walkthroughs WHERE id = ?").run(id).changes >
          0
        );
      })();
    },

    discussions(walkthroughId: string): Discussion[] {
      const rows = db
        .prepare(
          "SELECT data FROM discussions WHERE walkthrough_id = ? ORDER BY created_at",
        )
        .all(walkthroughId) as { data: string }[];
      return rows.map((row) => JSON.parse(row.data) as Discussion);
    },

    /** Walkthroughs whose summary the agent is still rewriting. */
    rewritingSummaries(): Walkthrough[] {
      const rows = db
        .prepare(
          "SELECT data FROM walkthroughs WHERE json_extract(data, '$.summaryJob.messageId') IS NOT NULL",
        )
        .all() as { data: string }[];
      return rows.map((row) => JSON.parse(row.data) as Walkthrough);
    },

    /** Conversations still waiting for an answer, across all walkthroughs. */
    waitingDiscussions(): Discussion[] {
      const rows = db
        .prepare("SELECT data FROM discussions WHERE waiting = 1")
        .all() as { data: string }[];
      return rows.map((row) => JSON.parse(row.data) as Discussion);
    },

    getDiscussion: readDiscussion,

    createDiscussion(
      discussion: Omit<Discussion, "id" | "createdAt" | "updatedAt">,
    ): Discussion {
      const now = Date.now();
      const created: Discussion = {
        ...discussion,
        id: newId("dc"),
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        "INSERT INTO discussions (id, walkthrough_id, created_at, waiting, data) VALUES (?, ?, ?, ?, ?)",
      ).run(
        created.id,
        created.walkthroughId,
        now,
        created.waiting ? 1 : 0,
        JSON.stringify(created),
      );
      return created;
    },

    updateDiscussion(
      walkthroughId: string,
      discussionId: string,
      change: (discussion: Discussion) => void,
    ): Discussion {
      return db.transaction(() => {
        const discussion = readDiscussion(walkthroughId, discussionId);
        change(discussion);
        discussion.updatedAt = Date.now();
        db.prepare(
          "UPDATE discussions SET waiting = ?, data = ? WHERE id = ?",
        ).run(
          discussion.waiting ? 1 : 0,
          JSON.stringify(discussion),
          discussion.id,
        );
        return discussion;
      })();
    },

    deleteDiscussion(walkthroughId: string, discussionId: string): void {
      db.prepare(
        "DELETE FROM discussions WHERE walkthrough_id = ? AND id = ?",
      ).run(walkthroughId, discussionId);
    },

    deleteComment(walkthroughId: string, commentId: string): void {
      db.prepare(
        "DELETE FROM comments WHERE walkthrough_id = ? AND id = ?",
      ).run(walkthroughId, commentId);
      touch(walkthroughId);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
