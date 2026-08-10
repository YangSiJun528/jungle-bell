import {copyFile, mkdir, readdir} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stagingRoot = join(workspaceRoot, 'site', 'dist');
const appAssetsRoot = join(workspaceRoot, 'dist');
const allowedRoots = new Set(['blog', 'blog-assets']);

async function copyTree(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        const source = join(directory, entry.name);
        if (entry.isDirectory()) {
            await copyTree(source);
            continue;
        }
        const relativePath = relative(stagingRoot, source);
        const portableRelativePath = relativePath.split(sep).join('/');
        const [topLevel] = portableRelativePath.split('/');
        if (!topLevel || !allowedRoots.has(topLevel)) {
            throw new Error(`Unexpected site output outside /blog: ${portableRelativePath}`);
        }
        const outputPath = portableRelativePath === 'blog/404/index.html'
            ? 'blog/404.html'
            : portableRelativePath;
        const destination = join(appAssetsRoot, ...outputPath.split('/'));
        await mkdir(dirname(destination), {recursive: true});
        try {
            await copyFile(source, destination, 1);
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
                throw new Error(`App asset already exists: ${outputPath}`, {cause: error});
            }
            throw error;
        }
    }
}

await copyTree(stagingRoot);
