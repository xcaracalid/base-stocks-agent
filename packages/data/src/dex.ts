/**
 * Aerodrome pool reader for the tokenized stocks on Base mainnet.
 *
 * Discovery is fully onchain: the classic PoolFactory and the Slipstream
 * CL factories are queried with getPool() for every (stock, quote) pair —
 * no indexer or third-party API is trusted for the signal. State is then
 * read from the pool contracts themselves (reserves for classic pools;
 * slot0 + liquidity + token balances for Slipstream CL pools).
 *
 * Factory facts (verified live 2026-11-19):
 * - Classic PoolFactory: 0x420DD381b31aEf6683db6B902084cB0FFECe40Da.
 * - The deep NVDAc/USDC Slipstream pool (0xF668…3C8EC) reports its factory
 *   as 0x9cb220581b91b0c83223012fe69688b92ad07a76 via factory() — that is
 *   the current CL factory and getPool() on it returns the pool. (The older
 *   0x5e7BB104… CL factory held none of these pools in repeated scans and
 *   is not scanned by default — see AERODROME_CL_FACTORIES.)
 * - The classic NVDAc/USDC volatile pool exists but holds dust reserves
 *   (~$0.01) — a pool existing is NOT a pool being usable. Depth is always
 *   measured and classified (see thresholds below); dust pools never feed
 *   the premium signal.
 *
 * Prices: spot is USD per 1 token unit — the same unit the API's NAV uses
 * (verified: NVDAc CL spot $152.88 vs NAV $152.85 at first read).
 */

import {
  BaseRpc,
  decodeAddress,
  decodeUint,
  encodeAddress,
  encodeBool,
  encodeCall,
  encodeInt,
  isZeroAddress,
  toDecimal,
  words,
} from "./rpc.ts";

export const AERODROME_CLASSIC_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
export const AERODROME_CL_FACTORIES = [
  "0x9cb220581b91b0c83223012fe69688b92ad07a76", // current (reported by live pools)
];
// The legacy Slipstream factory 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A was
// scanned in early discovery and held NONE of this token universe's pools
// (verified across repeated full scans, 2026-11-19) — it is not scanned by
// default, which also cuts ~43% of discovery calls against the rate-limited
// public RPC. Re-add it here if a pool ever reports it via factory().

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH_BASE = "0x4200000000000000000000000000000000000006";

const QUOTES = [
  { symbol: "USDC", address: USDC_BASE, decimals: 6 },
  { symbol: "WETH", address: WETH_BASE, decimals: 18 },
] as const;

const TICK_SPACINGS = [1, 5, 10, 50, 100, 200];

/** Depth at/above which a pool's spot price is trusted for the signal. */
export const DEX_USABLE_DEPTH_USD = 10_000;
/** Depth at/above which a pool is reported as "thin" rather than dust. */
export const DEX_THIN_DEPTH_USD = 100;

export type DexVenue = "aerodrome-classic" | "aerodrome-slipstream";

export interface DexPool {
  poolAddress: string;
  venue: DexVenue;
  /** Classic pools only: stable vs volatile curve. */
  stable?: boolean;
  /** Slipstream pools only. */
  tickSpacing?: number;
  stockAddress: string;
  quoteSymbol: "USDC" | "WETH";
  /** USD per 1 stock token; 0 when the pool is empty/unpriceable. */
  spotUsd: number;
  /** Both sides of the pool valued in USD (stock side at spot). */
  depthUsd: number;
  /** Quote-side value only, USD. */
  quoteDepthUsd: number;
  /** Slipstream active liquidity L (raw), when readable. */
  activeLiquidity?: string;
}

export interface DexQuote {
  contractAddress: string;
  symbol: string;
  poolAddress: string;
  venue: DexVenue;
  quoteSymbol: "USDC" | "WETH";
  spotUsd: number;
  depthUsd: number;
  quoteDepthUsd: number;
  /** How many pools were discovered for this token in total. */
  poolsFound: number;
}

interface StockRef {
  symbol: string;
  contractAddress: string;
  decimals: number;
}

interface DiscoveredPool {
  poolAddress: string;
  venue: DexVenue;
  stable?: boolean;
  tickSpacing?: number;
  stock: StockRef;
  quote: (typeof QUOTES)[number];
}

