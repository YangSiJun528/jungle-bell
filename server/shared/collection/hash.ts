import { canonicalize } from "json-canonicalize";

export async function sha256Bytes(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalJsonSha256(value: unknown): Promise<string> {
  return sha256Bytes(canonicalize(value));
}
