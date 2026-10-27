# Walkthrough

A BB plugin for guided code review.
An agent reviews a pull request or local changes and hands you a walkthrough: chapters, then stops, then the exact diff hunks, with draft inline comments under the lines they are about.
You step through it, keep, edit, or discard each draft, add your own, and publish.

- **Pull requests:** kept comments go to GitHub as one review with your summary and verdict.
- **Local changes:** kept comments go back to the agent in its thread as change requests.

Nothing is published until you press the button on the Finish step.
It replaces Codiff for both jobs.

## Using it

- In any thread, ask the agent to `/walkthrough` a PR (`/walkthrough https://github.com/org/repo/pull/123`) or its own changes.
  The Walkthrough tab opens beside the thread when the agent submits, and a card with an Open button appears in the chat.
- Or open **Reviews** in the sidebar: it lists the PRs waiting for your review.
  **Start review** runs a review thread in a fresh worktree of the matching BB project.
- In the tab, use Next and Back (or `j` and `k`) to move between stops, and the step menu to jump.
  Each stop opens with a card labelled **Review** or **Critical**; the agent can add short notes between files.
- Hover a diff line and click **+**, then **Add comment** for a review comment or **Ask agent** for a private question.
  Drag across line numbers for a range.
  **Ask agent** also sits on every draft and on each stop card.
  The question goes to the walkthrough's thread and the answer appears inline; these conversations are never posted.
- For pull requests, the first step shows the PR description as the author wrote it.
- On the Finish step, **Rewrite with agent** redrafts the review summary from the comments you kept; **Undo rewrite** restores yours.
  A note appears when your comments have changed since the summary was written.
- Check **Viewed** on a file to collapse it; the chevron opens it again.
  The step menu ticks stops whose files are all viewed.
- The header button shows how many drafts are still undecided.

## Settings

`reviewInstructions` is added to the prompt of review threads started from the Reviews page.
By default it asks for the `/code-review` skill.
Change it with `bb plugin config walkthrough set reviewInstructions "…"` or in Settings.

## Commands

| Command                                                                                   | What it does                                                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `bb walkthrough hunks --pr <ref> \| --local <uncommitted\|branch\|all> \| --commit <sha>` | Lists hunk ids to anchor stops and comments                                 |
| `bb walkthrough submit --document-stdin < <path>`                                         | Validates a walkthrough document against a fresh diff snapshot and opens it |
| `bb walkthrough show <id>`                                                                | Shows every draft and the reviewer's decision                               |
| `bb walkthrough list`                                                                     | Lists recent walkthroughs                                                   |
| `bb walkthrough delete <id>`                                                              | Deletes a walkthrough                                                       |

Inside a thread, `show`, `list`, and `delete` only reach that thread's walkthroughs; from a terminal outside any thread they reach all of them.
`submit` takes the document itself, never a path, so the plugin reads no files on an agent's behalf.

`skills/walkthrough/SKILL.md` documents the document format for agents.

## How it works

- `submit` snapshots the diff (`gh pr diff` for PRs, BB's environment diff API for local changes) and rejects any hunk id or comment line GitHub could not anchor, listing the valid ranges.
- The snapshot is stored with the walkthrough, so what you review is exactly what gets commented on.
  PR reviews post against the reviewed head commit; if the branch moved, the Finish step says so and GitHub marks changed lines as outdated.
- Hunks the agent leaves out are packed into a final "Other changes" chapter, so nothing in the diff is hidden.
- GitHub calls use the `gh` login on the BB server; the plugin stores no token.
  GitHub allows one pending review per person per PR, so finish or discard any pending review you started on github.com first.

The diff renders through the host-shimmed `@pierre/diffs` instead of bb's `experimental_Diff`, because bb's component has no slot for inline annotations.

## Development

```sh
npm install
npm test               # vitest: diff parsing, anchoring, payloads, CLI + RPC through the SDK harness
npm run check-types
bb plugin build . && bb plugin reload walkthrough
```
