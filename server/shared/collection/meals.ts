import { z } from "zod";
import { canonicalJsonSha256 } from "./hash";
import { kstWeekKey } from "./time";

const DAY_MS = 24 * 60 * 60 * 1_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const SOURCE_WEEK_PATTERN = /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})주차/;

const mediaSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  type: z.string().optional(),
  url: z.url().optional(),
  xlarge_url: z.url().optional(),
  filename: z.string().optional(),
  mimetype: z.string().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
});

const postSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  pinned: z.boolean().default(false),
  title: z.string().nullable().optional(),
  contents: z.array(z.unknown()).default([]),
  media: z.array(mediaSchema).default([]),
  published_at: z.number().nullable().optional(),
  updated_at: z.number().nullable().optional(),
  permalink: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});

const postsResponseSchema = z.looseObject({
  has_next: z.boolean().default(false),
  items: z.array(postSchema),
});

export interface MealImageCandidate {
  postId: string;
  mediaId: string;
  sourceUrl: string;
  declaredContentType: string | null;
  filename: string | null;
  width: number | null;
  height: number | null;
}

export interface MealImageAsset extends MealImageCandidate {
  sha: string;
  objectKey: string;
  contentType: string;
  extension: string;
  byteLength: number;
}

export interface MealPost {
  id: string;
  kind: "PINNED_MENU" | "DAILY_MENU" | "OTHER";
  contentSha: string;
  title: string | null;
  text: string;
  pinned: boolean;
  publishedAt: string | null;
  updatedAt: string | null;
  permalink: string | null;
  status: string | null;
  images: MealImageAsset[];
}

