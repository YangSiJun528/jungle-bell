import qrcodeFactory from 'qrcode-generator';

const MAX_PAIRING_PAYLOAD_LENGTH = 4_096;

/**
 * The resulting SVG is used only as an <img src>. It is never assigned to
 * innerHTML, so server text cannot become active DOM content.
 */
export function pairingQrDataUrl(payload: string): string {
    if (!payload || payload.length > MAX_PAIRING_PAYLOAD_LENGTH) {
        throw new Error('PAIRING_QR_PAYLOAD_INVALID');
    }
    const code = qrcodeFactory(0, 'M');
    code.addData(payload, 'Byte');
    code.make();
    const svg = code.createSvgTag({cellSize: 6, margin: 4, scalable: true});
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
