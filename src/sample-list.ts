/*
 * Memory-compact representation of the sample list built from a moov sample
 * table.
 *
 * Historically every sample was a plain object literal, which costs roughly
 * 250 bytes per sample in retained heap. A two-hour feature easily has
 * hundreds of thousands of samples, so building those literal objects
 * dominated both the moov processing time and the resident memory.
 *
 * This module keeps the exact same externally visible behavior while storing
 * the sample table in column-oriented typed arrays:
 *
 *  - Scalar sample fields live in flat Float64Arrays shared by all samples of
 *    the track (about 8 bytes per field per sample, allocated outside the JS
 *    heap's object area).
 *  - The library's internal hot paths (sample extraction, seeking, fragment
 *    and segment writing) read and write the columns directly through
 *    SampleColumnStore, so no per-sample JavaScript object is created for a
 *    sample the application never inspects.
 *  - When external code indexes trak.samples[n], a sample proxy materializes
 *    lazily (and only once). It exposes every legacy Sample field with
 *    identical values and enumeration semantics; scalar reads and writes go
 *    straight through to the shared columns and optional fields
 *    (`data`, `subsamples`, `sample_groups`, ...) keep plain object behavior.
 *
 * SampleList is an Array subclass behind a thin Proxy that intercepts indexed
 * access for the compact prefix. Samples appended by the fragmented-movie
 * path stay plain object literals and are stored untouched, so mixed lists
 * work transparently.
 */
import type { Sample, SampleGroup, SubSample } from '@types';

/* Column indexes of the flat Float64Array backing store. */
export const FIELD_SIZE = 0;
export const FIELD_OFFSET = 1;
export const FIELD_DTS = 2;
export const FIELD_CTS = 3;
export const FIELD_DURATION = 4;
export const FIELD_CHUNK_INDEX = 5;
export const FIELD_CHUNK_RUN_INDEX = 6;
export const FIELD_DESCRIPTION_INDEX = 7;
export const FIELD_DEGRADATION_PRIORITY = 8;
export const FIELD_NUMBER = 9;
export const FIELD_TRACK_ID = 10;
export const FIELD_TIMESCALE = 11;
export const FIELD_IS_SYNC = 12;
export const FIELD_IS_LEADING = 13;
export const FIELD_DEPENDS_ON = 14;
export const FIELD_IS_DEPENDED_ON = 15;
export const FIELD_HAS_REDUNDANCY = 16;
export const FIELD_ALREADY_READ = 17;
export const FIELD_COUNT = 18;

/** Scalar field names in column order, matching the legacy Sample object. */
export const SCALAR_FIELDS = [
  'size',
  'offset',
  'dts',
  'cts',
  'duration',
  'chunk_index',
  'chunk_run_index',
  'description_index',
  'degradation_priority',
  'number',
  'track_id',
  'timescale',
  'is_sync',
  'is_leading',
  'depends_on',
  'is_depended_on',
  'has_redundancy',
  'alreadyRead',
] as const;

/**
 * Enumeration order of the fields on a legacy sample object literal. The
 * generic builder assigns properties in this sequence (duration is written
 * one iteration late and therefore appears last), so Object.keys() on a
 * materialized compact sample must follow the same order to stay
 * indistinguishable from the old implementation. Two variants exist because
 * the presence of an stss box changes when degradation_priority is assigned
 * relative to the sdtp fields.
 */
export const ENUMERATION_ORDER_WITH_STSS = [
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
  'degradation_priority',
  'is_leading',
  'depends_on',
  'is_depended_on',
  'has_redundancy',
  'duration',
] as const;

export const ENUMERATION_ORDER_WITHOUT_STSS = [
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
] as const;

const SCALAR_FIELD_TO_COLUMN: ReadonlyMap<string, number> = new Map(
  SCALAR_FIELDS.map((name, index) => [name, index]),
);

/** Fields that the legacy plain-object sample only defined conditionally. */
const OPTIONAL_FIELDS = [
  'data',
  'description',
  'subsamples',
  'sample_groups',
  'pts',
  'moof_number',
  'number_in_traf',
] as const;

const OPTIONAL_FIELD_SET: ReadonlySet<string> = new Set(OPTIONAL_FIELDS);

