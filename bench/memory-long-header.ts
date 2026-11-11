/*
 * Measures the resident heap retained by mp4box after onReady for the
 * synthetic long-movie header.
 *
 * Every parsed ISOFile instance is kept alive for the whole script, so the
 * reported values measure the memory added by each additional parsed movie
 * rather than memory that the garbage collector is free to reclaim.
 *
 * For every iteration:
 *   1. force GC and record process.memoryUsage().heapUsed
 *   2. parse the header in one appendBuffer() call and wait for onReady
 *   3. force GC again and record heapUsed; the instance is retained
 *
 * Run with --expose-gc.
 *
 * Usage: npm run bench:memory [-- --runs 5]
 */
import { ensureCacheDir, loadMP4Box, median, readArrayBuffer, synthFile } from './lib.ts';

function parseArgs() {
  const args = process.argv.slice(2);
  let runs = 5;
  let warmup = 2;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs') runs = Number(args[++i]);
    if (args[i] === '--warmup') warmup = Number(args[++i]);
  }
  return { runs, warmup };
}

async function parseOnce(MP4Box: ReturnType<typeof loadMP4Box>, arrayBuffer: ArrayBuffer) {
  const bytes = arrayBuffer.slice(0);
  const mp4 = MP4Box.createFile(false);
  const ready = new Promise<void>(resolve => {
    mp4.onReady = () => resolve();
  });
  mp4.appendBuffer(MP4Box.MP4BoxBuffer.fromArrayBuffer(bytes, 0));
  mp4.flush();
  await ready;
  return mp4;
}

async function main() {
  ensureCacheDir();
  const { runs, warmup } = parseArgs();
  const MP4Box = loadMP4Box();
  const arrayBuffer = readArrayBuffer(synthFile);

  if (typeof globalThis.gc !== 'function') {
    throw new Error('This script must be run with --expose-gc (use "npm run bench:memory").');
  }

  // All parsed instances are retained so their heap cannot be reclaimed
  // before the end of the measurement.
  const retained: Array<unknown> = [];

  // Warm up the JIT compiler; these parses are retained as well.
  for (let i = 0; i < warmup; i++) {
    globalThis.gc();
    const mp4 = await parseOnce(MP4Box, arrayBuffer);
    retained.push(mp4);
    if (mp4.moov.traks[0].samples.length !== 180157) {
      throw new Error('Unexpected sample count during warmup');
    }
  }

  const deltas: Array<number> = [];
  let sampleCount = 0;
  for (let i = 0; i < runs; i++) {
    globalThis.gc();
    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const mp4 = await parseOnce(MP4Box, arrayBuffer);
    retained.push(mp4);

    globalThis.gc();
    globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    deltas.push(heapAfter - heapBefore);
    sampleCount = mp4.moov.traks[0].samples.length;
    if (sampleCount !== 180157) {
      throw new Error(`Unexpected sample count: ${sampleCount}`);
    }
  }

  // Reference the array once more so retention cannot be optimized away.
  if (!retained.length) throw new Error('No instances measured');

  const med = median(deltas);
  const toMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
  console.log(`retained heap per parsed movie over ${runs} runs (instances kept alive)`);
  console.log('  runs (MB):       ', deltas.map(v => toMB(v)).join(', '));
  console.log(`  median:          ${toMB(med)} MB`);
  console.log(`  samples:         ${sampleCount}`);
  console.log(`  bytes / sample:  ${(med / sampleCount).toFixed(1)}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
