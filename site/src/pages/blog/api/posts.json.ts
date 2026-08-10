import type {APIRoute} from 'astro';
import {postSummary, publishedPosts} from '../../../lib/posts';

export const GET: APIRoute = async () => Response.json({
    version: 1,
    posts: (await publishedPosts()).map(postSummary),
});