/** Non-scalar / optional sample state keyed by sample number. */
interface OptionalState {
  description?: Sample['description'];
  data?: Sample['data'];
  subsamples?: Array<SubSample>;
  sample_groups?: Array<SampleGroup>;
  pts?: number;
  moof_number?: number;
  number_in_traf?: number;
  dynamic?: Record<string, unknown>;
}

/** Internal identity of a materialized compact sample. */
class SampleSlot {
  constructor(
    readonly store: SampleColumnStore,
    readonly row: number,
  ) {}

  /**
   * Legacy key enumeration order for this sample. The generic builder only
   * differs in the position of degradation_priority: when an stss box marks
   * a sample as non-sync, its else branch assigns degradation_priority right
   * after is_sync (before the sdtp fields); sync samples and samples without
   * stss get it from the later stdp/default check, after the sdtp fields.
   */
  get enumerationOrder(): ReadonlyArray<string> {
    const hasStss = this.store.hasStss;
    if (hasStss && !this.store.columns[FIELD_IS_SYNC][this.row]) {
      return ENUMERATION_ORDER_WITH_STSS;
    }
    return ENUMERATION_ORDER_WITHOUT_STSS;
  }
}

/**
 * Column-oriented storage of a track's compact sample prefix plus the
 * read/write helpers used by internal hot paths. All accessors operate on
 * row indexes (sample numbers), no per-sample object is required.
 */
export class SampleColumnStore {
  readonly columns: Array<Float64Array>;
  readonly capacity: number;
  /** Sample description entries are objects, shared per description index. */
  descriptions: Array<Sample['description']> = [];
  /** Optional state, only allocated for samples that need it. */
  readonly optional: Array<OptionalState | undefined> = [];
  /** Whether the source track has an stss box; drives key ordering. */
  hasStss = false;

  constructor(capacity: number) {
    this.capacity = capacity;
    // One contiguous ArrayBuffer for every scalar column: a single backing
    // allocation instead of FIELD_COUNT independent typed arrays, which
    // removes allocation and GC bookkeeping overhead for long movies. The
    // buffer starts uninitialized and every column is filled explicitly by
    // the builder.
    this.buffer = new ArrayBuffer(capacity * FIELD_COUNT * Float64Array.BYTES_PER_ELEMENT);
    this.columns = new Array<Float64Array>(FIELD_COUNT);
    for (let i = 0; i < FIELD_COUNT; i++) {
      this.columns[i] = new Float64Array(
        this.buffer,
        i * capacity * Float64Array.BYTES_PER_ELEMENT,
        capacity,
      );
    }
  }

  /** Shared backing buffer of every scalar column. */
  readonly buffer: ArrayBuffer;

  ensureOptional(row: number): OptionalState {
    let state = this.optional[row];
    if (!state) {
      state = {};
      this.optional[row] = state;
    }
    return state;
  }

  /* Scalar field access for internal hot paths. */
  getNumber(row: number, column: number): number {
    return this.columns[column][row];
  }

  setNumber(row: number, column: number, value: number): void {
    this.columns[column][row] = value;
  }

  getSize(row: number): number {
    return this.columns[FIELD_SIZE][row];
  }
  setSize(row: number, value: number): void {
    this.columns[FIELD_SIZE][row] = value;
  }

  getOffset(row: number): number {
    return this.columns[FIELD_OFFSET][row];
  }
  setOffset(row: number, value: number): void {
    this.columns[FIELD_OFFSET][row] = value;
  }

  getDts(row: number): number {
    return this.columns[FIELD_DTS][row];
  }
  setDts(row: number, value: number): void {
    this.columns[FIELD_DTS][row] = value;
  }

  getCts(row: number): number {
    return this.columns[FIELD_CTS][row];
  }
  setCts(row: number, value: number): void {
    this.columns[FIELD_CTS][row] = value;
  }

  getDuration(row: number): number {
    return this.columns[FIELD_DURATION][row];
  }
  setDuration(row: number, value: number): void {
    this.columns[FIELD_DURATION][row] = value;
  }

  getAlreadyRead(row: number): number {
    return this.columns[FIELD_ALREADY_READ][row];
  }
  setAlreadyRead(row: number, value: number): void {
    this.columns[FIELD_ALREADY_READ][row] = value;
  }

