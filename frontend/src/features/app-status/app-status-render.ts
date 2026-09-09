import type {ReactNode} from 'react';

export interface AppStatusRenderState {
    content: ReactNode;
    warningCount: number;
}

export type AppStatusRenderer = (state: AppStatusRenderState) => ReactNode;
