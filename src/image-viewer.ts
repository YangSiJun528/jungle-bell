import Panzoom from '@panzoom/panzoom/dist/panzoom.es.js';
import {listen} from '@tauri-apps/api/event';
import {PANZOOM_OPTIONS} from './image-viewer-options';
import {isSafeMealImageUrl} from './meal-image-url';

interface ImageViewerPayload {
    imageUrl: string;
}

const SESSION_KEY = 'jungle-bell:image-viewer-payload';
function requiredElement<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Image viewer element is missing: ${selector}`);
    return element;
}

const viewerElement = requiredElement<HTMLElement>('#image-viewer');
const imageElement = requiredElement<HTMLImageElement>('#meal-image');

const panzoom = Panzoom(imageElement, PANZOOM_OPTIONS);
viewerElement.addEventListener('wheel', panzoom.zoomWithWheel, {passive: false});

function queryPayload(): ImageViewerPayload | null {
    const params = new URLSearchParams(window.location.search);
    const imageUrl = params.get('src') ?? '';
    if (!isSafeMealImageUrl(imageUrl)) return null;
    return {imageUrl};
}

function storedPayload(): ImageViewerPayload | null {
    try {
        const imageUrl = sessionStorage.getItem(SESSION_KEY) ?? '';
        return isSafeMealImageUrl(imageUrl) ? {imageUrl} : null;
    } catch {
        return null;
    }
}

function applyPayload(payload: ImageViewerPayload): void {
    if (!isSafeMealImageUrl(payload.imageUrl)) return;
    try {
        sessionStorage.setItem(SESSION_KEY, payload.imageUrl);
        const params = new URLSearchParams({src: payload.imageUrl});
        history.replaceState(null, '', `image-viewer.html?${params.toString()}`);
    } catch {
        // Storage and history are optional; the viewer can still open the image.
    }
    panzoom.reset({animate: false});
    imageElement.src = payload.imageUrl;
}

void listen<ImageViewerPayload>('image-viewer-update', ({payload}) => applyPayload(payload));
window.addEventListener('beforeunload', () => {
    viewerElement.removeEventListener('wheel', panzoom.zoomWithWheel);
    panzoom.destroy();
});

const initialPayload = queryPayload() ?? storedPayload();
if (initialPayload) applyPayload(initialPayload);