  isSync(row: number): boolean {
    return this.columns[FIELD_IS_SYNC][row] !== 0;
  }

  getDescription(row: number): Sample['description'] {
    const state = this.optional[row];
    if (state && state.description !== undefined) return state.description;
    const index = this.columns[FIELD_DESCRIPTION_INDEX][row];
    return this.descriptions[index];
  }

  setDescription(row: number, description: Sample['description']): void {
    this.ensureOptional(row).description = description;
  }

  getData(row: number): Sample['data'] {
    return this.optional[row]?.data;
  }

  setData(row: number, value: Sample['data']): void {
    this.ensureOptional(row).data = value;
  }

  getSubsamples(row: number): Array<SubSample> | undefined {
    return this.optional[row]?.subsamples;
  }

  setSubsamples(row: number, value: Array<SubSample> | undefined): void {
    this.ensureOptional(row).subsamples = value;
  }

  getSampleGroups(row: number): Array<SampleGroup> | undefined {
    return this.optional[row]?.sample_groups;
  }

  setSampleGroups(row: number, value: Array<SampleGroup> | undefined): void {
    this.ensureOptional(row).sample_groups = value;
  }

  getPts(row: number): number | undefined {
    return this.optional[row]?.pts;
  }

  setPts(row: number, value: number | undefined): void {
    this.ensureOptional(row).pts = value;
  }

  getMoofNumber(row: number): number | undefined {
    return this.optional[row]?.moof_number;
  }

  setMoofNumber(row: number, value: number | undefined): void {
    this.ensureOptional(row).moof_number = value;
  }

  getNumberInTraf(row: number): number | undefined {
    return this.optional[row]?.number_in_traf;
  }

  setNumberInTraf(row: number, value: number | undefined): void {
    this.ensureOptional(row).number_in_traf = value;
  }

  getDynamic(row: number, key: string): unknown {
    return this.optional[row]?.dynamic?.[key];
  }

  setDynamic(row: number, key: string, value: unknown): void {
    const state = this.ensureOptional(row);
    if (!state.dynamic) state.dynamic = {};
    state.dynamic[key] = value;
  }

  hasDynamic(row: number, key: string): boolean {
    const state = this.optional[row];
    return !!state?.dynamic && Object.prototype.hasOwnProperty.call(state.dynamic, key);
  }

  deleteOptional(row: number, key: string): void {
    const state = this.optional[row];
    if (!state) return;
    if (key === 'dynamic') {
      state.dynamic = undefined;
    } else if (key in state) {
      Reflect.deleteProperty(state, key);
    }
  }
}

/** Proxy behavior of a materialized compact sample. */
class SampleProxyHandler implements ProxyHandler<SampleSlot> {
  get(target: SampleSlot, key: string | symbol, receiver: unknown): unknown {
    if (typeof key === 'symbol') {
      if (key === Symbol.toPrimitive) return undefined;
      return Reflect.get(target, key, receiver);
    }
    const { store, row } = target;
    const column = SCALAR_FIELD_TO_COLUMN.get(key);
    if (column !== undefined) {
      if (key === 'is_sync') return store.columns[column][row] !== 0;
      return store.columns[column][row];
    }
    if (key === 'description') return store.getDescription(row);
    if (OPTIONAL_FIELD_SET.has(key)) {
      return store.optional[row]?.[key as (typeof OPTIONAL_FIELDS)[number]];
    }
    const dynamic = store.optional[row]?.dynamic;
    if (dynamic && Object.prototype.hasOwnProperty.call(dynamic, key)) {
      return dynamic[key];
    }
    return Reflect.get(target, key, receiver);
  }

  set(target: SampleSlot, key: string | symbol, value: unknown, receiver: unknown): boolean {
    if (typeof key === 'symbol') {
      return Reflect.set(target, key, value, receiver);
    }
    const { store, row } = target;
    const column = SCALAR_FIELD_TO_COLUMN.get(key);
    if (column !== undefined) {
      store.columns[column][row] = key === 'is_sync' ? (value ? 1 : 0) : (value as number);
      return true;
    }
    if (OPTIONAL_FIELD_SET.has(key)) {
      store.ensureOptional(row)[key as (typeof OPTIONAL_FIELDS)[number]] = value as never;
      return true;
    }
    store.setDynamic(row, key, value);
    return true;
  }

