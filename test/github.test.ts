import { describe, expect, it } from "vitest";
import { parsePrRef, signImages } from "../src/github";

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
});
