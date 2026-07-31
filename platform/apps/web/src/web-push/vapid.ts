const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/u;

export function base64UrlToUint8Array(
  value: string,
): Uint8Array<ArrayBuffer> {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !BASE64_URL_PATTERN.test(value) ||
    value.slice(0, -2).includes("=")
  ) {
    throw new TypeError("value must be valid base64url");
  }

  const withoutPadding = value.replace(/=+$/u, "");
  const padding = "=".repeat((4 - (withoutPadding.length % 4)) % 4);
  const normalized = `${withoutPadding}${padding}`
    .replaceAll("-", "+")
    .replaceAll("_", "/");

  let binary: string;
  try {
    binary = atob(normalized);
  } catch (error) {
    throw new TypeError("value must be valid base64url", { cause: error });
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function vapidPublicKeyToApplicationServerKey(
  value: string,
): Uint8Array<ArrayBuffer> {
  const bytes = base64UrlToUint8Array(value);
  if (bytes.byteLength !== 65 || bytes[0] !== 4) {
    throw new TypeError(
      "VAPID public key must be an uncompressed 65-byte P-256 point",
    );
  }
  return bytes;
}
