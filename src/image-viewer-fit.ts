export function calculateImageFitScale(
    viewportWidth: number,
    viewportHeight: number,
    imageWidth: number,
    imageHeight: number,
): number {
    const dimensions = [viewportWidth, viewportHeight, imageWidth, imageHeight];
    if (!dimensions.every((dimension) => Number.isFinite(dimension) && dimension > 0)) return 1;
    return Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
}
