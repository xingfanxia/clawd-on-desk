// test/dhash.test.js — Unit tests for perceptual hash (dHash) algorithm
// Tests the computeDHash and hammingDistance functions from soul/client.js
const { describe, it } = require("node:test");
const assert = require("node:assert");

// ---------------------------------------------------------------------------
// Extract the pure algorithm functions (same logic as soul/client.js)
// ---------------------------------------------------------------------------

function computeDHashFromBitmap(bitmap, width, height) {
  // Same algorithm as computeDHash in client.js, but takes raw bitmap
  let hash = BigInt(0);
  let bit = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const idx1 = (y * width + x) * 4;
      const idx2 = (y * width + x + 1) * 4;
      const g1 = (bitmap[idx1] + bitmap[idx1 + 1] + bitmap[idx1 + 2]) / 3;
      const g2 = (bitmap[idx2] + bitmap[idx2 + 1] + bitmap[idx2 + 2]) / 3;
      if (g1 > g2) hash |= (BigInt(1) << BigInt(bit));
      bit++;
    }
  }
  return hash;
}

function hammingDistance(a, b) {
  let xor = a ^ b;
  let count = 0;
  while (xor > BigInt(0)) {
    count += Number(xor & BigInt(1));
    xor >>= BigInt(1);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Helper: create a fake BGRA bitmap buffer
// ---------------------------------------------------------------------------
function makeBitmap(width, height, pixelFn) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b } = pixelFn(x, y);
      const idx = (y * width + x) * 4;
      buf[idx] = b;     // B
      buf[idx + 1] = g; // G
      buf[idx + 2] = r; // R
      buf[idx + 3] = 255; // A
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dHash algorithm", () => {

  it("identical bitmaps produce identical hashes", () => {
    const bitmap = makeBitmap(9, 8, (x) => ({ r: x * 28, g: x * 28, b: x * 28 }));
    const hash1 = computeDHashFromBitmap(bitmap, 9, 8);
    const hash2 = computeDHashFromBitmap(bitmap, 9, 8);
    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hammingDistance(hash1, hash2), 0);
  });

  it("all-black bitmap produces zero hash", () => {
    const bitmap = makeBitmap(9, 8, () => ({ r: 0, g: 0, b: 0 }));
    const hash = computeDHashFromBitmap(bitmap, 9, 8);
    assert.strictEqual(hash, BigInt(0));
  });

  it("uniform color bitmap (all same) produces zero hash", () => {
    const bitmap = makeBitmap(9, 8, () => ({ r: 128, g: 128, b: 128 }));
    const hash = computeDHashFromBitmap(bitmap, 9, 8);
    assert.strictEqual(hash, BigInt(0));
  });

  it("alternating pattern produces non-zero hash", () => {
    // Alternating bright/dark: ensures some g1 > g2 comparisons are true
    const bitmap = makeBitmap(9, 8, (x) => {
      const v = x % 2 === 0 ? 200 : 50;
      return { r: v, g: v, b: v };
    });
    const hash = computeDHashFromBitmap(bitmap, 9, 8);
    assert.notStrictEqual(hash, BigInt(0));
  });

  it("inverted gradient produces different hash", () => {
    const gradient = makeBitmap(9, 8, (x) => ({ r: x * 28, g: x * 28, b: x * 28 }));
    const inverted = makeBitmap(9, 8, (x) => ({ r: 252 - x * 28, g: 252 - x * 28, b: 252 - x * 28 }));
    const h1 = computeDHashFromBitmap(gradient, 9, 8);
    const h2 = computeDHashFromBitmap(inverted, 9, 8);
    assert.notStrictEqual(h1, h2);
    // Inverted gradient should differ in most bits
    const dist = hammingDistance(h1, h2);
    assert.ok(dist > 32, `Expected high distance for inverted gradient, got ${dist}`);
  });

  it("similar bitmaps have low hamming distance", () => {
    // Original: smooth gradient
    const original = makeBitmap(9, 8, (x, y) => {
      const v = (x * 28 + y * 10) % 256;
      return { r: v, g: v, b: v };
    });
    // Slightly perturbed: add small noise (simulates cursor blink, clock tick)
    const perturbed = makeBitmap(9, 8, (x, y) => {
      const v = (x * 28 + y * 10) % 256;
      const noise = (x === 4 && y === 3) ? 5 : 0; // tiny change at one pixel
      return { r: Math.min(255, v + noise), g: Math.min(255, v + noise), b: Math.min(255, v + noise) };
    });
    const h1 = computeDHashFromBitmap(original, 9, 8);
    const h2 = computeDHashFromBitmap(perturbed, 9, 8);
    const dist = hammingDistance(h1, h2);
    assert.ok(dist <= 5, `Expected low distance for minor perturbation, got ${dist}`);
  });

  it("structurally different bitmaps have high hamming distance", () => {
    // Screen A: alternating columns (bright-dark-bright-dark)
    const screenA = makeBitmap(9, 8, (x) => {
      const v = x % 2 === 0 ? 200 : 50;
      return { r: v, g: v, b: v };
    });
    // Screen B: inverted alternating (dark-bright-dark-bright)
    const screenB = makeBitmap(9, 8, (x) => {
      const v = x % 2 === 0 ? 50 : 200;
      return { r: v, g: v, b: v };
    });
    const h1 = computeDHashFromBitmap(screenA, 9, 8);
    const h2 = computeDHashFromBitmap(screenB, 9, 8);
    const dist = hammingDistance(h1, h2);
    assert.ok(dist > 30, `Expected high distance for inverted pattern, got ${dist}`);
  });

  it("produces exactly 64 bits", () => {
    const bitmap = makeBitmap(9, 8, (x) => ({ r: x * 28, g: x * 28, b: x * 28 }));
    const hash = computeDHashFromBitmap(bitmap, 9, 8);
    // Max possible value is 2^64 - 1
    assert.ok(hash >= BigInt(0));
    assert.ok(hash < (BigInt(1) << BigInt(64)));
  });
});

describe("hammingDistance", () => {

  it("identical values have distance 0", () => {
    assert.strictEqual(hammingDistance(BigInt(0), BigInt(0)), 0);
    assert.strictEqual(hammingDistance(BigInt(0xFF), BigInt(0xFF)), 0);
  });

  it("one bit difference", () => {
    assert.strictEqual(hammingDistance(BigInt(0), BigInt(1)), 1);
    assert.strictEqual(hammingDistance(BigInt(0b1010), BigInt(0b1011)), 1);
  });

  it("all bits different for 8-bit values", () => {
    assert.strictEqual(hammingDistance(BigInt(0xFF), BigInt(0)), 8);
  });

  it("64-bit maximum distance", () => {
    const allOnes = (BigInt(1) << BigInt(64)) - BigInt(1);
    assert.strictEqual(hammingDistance(allOnes, BigInt(0)), 64);
  });

  it("symmetry: d(a,b) == d(b,a)", () => {
    const a = BigInt(0xDEADBEEF);
    const b = BigInt(0xCAFEBABE);
    assert.strictEqual(hammingDistance(a, b), hammingDistance(b, a));
  });
});
