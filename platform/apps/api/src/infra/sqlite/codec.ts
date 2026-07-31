export class SqliteDataIntegrityError extends Error {
  readonly code = "SQLITE_DATA_INTEGRITY";

  constructor(message: string) {
    super(message);
    this.name = "SqliteDataIntegrityError";
  }
}

export function expectRow(
  value: unknown,
  expectedKeys: readonly string[],
  recordName: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new SqliteDataIntegrityError(
      `${recordName} row is not an object.`,
    );
  }

  const row = value as Record<string, unknown>;
  const actualKeys = Object.keys(row).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new SqliteDataIntegrityError(
      `${recordName} row has an unexpected shape.`,
    );
  }
  return row;
}

export function readText(
  row: Record<string, unknown>,
  key: string,
): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SqliteDataIntegrityError(`${key} must be non-empty text.`);
  }
  return value;
}

export function readNullableText(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  return readText(row, key);
}

export function readInteger(
  row: Record<string, unknown>,
  key: string,
): number {
  const value = row[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new SqliteDataIntegrityError(
      `${key} must be a non-negative safe integer.`,
    );
  }
  return value;
}

export function readNullableInteger(
  row: Record<string, unknown>,
  key: string,
): number | null {
  return row[key] === null ? null : readInteger(row, key);
}

export function readBoolean(
  row: Record<string, unknown>,
  key: string,
): boolean {
  const value = row[key];
  if (value !== 0 && value !== 1) {
    throw new SqliteDataIntegrityError(`${key} must be 0 or 1.`);
  }
  return value === 1;
}

export function parseStringArray(
  serialized: string,
  field: string,
  options: {
    readonly allowedValues?: ReadonlySet<string>;
    readonly requireNonEmpty?: boolean;
  } = {},
): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SqliteDataIntegrityError(`${field} is not valid JSON.`);
  }

  if (
    !Array.isArray(parsed) ||
    (options.requireNonEmpty === true && parsed.length === 0) ||
    parsed.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        options.allowedValues?.has(value) === false,
    )
  ) {
    throw new SqliteDataIntegrityError(
      `${field} is not a valid string array.`,
    );
  }

  const values = parsed as string[];
  const normalized = [...new Set(values)].sort();
  if (
    normalized.length !== values.length ||
    normalized.some((value, index) => value !== values[index])
  ) {
    throw new SqliteDataIntegrityError(
      `${field} must be sorted and contain unique values.`,
    );
  }
  return values;
}

export function serializeStringArray(
  values: readonly string[],
  field: string,
  options: {
    readonly allowedValues?: ReadonlySet<string>;
    readonly requireNonEmpty?: boolean;
  } = {},
): string {
  const serialized = JSON.stringify(values);
  parseStringArray(serialized, field, options);
  return serialized;
}

export function isSqliteUniquenessError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code: unknown }).code;
  return (
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export function assertNextVersion(
  nextVersion: number,
  expectedVersion: number,
): void {
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    nextVersion !== expectedVersion + 1
  ) {
    throw new SqliteDataIntegrityError(
      "Record version must increment by exactly one.",
    );
  }
}

export function assertCiphertext(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /^jbs_[0-9a-f]{64}$/.test(value)
  ) {
    throw new SqliteDataIntegrityError(
      "Approved session value must be ciphertext, not a session token.",
    );
  }
}
