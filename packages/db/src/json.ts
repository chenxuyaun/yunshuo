import type { JSONValue } from 'postgres';

export function jsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}
