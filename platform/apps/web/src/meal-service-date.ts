import type { MealPost } from "./campus-client";

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const KOREAN_DATE_PATTERN =
  /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/u;
const SEPARATOR_DATE_PATTERN =
  /(?:(\d{4})[./-])?(\d{1,2})[./-](\d{1,2})/u;

export function currentKstServiceDate(nowEpochMs = Date.now()): string {
  return new Date(nowEpochMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function mealServiceDate(
  post: MealPost,
  snapshotAsOf: string,
): string {
  const titleDate =
    KOREAN_DATE_PATTERN.exec(post.title ?? "") ??
    SEPARATOR_DATE_PATTERN.exec(post.title ?? "");
  const reference = post.publishedAt ?? snapshotAsOf;
  const referenceEpochMs = Date.parse(reference);

  if (titleDate?.[2] && titleDate[3]) {
    const referenceKst = new Date(referenceEpochMs + KST_OFFSET_MS);
    const year = titleDate[1]
      ? Number(titleDate[1])
      : referenceKst.getUTCFullYear();
    const month = Number(titleDate[2]);
    const day = Number(titleDate[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() === year &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day
    ) {
      return candidate.toISOString().slice(0, 10);
    }
  }

  return new Date(referenceEpochMs + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

export function deduplicateMealPosts(
  menus: readonly MealPost[],
): readonly MealPost[] {
  const seen = new Set<string>();
  return menus.filter((menu) => {
    const key = [
      menu.id,
      menu.publishedAt ?? "",
      menu.title ?? "",
      menu.text,
    ].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
