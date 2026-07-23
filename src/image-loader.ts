export const IMAGE_LOAD_TIMEOUT_MS = 15_000;

export interface LoadableImage extends EventTarget {
    src: string;
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
    decode(): Promise<void>;
}

export async function loadImageWithTimeout(
    imageElement: LoadableImage,
    imageUrl: string,
    timeoutMs = IMAGE_LOAD_TIMEOUT_MS,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let decoding = false;

        const cleanup = () => {
            clearTimeout(timeout);
            imageElement.removeEventListener('load', handleLoad);
            imageElement.removeEventListener('error', handleError);
        };
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const validateDecodedImage = () => {
            if (imageElement.naturalWidth > 0 && imageElement.naturalHeight > 0) {
                finish(resolve);
            } else {
                finish(() => reject(new Error('이미지를 디코딩하지 못했습니다.')));
            }
        };
        const handleLoad = () => {
            if (settled || decoding) return;
            decoding = true;
            void imageElement.decode()
                .catch(() => undefined)
                .then(validateDecodedImage);
        };
        const handleError = () => {
            finish(() => reject(new Error('이미지를 불러오지 못했습니다.')));
        };
        const timeout = setTimeout(() => {
            finish(() => reject(new Error('이미지 로딩 시간이 초과되었습니다.')));
        }, timeoutMs);

        imageElement.addEventListener('load', handleLoad);
        imageElement.addEventListener('error', handleError);
        imageElement.src = imageUrl;

        if (imageElement.complete) {
            queueMicrotask(() => {
                if (imageElement.naturalWidth > 0 && imageElement.naturalHeight > 0) {
                    handleLoad();
                } else {
                    handleError();
                }
            });
        }
    });
}
