/*
 * Unit tests for the compact, column-oriented sample list.
 *
 * These tests pin the externally observable contract of trak.samples after
 * the memory optimization: array semantics, lazy materialization, read/write
 * propagation into the shared columns and plain-object behavior for optional
 * fields.
 */
import {
  FIELD_ALREADY_READ,
  FIELD_DTS,
  FIELD_DURATION,
  FIELD_IS_SYNC,
  FIELD_NUMBER,
  FIELD_OFFSET,
  FIELD_SIZE,
  SampleColumnStore,
  createSampleList,
} from '../src/sample-list';

function buildStore(capacity: number): SampleColumnStore {
  const store = new SampleColumnStore(capacity);
  store.descriptions[0] = { type: 'hvc1' } as never;
  for (let i = 0; i < capacity; i++) {
    store.columns[FIELD_SIZE][i] = 100 + i;
    store.columns[FIELD_OFFSET][i] = 1000 + i * 10;
    store.columns[FIELD_DTS][i] = i * 1000;
    store.columns[FIELD_DURATION][i] = 1000;
    store.columns[FIELD_IS_SYNC][i] = i % 10 === 0 ? 1 : 0;
    store.columns[FIELD_ALREADY_READ][i] = 0;
    store.columns[FIELD_NUMBER][i] = i;
  }
  return store;
}

describe('SampleList compact storage', () => {
  it('behaves as an array indexed by sample number without eager objects', () => {
    const store = buildStore(100);
    const samples = createSampleList(store);

    expect(Array.isArray(samples)).toBe(true);
    expect(samples.length).toBe(100);
    expect(samples.compactCount).toBe(100);
    // Nothing materialized before external access.
    expect(samples.materialized.size).toBe(0);
  });

  it('materializes identical values lazily and only once per sample', () => {
    const store = buildStore(50);
    const samples = createSampleList(store);

    const first = samples[0];
    expect(samples.materialized.size).toBe(1);
    expect(first.number).toBe(0);
    expect(first.size).toBe(100);
    expect(first.offset).toBe(1000);
    expect(first.dts).toBe(0);
    expect(first.duration).toBe(1000);
    expect(first.is_sync).toBe(true);
    expect(first.alreadyRead).toBe(0);
    expect(first.description).toEqual({ type: 'hvc1' });

    const again = samples[0];
    expect(again).toBe(first);
    expect(samples.materialized.size).toBe(1);

    const later = samples[49];
    expect(later.size).toBe(149);
    expect(later.is_sync).toBe(false);
    expect(samples.materialized.size).toBe(2);
  });

  it('propagates scalar writes through to the shared columns', () => {
    const store = buildStore(10);
    const samples = createSampleList(store);
    const sample = samples[3];

    sample.alreadyRead = 77;
    sample.size = 999;
    sample.offset = 4242;
    sample.is_sync = false;

    expect(store.columns[FIELD_ALREADY_READ][3]).toBe(77);
    expect(store.columns[FIELD_SIZE][3]).toBe(999);
    expect(store.columns[FIELD_OFFSET][3]).toBe(4242);
    expect(store.columns[FIELD_IS_SYNC][3]).toBe(0);

    // Re-reading reflects the column state even through a fresh materialization.
    expect(samples[3].alreadyRead).toBe(77);
    expect(samples[3].size).toBe(999);
  });

  it('keeps optional fields absent until assigned, like object literals', () => {
    const store = buildStore(4);
    const samples = createSampleList(store);
    const sample = samples[1];

    // Baseline plain objects never had these keys before assignment.
    expect('data' in sample).toBe(false);
    expect('subsamples' in sample).toBe(false);
    expect('sample_groups' in sample).toBe(false);
    expect('pts' in sample).toBe(false);
    expect(sample.data).toBeUndefined();

    const payload = new Uint8Array([1, 2, 3]);
    sample.data = payload;
    sample.subsamples = [{ size: 1, priority: 0, discardable: 0, codec_specific_parameters: 0 }];
    sample.pts = 5000;

    expect('data' in sample).toBe(true);
    expect(sample.data).toBe(payload);
    expect(sample.subsamples).toHaveLength(1);
    expect(sample.pts).toBe(5000);
    expect(Object.keys(sample).sort()).toContain('data');
    expect(Object.keys(sample).sort()).toContain('pts');

    // Another untouched sample still does not enumerate the optional keys.
    expect(Object.keys(samples[2])).not.toContain('data');
  });

  it('enumerates the same keys in the same order as a legacy sample object', () => {
    const store = buildStore(2);
    const samples = createSampleList(store);
    // Matches the property assignment order of the old object-literal path.
    expect(Object.keys(samples[0])).toEqual([
      'number',
      'track_id',
      'timescale',
      'alreadyRead',
      'size',
      'chunk_index',
      'chunk_run_index',
      'description_index',
      'description',
      'offset',
      'dts',
      'cts',
      'is_sync',
      'is_leading',
      'depends_on',
      'is_depended_on',
      'has_redundancy',
      'degradation_priority',
      'duration',
    ]);
  });

  it('supports arbitrary dynamic properties', () => {
    const store = buildStore(2);
    const samples = createSampleList(store);
    const sample = samples[0];

    expect((sample as Record<string, unknown>).custom).toBeUndefined();
    (sample as Record<string, unknown>).custom = { hello: 'world' };
    expect((samples[0] as Record<string, unknown>).custom).toEqual({ hello: 'world' });
    expect(Object.keys(samples[0])).toContain('custom');
  });

  it('accepts plain object literals pushed after the compact prefix', () => {
    const store = buildStore(3);
    const samples = createSampleList(store);

    const fragmented = { number: 3, dts: 3000, is_sync: true } as never;
    samples.push(fragmented);

    expect(samples.length).toBe(4);
    expect(samples[3]).toBe(fragmented);
    // Compact samples remain accessible.
    expect(samples[2].dts).toBe(2000);
    expect(samples.materialized.size).toBe(1);
  });

  it('iterates compact and appended samples uniformly', () => {
    const store = buildStore(3);
    const samples = createSampleList(store);
    samples.push({ number: 3 } as never);

    const numbers = samples.map(sample => sample.number);
    expect(numbers).toEqual([0, 1, 2, 3]);
    // map() must produce a plain array, not another SampleList.
    expect(Array.isArray(samples.map(sample => sample))).toBe(true);
  });

  it('round-trips through JSON.stringify like a plain object', () => {
    const store = buildStore(2);
    const samples = createSampleList(store);
    samples[0].data = new Uint8Array([9]);

    const parsed = JSON.parse(JSON.stringify(samples[0]));
    expect(parsed.size).toBe(100);
    expect(parsed.offset).toBe(1000);
    // Typed arrays serialize as {0: value} objects, same as on literals.
    expect(parsed.data).toEqual({ 0: 9 });
  });
});
