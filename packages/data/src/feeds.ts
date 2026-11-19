/**
 * Chainlink onchain feed reader for the Coinbase tokenized-equity feeds on
 * Base mainnet, plus a cross-check of the onchain values against the
 * Tokenized Stocks API's `nav_price` (which republishes the same feeds
 * offchain — session 1 verified NVDA and AAPL match to the last digit).
 *
 * Feed proxy addresses: Chainlink's canonical reference-data directory
 * (https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json),
 * entries named "Coinbase <TICKER>", cross-confirmed against the Base docs'
 * integration guide. The API metadata endpoint does NOT carry feed
 * addresses (checked 2026-11-19: metadata exposes only contract, name,
 * symbol, image, prospectus URL, description).
 *
 * Feed semantics: Total Return value (underlying price × multiplier,
 * dividend-adjusted), 8 decimals, updates on 0.5% deviation or a 24h
 * heartbeat during US market hours (24/5) and holds its last value outside
 * them — always check `updatedAt`.
 */

import {
  BaseRpc,
  decodeString,
  decodeUint,
  encodeCall,
  toDecimal,
  words,
} from "./rpc.ts";
import type { TokenizedStock } from "./types.ts";

/** Underlying ticker (no "c" suffix) → Chainlink proxy on Base mainnet. */
export const CHAINLINK_FEED_ADDRESSES: Record<string, string> = {
  AAPL: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
  AMZN: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
  CRCL: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33",
  GOOGL: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
  INTC: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB",
  META: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
  MSFT: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
  MSTR: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
  NVDA: "0x04689a41629776563E6822F76f2e57D148d28513",
  SNDK: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
  SPCX: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
  TSLA: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
};

/** ETH/USD on Base — used to convert WETH-quoted DEX prices into USD. */
export const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

/** Token symbol as the API names it ("NVDAc") → feed address, if one exists. */
export function feedAddressForSymbol(symbol: string): string | undefined {
  const underlying = symbol.endsWith("c") ? symbol.slice(0, -1) : symbol;
  return CHAINLINK_FEED_ADDRESSES[underlying.toUpperCase()];
}

export interface ChainlinkFeedReading {
  feedAddress: string;
  description: string;
  decimals: number;
  roundId: bigint;
  /** Price in USD (answer scaled by the feed's decimals). */
  priceUsd: number;
  /** ISO timestamp of the last onchain update. */
  updatedAt: string;
}

/** Read one AggregatorV3 proxy: latestRoundData + decimals + description (batched). */
export async function readChainlinkFeed(
  rpc: BaseRpc,
  feedAddress: string,
): Promise<ChainlinkFeedReading> {
  const [roundData, decimalsHex, descriptionHex] = await rpc.batchCall([
    { to: feedAddress, data: encodeCall("latestRoundData()") },
    { to: feedAddress, data: encodeCall("decimals()") },
    { to: feedAddress, data: encodeCall("description()") },
  ]);
  if (!roundData || !decimalsHex) {
    throw new Error(`feed ${feedAddress}: latestRoundData/decimals read failed`);
  }
  const w = words(roundData);
  const decimals = Number(decodeUint(decimalsHex));
  const answer = w[1];
  // answer is int256; these equity feeds are always positive.
  const updatedAtSeconds = Number(w[3]);
  return {
    feedAddress,
    description: descriptionHex ? decodeString(descriptionHex) : "",
    decimals,
    roundId: w[0],
    priceUsd: toDecimal(answer, decimals),
    updatedAt: new Date(updatedAtSeconds * 1000).toISOString(),
  };
}

export interface FeedCrossCheck {
  symbol: string;
  feedAddress: string;
  feedDescription: string;
  /** API-published NAV and its timestamp. */
  apiNav: number | null;
  apiUpdatedAt: string | null;
  /** Onchain feed value and its timestamp. */
  feedPrice: number;
  feedUpdatedAt: string;
  /** True when both sides carry the identical update timestamp. */
  timestampsMatch: boolean;
  /** (feed − api) / api × 100; null when the API has no NAV for the token. */
  driftPct: number | null;
}

/**
 * Cross-check every API token that has both a published NAV and a known
 * Chainlink feed. Expectation: drift ≈ 0 and identical timestamps when the
 * API is current; a nonzero drift means the API is a round behind (or
 * ahead) — either way it is reported, never hidden.
 */
export async function crossCheckFeeds(
  rpc: BaseRpc,
  tokens: TokenizedStock[],
): Promise<FeedCrossCheck[]> {
  const targets = tokens
    .map((t) => ({ token: t, feed: feedAddressForSymbol(t.symbol) }))
    .filter((x): x is { token: TokenizedStock; feed: string } => x.feed !== undefined);
  const readings = await Promise.all(
    targets.map(async ({ token, feed }) => {
      const reading = await readChainlinkFeed(rpc, feed);
      const apiNav = token.navPrice ?? null;
      return {
        symbol: token.symbol,
        feedAddress: feed,
        feedDescription: reading.description,
        apiNav,
        apiUpdatedAt: token.navPriceUpdatedAt ?? null,
        feedPrice: reading.priceUsd,
        feedUpdatedAt: reading.updatedAt,
        timestampsMatch:
          token.navPriceUpdatedAt !== undefined &&
          new Date(token.navPriceUpdatedAt).getTime() === new Date(reading.updatedAt).getTime(),
        driftPct:
          apiNav !== null && apiNav !== 0
            ? ((reading.priceUsd - apiNav) / apiNav) * 100
            : null,
      } satisfies FeedCrossCheck;
    }),
  );
  readings.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return readings;
}
