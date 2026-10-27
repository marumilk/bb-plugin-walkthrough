---
name: walkthrough
description: Hand the user a guided review walkthrough in BB, with draft inline comments they keep, edit, or discard before anything is published. Use for "/walkthrough", "walk me through this PR", "review PR #123 and leave draft comments", "walk me through your changes", or when the user asks to review a change visually. Replaces Codiff.
---

# Walkthrough

A walkthrough is a guided path through a diff (chapters, then stops, then hunks) plus draft inline comments.
You write it as JSON and submit it with `bb walkthrough submit`; BB opens it in a tab beside this thread.
The user steps through it, keeps, edits, or discards each draft, adds their own, and publishes:

- **Pull request:** one GitHub review with their summary and verdict.
- **Local changes:** the kept comments come back to you in this thread as change requests.

You never publish anything yourself.
Never run `gh pr review`, `gh pr comment`, or `gh api …/reviews`, and never approve or request changes.

## 1. Pick the target

- A PR the user names (URL, `owner/repo#123`, or a number in this project's repo): `{"pr": "…"}`.
- "My changes" or your own work in this checkout: `{"local": "uncommitted"}`.
  Use `{"local": "branch"}` for the branch's commits against its base, or `{"local": "all"}` for both.
- One commit: `{"commit": "<sha>"}`.

## 2. Review the change

For a pull request, read the diff (`gh pr diff <n>`) and the surrounding code.
If this thread runs in its own worktree, `gh pr checkout <n>` there; otherwise read files at the PR head with `git fetch origin pull/<n>/head && git show FETCH_HEAD:<path>` so the user's checkout is untouched.
Use the review skills the user asked for (for example `/code-review`, without `--comment` or `--fix`).
Keep only findings that hold up after you check them against the code.

For local changes you made, the walkthrough explains your own work.
Draft comments are optional there; add them only for things you want the user to decide.

## 3. List the hunk ids

```bash
bb walkthrough hunks --pr <ref>          # or --local uncommitted|branch|all, or --commit <sha>
```

Each hunk prints as `<path>:h<n>` with its `@@ -old,len +new,len @@` header.
Anchor every stop and comment to these exact ids and line numbers.

## 4. Write the walkthrough JSON

Write it to a temporary file outside the repository, for example `$TMPDIR/walkthrough-<id>.json`.
Use a file-writing tool or a quoted heredoc (`<<'EOF'`).

```json
{
  "target": { "pr": "https://github.com/acme/app/pull/42" },
  "title": "Retry failed webhook deliveries",
  "focus": "Adds a retry queue for webhook deliveries; the risk is duplicate sends.",
  "chapters": [
    {
      "title": "Delivery",
      "blurb": "How a failed delivery is queued and retried.",
      "stops": [
        {
          "title": "Queue failed deliveries",
          "prose": "`deliver` now catches transport errors and enqueues a retry with backoff instead of dropping the event.",
          "hunks": ["src/webhooks/deliver.ts:h1", "src/webhooks/queue.ts:h1"]
        }
      ]
    }
  ],
  "comments": [
    {
      "path": "src/webhooks/deliver.ts",
      "line": 48,
      "startLine": 44,
      "side": "RIGHT",
      "severity": "issue",
      "body": "A retry after a timeout can deliver twice, because the first request may have succeeded. Could we send an idempotency key with each attempt?"
    }
  ],
  "review": {
    "summary": "Solid approach. One correctness issue around duplicate sends; the rest are nits.",
    "verdict": "COMMENT"
  }
}
```

### Shape

- `chapters`: 1-8 conceptual groups in reading order, not one per file. `title` is 1-2 words.
- `stops`: one review idea each, with a semantic title (never a file path), short `prose`, and 1-20 `hunks` in the order to read them.
  Prefer few stops: 1-2 for a tiny change, 3-5 for a focused one, at most 14 per chapter.
  Order stops by review leverage, not by file path.
  Group hunks that only make sense together; a stop must not depend on code shown in another stop.
- Each hunk id may appear in one stop at most.
  Hunks you leave out (lockfiles, snapshots, generated code, mechanical edits) are gathered into a final "Other changes" chapter automatically.
- `prose`, `blurb`, `focus`, and comment `body` are Markdown; keep them short and concrete.
  Do not invent risks, tests, or validation the diff does not show.

### Comments

- `path` and `line` are on the `side` the comment targets: `RIGHT` is the new file (added or unchanged lines), `LEFT` is the old file (removed lines).
- `startLine` makes a multi-line comment; the whole range must be inside one hunk on the same side.
- GitHub only anchors comments inside the diff. A line outside every hunk is rejected, and the error lists the valid ranges.
- `severity` is `blocker`, `issue`, `suggestion`, `nit`, `question`, or `praise`.
  It labels the draft for the user; it is not posted, so write the body exactly as it should appear on GitHub.
- Write each body to the PR author, in the user's voice: specific, kind, and actionable.
  Use a ` ```suggestion ` block when you can propose the exact replacement lines.
- `review.summary` and `review.verdict` (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`) are suggestions the user can change.
  Default to `COMMENT` unless the user asked for a verdict.

## 5. Submit

```bash
bb walkthrough submit --file "$TMPDIR/walkthrough-<id>.json"
```

The command checks every hunk id and comment anchor against a fresh snapshot of the diff.
If it fails, fix the listed problems and run it again; nothing opens until it passes.
On success it opens the tab beside this thread and prints a line like `::walkthrough{id="wt_…"}`.
End your reply with that line on its own so the user gets an Open card in the chat.
Keep the rest of the reply to a sentence or two; the walkthrough carries the detail.

## After the user publishes

- For a pull request, the review is on GitHub; there is nothing left for you to do unless asked.
- For local changes, you receive a message listing the kept comments.
  Address each one, then offer a fresh walkthrough of the result.
- `bb walkthrough show <id>` prints the user's decisions on every draft, and `bb walkthrough list` lists recent walkthroughs.
- `bb walkthrough delete <id>` removes a walkthrough you submitted by mistake.
