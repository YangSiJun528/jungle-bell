import {listen} from '@tauri-apps/api/event';
import {isSafeImageAssetUrl} from './image-asset-url';
import {calculateImageFitScale} from './image-viewer-fit';

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
const fitLayer = requiredElement<HTMLElement>('#image-fit-layer');
const imageElement = requiredElement<HTMLImageElement>('#viewer-image');

let naturalWidth = 0;
let naturalHeight = 0;
let fittedViewportWidth = 0;
let fittedViewportHeight = 0;
let imageLoadSequence = 0;

function updateImageFit(
    viewportWidth = viewerElement.clientWidth,
    viewportHeight = viewerElement.clientHeight,
): void {
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    if (viewportWidth === fittedViewportWidth && viewportHeight === fittedViewportHeight) return;

    fittedViewportWidth = viewportWidth;
    fittedViewportHeight = viewportHeight;
    const fitScale = calculateImageFitScale(viewportWidth, viewportHeight, naturalWidth, naturalHeight);
    fitLayer.style.transform = `translate3d(-50%, -50%, 0) scale(${fitScale})`;
}

const resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(([entry]) => {
        if (!entry) return;
        const size = entry.contentBoxSize[0];
        updateImageFit(size?.inlineSize ?? entry.contentRect.width, size?.blockSize ?? entry.contentRect.height);
    });
const updateImageFitFromViewport = () => updateImageFit();
if (resizeObserver) {
    resizeObserver.observe(viewerElement);
} else {
    window.addEventListener('resize', updateImageFitFromViewport);
}

async function loadImage(imageUrl: string): Promise<void> {
    const loadSequence = ++imageLoadSequence;

    fitLayer.classList.add('invisible');
    imageElement.src = imageUrl;

    try {
        await imageElement.decode();
    } catch {
        if (!imageElement.complete || imageElement.naturalWidth <= 0) return;
    }

    if (loadSequence !== imageLoadSequence) return;

    naturalWidth = imageElement.naturalWidth;
    naturalHeight = imageElement.naturalHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) return;

    fitLayer.style.width = `${naturalWidth}px`;
    fitLayer.style.height = `${naturalHeight}px`;
    fittedViewportWidth = 0;
    fittedViewportHeight = 0;
    updateImageFit();
    fitLayer.classList.remove('invisible');
}

function queryPayload(): ImageViewerPayload | null {
    const params = new URLSearchParams(window.location.search);
    const imageUrl = params.get('src') ?? '';
    if (!isSafeImageAssetUrl(imageUrl)) return null;
    return {imageUrl};
}

function storedPayload(): ImageViewerPayload | null {
    try {
        const imageUrl = sessionStorage.getItem(SESSION_KEY) ?? '';
        return isSafeImageAssetUrl(imageUrl) ? {imageUrl} : null;
    } catch {
        return null;
    }
}

function applyPayload(payload: ImageViewerPayload): void {
    if (!isSafeImageAssetUrl(payload.imageUrl)) return;
    try {
        sessionStorage.setItem(SESSION_KEY, payload.imageUrl);
        const params = new URLSearchParams({src: payload.imageUrl});
        history.replaceState(null, '', `image-viewer.html?${params.toString()}`);
    } catch {
        // Storage and history are optional; the viewer can still open the image.
    }
    void loadImage(payload.imageUrl);
}

void listen<ImageViewerPayload>('image-viewer-update', ({payload}) => applyPayload(payload));
window.addEventListener('beforeunload', () => {
    imageLoadSequence += 1;
    resizeObserver?.disconnect();
    window.removeEventListener('resize', updateImageFitFromViewport);
});

const initialPayload = queryPayload() ?? storedPayload();
if (initialPayload) applyPayload(initialPayload);
