import type {PanzoomOptions} from '@panzoom/panzoom/dist/src/types.js';

export const PANZOOM_OPTIONS = {
    animate: false,
    canvas: true,
    contain: 'outside',
    maxScale: 4,
    minScale: 1,
    overflow: 'hidden',
    panOnlyWhenZoomed: true,
    roundPixels: false,
    step: 0.12,
    touchAction: 'none',
} satisfies PanzoomOptions;
