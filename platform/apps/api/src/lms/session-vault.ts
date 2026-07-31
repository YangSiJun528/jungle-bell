import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const LMS_HOST = "jungle-lms.krafton.com";

const cookieSchema = z
  .object({
    name: z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/),
    value: z
      .string()
      .min(1)
      .max(8_192)
      .refine((value) => /^[\x21-\x3A\x3C-\x5B\x5D-\x7E]+$/u.test(value)),
    domain: z.string(),
    path: z.string().regex(/^\/[\x21-\x3A\x3C-\x7E]{0,511}$/u),
    expires: z.number().finite(),
    httpOnly: z.boolean(),
    secure: z.literal(true),
    sameSite: z.enum(["Strict", "Lax", "None"]),
  })
  .strict();

export type LmsCookie = z.infer<typeof cookieSchema>;

export interface SealedValue {
  readonly keyVersion: 1;
  readonly ivBase64: string;
  readonly authTagBase64: string;
  readonly ciphertextBase64: string;
}

export class LmsSessionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LmsSessionError";
  }
}

/**
 * Used only for short-lived pairing claim transport. LMS cookies are never
 * passed to this class or persisted by the server.
 */
export class AesGcmSessionSealer {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new LmsSessionError("LMS_SESSION_KEY_INVALID");
    }
  }

  seal(plaintext: string, associatedData: string): SealedValue {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return {
      keyVersion: 1,
      ivBase64: iv.toString("base64"),
      authTagBase64: cipher.getAuthTag().toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
    };
  }

  open(value: SealedValue, associatedData: string): string {
    try {
      if (value.keyVersion !== 1) {
        throw new Error("unsupported key");
      }
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(value.ivBase64, "base64"),
      );
      decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(Buffer.from(value.authTagBase64, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertextBase64, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new LmsSessionError("LMS_SESSION_DECRYPTION_FAILED");
    }
  }
}

export function normalizeLmsCookies(input: unknown): readonly LmsCookie[] {
  const parsed = z.array(cookieSchema).min(1).max(16).safeParse(input);
  if (!parsed.success) {
    throw new LmsSessionError("LMS_COOKIE_INVALID");
  }
  const seen = new Set<string>();
  return parsed.data
    .map((cookie) => {
      const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
      if (domain !== LMS_HOST) {
        throw new LmsSessionError("LMS_COOKIE_SCOPE_INVALID");
      }
      return { ...cookie, domain };
    })
    .filter((cookie) => {
      const key = `${cookie.name}\u0000${cookie.path}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      `${left.name}\u0000${left.path}`.localeCompare(
        `${right.name}\u0000${right.path}`,
      ),
    );
}
