/*
 * Serialization rules shared by the golden-snapshot generator
 * (bench/generate-sample-golden.ts) and its comparison test
 * (tests/sample-golden.test.ts).
 *
 * Keeping a single implementation on both sides of the comparison guarantees
 * that "same sample" serializes to exactly the same structure before and
 * after the optimization.
 */

/** Fields that hold fetched media payloads rather than sample metadata. */
export const SKIP_SAMPLE_FIELDS = new Set(['data']);

export function stableDescription(description: unknown): unknown {
  if (description === null || description === undefined) {
    return description;
  }
  if (typeof description !== 'object') {
    return description;
  }
  const box = description as { type?: unknown; box_name?: unknown };
  return { __box: true, type: String(box.type ?? ''), box_name: String(box.box_name ?? '') };
}

export function serializeSampleValue(key: string, value: unknown): unknown {
  // JSON snapshots need explicit null: JSON.stringify would drop the key
  // entirely for undefined, changing the golden format.
  /* eslint-disable unicorn/no-null */
  if (value === undefined) return null;
  if (value === null) return null;
  /* eslint-enable unicorn/no-null */
  if (typeof value === 'function') return { __function: true };
  if (typeof value === 'object') {
    if (key === 'description') {
      return stableDescription(value);
    }
    if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
      return { __typedarray: true, length: (value as unknown as { length: number }).length };
    }
    // Generic plain object / array (sample_groups, subsamples, ...).
    return JSON.parse(JSON.stringify(value));
  }
  return value;
}

export function serializeSample(sample: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(sample)) {
    if (SKIP_SAMPLE_FIELDS.has(key)) continue;
    out[key] = serializeSampleValue(key, sample[key]);
  }
  return out;
}
