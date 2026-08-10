import type {APIRoute} from 'astro';
import {postHref, publishedPosts} from '../../lib/posts';

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

export const GET: APIRoute = async ({site}) => {
    const origin = site ?? new URL('https://jungle-bell-api.yangsijun5528.workers.dev');
    const items = (await publishedPosts()).map((post) => {
        const link = new URL(postHref(post), origin).href;
        return `<item><title>${escapeXml(post.data.title)}</title><link>${escapeXml(link)}</link>`
            + `<guid>${escapeXml(link)}</guid><pubDate>${post.data.publishedAt.toUTCString()}</pubDate>`
            + `<description>${escapeXml(post.data.description)}</description></item>`;
    }).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>`
        + `<rss version="2.0"><channel><title>Jungle Bell 이야기</title>`
        + `<link>${escapeXml(new URL('/blog/index.html', origin).href)}</link>`
        + `<description>Jungle Bell의 업데이트와 이용 안내</description>${items}</channel></rss>`;
    return new Response(xml, {headers: {'content-type': 'application/rss+xml; charset=utf-8'}});
};
