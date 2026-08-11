import {QueryClient} from '@tanstack/react-query';

export function createJungleBellQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                retry: 1,
                refetchOnWindowFocus: true,
                refetchOnReconnect: true,
            },
            mutations: {retry: false},
        },
    });
}
