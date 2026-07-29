import {listen} from '@tauri-apps/api/event';
import {isSafeImageAssetUrl} from './image-asset-url';
import {IMAGE_LOAD_TIMEOUT_MS, loadImageWithTimeout} from './image-loader';
import {calculateImageFitScale} from './image-viewer-fit';

interface ImageViewerPayload {
    imageUrl: string;
}

const SESSION_KEY = 'jungle-bell:image-viewer-payload';
const MIN_ZOOM_PERCENT = 25;
const MAX_ZOOM_PERCENT = 400;
const ZOOM_STEP_PERCENT = 25;

type ViewerState = 'loading' | 'loaded' | 'error';
type ZoomMode = 'fit' | 'custom';

interface ResizeObservationBoxSize {
    inlineSize: number;
    blockSize: number;
}

interface ResizeObservation {
    contentBoxSize?: ResizeObservationBoxSize | readonly ResizeObservationBoxSize[];
    contentRect: {
        width: number;
        height: number;
    };
}

export function resizeObservationSize(observation: ResizeObservation): {
    width: number;
    height: number;
} {
    const contentBoxSize = observation.contentBoxSize;
    const boxSize = contentBoxSize === undefined
        ? undefined
        : Array.isArray(contentBoxSize)
            ? contentBoxSize[0]
            : contentBoxSize as ResizeObservationBoxSize;
    return {
        width: boxSize?.inlineSize ?? observation.contentRect.width,
        height: boxSize?.blockSize ?? observation.contentRect.height,
    };
}

export function clampSteppedZoomPercent(zoomPercent: number): number {
    if (!Number.isFinite(zoomPercent)) return MIN_ZOOM_PERCENT;
    const steppedPercent = Math.round(zoomPercent / ZOOM_STEP_PERCENT) * ZOOM_STEP_PERCENT;
    return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, steppedPercent));
}

export function nextSteppedZoomPercent(currentZoomPercent: number, direction: -1 | 1): number {
    const nextZoomPercent = direction > 0
        ? (Math.floor(currentZoomPercent / ZOOM_STEP_PERCENT) + 1) * ZOOM_STEP_PERCENT
        : (Math.ceil(currentZoomPercent / ZOOM_STEP_PERCENT) - 1) * ZOOM_STEP_PERCENT;
    return clampSteppedZoomPercent(nextZoomPercent);
}

