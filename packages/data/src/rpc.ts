/**
 * Minimal read-only JSON-RPC client for Base mainnet, plus the handful of
 * ABI encode/decode helpers this project needs. Zero dependencies.
 *
 * Default endpoint: the public RPC https://mainnet.base.org — no API key.
 * Only `eth_call` / `eth_blockNumber` are used; nothing here can sign or
 * send a transaction.
 *
 * Batching note (learned live, 2026-11-19): the public RPC silently fails
 * oversized JSON-RPC batches (a 192-call batch returned an error object
 * instead of an array). Batches are therefore chunked at 20 calls, and a
 * failed chunk falls back to sequential single calls.
 */

import { functionSelector } from "./keccak.ts";

export const BASE_MAINNET_RPC = "https://mainnet.base.org";
export const BASE_CHAIN_ID = 8453;

const BATCH_CHUNK = 20;
/** Pause between batch chunks — the public RPC drops calls under rapid fire. */
const CHUNK_DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RpcError {
  code: number;
  message: string;
}

export class BaseRpc {
  readonly url: string;
  private nextId = 1;

  constructor(url: string = BASE_MAINNET_RPC) {
    this.url = url;
  }

  private async post(payload: unknown): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${this.url}`);
    return res.json();
  }

  /** Single eth_call at "latest". Returns the raw hex result ("0x…"). Throws on revert/error. */
  async call(to: string, data: string): Promise<string> {
    const body = (await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    })) as { result?: string; error?: RpcError };
    if (body.error) throw new Error(`eth_call ${to} ${data.slice(0, 10)}: ${body.error.message}`);
    if (typeof body.result !== "string") throw new Error(`eth_call ${to}: malformed response`);
    return body.result;
  }

  /**
   * Batched eth_call. Returns one entry per call, in order; an entry is
   * `null` when that individual call errored/reverted (callers decide what
   * a missing value means — usually "contract doesn't implement this").
   *
   * Reliability (measured live 2026-11-19): the public RPC silently drops
   * or rate-errors a large random subset of calls in rapid batches — one
   * 336-call discovery pass lost 62–88 results, a different subset each
   * run. So chunks are paced, and any call that comes back null is retried
   * in small sub-batches (up to 2 extra rounds with backoff). A null that
   * survives every round is a genuine error/revert.
   */
  async batchCall(calls: Array<{ to: string; data: string }>): Promise<Array<string | null>> {
    const out: Array<string | null> = new Array(calls.length).fill(null);
    const attempt = async (indices: number[], chunkSize: number): Promise<void> => {
      for (let start = 0; start < indices.length; start += chunkSize) {
        const idxChunk = indices.slice(start, start + chunkSize);
        const results = await this.batchChunk(idxChunk.map((i) => calls[i]));
        for (let k = 0; k < idxChunk.length; k++) {
          if (results[k] !== null) out[idxChunk[k]] = results[k];
        }
        if (start + chunkSize < indices.length) await sleep(CHUNK_DELAY_MS);
      }
    };

    await attempt(calls.map((_, i) => i), BATCH_CHUNK);
    for (const [delayMs, chunkSize] of [[600, 5], [1500, 5]] as const) {
      const missing = out.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
      if (missing.length === 0) break;
      await sleep(delayMs);
      await attempt(missing, chunkSize);
    }
    return out;
  }

  /** One raw JSON-RPC batch request (no retries); null per call on error. */
  private async batchChunk(
    calls: Array<{ to: string; data: string }>,
  ): Promise<Array<string | null>> {
    const out: Array<string | null> = new Array(calls.length).fill(null);
    const ids = calls.map(() => this.nextId++);
    const payload = calls.map((c, i) => ({
      jsonrpc: "2.0",
      id: ids[i],
      method: "eth_call",
      params: [{ to: c.to, data: c.data }, "latest"],
    }));
    let body: unknown;
    try {
      body = await this.post(payload);
    } catch {
      body = null;
    }
    if (!Array.isArray(body)) {
      // Batch rejected wholesale — fall back to sequential singles.
      for (let i = 0; i < calls.length; i++) {
        try {
          out[i] = await this.call(calls[i].to, calls[i].data);
        } catch {
          out[i] = null;
        }
      }
      return out;
    }
    const byId = new Map<number, { result?: string; error?: RpcError }>();
    for (const r of body as Array<{ id: number; result?: string; error?: RpcError }>) {
      byId.set(r.id, r);
    }
    for (let i = 0; i < calls.length; i++) {
      const r = byId.get(ids[i]);
      if (r === undefined) {
        // Dropped from the batch response entirely — retry as a single.
        try {
          out[i] = await this.call(calls[i].to, calls[i].data);
        } catch {
          out[i] = null;
        }
      } else {
        out[i] = typeof r.result === "string" ? r.result : null;
      }
    }
    return out;
  }

  async blockNumber(): Promise<number> {
    const body = (await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "eth_blockNumber",
      params: [],
    })) as { result?: string; error?: RpcError };
    if (body.error || typeof body.result !== "string") {
      throw new Error(`eth_blockNumber failed: ${body.error?.message ?? "malformed response"}`);
    }
    return Number(BigInt(body.result));
  }
}

// ---------------------------------------------------------------------------
// ABI helpers (only the types this project uses)
// ---------------------------------------------------------------------------

export const pad32 = (hex: string): string =>
  hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export const encodeAddress = (address: string): string => pad32(address);

export const encodeUint = (value: bigint | number): string =>
  BigInt(value).toString(16).padStart(64, "0");

export const encodeBool = (value: boolean): string => encodeUint(value ? 1n : 0n);

/** int24 and friends: two's-complement in a 256-bit word. */
export const encodeInt = (value: number): string => {
  const v = BigInt(value);
  const wrapped = v < 0 ? (1n << 256n) + v : v;
  return wrapped.toString(16).padStart(64, "0");
};

/** Build calldata from a signature and pre-encoded 32-byte words. */
export function encodeCall(signature: string, ...words: string[]): string {
  return functionSelector(signature) + words.join("");
}

/** Split a hex result into 32-byte words (as bigints, unsigned). */
export function words(hex: string): bigint[] {
  const clean = hex.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) {
    out.push(BigInt("0x" + clean.slice(i, i + 64)));
  }
  return out;
}

export const decodeUint = (hex: string): bigint => words(hex)[0] ?? 0n;

/** Decode a word as a signed int256/int24 (two's complement). */
export function decodeInt(hex: string): bigint {
  const v = decodeUint(hex);
  return v > (1n << 255n) - 1n ? v - (1n << 256n) : v;
}

export const decodeAddress = (hex: string): string => "0x" + hex.replace(/^0x/, "").slice(-40).toLowerCase();

/** Decode an ABI dynamic string return value. */
export function decodeString(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  if (clean.length < 128) return "";
  const length = Number(BigInt("0x" + clean.slice(64, 128)));
  const bytesHex = clean.slice(128, 128 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = parseInt(bytesHex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

/** Scale a raw integer amount by token decimals into a JS number. */
export function toDecimal(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const isZeroAddress = (address: string): boolean =>
  address.toLowerCase() === ZERO_ADDRESS;
