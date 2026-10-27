import { describe, expect, it } from "vitest";
import { CHAPTER_ICONS, inferChapterIcon } from "../src/icons";

describe("inferChapterIcon", () => {
  it.each([
    ["Tests", "tests"],
    ["Singular, plural, and stories", "tests"],
    ["Styles", "styles"],
    ["Locales", "i18n"],
    ["Banner", "ui"],
    ["Icon", "icons"],
    ["DB migration", "data"],
    ["Retry logic", "logic"],
  ] as const)("%s → %s", (title, icon) => {
    expect(inferChapterIcon(title)).toBe(icon);
  });

  it("maps every icon to a bb icon name", () => {
    for (const name of Object.values(CHAPTER_ICONS))
      expect(name).toMatch(/^[A-Z][A-Za-z0-9]+$/);
  });
});
