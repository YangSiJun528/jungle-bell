import {getCollection, type CollectionEntry} from 'astro:content';

export type Post = CollectionEntry<'posts'>;

export interface PostSummary {
    slug: string;
    title: string;
    description: string;
    publishedAt: string;
    updatedAt: string | null;
    category: string;
    tags: string[];
}

export async function publishedPosts(): Promise<Post[]> {
    const posts = await getCollection('posts', ({data}) => !data.draft);
    return posts.sort((left, right) => right.data.publishedAt.getTime() - left.data.publishedAt.getTime());
}

export function postSummary(post: Post): PostSummary {
    return {
        slug: post.id,
        title: post.data.title,
        description: post.data.description,
        publishedAt: post.data.publishedAt.toISOString(),
        updatedAt: post.data.updatedAt?.toISOString() ?? null,
        category: post.data.category,
        tags: [...post.data.tags],
    };
}

export function postHref(post: Pick<Post, 'id'>): string {
    return `/blog/posts/${encodeURIComponent(post.id)}/index.html`;
}
