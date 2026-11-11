/*
 * Behavior-preservation test for the sample-list construction optimization.
 *
 * The golden snapshot at .cache/bench/sample-golden.json is produced by
 * bench/generate-sample-golden.ts from the unmodified library. It contains,
 * for every parseable file of the conformance suite, every track and every
 * sample serialized field by field in sample-number order.
 *
 * This test re-parses the same files with the current code and asserts that
 * the sample arrays (length, order, every field of every sample, trak-level
 * sample totals) are identical to the pre-optimization snapshot.
 *
 * Regenerate the snapshot with "npm run golden:generate" (only intended to be
 * done against the reference implementation, before changing library code).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createFile, MP4BoxBuffer } from '../entries/all';
import { serializeSample } from '../bench/golden-snapshot';

const publishedDir = path.join(import.meta.dirname, '..', '.cache', 'files', 'published');
const goldenPath = path.join(import.meta.dirname, '..', '.cache', 'bench', 'sample-golden.json');

interface GoldenTrack {
  track_id: number;
  nb_samples: number;
  samples_size: number;
  samples_duration: number;
  samples: Array<Record<string, unknown>>;
}

interface GoldenFile {
  tracks: Array<GoldenTrack>;
}

interface GoldenSnapshot {
  version: number;
  files: Record<string, GoldenFile>;
}

function parseWholeFile(filePath: string) {
  const buffer = fs.readFileSync(filePath);
  const mp4 = createFile(false);
  const ready = new Promise<void>(resolve => {
    mp4.onReady = () => resolve();
  });
  mp4.appendBuffer(
    MP4BoxBuffer.fromArrayBuffer(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
      0,
    ),
  );
  mp4.flush();
  return ready.then(() => mp4);
}

const goldenExists = fs.existsSync(goldenPath);
const golden: GoldenSnapshot = goldenExists
  ? (JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as GoldenSnapshot)
  : { version: 0, files: {} };
const goldenFiles = Object.keys(golden.files).sort();

describe('Sample table golden comparison', () => {
  beforeAll(() => {
    if (!goldenExists) {
      throw new Error(
        'Golden snapshot missing. Run "npm run golden:generate" with the reference implementation first.',
      );
    }
  });

  it('covers the whole conformance suite snapshot', () => {
    // Guard against an accidentally truncated snapshot.
    expect(goldenFiles.length).toBeGreaterThan(100);
  });

  test.for(goldenFiles)('sample lists of %s', async relPath => {
    const filePath = path.join(publishedDir, ...relPath.split('/'));
    expect(fs.existsSync(filePath)).toBe(true);

    const mp4 = await parseWholeFile(filePath);
    const expected = golden.files[relPath];

    expect(mp4.moov).toBeDefined();
    expect(mp4.moov.traks.length).toBe(expected.tracks.length);

    for (let t = 0; t < expected.tracks.length; t++) {
      const expectedTrack = expected.tracks[t];
      const trak = mp4.moov.traks[t];

      // Track identity and trak-level aggregates.
      expect(trak.tkhd.track_id).toBe(expectedTrack.track_id);
      expect(trak.samples.length).toBe(expectedTrack.nb_samples);
      expect(trak.samples_size).toBe(expectedTrack.samples_size);
      expect(trak.samples_duration).toBe(expectedTrack.samples_duration);

      // The samples must remain a plain array indexed by sample number.
      expect(Array.isArray(trak.samples)).toBe(true);
      for (let j = 0; j < trak.samples.length; j++) {
        expect(trak.samples[j].number).toBe(j);
      }

      // Field-by-field comparison of every sample.
      for (let j = 0; j < expectedTrack.samples.length; j++) {
        const actual = serializeSample(trak.samples[j] as unknown as Record<string, unknown>);
        expect(actual, `track ${expectedTrack.track_id} sample ${j}`).toEqual(
          expectedTrack.samples[j],
        );
      }
    }
  });
});
