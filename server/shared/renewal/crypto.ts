const textEncoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function hashAppSessionToken(token: string): Promise<string> {
  const domain = token.startsWith("jbd_")
    ? "jungle-bell:desktop-session:v2"
    : token.startsWith("jbs_")
      ? "jungle-bell:mobile-session:v2"
      : "jungle-bell:invalid-session:v2";
  return sha256Hex(`${domain}\0${token}`);
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  if (textEncoder.encode(secret).byteLength < 32) throw new Error("PAIRING_SECRET_TOO_SHORT");
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

export async function deriveMobileSessionToken(secret: string, claimReceipt: string): Promise<string> {
  return `jbs_${await hmacSha256Hex(secret, `jungle-bell:mobile-session:v2\0${claimReceipt}`)}`;
}

export function randomOpaqueToken(prefix: string, byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return `${prefix}${bytesToHex(bytes)}`;
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomManualPairingCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => CROCKFORD_BASE32[value & 31]).join("");
}

export function normalizeManualPairingCode(value: string): string | null {
  const normalized = value
    .toUpperCase()
    .replace(/[\s-]/gu, "")
    .replace(/[IL]/gu, "1")
    .replace(/O/gu, "0");
  return normalized.length === 10 && [...normalized].every((character) => CROCKFORD_BASE32.includes(character))
    ? normalized
    : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
