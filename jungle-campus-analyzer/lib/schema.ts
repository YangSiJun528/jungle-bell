import type { SchemaNode, SchemaType } from './types.ts';

const ENUM_VALUE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T/;

export function inferSchemaFromSamples(samples: unknown[]): SchemaNode {
  if (samples.length === 0) return { types: ['unknown'], sampleCount: 0 };
  const merged = samples.map((sample) => inferSchema(sample)).reduce(mergeSchemas);
  return applyPresence(merged);
}

export function mergeSchemas(left: SchemaNode, right: SchemaNode): SchemaNode {
  const merged: SchemaNode = {
    types: sortedUnique([...left.types, ...right.types]),
    sampleCount: left.sampleCount + right.sampleCount,
  };

  const formats = sortedUnique([left.format, right.format].filter((value): value is NonNullable<SchemaNode['format']> => Boolean(value)));
  if (formats.length === 1) merged.format = formats[0];

  const enumCandidates = sortedUnique([...(left.enumCandidates ?? []), ...(right.enumCandidates ?? [])]);
  if (enumCandidates.length > 0) merged.enumCandidates = enumCandidates;

  if (left.properties || right.properties) {
    const properties: Record<string, SchemaNode> = {};
    for (const key of sortedUnique([...Object.keys(left.properties ?? {}), ...Object.keys(right.properties ?? {})])) {
      const leftProperty = left.properties?.[key];
      const rightProperty = right.properties?.[key];
      properties[key] = leftProperty && rightProperty
        ? mergeSchemas(leftProperty, rightProperty)
        : cloneSchema(leftProperty ?? rightProperty!);
    }
    merged.properties = properties;
  }

  if (left.items && right.items) merged.items = mergeSchemas(left.items, right.items);
  else if (left.items || right.items) merged.items = cloneSchema(left.items ?? right.items!);

  return merged;
}

export function extractObservedErrorMetadata(value: unknown): { errorCodes: string[]; messages: string[] } {
  const errorCodes = new Set<string>();
  const messages = new Set<string>();

  if (typeof value === 'string') messages.add(redactText(value));

  visitValue(value, (key, item) => {
    if (typeof item !== 'string') return;
    const normalizedKey = key.toLowerCase();
    if ((normalizedKey.includes('errorcode') || normalizedKey === 'code') && ENUM_VALUE_RE.test(item)) {
      errorCodes.add(item);
      return;
    }
    if (normalizedKey.includes('message') || normalizedKey === 'error' || normalizedKey === 'detail') {
      messages.add(redactText(item));
    }
  });

  return {
    errorCodes: [...errorCodes].sort(),
    messages: [...messages].filter(Boolean).sort(),
  };
}

export function redactText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[ID]')
    .replace(/\bc[a-z0-9]{20,}\b/gi, '[ID]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[TOKEN]');
}

function inferSchema(value: unknown, fieldName: string | null = null): SchemaNode {
  if (value === undefined) return { types: ['empty'], sampleCount: 1 };
  if (value === null) return { types: ['null'], sampleCount: 1 };

  if (Array.isArray(value)) {
    const schema: SchemaNode = { types: ['array'], sampleCount: 1 };
    if (value.length > 0) schema.items = value.map((item) => inferSchema(item, fieldName)).reduce(mergeSchemas);
    return schema;
  }

  switch (typeof value) {
    case 'boolean':
      return { types: ['boolean'], sampleCount: 1 };
    case 'number':
      return { types: ['number'], sampleCount: 1 };
    case 'string': {
      const schema: SchemaNode = { types: ['string'], sampleCount: 1 };
      if (DATE_RE.test(value)) schema.format = 'date';
      else if (DATE_TIME_RE.test(value)) schema.format = 'date-time';
      if (isPotentialEnumField(fieldName) && ENUM_VALUE_RE.test(value)) schema.enumCandidates = [value];
      return schema;
    }
    case 'object': {
      const properties: Record<string, SchemaNode> = {};
      for (const [key, item] of Object.entries(value)) properties[key] = inferSchema(item, key);
      return { types: ['object'], sampleCount: 1, properties };
    }
    default:
      return { types: ['unknown'], sampleCount: 1 };
  }
}

function applyPresence(schema: SchemaNode): SchemaNode {
  const result = cloneSchema(schema);
  if ((result.enumCandidates?.length ?? 0) < 2) delete result.enumCandidates;
  if (result.properties) {
    for (const [key, property] of Object.entries(result.properties)) {
      const normalized = applyPresence(property);
      normalized.presence = property.sampleCount === result.sampleCount ? 'required' : 'optional';
      result.properties[key] = normalized;
    }
  }
  if (result.items) result.items = applyPresence(result.items);
  return result;
}

function isPotentialEnumField(fieldName: string | null): boolean {
  return Boolean(fieldName && /(status|type|category|target|code|role|state|label|kind|mode|reason|event|features?|permissions?)$/i.test(fieldName));
}

function cloneSchema(schema: SchemaNode): SchemaNode {
  return {
    ...schema,
    types: [...schema.types],
    enumCandidates: schema.enumCandidates ? [...schema.enumCandidates] : undefined,
    properties: schema.properties
      ? Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, cloneSchema(value)]))
      : undefined,
    items: schema.items ? cloneSchema(schema.items) : undefined,
  };
}

function visitValue(value: unknown, visitor: (key: string, value: unknown) => void, key = ''): void {
  visitor(key, value);
  if (Array.isArray(value)) {
    for (const item of value) visitValue(item, visitor, key);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) visitValue(child, visitor, childKey);
  }
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort() as T[];
}
