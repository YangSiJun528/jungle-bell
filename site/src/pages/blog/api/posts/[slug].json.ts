import type {APIRoute} from 'astro';
import {getEntry} from 'astro:content';
import {postSummary, publishedPosts} from '../../../../lib/posts';

export async function getStaticPaths() {
    return (await publishedPosts()).map((post) => ({params: {slug: post.id}}));
}

export const GET: APIRoute = async ({params}) => {
    const post = params.slug ? await getEntry('posts', params.slug) : undefined;
    if (!post || post.data.draft) return new Response(null, {status: 404});
    return Response.json({
        version: 1,
        post: {
            ...postSummary(post),
            bodyMarkdown: post.body ?? '',
        },
    });
};
