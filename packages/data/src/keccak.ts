/**
 * Minimal pure-TypeScript Keccak-256 (the Ethereum variant, padding 0x01 —
 * NOT NIST SHA3-256). The project has zero runtime dependencies and Node's
 * crypto module offers SHA3 but not Keccak, so function selectors are
 * computed with this implementation.
 *
 * Verified against known vectors:
 *   keccak256("")                            = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
 *   keccak256("transfer(address,uint256)")   → selector a9059cbb
 *   keccak256("latestRoundData()")           → selector feaf968c
 */

const MASK64 = (1n << 64n) - 1n;

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets r[x][y]. */
const RHO: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl64(x: bigint, n: number): bigint {
  if (n === 0) return x;
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;
}

function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = new Array<bigint>(5);
    const d = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= d[x];
    }
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], RHO[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y]);
      }
    }
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

/** Keccak-256 digest of a UTF-8 string or byte buffer, as lowercase hex (no 0x). */
export function keccak256(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const rate = 136; // (1600 - 2*256) / 8
  const state = new Array<bigint>(25).fill(0n);
  const paddedLength = Math.ceil((bytes.length + 1) / rate) * rate;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x01; // Keccak domain separation (SHA3 would use 0x06)
  padded[paddedLength - 1] |= 0x80;

  for (let offset = 0; offset < paddedLength; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let value = 0n;
      for (let j = 7; j >= 0; j--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + j]);
      }
      state[lane] ^= value;
    }
    keccakF1600(state);
  }

  let hex = "";
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane];
    for (let j = 0; j < 8; j++) {
      hex += Number(value & 0xffn).toString(16).padStart(2, "0");
      value >>= 8n;
    }
  }
  return hex;
}

/** 4-byte function selector ("0x........") for an ABI signature like "transfer(address,uint256)". */
export function functionSelector(signature: string): string {
  return "0x" + keccak256(signature).slice(0, 8);
}
