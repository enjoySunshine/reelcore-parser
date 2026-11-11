/*
 * Shared helpers for the long-movie performance benchmarks.
 *
 * The benchmark scripts intentionally load the *built* bundle from dist/, i.e.
 * the exact code a browser would execute, rather than the TypeScript sources.
 * Run `npm run build` before the benchmarks (rebuild after any code change).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');
export const cacheDir = path.join(repoRoot, '.cache', 'bench');
export const synthFile = path.join(cacheDir, 'long_header.mp4');

/** Path of the source test asset used to build the synthetic long header. */
export const hvc1OnlyFile = path.join(
  repoRoot,
  '.cache',
  'files',
  'published',
  'nalu',
  'hevc',
  'hvc1_only.mp4',
);

export function ensureCacheDir() {
  fs.mkdirSync(cacheDir, { recursive: true });
}

export function loadMP4Box() {
  const bundlePath = path.join(repoRoot, 'dist', 'mp4box.all.mjs');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `Cannot find ${bundlePath}. Run "npm run build" before running the benchmarks.`,
    );
  }
  return require(bundlePath);
}

export function readArrayBuffer(filePath: string) {
  const buf = fs.readFileSync(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

export function median(values: Array<number>) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Parse a file in one shot and resolve with the ISOFile instance once onReady
 * has fired. Mirrors the way the web application feeds a moov-first MP4.
 */
export function parseOnce(MP4Box: ReturnType<typeof loadMP4Box>, arrayBuffer: ArrayBuffer) {
  return new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile(false);
    mp4.onReady = () => resolve(mp4);
    try {
      mp4.appendBuffer(MP4Box.MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0));
      mp4.flush();
    } catch (error) {
      reject(error);
    }
  });
}
