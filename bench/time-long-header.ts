/*
 * Measures the time between appendBuffer() and the onReady callback when
 * parsing the synthetic long-movie header (.cache/bench/long_header.mp4).
 *
 * The file is appended in a single appendBuffer() call, exactly like the
 * reproduction described in the optimization request. Each iteration runs in
 * the same process after a forced GC so that heap state does not drift.
 *
 * Usage: npm run bench:time [-- --runs 7]
 */
import { ensureCacheDir, loadMP4Box, median, readArrayBuffer, synthFile } from './lib.ts';

function parseArgs() {
  const args = process.argv.slice(2);
  let runs = 7;
  let warmup = 3;
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
    throw new Error('This script must be run with --expose-gc (use "npm run bench:time").');
  }

  // Warm up the JIT compiler; these timings are discarded.
  for (let i = 0; i < warmup; i++) {
    globalThis.gc();
    const mp4 = await parseOnce(MP4Box, arrayBuffer);
    if (mp4.moov.traks[0].samples.length !== 180157) {
      throw new Error('Unexpected sample count during warmup');
    }
  }

  const timings: Array<number> = [];
  for (let i = 0; i < runs; i++) {
    globalThis.gc();
    const start = performance.now();
    const mp4 = await parseOnce(MP4Box, arrayBuffer);
    const elapsed = performance.now() - start;
    timings.push(elapsed);

    // Verify the parse result on every run.
    const trak = mp4.moov.traks[0];
    if (trak.samples.length !== 180157) {
      throw new Error(`Unexpected sample count: ${trak.samples.length}`);
    }
  }

  const med = median(timings);
  console.log(`appendBuffer -> onReady over ${runs} runs (ms)`);
  console.log('  runs:  ', timings.map(v => v.toFixed(2)).join(', '));
  console.log(`  median: ${med.toFixed(2)} ms`);
  console.log(`  min:    ${Math.min(...timings).toFixed(2)} ms`);
  console.log(`  max:    ${Math.max(...timings).toFixed(2)} ms`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
