// Chapter icons: a small vocabulary agents choose from, mapped to icons bb
// ships. Shared by the server (validation) and the app (rendering).

export const CHAPTER_ICONS = {
  ui: "AppWindow",
  components: "Puzzle",
  styles: "Palette",
  logic: "Code",
  types: "Code",
  api: "Cloud",
  data: "Layers",
  tests: "Beaker",
  docs: "FileText",
  config: "Settings",
  build: "Workflow",
  deps: "PackageReceive",
  i18n: "Globe",
  security: "SecurityCheck",
  performance: "Zap",
  bug: "Bug",
  refactor: "Clean",
  cli: "Terminal",
  icons: "Star",
  other: "Layers",
} as const;

export type ChapterIcon = keyof typeof CHAPTER_ICONS;

export const CHAPTER_ICON_NAMES = Object.keys(CHAPTER_ICONS) as [
  ChapterIcon,
  ...ChapterIcon[],
];

// First match wins, so specific words come before broad ones.
const KEYWORDS: [RegExp, ChapterIcon][] = [
  [/\b(tests?|specs?|stories|storybook|coverage|fixtures?)\b/i, "tests"],
  [/\b(i18n|l10n|locales?|translations?|copy|strings)\b/i, "i18n"],
  [/\b(styles?|css|scss|themes?|layout|design)\b/i, "styles"],
  [/\b(icons?|assets?|images?)\b/i, "icons"],
  [/\b(docs?|readme|documentation|comments?)\b/i, "docs"],
  [/\b(auth|security|permissions?|secrets?)\b/i, "security"],
  [/\b(deps|dependenc(y|ies)|packages?|upgrade|bump)\b/i, "deps"],
  [/\b(build|ci|pipeline|deploy|release)\b/i, "build"],
  [/\b(config|settings|flags?|env)\b/i, "config"],
  [/\b(api|endpoints?|server|graphql|rpc|routes?)\b/i, "api"],
  [/\b(data|db|database|schema|migrations?|models?|queries)\b/i, "data"],
  [/\b(types?|interfaces?)\b/i, "types"],
  [/\b(perf|performance|speed|cache|caching)\b/i, "performance"],
  [/\b(fix|bugs?|regression)\b/i, "bug"],
  [/\b(refactor|cleanup|clean|rename|tidy)\b/i, "refactor"],
  [/\b(cli|commands?|scripts?)\b/i, "cli"],
  [/\b(ui|views?|pages?|screens?|banners?|modals?|forms?)\b/i, "ui"],
  [/\b(components?)\b/i, "components"],
];

/** A fitting icon for a chapter title the agent gave no icon for. */
export function inferChapterIcon(title: string): ChapterIcon {
  for (const [pattern, icon] of KEYWORDS) if (pattern.test(title)) return icon;
  return "logic";
}
