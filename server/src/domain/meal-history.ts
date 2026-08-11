import type { ArchivedMealPost } from "../collector/meals";

export const MEAL_HISTORY_CURSOR_MAX_LENGTH = 2_048;

const CANONICAL_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface MealHistoryCursor {
  timestamp: string;
  postId: string;
}

function canonicalTimestamp(value: string): boolean {
  if (!CANONICAL_UTC_MILLISECONDS.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function encodeMealHistoryCursor(
  post: Pick<ArchivedMealPost, "firstSeenAt" | "id" | "publishedAt">,
): string {
  const timestamp = post.publishedAt ?? post.firstSeenAt;
  if (!canonicalTimestamp(timestamp) || post.id.length < 1 || post.id.length > 128) {
    throw new Error("Meal history post cannot be represented by a cursor");
  }
  const cursor = `${timestamp}~${encodeURIComponent(post.id)}`;
  if (cursor.length > MEAL_HISTORY_CURSOR_MAX_LENGTH) {
    throw new Error("Meal history cursor is too long");
  }
  return cursor;
}

export function decodeMealHistoryCursor(value: string): MealHistoryCursor | null {
  if (value.length < 26 || value.length > MEAL_HISTORY_CURSOR_MAX_LENGTH || value[24] !== "~") {
    return null;
  }
  const timestamp = value.slice(0, 24);
  const encodedPostId = value.slice(25);
  if (!canonicalTimestamp(timestamp) || encodedPostId.length === 0) return null;
  try {
    const postId = decodeURIComponent(encodedPostId);
    if (postId.length < 1 || postId.length > 128 || encodeURIComponent(postId) !== encodedPostId) {
      return null;
    }
    return { timestamp, postId };
  } catch {
    return null;
  }
}
