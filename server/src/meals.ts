import { z } from "zod";

const mediaSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    type: z.string().optional(),
    url: z.string().url().optional(),
    xlarge_url: z.string().url().optional(),
    filename: z.string().optional(),
    mimetype: z.string().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const postSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    pinned: z.boolean().default(false),
    title: z.string().nullable().optional(),
    contents: z.array(z.unknown()).default([]),
    media: z.array(mediaSchema).default([]),
    published_at: z.number().nullable().optional(),
    updated_at: z.number().nullable().optional(),
    permalink: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .passthrough();

const postsResponseSchema = z
  .object({
    has_next: z.boolean().default(false),
    items: z.array(postSchema),
  })
  .passthrough();

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
  schemaVersion: 1;
  sourceVersionSha: string;
  observedAt: string;
  hasNext: boolean;
  pinnedMenus: MealPost[];
  dailyMenus: MealPost[];
  otherPosts: MealPost[];
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
  return title && /(중식|석식)\s*메뉴/.test(title) ? "DAILY_MENU" : "OTHER";
}

function secureUrl(url: string): string {
  return url.replace(/^http:\/\//, "https://");
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
    posts.push({
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
  }

  return {
    schemaVersion: 1,
    sourceVersionSha,
    observedAt,
    hasNext: parsed.has_next,
    pinnedMenus: posts.filter((post) => post.kind === "PINNED_MENU"),
    dailyMenus: posts.filter((post) => post.kind === "DAILY_MENU"),
    otherPosts: posts.filter((post) => post.kind === "OTHER"),
  };
}
