import { describe, expect, it } from "vitest";
import { githubFileUrl } from "../src/model";

describe("githubFileUrl", () => {
  const browse = { repo: "acme/app", ref: "feat/retry" };

  it("links a file on a branch at a line", () => {
    expect(githubFileUrl(browse, "src/deliver.ts", 13)).toBe(
      "https://github.com/acme/app/blob/feat/retry/src/deliver.ts#L13",
    );
  });

  it("escapes what is not a path separator", () => {
    expect(
      githubFileUrl({ repo: "acme/app", ref: "fix/#12" }, "docs/a b?.md", null),
    ).toBe("https://github.com/acme/app/blob/fix/%2312/docs/a%20b%3F.md");
  });
});