function requiredElement<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Image viewer element is missing: ${selector}`);
    return element;
}

function initializeImageViewer(): void {
const viewerElement = requiredElement<HTMLElement>('#image-viewer');
const viewportElement = requiredElement<HTMLElement>('#image-viewer-viewport');
const canvasElement = requiredElement<HTMLElement>('#image-viewer-canvas');
const fitLayer = requiredElement<HTMLElement>('#image-fit-layer');
const imageElement = requiredElement<HTMLImageElement>('#viewer-image');
const loadingElement = requiredElement<HTMLElement>('#image-viewer-loading');
const errorElement = requiredElement<HTMLElement>('#image-viewer-error');
const retryButton = requiredElement<HTMLButtonElement>('#image-viewer-retry');
const zoomOutButton = requiredElement<HTMLButtonElement>('#image-viewer-zoom-out');
const zoomInButton = requiredElement<HTMLButtonElement>('#image-viewer-zoom-in');
const actualSizeButton = requiredElement<HTMLButtonElement>('#image-viewer-actual-size');
const fitButton = requiredElement<HTMLButtonElement>('#image-viewer-fit');
const zoomOutput = requiredElement<HTMLOutputElement>('#image-viewer-zoom');

let naturalWidth = 0;
let naturalHeight = 0;
let fittedViewportWidth = 0;
let fittedViewportHeight = 0;
let imageLoadSequence = 0;
let currentImageUrl: string | null = null;
let viewerState: ViewerState = 'loading';
let zoomMode: ZoomMode = 'fit';
let currentScale = 1;

function currentZoomPercent(): number {
    return currentScale * 100;
}

function updateZoomControls(): void {
    const isLoaded = viewerState === 'loaded';
    const zoomPercent = currentZoomPercent();
    zoomOutButton.disabled = !isLoaded || zoomPercent <= MIN_ZOOM_PERCENT;
    zoomInButton.disabled = !isLoaded || zoomPercent >= MAX_ZOOM_PERCENT;
    actualSizeButton.disabled = !isLoaded;
    fitButton.disabled = !isLoaded;
    actualSizeButton.setAttribute(
        'aria-pressed',
        String(isLoaded && zoomMode === 'custom' && Math.round(zoomPercent) === 100),
    );
    fitButton.setAttribute('aria-pressed', String(isLoaded && zoomMode === 'fit'));
    zoomOutput.value = isLoaded ? `${Math.round(zoomPercent)}%` : '—';
}

function setViewerState(state: ViewerState): void {
    viewerState = state;
    fitLayer.classList.toggle('invisible', state !== 'loaded');
    loadingElement.classList.toggle('hidden', state !== 'loading');
    loadingElement.classList.toggle('flex', state === 'loading');
    errorElement.classList.toggle('hidden', state !== 'error');
    errorElement.classList.toggle('flex', state === 'error');
    viewerElement.setAttribute('aria-busy', String(state === 'loading'));
    updateZoomControls();
}

interface ViewportAnchor {
    x: number;
    y: number;
}

function captureViewportAnchor(): ViewportAnchor | null {
    const layerBounds = fitLayer.getBoundingClientRect();
    if (layerBounds.width <= 0 || layerBounds.height <= 0) return null;
    const viewportBounds = viewportElement.getBoundingClientRect();
    return {
        x: Math.min(1, Math.max(0, (viewportBounds.left + viewportBounds.width / 2 - layerBounds.left) / layerBounds.width)),
        y: Math.min(1, Math.max(0, (viewportBounds.top + viewportBounds.height / 2 - layerBounds.top) / layerBounds.height)),
    };
}

function restoreViewportAnchor(anchor: ViewportAnchor | null): void {
    if (!anchor) {
        viewportElement.scrollLeft = Math.max(0, (viewportElement.scrollWidth - viewportElement.clientWidth) / 2);
        viewportElement.scrollTop = Math.max(0, (viewportElement.scrollHeight - viewportElement.clientHeight) / 2);
        return;
    }

    const layerBounds = fitLayer.getBoundingClientRect();
    const viewportBounds = viewportElement.getBoundingClientRect();
    viewportElement.scrollLeft += (
        layerBounds.left + layerBounds.width * anchor.x
        - viewportBounds.left - viewportBounds.width / 2
    );
    viewportElement.scrollTop += (
        layerBounds.top + layerBounds.height * anchor.y
        - viewportBounds.top - viewportBounds.height / 2
    );
}

function applyScale(scale: number, preserveViewportAnchor = true): void {
    const anchor = preserveViewportAnchor ? captureViewportAnchor() : null;
    currentScale = scale;
    fitLayer.style.width = `${naturalWidth * scale}px`;
    fitLayer.style.height = `${naturalHeight * scale}px`;
    restoreViewportAnchor(anchor);
    updateZoomControls();
}

function availableViewportSize(viewportWidth: number, viewportHeight: number): {
    width: number;
    height: number;
} {
    const canvasStyle = getComputedStyle(canvasElement);
    const horizontalPadding = (Number.parseFloat(canvasStyle.paddingLeft) || 0)
        + (Number.parseFloat(canvasStyle.paddingRight) || 0);
    const verticalPadding = (Number.parseFloat(canvasStyle.paddingTop) || 0)
        + (Number.parseFloat(canvasStyle.paddingBottom) || 0);
    return {
        width: Math.max(1, viewportWidth - horizontalPadding),
        height: Math.max(1, viewportHeight - verticalPadding),
    };
}

function updateImageFit(
    viewportWidth = viewportElement.clientWidth,
    viewportHeight = viewportElement.clientHeight,
): void {
    if (naturalWidth <= 0 || naturalHeight <= 0 || zoomMode !== 'fit') return;
    if (viewportWidth === fittedViewportWidth && viewportHeight === fittedViewportHeight) return;

    fittedViewportWidth = viewportWidth;
    fittedViewportHeight = viewportHeight;
    const availableSize = availableViewportSize(viewportWidth, viewportHeight);
    const fitScale = Math.min(
        MAX_ZOOM_PERCENT / 100,
        calculateImageFitScale(availableSize.width, availableSize.height, naturalWidth, naturalHeight),
    );
    applyScale(fitScale, false);
}

function fitImage(): void {
    zoomMode = 'fit';
    fittedViewportWidth = 0;
    fittedViewportHeight = 0;
    updateImageFit();
}

function setZoomPercent(zoomPercent: number): void {
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    const clampedPercent = clampSteppedZoomPercent(zoomPercent);
    zoomMode = 'custom';
    applyScale(clampedPercent / 100);
}

function stepZoom(direction: -1 | 1): void {
    setZoomPercent(nextSteppedZoomPercent(currentZoomPercent(), direction));
}

const resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(([entry]) => {
        if (!entry) return;
        const size = resizeObservationSize(entry);
        updateImageFit(size.width, size.height);
    });
const updateImageFitFromViewport = () => updateImageFit();
if (resizeObserver) {
    resizeObserver.observe(viewportElement);
} else {
    window.addEventListener('resize', updateImageFitFromViewport);
}

async function loadImage(imageUrl: string, manageInteractionFocus = false): Promise<void> {
    const loadSequence = ++imageLoadSequence;
    currentImageUrl = imageUrl;
    const shouldManageInteractionFocus = manageInteractionFocus || document.activeElement === loadingElement;

    naturalWidth = 0;
    naturalHeight = 0;
    zoomMode = 'fit';
    currentScale = 1;
    fitLayer.style.removeProperty('width');
    fitLayer.style.removeProperty('height');
    setViewerState('loading');
    if (shouldManageInteractionFocus) loadingElement.focus();

    try {
        await loadImageWithTimeout(imageElement, imageUrl, IMAGE_LOAD_TIMEOUT_MS);
    } catch {
        if (loadSequence !== imageLoadSequence) return;
        naturalWidth = 0;
        naturalHeight = 0;
        imageElement.removeAttribute('src');
        setViewerState('error');
        if (shouldManageInteractionFocus) retryButton.focus();
        return;
    }

    if (loadSequence !== imageLoadSequence) return;

    naturalWidth = imageElement.naturalWidth;
    naturalHeight = imageElement.naturalHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) {
        setViewerState('error');
        if (shouldManageInteractionFocus) retryButton.focus();
        return;
    }

    fitImage();
    setViewerState('loaded');
    if (shouldManageInteractionFocus) viewportElement.focus();
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

retryButton.addEventListener('click', () => {
    if (currentImageUrl) void loadImage(currentImageUrl, true);
});
zoomOutButton.addEventListener('click', () => stepZoom(-1));
zoomInButton.addEventListener('click', () => stepZoom(1));
actualSizeButton.addEventListener('click', () => setZoomPercent(100));
fitButton.addEventListener('click', fitImage);

function handleKeyboardShortcut(event: KeyboardEvent): void {
    if (
        event.defaultPrevented
        || event.ctrlKey
        || event.metaKey
        || event.altKey
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement
        || (event.target instanceof HTMLElement && event.target.isContentEditable)
    ) {
        return;
    }

    if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        stepZoom(1);
        return;
    }
    if (event.key === '-') {
        event.preventDefault();
        stepZoom(-1);
        return;
    }
    if (event.key === '0') {
        event.preventDefault();
        setZoomPercent(100);
        return;
    }
    if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fitImage();
    }
}

window.addEventListener('keydown', handleKeyboardShortcut);
void listen<ImageViewerPayload>('image-viewer-update', ({payload}) => applyPayload(payload));
window.addEventListener('beforeunload', () => {
    imageLoadSequence += 1;
    resizeObserver?.disconnect();
    window.removeEventListener('resize', updateImageFitFromViewport);
    window.removeEventListener('keydown', handleKeyboardShortcut);
});

const initialPayload = queryPayload() ?? storedPayload();
if (initialPayload) {
    applyPayload(initialPayload);
} else {
    setViewerState('error');
}
}

if (typeof document !== 'undefined') {
    initializeImageViewer();
}
