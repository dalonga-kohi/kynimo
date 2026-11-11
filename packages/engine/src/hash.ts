/** One murmur3 block step: folds the 32-bit word `k` into the running hash `h`. */
export function murmurStep(h: number, k: number): number {
  let word = Math.imul(k, 0xcc9e2d51);
  word = (word << 15) | (word >>> 17);
  word = Math.imul(word, 0x1b873593);
  let hash = h ^ word;
  hash = (hash << 13) | (hash >>> 19);
  return (Math.imul(hash, 5) + 0xe6546b64) | 0;
}

/**
 * Integer hash of `seed` and a fixed list of 32-bit words to an unsigned 32-bit value: murmur3 x86_32
 * with one block step per word, the length (4 bytes per word) mixed in, then the fmix finalizer.
 * Signed words enter as their two's-complement bit pattern. Integer math only, so a GLSL `uint`
 * mirror (wrapping multiply) gives identical results (ADR-0045).
 */
export function hashWords(seed: number, words: readonly number[]): number {
  let h = seed >>> 0;
  for (const word of words) h = murmurStep(h, word);
  h ^= 4 * words.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Seeded 32-bit PRNG (mulberry32): pure integer math, so every platform agrees. Returns unsigned 32-bit integers. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
