export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function deepFreezeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    const cloned = value.map((item) => deepFreezeUnknown(item));
    return Object.freeze(cloned);
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = { ...value };
    for (const key of Object.keys(clone)) {
      clone[key] = deepFreezeUnknown(clone[key]);
    }
    return Object.freeze(clone);
  }
  return value;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  return deepFreezeUnknown(value) as Readonly<T>;
}
