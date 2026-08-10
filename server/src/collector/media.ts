const KAKAO_MEAL_MEDIA_HOST = "k.kakaocdn.net";

export const MAX_MEAL_IMAGE_BYTES = 8 * 1024 * 1024;

export function allowedMealMediaHosts(): readonly string[] {
  return [KAKAO_MEAL_MEDIA_HOST];
}

export function rasterImageContentType(body: Uint8Array): string | null {
  if (startsWith(body, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(body, 0, 6) === "GIF87a" || ascii(body, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(body, 0, 4) === "RIFF" && ascii(body, 8, 4) === "WEBP") return "image/webp";
  if (ascii(body, 4, 4) === "ftyp") {
    const brandLimit = Math.min(body.byteLength, 32);
    for (let offset = 8; offset + 4 <= brandLimit; offset += 4) {
      const brand = ascii(body, offset, 4);
      if (brand === "avif" || brand === "avis") return "image/avif";
    }
  }
  return null;
}

function startsWith(body: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => body[index] === value);
}

function ascii(body: Uint8Array, offset: number, length: number): string {
  if (body.byteLength < offset + length) return "";
  return String.fromCharCode(...body.subarray(offset, offset + length));
}
