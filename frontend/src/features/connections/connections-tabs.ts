export const CONNECTIONS_TABS = ['status', 'notifications', 'services', 'devices'] as const;

export type ConnectionsTab = (typeof CONNECTIONS_TABS)[number];

const DEFAULT_CONNECTIONS_TAB: ConnectionsTab = 'notifications';

function isConnectionsTab(value: unknown): value is ConnectionsTab {
    return typeof value === 'string' && CONNECTIONS_TABS.some((tab) => tab === value);
}

export function parseConnectionsTabSearch(search: unknown): ConnectionsTab {
    if (search instanceof URLSearchParams) {
        const tab = search.get('tab');
        return isConnectionsTab(tab) ? tab : DEFAULT_CONNECTIONS_TAB;
    }
    if (typeof search !== 'object' || search === null || !('tab' in search)) {
        return DEFAULT_CONNECTIONS_TAB;
    }
    const tab = (search as {tab?: unknown}).tab;
    return isConnectionsTab(tab) ? tab : DEFAULT_CONNECTIONS_TAB;
}

export function connectionsTabFromHash(hash: string): ConnectionsTab {
    const questionMark = hash.indexOf('?');
    if (questionMark < 0) return DEFAULT_CONNECTIONS_TAB;
    try {
        return parseConnectionsTabSearch(new URLSearchParams(hash.slice(questionMark + 1)));
    } catch {
        return DEFAULT_CONNECTIONS_TAB;
    }
}

export function connectionsTabHref(tab: ConnectionsTab): `#/connections?tab=${ConnectionsTab}` {
    return `#/connections?tab=${tab}`;
}
