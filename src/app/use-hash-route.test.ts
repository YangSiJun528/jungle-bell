import {describe, expect, test, vi} from 'vitest';
import {replaceDashboardRouteHash} from './use-hash-route';

describe('replaceDashboardRouteHash', () => {
    test('replaces the current history entry and notifies route subscribers', () => {
        const replaceState = vi.fn();
        const dispatchEvent = vi.fn((_event: Event) => true);
        const historyState = {source: 'notification-panel'};

        replaceDashboardRouteHash({
            history: {state: historyState, replaceState},
            dispatchEvent,
        }, 'meals');

        expect(replaceState).toHaveBeenCalledWith(historyState, '', '#meals');
        expect(dispatchEvent).toHaveBeenCalledOnce();
        expect(dispatchEvent.mock.calls[0]?.[0]).toBeInstanceOf(Event);
    });
});
