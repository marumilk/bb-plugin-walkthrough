import { describe, expect, it } from "vitest";
import { parsePrRef, repoFromRemote, signImages } from "../src/github";

describe("signImages", () => {
  const html =
    '<p><img alt="a" src="https://private-user-images.githubusercontent.com/1/a.png?jwt=x&amp;y=1"></p>' +
    '<p><img width="10" src="https://private-user-images.githubusercontent.com/1/b.png?jwt=z"></p>';

  it("swaps Markdown and HTML images for GitHub's signed URLs, in order", () => {
    const body =
      '![shot](https://github.com/user-attachments/assets/a "Shot")\n\n' +
      '<img width="10" alt="image" src="https://github.com/user-attachments/assets/b" />';
    expect(signImages(body, html)).toBe(
      '![shot](https://private-user-images.githubusercontent.com/1/a.png?jwt=x&y=1 "Shot")\n\n' +
        '<img width="10" alt="image" src="https://private-user-images.githubusercontent.com/1/b.png?jwt=z" />',
    );
  });

  it("leaves the body alone when the images cannot be paired", () => {
    const body = "![only one](https://github.com/user-attachments/assets/a)";
    expect(signImages(body, html)).toBe(body);
  });
});

describe("PR references", () => {
  it("parses URLs, short refs, and bare numbers", () => {
    expect(
      parsePrRef("https://github.com/acme/app/pull/12/files", null),
    ).toEqual({ repo: "acme/app", number: 12 });
    expect(parsePrRef("acme/app#7", null)).toEqual({
      repo: "acme/app",
      number: 7,
    });
    expect(parsePrRef(42, "acme/app")).toEqual({
      repo: "acme/app",
      number: 42,
    });
    expect(() => parsePrRef("#42", null)).toThrow(/needs a repository/);
  });

  it("accepts real repository names, with or without a PR page suffix", () => {
    expect(
      parsePrRef("https://github.com/acme/app.js/pull/12/files", null),
    ).toEqual({ repo: "acme/app.js", number: 12 });
    expect(parsePrRef("acme-co/my_repo-2#3", null)).toEqual({
      repo: "acme-co/my_repo-2",
      number: 3,
    });
  });

  it("refuses names that would reshape the GitHub API path", () => {
    for (const input of [
      "https://github.com/../../pull/1",
      "https://github.com/acme/app?x=1/pull/2",
      "https://github.com/acme/app#/pull/3",
      "https://github.com/acme/%2e%2e/pull/4",
      "../..#5",
      "acme/..#6",
    ]) {
      expect(() => parsePrRef(input, null), input).toThrow();
    }
    expect(() => parsePrRef("#7", "../evil")).toThrow();
  });

  it("refuses pull request numbers that are not positive integers", () => {
    expect(() => parsePrRef("acme/app#0", null)).toThrow();
    expect(() => parsePrRef(0, "acme/app")).toThrow();
    expect(() => parsePrRef("acme/app#99999999999999999999", null)).toThrow();
  });

  it("reads owner/repo from SSH and HTTPS remotes", () => {
    expect(repoFromRemote("git@github.com:acme/app.git")).toBe("acme/app");
    expect(repoFromRemote("ssh://git@github.com/acme/app.git")).toBe(
      "acme/app",
    );
    expect(repoFromRemote("https://github.com/acme/app")).toBe("acme/app");
    expect(repoFromRemote("https://github.com/acme/app.git/")).toBe("acme/app");
  });

  it("ignores remotes that are not on GitHub", () => {
    expect(repoFromRemote("https://gitlab.com/acme/app.git")).toBeNull();
    expect(repoFromRemote("")).toBeNull();
    expect(repoFromRemote(null)).toBeNull();
    expect(repoFromRemote("git@github.com:../evil.git")).toBeNull();
    expect(repoFromRemote("https://github.com/acme/app?x=1")).toBeNull();
  });
});