/** Step 1: factory getPool() lookups for every (stock, quote, venue) combo. */
async function discoverPools(rpc: BaseRpc, stocks: StockRef[]): Promise<DiscoveredPool[]> {
  const jobs: Array<{ to: string; data: string }> = [];
  const meta: Array<Omit<DiscoveredPool, "poolAddress">> = [];

  for (const stock of stocks) {
    for (const quote of QUOTES) {
      for (const stable of [false, true]) {
        jobs.push({
          to: AERODROME_CLASSIC_FACTORY,
          data: encodeCall(
            "getPool(address,address,bool)",
            encodeAddress(stock.contractAddress),
            encodeAddress(quote.address),
            encodeBool(stable),
          ),
        });
        meta.push({ venue: "aerodrome-classic", stable, stock, quote });
      }
      for (const factory of AERODROME_CL_FACTORIES) {
        for (const tickSpacing of TICK_SPACINGS) {
          jobs.push({
            to: factory,
            data: encodeCall(
              "getPool(address,address,int24)",
              encodeAddress(stock.contractAddress),
              encodeAddress(quote.address),
              encodeInt(tickSpacing),
            ),
          });
          meta.push({ venue: "aerodrome-slipstream", tickSpacing, stock, quote });
        }
      }
    }
  }

  const results = await rpc.batchCall(jobs);
  const byAddress = new Map<string, DiscoveredPool>();
  for (let i = 0; i < results.length; i++) {
    const raw = results[i];
    if (!raw) continue;
    const poolAddress = decodeAddress(raw);
    if (isZeroAddress(poolAddress)) continue;
    if (!byAddress.has(poolAddress)) {
      byAddress.set(poolAddress, { poolAddress, ...meta[i] });
    }
  }
  return [...byAddress.values()];
}

/** Step 2: read state for every discovered pool and compute spot + depth. */
async function readPoolStates(
  rpc: BaseRpc,
  pools: DiscoveredPool[],
  ethUsd: number,
): Promise<DexPool[]> {
  const quoteUsd = (symbol: "USDC" | "WETH") => (symbol === "USDC" ? 1 : ethUsd);
  const jobs: Array<{ to: string; data: string }> = [];
  const plan: Array<{ pool: DiscoveredPool; kind: string }> = [];
  const push = (pool: DiscoveredPool, kind: string, to: string, data: string) => {
    jobs.push({ to, data });
    plan.push({ pool, kind });
  };

  for (const pool of pools) {
    push(pool, "token0", pool.poolAddress, encodeCall("token0()"));
    if (pool.venue === "aerodrome-classic") {
      push(pool, "reserves", pool.poolAddress, encodeCall("getReserves()"));
    } else {
      push(pool, "slot0", pool.poolAddress, encodeCall("slot0()"));
      push(pool, "liquidity", pool.poolAddress, encodeCall("liquidity()"));
      push(pool, "balStock", pool.stock.contractAddress,
        encodeCall("balanceOf(address)", encodeAddress(pool.poolAddress)));
      push(pool, "balQuote", pool.quote.address,
        encodeCall("balanceOf(address)", encodeAddress(pool.poolAddress)));
    }
  }

  const results = await rpc.batchCall(jobs);
  const state = new Map<string, Map<string, string>>();
  for (let i = 0; i < plan.length; i++) {
    const raw = results[i];
    if (!raw) continue;
    const key = plan[i].pool.poolAddress;
    if (!state.has(key)) state.set(key, new Map());
    state.get(key)!.set(plan[i].kind, raw);
  }

  // Fill any state reads the batches dropped (the public RPC loses calls
  // under load — see rpc.ts) with sequential singles before computing, so a
  // pool is never dropped or mispriced because of a lost read.
  for (const pool of pools) {
    const existing = state.get(pool.poolAddress) ?? new Map<string, string>();
    const wanted: Array<[string, string, string]> =
      pool.venue === "aerodrome-classic"
        ? [
            ["token0", pool.poolAddress, encodeCall("token0()")],
            ["reserves", pool.poolAddress, encodeCall("getReserves()")],
          ]
        : [
            ["token0", pool.poolAddress, encodeCall("token0()")],
            ["slot0", pool.poolAddress, encodeCall("slot0()")],
            ["liquidity", pool.poolAddress, encodeCall("liquidity()")],
            ["balStock", pool.stock.contractAddress, encodeCall("balanceOf(address)", encodeAddress(pool.poolAddress))],
            ["balQuote", pool.quote.address, encodeCall("balanceOf(address)", encodeAddress(pool.poolAddress))],
          ];
    let changed = false;
    for (const [kind, to, data] of wanted) {
      if (existing.has(kind)) continue;
      try {
        existing.set(kind, await rpc.call(to, data));
        changed = true;
      } catch {
        // Genuinely unreadable — the pool is dropped below if token0 is absent.
      }
    }
    if (changed || existing.size > 0) state.set(pool.poolAddress, existing);
  }

  const out: DexPool[] = [];
  for (const pool of pools) {
    const s = state.get(pool.poolAddress);
    if (!s?.has("token0")) continue;
    const token0 = decodeAddress(s.get("token0")!);
    const stockIsToken0 = token0 === pool.stock.contractAddress.toLowerCase();
    const qUsd = quoteUsd(pool.quote.symbol);
    let spotUsd = 0;
    let depthUsd = 0;
    let quoteDepthUsd = 0;
    let activeLiquidity: string | undefined;

    if (pool.venue === "aerodrome-classic") {
      if (!s.has("reserves")) continue;
      const w = words(s.get("reserves")!);
      const reserve0 = stockIsToken0 ? w[0] : w[1];
      const reserve1 = stockIsToken0 ? w[1] : w[0];
      const stockRaw = reserve0;
      const quoteRaw = reserve1;
      const stockTokens = toDecimal(stockRaw, pool.stock.decimals);
      const quoteTokens = toDecimal(quoteRaw, pool.quote.decimals);
      if (stockTokens > 0 && quoteTokens > 0) {
        spotUsd = (quoteTokens / stockTokens) * qUsd;
        quoteDepthUsd = quoteTokens * qUsd;
        depthUsd = quoteDepthUsd + stockTokens * spotUsd;
      }
    } else {
      if (!s.has("slot0")) continue;
      const w = words(s.get("slot0")!);
      const sqrtPriceX96 = w[0];
      if (sqrtPriceX96 > 0n) {
        // priceRaw = token1_raw per token0_raw = (sqrtP / 2^96)^2
        const priceRaw = Number(sqrtPriceX96) ** 2 / Number(2n ** 96n) ** 2;
        const dec0 = stockIsToken0 ? pool.stock.decimals : pool.quote.decimals;
        const dec1 = stockIsToken0 ? pool.quote.decimals : pool.stock.decimals;
        // Human price of token1 in token0 = (1/priceRaw) * 10^(dec1-dec0);
        // of token0 in token1 = priceRaw * 10^(dec0-dec1).
        const spotInQuote = stockIsToken0
          ? priceRaw * 10 ** (dec0 - dec1)
          : (1 / priceRaw) * 10 ** (dec1 - dec0);
        spotUsd = spotInQuote * qUsd;
      }
      if (s.has("liquidity")) activeLiquidity = decodeUint(s.get("liquidity")!).toString();
      const stockTokens = s.has("balStock")
        ? toDecimal(decodeUint(s.get("balStock")!), pool.stock.decimals)
        : 0;
      const quoteTokens = s.has("balQuote")
        ? toDecimal(decodeUint(s.get("balQuote")!), pool.quote.decimals)
        : 0;
      quoteDepthUsd = quoteTokens * qUsd;
      depthUsd = quoteDepthUsd + stockTokens * spotUsd;
    }

    out.push({
      poolAddress: pool.poolAddress,
      venue: pool.venue,
      stable: pool.stable,
      tickSpacing: pool.tickSpacing,
      stockAddress: pool.stock.contractAddress,
      quoteSymbol: pool.quote.symbol,
      spotUsd,
      depthUsd,
      quoteDepthUsd,
      activeLiquidity,
    });
  }
  return out;
}

