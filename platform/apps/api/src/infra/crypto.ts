import { createHash, randomBytes } from "node:crypto";

import type { Clock, Hasher, RandomSource } from "../domain/index.js";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class CryptoRandomSource implements RandomSource {
  bytes(length: number): Uint8Array {
    return randomBytes(length);
  }
}

export class Sha256Hasher implements Hasher {
  async hash(value: string): Promise<string> {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}

export function randomOpaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}