export interface ArchivedMealPost extends MealPost {
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MealsVersion {
  schemaVersion: 2;
  sourceVersionSha: string;
  observedAt: string;
  hasNext: boolean;
  pinnedMenus: MealPost[];
  dailyMenus: MealPost[];
  otherPosts: MealPost[];
}

export interface WeeklyMealMenu {
  weekKey: string;
  contentSha: string;
  post: MealPost;
}

export interface CurrentWeeklyMealMenu {
  targetWeekKey: string;
  status: "AVAILABLE" | "AWAITING_UPDATE";
  contentSha: string | null;
  post: MealPost | null;
}

export type ArchiveMealImage = (candidate: MealImageCandidate) => Promise<MealImageAsset>;

function epochMillisToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function contentText(contents: unknown[]): string {
  return contents
    .flatMap((content) => {
      if (typeof content !== "object" || content === null) return [];
      const candidate = content as Record<string, unknown>;
      return candidate.t === "text" && typeof candidate.v === "string" ? [candidate.v] : [];
    })
    .join("\n");
}

function postKind(title: string | null, pinned: boolean): MealPost["kind"] {
  if (pinned) return "PINNED_MENU";
  return title && /(중식|석식)\s*메[뉴누]/.test(title) ? "DAILY_MENU" : "OTHER";
}

export function mealImageExtension(contentType: string, filename: string | null): string {
  const byContentType: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const mapped = byContentType[contentType.toLowerCase()];
  if (mapped) return mapped;
  return filename?.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "bin";
}

function secureUrl(url: string): string {
  return url.replace(/^http:\/\//, "https://");
}

export async function mealPostContentSha(
  post: Pick<MealPost, "title" | "text" | "images">,
): Promise<string> {
  return canonicalJsonSha256({
    title: post.title,
    text: post.text,
    imageShas: post.images.map((image) => image.sha),
  });
}

export async function withMealPostContentSha(
  post: Omit<MealPost, "contentSha"> | MealPost,
): Promise<MealPost> {
  const contentSha = await mealPostContentSha(post);
  return { ...post, contentSha };
}

function sourceWeekStart(year: number, month: number, week: number): Date {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysUntilMonday = (8 - firstDay.getUTCDay()) % 7;
  return new Date(firstDay.getTime() + (daysUntilMonday + (week - 1) * 7) * DAY_MS);
}

export function sourceMealWeekKey(title: string | null, reference: Date): string | null {
  const match = title?.match(SOURCE_WEEK_PATTERN);
  if (!match || Number.isNaN(reference.getTime())) return null;

  const [, explicitYear, rawMonth, rawWeek] = match;
  const month = Number(rawMonth);
  const week = Number(rawWeek);
  if (month < 1 || month > 12 || week < 1 || week > 6) return null;

  // The meal provider calls the first Monday contained in a month week 1.
  // This intentionally differs from KS/ISO majority-day week numbering.
  const referenceKst = new Date(reference.getTime() + KST_OFFSET_MS);
  const referenceYear = referenceKst.getUTCFullYear();
  const years = explicitYear
    ? [Number(explicitYear)]
    : [referenceYear, referenceYear - 1, referenceYear + 1];
  const candidates = years.map((year) => sourceWeekStart(year, month, week));
  const closest = candidates.reduce((selected, candidate) =>
    Math.abs(candidate.getTime() - reference.getTime()) < Math.abs(selected.getTime() - reference.getTime())
      ? candidate
      : selected
  );
  return closest.toISOString().slice(0, 10);
}

export function targetMealWeekKey(reference: Date): string {
  const referenceKst = new Date(reference.getTime() + KST_OFFSET_MS);
  return kstWeekKey(referenceKst.getUTCDay() === 0
    ? new Date(reference.getTime() + DAY_MS)
    : reference);
}

export async function weeklyMealMenu(
  post: MealPost,
  observedAt: string,
): Promise<WeeklyMealMenu | null> {
  const normalizedPost = await withMealPostContentSha(post);
  const observed = new Date(observedAt);
  const reference = Number.isNaN(observed.getTime())
    ? new Date(post.updatedAt ?? observedAt)
    : observed;
  const weekKey = sourceMealWeekKey(post.title, reference);
  return weekKey ? { weekKey, contentSha: normalizedPost.contentSha, post: normalizedPost } : null;
}

export function currentWeeklyMealMenu(
  menus: WeeklyMealMenu[],
  reference: Date,
): CurrentWeeklyMealMenu {
  const targetWeekKey = targetMealWeekKey(reference);
  const current = menus.find((menu) => menu.weekKey === targetWeekKey) ?? null;
  return {
    targetWeekKey,
    status: current ? "AVAILABLE" : "AWAITING_UPDATE",
    contentSha: current?.contentSha ?? null,
    post: current?.post ?? null,
  };
}

export async function normalizeMeals(
  rawValue: unknown,
  sourceVersionSha: string,
  observedAt: string,
  archiveImage: ArchiveMealImage,
): Promise<MealsVersion> {
  const parsed = postsResponseSchema.parse(rawValue);
  const posts: MealPost[] = [];

  for (const rawPost of parsed.items) {
    const postId = String(rawPost.id);
    const images: MealImageAsset[] = [];
    for (const media of rawPost.media) {
      const sourceUrl = media.xlarge_url ?? media.url;
      if (!sourceUrl || (media.type && media.type !== "image")) continue;
      images.push(await archiveImage({
        postId,
        mediaId: String(media.id),
        sourceUrl: secureUrl(sourceUrl),
        declaredContentType: media.mimetype ?? null,
        filename: media.filename ?? null,
        width: media.width ?? null,
        height: media.height ?? null,
      }));
    }

    const title = rawPost.title ?? null;
    const post = await withMealPostContentSha({
      id: postId,
      kind: postKind(title, rawPost.pinned),
      title,
      text: contentText(rawPost.contents),
      pinned: rawPost.pinned,
      publishedAt: epochMillisToIso(rawPost.published_at),
      updatedAt: epochMillisToIso(rawPost.updated_at),
      permalink: rawPost.permalink ?? null,
      status: rawPost.status ?? null,
      images,
    });
    posts.push(post);
  }

  return {
    schemaVersion: 2,
    sourceVersionSha,
    observedAt,
    hasNext: parsed.has_next,
    pinnedMenus: posts.filter((post) => post.kind === "PINNED_MENU"),
    dailyMenus: posts.filter((post) => post.kind === "DAILY_MENU"),
    otherPosts: posts.filter((post) => post.kind === "OTHER"),
  };
}
