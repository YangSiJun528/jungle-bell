declare module '@panzoom/panzoom/dist/panzoom.es.js' {
    import type {PanzoomGlobalOptions, PanzoomObject} from '@panzoom/panzoom/dist/src/types.js';

    function Panzoom(element: HTMLElement | SVGElement, options?: PanzoomGlobalOptions): PanzoomObject;

    export default Panzoom;
}
