import { cp, glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";
import { canonicalJsonSha256, sha256Bytes } from "../src/collector/hash.ts";
import {
  mealImageExtension,
  normalizeMeals,
  weeklyMealMenu,
  type MealImageAsset,
  type MealImageCandidate,
  type MealPost,
  type WeeklyMealMenu,
} from "../src/collector/meals.ts";

interface NewPostEvent {
  observed_at: string;
  post: { id: number | string };
}

interface R2Asset {
  objectKey: string;
  file: string;
  contentType: string;
}

interface ManifestEntry {
  collected_at?: string;
  posts_changed?: boolean;
  posts_snapshot?: string;
  endpoints?: { include_pinned?: { snapshot?: string; changed?: boolean } };
}

const gunzip = promisify(gunzipCallback);

const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    output: { type: "string" },
  },
});

if (!values.archive || !values.output) {
  throw new Error("Usage: npm run backfill:meals:prepare -- --archive <data-dir> --output <dir>");
}

const archiveDir = resolve(values.archive);
const outputDir = resolve(values.output);
const postFiles = await collect(glob("*.json", { cwd: join(archiveDir, "posts") }));
if (postFiles.length === 0) throw new Error(`No post JSON files found in ${join(archiveDir, "posts")}`);

const posts = await Promise.all(postFiles.map(async (file) =>
  JSON.parse(await readFile(join(archiveDir, "posts", file), "utf8")) as unknown
));
const observedAtByPost = await loadObservedAtByPost(join(archiveDir, "events", "new-posts.jsonl"));
const observedAt = [...observedAtByPost.values()].sort().at(-1) ?? new Date().toISOString();
const rawValue = { has_next: false, items: posts };
const sourceVersionSha = await canonicalJsonSha256(rawValue);
const assets = new Map<string, R2Asset>();

await mkdir(join(outputDir, "r2"), { recursive: true });
const version = await normalizeMeals(rawValue, sourceVersionSha, observedAt, archiveImage);
const normalizedPosts = [...version.pinnedMenus, ...version.dailyMenus, ...version.otherPosts];
const weeklyMenus = await loadWeeklyMenus(archiveDir, posts, observedAt, archiveImage);
await writeFile(join(outputDir, "meals.sql"), createSql(
  normalizedPosts,
  weeklyMenus,
  observedAtByPost,
  observedAt,
));
await writeFile(join(outputDir, "r2-assets.json"), `${JSON.stringify([...assets.values()], null, 2)}\n`);
await writeFile(join(outputDir, "normalized.json"), `${JSON.stringify(version, null, 2)}\n`);

const published = normalizedPosts.flatMap((post) => post.publishedAt ? [post.publishedAt] : []).sort();
const imageReferences = normalizedPosts.reduce((count, post) => count + post.images.length, 0);
const summary = {
  posts: normalizedPosts.length,
  dailyMenus: version.dailyMenus.length,
  pinnedMenus: version.pinnedMenus.length,
  weeklyMenus: weeklyMenus.length,
  otherPosts: version.otherPosts.length,
  imageReferences,
  uniqueImageAssets: assets.size,
  earliestPublishedAt: published.at(0) ?? null,
  latestPublishedAt: published.at(-1) ?? null,
  outputDir,
};
console.log(JSON.stringify(summary, null, 2));

async function archiveImage(candidate: MealImageCandidate): Promise<MealImageAsset> {
  const imageDir = join(archiveDir, "images", candidate.postId);
  const matches = await collect(glob(`${candidate.mediaId}.*`, { cwd: imageDir }));
  if (matches.length !== 1) {
    throw new Error(`Expected one local image for ${candidate.postId}/${candidate.mediaId}, found ${matches.length}`);
  }

  const sourcePath = join(imageDir, matches[0]!);
  const body = await readFile(sourcePath);
  const contentType = candidate.declaredContentType ?? contentTypeFor(sourcePath);
  if (!contentType.startsWith("image/")) throw new Error(`Unsupported content type for ${sourcePath}: ${contentType}`);

  const sha = await sha256Bytes(body);
  const extension = mealImageExtension(contentType, candidate.filename ?? sourcePath);
  const objectKey = `assets/${sha.slice(0, 2)}/${sha}.${extension}`;
  const destination = join(outputDir, "r2", objectKey);
  await mkdir(dirname(destination), { recursive: true });
  await cp(sourcePath, destination);
  assets.set(objectKey, { objectKey, file: destination, contentType });

  return {
    ...candidate,
    sha,
    objectKey,
    contentType,
    extension,
    byteLength: body.byteLength,
  };
}

async function loadObservedAtByPost(path: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  for (const line of lines) {
    const event = JSON.parse(line) as NewPostEvent;
    result.set(String(event.post.id), event.observed_at);
  }
  return result;
}

