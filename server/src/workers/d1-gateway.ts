import { z } from "zod";

export const D1_GATEWAY_PATH = "/internal/jobs/d1";
export const D1_GATEWAY_MAX_BODY_BYTES = 1024 * 1024;
const MAX_STATEMENTS = 50;
const MAX_SQL_BYTES = 64 * 1024;
const MAX_PARAMS = 100;
const MAX_STRING_PARAM_BYTES = 256 * 1024;

export interface D1GatewayEnvironment {
  DB: D1Database;
  JOBS_D1_GATEWAY_SECRET?: string;
}

const encoder = new TextEncoder();
const bindingSchema = z.union([
  z.string().refine((value) => encoder.encode(value).byteLength <= MAX_STRING_PARAM_BYTES),
  z.number().finite(),
  z.null(),
]);
const sqlSchema = z.string().trim().min(1)
  .refine((value) => encoder.encode(value).byteLength <= MAX_SQL_BYTES)
  .refine((value) => /^(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu.test(value), "SQL operation is not allowed")
  .refine((value) => !value.includes(";"), "Multiple SQL statements are not allowed");
const querySchema = z.object({
  sql: sqlSchema,
  params: z.array(bindingSchema).max(MAX_PARAMS),
}).strict();
const requestSchema = z.union([
  querySchema,
  z.object({ batch: z.array(querySchema).min(1).max(MAX_STATEMENTS) }).strict(),
]);

function json(status: number, value: unknown, headers: HeadersInit = {}): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
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

function statements(
  db: D1Database,
  value: z.infer<typeof requestSchema>,
): { batch: boolean; statements: D1PreparedStatement[] } {
  const queries = "batch" in value ? value.batch : [value];
  return {
    batch: "batch" in value,
    statements: queries.map((query) => db.prepare(query.sql).bind(...query.params)),
  };
}

export async function handleD1Gateway(request: Request, environment: D1GatewayEnvironment): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, { Allow: "POST" });
  const secret = environment.JOBS_D1_GATEWAY_SECRET?.trim();
  if (!secret || secret.length < 32) return json(503, { error: "D1_GATEWAY_NOT_CONFIGURED" });
  if (!(await authenticated(request.headers.get("authorization"), secret))) {
    return json(401, { error: "AUTHENTICATION_REQUIRED" });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json(415, { error: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > D1_GATEWAY_MAX_BODY_BYTES) {
    return json(413, { error: "PAYLOAD_TOO_LARGE" });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > D1_GATEWAY_MAX_BODY_BYTES) return json(413, { error: "PAYLOAD_TOO_LARGE" });

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return json(400, { error: "INVALID_JSON" });
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return json(400, { error: "INVALID_D1_REQUEST" });

  try {
    const prepared = statements(environment.DB, parsed.data);
    const results = prepared.batch
      ? await environment.DB.batch(prepared.statements)
      : [await prepared.statements[0]!.run()];
    return json(200, { results });
  } catch {
    // The gateway itself succeeded; a prepared statement failure is not made
    // safer by immediately replaying the same write or transaction.
    return json(422, { error: "D1_EXECUTION_FAILED" });
  }
}
