# Long-movie performance benchmarks

These scripts reproduce and measure the cost of opening a long movie whose
moov box describes hundreds of thousands of samples. They operate on the
**built** bundle in `dist/`, i.e. the same code a browser runs, so run
`npm run build` first (and rebuild after any source change).

## Scripts

| Command                   | Purpose                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run bench:generate`  | Builds `.cache/bench/long_header.mp4` from the test asset `nalu/hevc/hvc1_only.mp4`. Its sample table is repeated 701 times to produce 180157 one-sample chunks (7206 s); only `ftyp` + `moov` are written, no `mdat`. The output is 2919834 bytes. |
| `npm run bench:time`      | Median time between the single `appendBuffer()` call and the `onReady` callback over several runs (with warmup and forced GC).                                                                                                                      |
| `npm run bench:memory`    | Resident heap retained per parsed movie after `onReady`, measured with forced GC while every parsed instance is kept alive.                                                                                                                         |
| `npm run golden:generate` | Regenerates the golden sample snapshot `.cache/bench/sample-golden.json` by parsing every parseable file of the conformance suite. Intended to be run against the reference implementation before changing library code.                            |

`tests/sample-golden.test.ts` compares the current implementation against the
golden snapshot, sample by sample and field by field (including property key
order). `tests/sample-list.test.ts` covers the compact column-oriented sample
list directly.