/**
 * Full DEX read for a set of stock tokens: discover pools, read state, and
 * pick the deepest pool per token as its quote. `ethUsd` converts WETH
 * quotes (read it from the Chainlink ETH/USD feed).
 */
export async function readDexQuotes(
  rpc: BaseRpc,
  stocks: StockRef[],
  ethUsd: number,
): Promise<{ quotes: Map<string, DexQuote>; pools: DexPool[] }> {
  const discovered = await discoverPools(rpc, stocks);
  const pools = await readPoolStates(rpc, discovered, ethUsd);

  const poolsByStock = new Map<string, DexPool[]>();
  for (const p of pools) {
    const list = poolsByStock.get(p.stockAddress.toLowerCase()) ?? [];
    list.push(p);
    poolsByStock.set(p.stockAddress.toLowerCase(), list);
  }

  const quotes = new Map<string, DexQuote>();
  for (const stock of stocks) {
    const list = poolsByStock.get(stock.contractAddress.toLowerCase()) ?? [];
    if (list.length === 0) continue;
    const best = [...list].sort((a, b) => b.depthUsd - a.depthUsd)[0];
    quotes.set(stock.contractAddress.toLowerCase(), {
      contractAddress: stock.contractAddress,
      symbol: stock.symbol,
      poolAddress: best.poolAddress,
      venue: best.venue,
      quoteSymbol: best.quoteSymbol,
      spotUsd: best.spotUsd,
      depthUsd: best.depthUsd,
      quoteDepthUsd: best.quoteDepthUsd,
      poolsFound: list.length,
    });
  }
  return { quotes, pools };
}
