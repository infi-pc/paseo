import { describe, expect, it } from "vitest";
import { getAlternativePages } from "~/data/alternative-pages";
import { getDocs } from "~/docs";
import type { Locale } from "~/i18n";
import { getLegalDocument, type LegalDocumentName } from "~/legal";
import { getPosts } from "~/posts";

/**
 * First-party pages paired by path, including English fallbacks for untranslated pages.
 * FORK(english-only): existing translations may lag behind English content edits.
 */
interface ContentPair {
  path: string;
  english: { content: string; locale: Locale };
  chinese: { content: string; locale: Locale };
}

const LEGAL_DOCUMENTS: LegalDocumentName[] = ["privacy", "terms"];

function pairs<T extends { content: string; locale: Locale }>(
  english: T[],
  chinese: T[],
  pathOf: (page: T) => string,
): ContentPair[] {
  const byPath = new Map(chinese.map((page) => [pathOf(page), page]));
  return english.map((page) => ({
    path: pathOf(page),
    english: page,
    chinese: byPath.get(pathOf(page)) ?? { content: "", locale: "en" },
  }));
}

const CONTENT: ContentPair[] = [
  ...pairs(getDocs("en"), getDocs("zh-CN"), (doc) => doc.href),
  ...pairs(getPosts("en"), getPosts("zh-CN"), (post) => `/blog/${post.slug}`),
  ...pairs(getAlternativePages("en"), getAlternativePages("zh-CN"), (page) => page.href),
  ...LEGAL_DOCUMENTS.map((name) => ({
    path: `/${name}`,
    english: getLegalDocument(name, "en"),
    chinese: getLegalDocument(name, "zh-CN"),
  })),
];

describe("First-party localized content", () => {
  it("serves content for every first-party path in both locales", () => {
    expect(CONTENT.length).toBeGreaterThan(70);
    const missing = CONTENT.filter(
      (pair) => !pair.english.content.trim() || !pair.chinese.content.trim(),
    ).map((pair) => pair.path);
    expect(missing).toEqual([]);
  });

  it("uses the current English content when a translation is unavailable", () => {
    const staleFallbacks = CONTENT.filter(
      (pair) => pair.chinese.locale === "en" && pair.chinese.content !== pair.english.content,
    ).map((pair) => pair.path);
    expect(staleFallbacks).toEqual([]);
  });
});