function contentTypeFor(path: string): string {
  const types: Record<string, string> = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

async function loadWeeklyMenus(
  archive: string,
  latestPosts: unknown[],
  fallbackObservedAt: string,
  archiveMealImage: (candidate: MealImageCandidate) => Promise<MealImageAsset>,
): Promise<WeeklyMealMenu[]> {
  const versions = new Map<string, { post: unknown; observedAt: string }>();
  const snapshots = new Map<string, string>();
  const addPosts = (value: unknown, observedAt: string) => {
    if (typeof value !== "object" || value === null) return;
    const items = (value as { items?: unknown }).items;
    if (!Array.isArray(items)) return;
    for (const post of items) {
      if (typeof post !== "object" || post === null || (post as { pinned?: unknown }).pinned !== true) continue;
      const candidate = post as { id?: unknown; updated_at?: unknown; media?: unknown };
      const key = JSON.stringify([candidate.id, candidate.updated_at, candidate.media]);
      versions.set(key, { post, observedAt });
    }
  };

  addPosts({ items: latestPosts }, fallbackObservedAt);
  const manifest = await readFile(join(archive, "manifest.jsonl"), "utf8");
  for (const line of manifest.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as ManifestEntry;
    const snapshot = entry.endpoints?.include_pinned?.snapshot ?? entry.posts_snapshot;
    const changed = entry.endpoints?.include_pinned?.changed ?? entry.posts_changed;
    if (snapshot && changed !== false) snapshots.set(snapshot, entry.collected_at ?? fallbackObservedAt);
  }

  for (const [snapshot, observedAt] of snapshots) {
    const raw = await gunzip(await readFile(join(archive, snapshot)));
    addPosts(JSON.parse(raw.toString("utf8")) as unknown, observedAt);
  }

  const byWeek = new Map<string, WeeklyMealMenu>();
  const orderedVersions = [...versions.values()].sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  for (const { post, observedAt } of orderedVersions) {
    const raw = { has_next: false, items: [post] };
    const normalized = await normalizeMeals(
      raw,
      await canonicalJsonSha256(raw),
      observedAt,
      archiveMealImage,
    );
    const postVersion = normalized.pinnedMenus[0];
    if (!postVersion) continue;
    const menu = await weeklyMealMenu(postVersion, observedAt);
    if (menu) byWeek.set(menu.weekKey, menu);
  }

  return [...byWeek.values()]
    .sort((left, right) => right.weekKey.localeCompare(left.weekKey));
}

function literal(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function createSql(
  posts: MealPost[],
  weeklyMenus: WeeklyMealMenu[],
  observedAtByPost: Map<string, string>,
  fallbackObservedAt: string,
): string {
  const statements: string[] = [];
  for (const post of posts) {
    const seenAt = observedAtByPost.get(post.id) ?? fallbackObservedAt;
    statements.push(`
INSERT INTO meal_post (
  id, kind, content_sha, title, text, pinned, published_at, updated_at,
  permalink, status, first_seen_at, last_seen_at
) VALUES (
  ${literal(post.id)}, ${literal(post.kind)}, ${literal(post.contentSha)},
  ${literal(post.title)}, ${literal(post.text)},
  ${post.pinned ? 1 : 0}, ${literal(post.publishedAt)}, ${literal(post.updatedAt)},
  ${literal(post.permalink)}, ${literal(post.status)}, ${literal(seenAt)}, ${literal(seenAt)}
)
ON CONFLICT(id) DO UPDATE SET
  kind = excluded.kind,
  content_sha = excluded.content_sha,
  title = excluded.title,
  text = excluded.text,
  pinned = excluded.pinned,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at,
  permalink = excluded.permalink,
  status = excluded.status,
  first_seen_at = MIN(meal_post.first_seen_at, excluded.first_seen_at),
  last_seen_at = MAX(meal_post.last_seen_at, excluded.last_seen_at);`);

    for (const [position, image] of post.images.entries()) {
      statements.push(`
INSERT INTO meal_image (
  post_id, media_id, position, source_url, declared_content_type, filename,
  width, height, sha, object_key, content_type, extension, byte_length
) VALUES (
  ${literal(post.id)}, ${literal(image.mediaId)}, ${position}, ${literal(image.sourceUrl)},
  ${literal(image.declaredContentType)}, ${literal(image.filename)}, ${literal(image.width)},
  ${literal(image.height)}, ${literal(image.sha)}, ${literal(image.objectKey)},
  ${literal(image.contentType)}, ${literal(image.extension)}, ${image.byteLength}
)
ON CONFLICT(post_id, media_id) DO UPDATE SET
  position = excluded.position,
  source_url = excluded.source_url,
  declared_content_type = excluded.declared_content_type,
  filename = excluded.filename,
  width = excluded.width,
  height = excluded.height,
  sha = excluded.sha,
  object_key = excluded.object_key,
  content_type = excluded.content_type,
  extension = excluded.extension,
  byte_length = excluded.byte_length;`);
    }
  }
  for (const menu of weeklyMenus) {
    statements.push(`
INSERT INTO meal_weekly_menu (week_key, content_sha, post_json, updated_at, observed_at)
VALUES (
  ${literal(menu.weekKey)}, ${literal(menu.contentSha)}, ${literal(JSON.stringify(menu.post))},
  ${literal(menu.post.updatedAt)}, ${literal(menu.post.updatedAt ?? fallbackObservedAt)}
)
ON CONFLICT(week_key) DO UPDATE SET
  content_sha = excluded.content_sha,
  post_json = excluded.post_json,
  updated_at = excluded.updated_at,
  observed_at = excluded.observed_at
WHERE excluded.content_sha <> meal_weekly_menu.content_sha
  AND excluded.observed_at >= meal_weekly_menu.observed_at;`);
  }
  statements.push("");
  return statements.join("\n");
}
