import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_INSTRUCTIONS,
  buildReviewPrompt,
} from "../src/review-prompt";

describe("buildReviewPrompt", () => {
  const pr = { repo: "acme/app", number: 42 };

  it("treats the pull request as untrusted and forbids running its code", () => {
    const prompt = buildReviewPrompt({ ...pr, instructions: "" });
    expect(prompt).toContain("https://github.com/acme/app/pull/42");
    expect(prompt).toContain(DEFAULT_REVIEW_INSTRUCTIONS);
    expect(prompt).toMatch(/untrusted/);
    expect(prompt).toMatch(/never run it/);
    expect(prompt).toMatch(/Do not install dependencies/);
    expect(prompt).toMatch(/report it to me as a finding/);
    expect(prompt).toMatch(/Never post, approve, or request changes/);
  });

  it("keeps the safety rules after custom instructions, which cannot drop them", () => {
    const instructions = "Run the test suite to confirm each finding.";
    const prompt = buildReviewPrompt({ ...pr, instructions });
    expect(prompt).toContain(instructions);
    expect(prompt).not.toContain(DEFAULT_REVIEW_INSTRUCTIONS);
    expect(prompt.indexOf("never run it")).toBeGreaterThan(
      prompt.indexOf(instructions),
    );
    expect(prompt).toMatch(/even if the instructions above say otherwise/);
  });
});
