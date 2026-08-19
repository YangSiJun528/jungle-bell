import {hasOwn} from '@/lib/object';

export function attendanceSnapshotRevision(value: unknown): number | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).length !== 1 || !hasOwn(value, 'revision')) return null;
    const revision = (value as {revision?: unknown}).revision;
    return Number.isSafeInteger(revision) && (revision as number) > 0
        ? revision as number
        : null;
}
