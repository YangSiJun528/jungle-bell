/** Shared Hono RPC routes for desktop/mobile personal controls. */
import {zValidator, type Hook} from '@hono/zod-validator';
import {Hono, type Context, type Env, type ErrorHandler} from 'hono';
import {z} from 'zod';
import {
    attendancePreferencesSchema,
    laundryQueueIdSchema,
    laundryQueueInputSchema,
    laundryWatchIdSchema,
    laundryWatchInputSchema,
    mealPreferencesInputSchema,
    type AttendancePreferences,
    type LaundryQueueEntry,
    type LaundryQueueInput,
    type LaundryWatch,
    type LaundryWatchInput,
    type MealPreferences,
    type MealPreferencesInput,
} from './personal-schemas';

const laundryWatchParamSchema = z.strictObject({id: laundryWatchIdSchema});
const laundryQueueParamSchema = z.strictObject({id: laundryQueueIdSchema});

export interface PersonalRouteHandlers {
    getAttendancePreferences(context: Context): Promise<AttendancePreferences>;
    updateAttendancePreferences(
        context: Context, input: AttendancePreferences,
    ): Promise<AttendancePreferences>;
    getMealPreferences(context: Context): Promise<MealPreferences>;
    updateMealPreferences(context: Context, input: MealPreferencesInput): Promise<MealPreferences>;
    listLaundryWatches(context: Context): Promise<LaundryWatch[]>;
    createLaundryWatch(context: Context, input: LaundryWatchInput): Promise<LaundryWatch>;
    deleteLaundryWatch(context: Context, id: string): Promise<boolean>;
    listLaundryQueue(context: Context): Promise<LaundryQueueEntry[]>;
    joinLaundryQueue(context: Context, input: LaundryQueueInput): Promise<LaundryQueueEntry>;
    leaveLaundryQueue(context: Context, id: string): Promise<boolean>;
}

function validationHook(): Hook<unknown, Env, string> {
    return (result, context) => {
        if (result.success) return;
        return context.json({
            error: 'INVALID_REQUEST',
            issues: result.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
            })),
        }, 400);
    };
}

export function createPersonalRoutes(handlers: PersonalRouteHandlers, errorHandler: ErrorHandler) {
    const hook = validationHook();
    const app = new Hono();
    app.onError(errorHandler);
    return app
        .get('/attendance/preferences', async (context) => context.json(
            await handlers.getAttendancePreferences(context),
        ))
        .put(
            '/attendance/preferences',
            zValidator('json', attendancePreferencesSchema, hook),
            async (context) => context.json(await handlers.updateAttendancePreferences(
                context,
                context.req.valid('json'),
            )),
        )
        .get('/meal-preferences', async (context) => context.json(
            await handlers.getMealPreferences(context),
        ))
        .put(
            '/meal-preferences',
            zValidator('json', mealPreferencesInputSchema, hook),
            async (context) => context.json(await handlers.updateMealPreferences(
                context,
                context.req.valid('json'),
            )),
        )
        .get('/laundry-watches', async (context) => context.json({
            watches: await handlers.listLaundryWatches(context),
        }))
        .post(
            '/laundry-watches',
            zValidator('json', laundryWatchInputSchema, hook),
            async (context) => context.json(await handlers.createLaundryWatch(
                context,
                context.req.valid('json'),
            ), 201),
        )
        .delete(
            '/laundry-watches/:id',
            zValidator('param', laundryWatchParamSchema, hook),
            async (context) => (await handlers.deleteLaundryWatch(context, context.req.valid('param').id))
                ? context.body(null, 204)
                : context.json({error: 'LAUNDRY_WATCH_NOT_FOUND'} as const, 404),
        )
        .get('/laundry-queue', async (context) => context.json({
            entries: await handlers.listLaundryQueue(context),
        }))
        .post(
            '/laundry-queue',
            zValidator('json', laundryQueueInputSchema, hook),
            async (context) => context.json(await handlers.joinLaundryQueue(
                context,
                context.req.valid('json'),
            ), 201),
        )
        .delete(
            '/laundry-queue/:id',
            zValidator('param', laundryQueueParamSchema, hook),
            async (context) => (await handlers.leaveLaundryQueue(context, context.req.valid('param').id))
                ? context.body(null, 204)
                : context.json({error: 'LAUNDRY_QUEUE_ENTRY_NOT_FOUND'} as const, 404),
        );
}

export type PersonalRoutes = ReturnType<typeof createPersonalRoutes>;
