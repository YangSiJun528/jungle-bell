export const R2_GATEWAY_PATH = "/internal/jobs/r2";
export const R2_GATEWAY_MAX_BODY_BYTES = 16 * 1024 * 1024;

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const EXACT_KEYS = new Set(["latest/laundry.json", "latest/meals.json"]);
const ALLOWED_KEY_PREFIXES = [
  "assets/",
  "collector/commits/",
  "collector/latest/",
  "collector/state/",
  "latest/raw/",
  "logs/jobs-runs/",
  "media-map/",
  "raw/",
  "versions/laundry/",
  "versions/meals/",
] as const;

export interface R2GatewayEnvironment {
  DATA_BUCKET: R2Bucket;
  JOBS_D1_GATEWAY_SECRET?: string;
}

const encoder = new TextEncoder();

function response(status: number, body: BodyInit | null, headers: HeadersInit = {}): Response {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("Cache-Control", "no-store");
  outputHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(body, {
    status,
    headers: outputHeaders,
  });
}

function json(status: number, error: string, headers: HeadersInit = {}): Response {
  return response(status, JSON.stringify({ error }), {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function authenticated(authorization: string | null, expected: string): Promise<boolean> {
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (provided.length > 1_024 || expected.length > 1_024) return false;
  const [providedHash, expectedHash] = await Promise.all([sha256(provided), sha256(expected)]);
  let difference = provided.length ^ expected.length;
  for (let index = 0; index < expectedHash.length; index += 1) {
    difference |= providedHash[index]! ^ expectedHash[index]!;
  }
  return difference === 0;
}

function objectKey(request: Request): string | null {
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  if (url.pathname !== R2_GATEWAY_PATH || entries.length !== 1 || entries[0]?.[0] !== "key") return null;
  const key = entries[0][1];
  if (encoder.encode(key).byteLength > 1_024 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(key)) return null;
  if (key.includes("//") || key.split("/").some((part) => part === "." || part === "..")) return null;
  if (EXACT_KEYS.has(key)) return key;
  return ALLOWED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length)
    ? key
    : null;
}

function acceptedContentType(key: string, header: string | null): string | null {
  const normalized = header?.trim().toLowerCase() ?? "";
  if (key.startsWith("assets/")) return IMAGE_CONTENT_TYPES.has(normalized) ? normalized : null;
  return normalized === "application/json" || normalized === JSON_CONTENT_TYPE ? JSON_CONTENT_TYPE : null;
}

function copyObjectHeaders(object: R2Object, headers: Headers): void {
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
}

async function readObject(
  request: Request,
  environment: R2GatewayEnvironment,
  key: string,
): Promise<Response> {
  const object = request.method === "HEAD"
    ? await environment.DATA_BUCKET.head(key)
    : await environment.DATA_BUCKET.get(key);
  if (!object) return json(404, "R2_OBJECT_NOT_FOUND");
  if (object.size > R2_GATEWAY_MAX_BODY_BYTES) return json(413, "PAYLOAD_TOO_LARGE");
  const headers = new Headers();
  copyObjectHeaders(object, headers);
  return response(200, request.method === "HEAD" ? null : (object as R2ObjectBody).body, headers);
}

async function writeObject(
  request: Request,
  environment: R2GatewayEnvironment,
  key: string,
): Promise<Response> {
  const contentType = acceptedContentType(key, request.headers.get("content-type"));
  if (!contentType) return json(415, "UNSUPPORTED_MEDIA_TYPE");
  const rawLength = request.headers.get("content-length");
  if (!rawLength || !/^\d+$/u.test(rawLength)) return json(411, "LENGTH_REQUIRED");
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > R2_GATEWAY_MAX_BODY_BYTES) {
    return json(413, "PAYLOAD_TOO_LARGE");
  }
  if (!request.body) return json(400, "BODY_REQUIRED");
  const sha256Metadata = request.headers.get("x-jungle-bell-sha256");
  if (sha256Metadata !== null && !/^[a-f0-9]{64}$/u.test(sha256Metadata)) {
    return json(400, "INVALID_SHA256_METADATA");
  }
  await environment.DATA_BUCKET.put(key, request.body, {
    httpMetadata: { contentType },
    ...(sha256Metadata ? { customMetadata: { sha256: sha256Metadata } } : {}),
  });
  return response(204, null);
}

export async function handleR2Gateway(request: Request, environment: R2GatewayEnvironment): Promise<Response> {
  const secret = environment.JOBS_D1_GATEWAY_SECRET?.trim();
  if (!secret || secret.length < 32) return json(503, "R2_GATEWAY_NOT_CONFIGURED");
  if (!(await authenticated(request.headers.get("authorization"), secret))) {
    return json(401, "AUTHENTICATION_REQUIRED");
  }
  if (!new Set(["GET", "HEAD", "PUT"]).has(request.method)) {
    return json(405, "METHOD_NOT_ALLOWED", { Allow: "GET, HEAD, PUT" });
  }
  const key = objectKey(request);
  if (!key) return json(400, "INVALID_R2_KEY");
  try {
    return request.method === "PUT"
      ? await writeObject(request, environment, key)
      : await readObject(request, environment, key);
  } catch {
    return json(502, "R2_OPERATION_FAILED");
  }
}