  has(target: SampleSlot, key: string | symbol): boolean {
    if (typeof key === 'string') {
      if (SCALAR_FIELD_TO_COLUMN.has(key) || key === 'description') return true;
      if (OPTIONAL_FIELD_SET.has(key)) {
        const state = target.store.optional[target.row];
        return !!state && state[key as (typeof OPTIONAL_FIELDS)[number]] !== undefined;
      }
      if (target.store.hasDynamic(target.row, key)) return true;
    }
    return Reflect.has(target, key);
  }

  ownKeys(target: SampleSlot): Array<string | symbol> {
    // Enumeration order matches the legacy object-literal construction for
    // this specific sample (sync vs non-sync under an stss box).
    const keys: Array<string | symbol> = [...target.enumerationOrder];
    const state = target.store.optional[target.row];
    if (state) {
      for (const key of OPTIONAL_FIELDS) {
        if (key === 'description') continue;
        if (state[key] !== undefined) keys.push(key);
      }
      if (state.dynamic) keys.push(...Object.keys(state.dynamic));
    }
    return keys;
  }

  getOwnPropertyDescriptor(
    target: SampleSlot,
    key: string | symbol,
  ): PropertyDescriptor | undefined {
    if (typeof key === 'symbol') {
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
    if (SCALAR_FIELD_TO_COLUMN.has(key) || key === 'description' || this.has(target, key)) {
      return {
        enumerable: true,
        configurable: true,
        writable: true,
        value: this.get(target, key, undefined),
      };
    }
    return Reflect.getOwnPropertyDescriptor(target, key);
  }

  defineProperty(
    target: SampleSlot,
    key: string | symbol,
    descriptor: PropertyDescriptor,
  ): boolean {
    if (typeof key === 'string' && 'value' in descriptor) {
      this.set(target, key, descriptor.value, undefined);
      return true;
    }
    return Reflect.defineProperty(target, key, descriptor);
  }

  deleteProperty(target: SampleSlot, key: string | symbol): boolean {
    if (typeof key === 'string') {
      if (OPTIONAL_FIELD_SET.has(key) || target.store.hasDynamic(target.row, key)) {
        target.store.deleteOptional(target.row, key);
        return true;
      }
    }
    return Reflect.deleteProperty(target, key);
  }
}

const sampleHandler = new SampleProxyHandler();

/**
 * Array-like list of samples backed by a SampleColumnStore for its compact
 * prefix. Indexed access lazily materializes sample proxies; plain object
 * literals pushed by fragmented-movie handling are stored as-is after the
 * compact prefix.
 */
export class SampleList extends Array<Sample> {
  /** Column storage of the compact prefix; undefined for plain lists. */
  columnStore?: SampleColumnStore;
  /** Number of compact (column-backed) samples at the start of the list. */
  compactCount = 0;
  /**
   * Cache of materialized sample proxies, keyed by sample number. A Map
   * avoids allocating a capacity-sized hole array when the application only
   * inspects a few samples.
   */
  materialized = new Map<number, Sample>();

  static get [Symbol.species](): ArrayConstructor {
    // Built-in array operations must produce plain arrays.
    return Array;
  }

  initCompact(store: SampleColumnStore): void {
    this.columnStore = store;
    this.compactCount = store.capacity;
    // Keep the reported length accurate without filling holes with objects.
    this.length = store.capacity;
  }

  /** Internal: raw column accessor for hot paths, no materialization. */
  get columns(): SampleColumnStore | undefined {
    return this.columnStore;
  }

  /** Materializes (once) and returns the sample for external consumers. */
  getSample(index: number): Sample {
    if (index < this.compactCount) {
      let sample = this.materialized.get(index);
      if (!sample) {
        const store = this.columnStore;
        if (!store) {
          throw new Error('Compact sample list has no column store');
        }
        sample = new Proxy(new SampleSlot(store, index), sampleHandler) as unknown as Sample;
        this.materialized.set(index, sample);
      }
      return sample;
    }
    // Appended plain object literals (fragmented-movie path, sample creation
    // API) are regular array elements beyond the compact prefix.
    return (this as unknown as Array<Sample>)[index];
  }

