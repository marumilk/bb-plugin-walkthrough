// The first step of a pull request walkthrough: the PR as its author
// described it, before the agent's guided path through the diff.
import { useEffect, useState } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { Target } from "../src/model";
import type { Rpc } from "./shared";

export function OverviewStep({
  walkthroughId,
  target,
  focus,
  rpc,
}: {
  walkthroughId: string;
  target: Extract<Target, { kind: "pr" }>;
  focus: string | null;
  rpc: Rpc;
}) {
  // The stored copy shows at once; the live one replaces it with any edits
  // and with image URLs the webview is allowed to load.
  const [live, setLive] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc.call("prDescription", { id: walkthroughId }).then(
      (result) => {
        if (!cancelled) setLive(result.body);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, walkthroughId]);
  const source = live ?? target.body;
  const body = source?.trim() ?? "";
  return (
    <div className="space-y-4">
      <section className="w-full rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-medium text-muted-foreground">
          Pull request description
        </p>
        <h2 className="mt-1 text-lg font-semibold leading-7">{target.title}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <Icon name="GitPullRequest" className="size-3.5" aria-hidden="true" />
          <span>
            {target.repo}#{target.number} by {target.author}
          </span>
          <span aria-hidden="true">·</span>
          <UrlLink href={target.url}>Open on GitHub</UrlLink>
        </p>
        <div className="mt-3 border-t border-border pt-3">
          {body === "" ? (
            <p className="text-sm text-muted-foreground">
              {source === undefined || source === null
                ? "This walkthrough was made before descriptions were captured."
                : "The author left no description."}
            </p>
          ) : (
            <Markdown
              content={body}
              className="min-w-0 text-sm leading-6 [&_img]:max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto"
            />
          )}
        </div>
      </section>
      {focus ? (
        <section className="w-full rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">
            What to focus on
          </p>
          <Markdown content={focus} className="mt-1 text-sm leading-6" />
        </section>
      ) : null}
    </div>
  );
}
