/*
 * Builds the synthetic "long movie" header used for the performance benchmarks.
 *
 * Starting from the test asset nalu/hevc/hvc1_only.mp4, the sample table of its
 * single video track is repeated REPEAT times to mimic the moov box of a
 * two-hour feature:
 *   - 180157 samples (257 * 701)
 *   - every sample is its own chunk (180157 chunk offsets / stsc entries)
 *   - 7206 seconds of declared media
 *
 * Only the ftyp and moov boxes are written out; there is no mdat box.
 *
 * Usage: npm run bench:generate
 */
import fs from 'node:fs';
import { DataStream } from '../dist/mp4box.all.mjs';
import { ensureCacheDir, hvc1OnlyFile, loadMP4Box, readArrayBuffer, synthFile } from './lib.ts';

const REPEAT = 701;
const BASE_SAMPLES = 257;
const TOTAL_SAMPLES = BASE_SAMPLES * REPEAT;

async function main() {
  ensureCacheDir();
  if (!fs.existsSync(hvc1OnlyFile)) {
    throw new Error(
      `Missing test asset ${hvc1OnlyFile}. Run the test suite once so the conformance files are downloaded.`,
    );
  }

  const MP4Box = loadMP4Box();
  const mp4 = await parseSource(MP4Box);

  const ftyp = mp4.boxes.find(box => box.type === 'ftyp');
  const moov = mp4.moov;
  if (!ftyp || !moov) {
    throw new Error('Source asset does not contain ftyp and moov boxes');
  }

  const trak = moov.traks[0];
  const stbl = trak.mdia.minf.stbl;
  const baseSizes = [...(stbl.stsz || stbl.stz2).sample_sizes];
  if (baseSizes.length !== BASE_SAMPLES) {
    throw new Error(`Expected ${BASE_SAMPLES} source samples, got ${baseSizes.length}`);
  }
  const baseCttsOffsets = stbl.ctts ? [...stbl.ctts.sample_offsets] : undefined;
  const baseStss = stbl.stss ? [...stbl.stss.sample_numbers] : undefined;

  const stsz = stbl.stsz || stbl.stz2;
  const stsc = stbl.stsc;
  const stco = stbl.stco || stbl.co64;
  const stts = stbl.stts;
  const ctts = stbl.ctts;
  const stss = stbl.stss;

  // stsz: repeat the per-sample sizes, make sure the constant-size shortcut is off.
  stsz.sample_size = 0;
  stsz.sample_count = TOTAL_SAMPLES;
  stsz.sample_sizes = new Array(TOTAL_SAMPLES);
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    stsz.sample_sizes[i] = baseSizes[i % BASE_SAMPLES];
  }

  // stsc: every chunk holds exactly one sample. A single run covers all
  // chunks; this is the compact form of the expanded per-chunk table and
  // produces identical sample properties.
  stsc.first_chunk = [1];
  stsc.samples_per_chunk = [1];
  stsc.sample_description_index = [1];

  // stco: monotonically increasing 32-bit offsets (no mdat is present, values
  // only need to be parseable and unique).
  stco.chunk_offsets = new Array(TOTAL_SAMPLES);
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    stco.chunk_offsets[i] = (i + 1) * 8;
  }

  // stts: one run per repetition, each covering 257 samples of 1000 ticks.
  stts.sample_counts = new Array(REPEAT).fill(BASE_SAMPLES);
  stts.sample_deltas = new Array(REPEAT).fill(1000);

  // ctts: repeat the 257 per-sample composition offsets.
  if (ctts && baseCttsOffsets) {
    ctts.sample_counts = new Array(TOTAL_SAMPLES).fill(1);
    ctts.sample_offsets = new Array(TOTAL_SAMPLES);
    for (let i = 0; i < TOTAL_SAMPLES; i++) {
      ctts.sample_offsets[i] = baseCttsOffsets[i % BASE_SAMPLES];
    }
  }

  // stss: shift sync sample numbers into every repetition.
  if (stss && baseStss) {
    stss.sample_numbers = new Array(baseStss.length * REPEAT);
    let k = 0;
    for (let r = 0; r < REPEAT; r++) {
      for (const n of baseStss) {
        stss.sample_numbers[k++] = r * BASE_SAMPLES + n;
      }
    }
  }

  const mediaDuration = TOTAL_SAMPLES * 1000;
  const timescale = trak.mdia.mdhd.timescale;
  trak.mdia.mdhd.duration = mediaDuration;
  trak.tkhd.duration = mediaDuration;
  const movieDuration = Math.round((mediaDuration / timescale) * moov.mvhd.timescale);
  moov.mvhd.duration = movieDuration;

  // Serialize ftyp + moov only.
  const stream = new DataStream();
  ftyp.write(stream);
  moov.write(stream);
  const bytes = new Uint8Array(stream.buffer, 0, stream.byteLength);
  fs.writeFileSync(synthFile, bytes);

  console.log(`Wrote ${synthFile}`);
  console.log(`  size: ${bytes.length} bytes`);
  console.log(`  samples: ${TOTAL_SAMPLES}, chunks: ${TOTAL_SAMPLES}`);
  console.log(`  media duration: ${mediaDuration / timescale} s`);
}

type MP4BoxModule = ReturnType<typeof loadMP4Box>;
type ISOFileInstance = ReturnType<MP4BoxModule['createFile']>;

function parseSource(MP4Box: MP4BoxModule): Promise<ISOFileInstance> {
  return new Promise<ISOFileInstance>((resolve, reject) => {
    const mp4 = MP4Box.createFile(true);
    mp4.onReady = () => resolve(mp4);
    try {
      mp4.appendBuffer(MP4Box.MP4BoxBuffer.fromArrayBuffer(readArrayBuffer(hvc1OnlyFile), 0));
      mp4.flush();
    } catch (error) {
      reject(error);
    }
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
