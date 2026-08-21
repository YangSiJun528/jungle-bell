import {z} from 'zod';

export const textSchema = (maximum = 512) => z.string().min(1).max(maximum);

export const isoDateTimeSchema = textSchema(64).refine(
    (value) => Number.isFinite(Date.parse(value)),
    '유효한 ISO 날짜/시간이어야 합니다.',
);

export const calendarDateSchema = z.iso.date();

export const safeEpochMillisecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const boundedLaundryCountSchema = z.number().int().min(0).max(64);

export const finiteNumberSchema = z.number().finite();

export const refreshIntervalSecondsSchema = z.number().int().min(1).max(3_600);
