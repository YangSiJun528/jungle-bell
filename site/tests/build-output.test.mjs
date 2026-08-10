import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dist = new URL("../dist/", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, dist), "utf8");
}

test("builds the Korean post index, detail page, and custom 404", async () => {
  const [index, detail, notFound] = await Promise.all([
    read("blog/index.html"),
    read("blog/posts/welcome/index.html"),
    read("blog/404/index.html"),
  ]);

  assert.match(index, /<html lang="ko">/);
  assert.match(index, /Jungle Bell 이야기/);
  assert.match(index, /Jungle Bell 소식 페이지를 시작합니다/);
  assert.match(index, /href="\/blog\/posts\/welcome\/index\.html"/);
  assert.match(
    index,
    /<link rel="canonical" href="https:\/\/jungle-bell-api\.yangsijun5528\.workers\.dev\/blog\/index\.html">/,
  );
  assert.match(detail, /서비스 업데이트와 이용 안내를 한곳에서/);
  assert.match(
    detail,
    /<link rel="canonical" href="https:\/\/jungle-bell-api\.yangsijun5528\.workers\.dev\/blog\/posts\/welcome\/index\.html">/,
  );
  assert.match(detail, /href="\/blog\/api\/posts\.json"/);
  assert.match(notFound, /페이지를 찾을 수 없어요/);
  assert.match(notFound, /href="\/blog\/index\.html"/);
  assert.match(
    notFound,
    /<link rel="canonical" href="https:\/\/jungle-bell-api\.yangsijun5528\.workers\.dev\/blog\/404\.html">/,
  );
});

test("publishes stable list and Markdown detail JSON contracts", async () => {
  const [list, detail] = await Promise.all([
    read("blog/api/posts.json"),
    read("blog/api/posts/welcome.json"),
  ]).then((files) => files.map(JSON.parse));

  assert.equal(list.version, 1);
  assert.equal(list.posts.length, 1);
  assert.deepEqual(Object.keys(list.posts[0]).sort(), [
    "category",
    "description",
    "publishedAt",
    "slug",
    "tags",
    "title",
    "updatedAt",
  ]);
  assert.equal(list.posts[0].slug, "welcome");
  assert.equal("bodyMarkdown" in list.posts[0], false);

  assert.equal(detail.version, 1);
  assert.equal(detail.post.slug, "welcome");
  assert.match(detail.post.bodyMarkdown, /^Jungle Bell/m);
  assert.equal("bodyHtml" in detail.post, false);
});

test("publishes a valid RSS feed without a standalone Worker configuration", async () => {
  const rss = await read("blog/rss.xml");

  assert.match(rss, /<rss[^>]+version="2\.0"/);
  assert.match(rss, /Jungle Bell 소식 페이지를 시작합니다/);
  assert.match(rss, /\/blog\/index\.html/);
  assert.match(rss, /\/blog\/posts\/welcome\/index\.html/);
  await assert.rejects(readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
});

test("keeps the staged blog output self-contained", async () => {
  const index = await read("blog/index.html");
  assert.match(index, /<style>[\s\S]*Pretendard[\s\S]*<\/style>/);
  assert.doesNotMatch(index, /<link[^>]+rel="stylesheet"[^>]+https?:\/\//);
});
