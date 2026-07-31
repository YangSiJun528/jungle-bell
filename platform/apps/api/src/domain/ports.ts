export interface Clock {
  now(): number;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export interface Hasher {
  hash(value: string): Promise<string>;
}