  /*
   * Built-in array iteration methods read indexed elements through internal
   * slots of the underlying target and would see the compact prefix as
   * holes. Override them to route every element access through getSample().
   */
  *[Symbol.iterator](): IterableIterator<Sample> {
    for (let i = 0; i < this.length; i++) {
      yield this.getSample(i);
    }
  }

  forEach(callback: (sample: Sample, index: number, array: Array<Sample>) => void): void {
    for (let i = 0; i < this.length; i++) {
      callback(this.getSample(i), i, this as unknown as Array<Sample>);
    }
  }

  map<U>(callback: (sample: Sample, index: number, array: Array<Sample>) => U): Array<U> {
    const result = new Array<U>(this.length);
    for (let i = 0; i < this.length; i++) {
      result[i] = callback(this.getSample(i), i, this as unknown as Array<Sample>);
    }
    return result;
  }

  filter(
    callback: (sample: Sample, index: number, array: Array<Sample>) => boolean,
  ): Array<Sample> {
    const result: Array<Sample> = [];
    for (let i = 0; i < this.length; i++) {
      const sample = this.getSample(i);
      if (callback(sample, i, this as unknown as Array<Sample>)) result.push(sample);
    }
    return result;
  }

  find(
    callback: (sample: Sample, index: number, array: Array<Sample>) => boolean,
  ): Sample | undefined {
    for (let i = 0; i < this.length; i++) {
      const sample = this.getSample(i);
      if (callback(sample, i, this as unknown as Array<Sample>)) return sample;
    }
    return undefined;
  }

  indexOf(searchElement: Sample, fromIndex = 0): number {
    for (let i = Math.max(fromIndex, 0); i < this.length; i++) {
      if (this.getSample(i) === searchElement) return i;
    }
    return -1;
  }

  includes(searchElement: Sample, fromIndex = 0): boolean {
    return this.indexOf(searchElement, fromIndex) !== -1;
  }

  some(callback: (sample: Sample, index: number, array: Array<Sample>) => boolean): boolean {
    for (let i = 0; i < this.length; i++) {
      if (callback(this.getSample(i), i, this as unknown as Array<Sample>)) return true;
    }
    return false;
  }

  // Narrower runtime implementation; the standard library type uses type
  // predicates / overloads that cannot be expressed on a subclass directly.
  // @ts-expect-error override intentionally simplifies the Array signature
  every(callback: (sample: Sample, index: number, array: Array<Sample>) => boolean): boolean {
    for (let i = 0; i < this.length; i++) {
      if (!callback(this.getSample(i), i, this as unknown as Array<Sample>)) return false;
    }
    return true;
  }

  // @ts-expect-error override intentionally simplifies the Array signature
  reduce<U>(
    callback: (accumulator: U, sample: Sample, index: number, array: Array<Sample>) => U,
    initialValue: U,
  ): U {
    let accumulator = initialValue;
    for (let i = 0; i < this.length; i++) {
      accumulator = callback(accumulator, this.getSample(i), i, this as unknown as Array<Sample>);
    }
    return accumulator;
  }
}

/**
 * Wraps a SampleList so that indexed property access transparently goes
 * through getSample(), while length, iteration and array methods keep their
 * normal behavior.
 */
class SampleListProxyHandler implements ProxyHandler<SampleList> {
  get(target: SampleList, key: string | symbol, receiver: unknown): unknown {
    if (typeof key === 'string') {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < target.length) {
        return target.getSample(index);
      }
    }
    return Reflect.get(target, key, receiver);
  }

  set(target: SampleList, key: string | symbol, value: unknown, receiver: unknown): boolean {
    if (typeof key === 'string') {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < target.compactCount) {
        // A direct slot replacement drops the compact linkage for this row
        // and behaves like a plain array element assignment from then on.
        target.materialized.set(index, value as Sample);
        target.compactCount = Math.min(target.compactCount, index);
        return Reflect.set(target, key, value, receiver);
      }
    }
    return Reflect.set(target, key, value, receiver);
  }
}

const listHandler = new SampleListProxyHandler();

/** Creates the externally visible, lazily materializing sample array. */
export function createSampleList(store?: SampleColumnStore): SampleList {
  const list = new SampleList();
  if (store) list.initCompact(store);
  return new Proxy(list, listHandler) as unknown as SampleList;
}
