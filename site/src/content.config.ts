import {defineCollection} from 'astro:content';
import {glob} from 'astro/loaders';
import {z} from 'astro/zod';

const posts = defineCollection({
    loader: glob({pattern: '**/*.md', base: './src/content/posts', retainBody: true}),
    schema: z.object({
        title: z.string().trim().min(1).max(120),
        description: z.string().trim().min(1).max(240),
        publishedAt: z.coerce.date(),
        updatedAt: z.coerce.date().optional(),
        category: z.string().trim().min(1).max(40),
        tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
        draft: z.boolean().default(false),
    }),
});

export const collections = {posts};
