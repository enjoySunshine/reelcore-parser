/*
 * Generates the "golden" sample-table snapshot used by
 * tests/sample-golden.test.ts to prove that the sample-list optimization does
 * not change any externally visible behavior.
 *
 * Every parseable file under the downloaded conformance suite
 * (.cache/files/published) is parsed in full (including fragments), and for
 * every track every sample is serialized field by field in sample-number
 * order. The resulting JSON is written to .cache/bench/sample-golden.json.
 *
 * This script must be executed BEFORE modifying any library source code, and
 * re-executed is not needed afterwards: the test compares the current code
 * against the snapshot captured here.
 *
 * Usage: npm run golden:generate
 */
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, ensureCacheDir, loadMP4Box } from './lib.ts';
import { serializeSample } from './golden-snapshot.ts';

const publishedDir = path.join(cacheDir, '..', 'files', 'published');
const goldenPath = path.join(cacheDir, 'sample-golden.json');

function walk(dir: string): Array<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: Array<string> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  ensureCacheDir();
  if (!fs.existsSync(publishedDir)) {
    throw new Error(
      `Missing ${publishedDir}. Run the test suite once so the conformance files are downloaded.`,
    );
  }

  const MP4Box = loadMP4Box();
  const allFiles = walk(publishedDir);
  const golden: Record<string, unknown> = {};
  const skipped: Array<{ file: string; reason: string }> = [];

  let count = 0;
  for (const file of allFiles) {
    const rel = path.relative(publishedDir, file).split(path.sep).join('/');
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      skipped.push({ file: rel, reason: 'unreadable' });
      continue;
    }

    const mp4 = MP4Box.createFile(false);
    let ready = false;
    mp4.onReady = () => {
      ready = true;
    };
    try {
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
      mp4.appendBuffer(MP4Box.MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0));
      mp4.flush();
    } catch (error) {
      skipped.push({ file: rel, reason: `parse error: ${String(error)}` });
      continue;
    }

    if (!ready || !mp4.moov) {
      skipped.push({ file: rel, reason: 'no moov' });
      continue;
    }

    const tracks: Array<unknown> = [];
    let totalSamples = 0;
    for (const trak of mp4.moov.traks) {
      // Some non-MP4 containers (e.g. .iso3) expose tracks without a full
      // sample table; buildTrakSampleLists leaves those without samples.
      if (!trak.mdia?.minf?.stbl?.stts) {
        skipped.push({
          file: rel,
          reason: 'track without stts sample table',
        });
        continue;
      }
      const samples = trak.samples ?? [];
      totalSamples += samples.length;
      tracks.push({
        track_id: trak.tkhd?.track_id,
        nb_samples: samples.length,
        samples_size: trak.samples_size,
        samples_duration: trak.samples_duration,
        samples: samples.map((sample: Record<string, unknown>) => serializeSample(sample)),
      });
    }
    golden[rel] = { tracks };
    count++;
    console.log(`golden: ${rel} (${totalSamples} samples)`);
  }

  fs.writeFileSync(
    goldenPath,
    JSON.stringify({ version: 1, generated_at: new Date().toISOString(), files: golden, skipped }),
  );
  console.log(`\nWrote ${goldenPath}`);
  console.log(`  files captured: ${count}`);
  console.log(`  files skipped:  ${skipped.length}`);
  for (const item of skipped) {
    console.log(`    - ${item.file}: ${item.reason}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
