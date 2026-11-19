/**
 * CLI: discover Aerodrome pools for every token that publishes a NAV and
 * print spot vs NAV with pool depth. Usage: npm run dex
 *
 * This is the raw DEX view (all pools found, deepest first per token);
 * the signal engine applies the depth thresholds on top of it.
 */

import { TokenizedStocksClient } from "./client.ts";
import { BaseRpc } from "./rpc.ts";
import { ETH_USD_FEED, readChainlinkFeed } from "./feeds.ts";
import { readDexQuotes } from "./dex.ts";

const client = new TokenizedStocksClient();
const rpc = new BaseRpc();

const tokens = await client.listAllTokens(500);
const withNav = tokens.filter((t) => t.navPrice !== undefined);
const eth = await readChainlinkFeed(rpc, ETH_USD_FEED);
console.log(
  `ETH/USD feed: $${eth.priceUsd.toFixed(2)} ("${eth.description}", updated ${eth.updatedAt})\n`,
);

const { quotes, pools } = await readDexQuotes(
  rpc,
  withNav.map((t) => ({ symbol: t.symbol, contractAddress: t.contractAddress, decimals: t.decimals })),
  eth.priceUsd,
);

console.log(`Discovered ${pools.length} Aerodrome pools across ${quotes.size}/${withNav.length} NAV tokens.\n`);
for (const t of withNav) {
  const mine = pools
    .filter((p) => p.stockAddress.toLowerCase() === t.contractAddress.toLowerCase())
    .sort((a, b) => b.depthUsd - a.depthUsd);
  if (mine.length === 0) {
    console.log(`${t.symbol.padEnd(8)} NAV $${t.navPrice!.toFixed(2)} — no pool found`);
    continue;
  }
  for (const p of mine) {
    const premium = ((p.spotUsd - t.navPrice!) / t.navPrice!) * 100;
    console.log(
      `${t.symbol.padEnd(8)} NAV $${t.navPrice!.toFixed(2)}  spot $${p.spotUsd.toFixed(4)}  ` +
        `premium ${premium >= 0 ? "+" : ""}${premium.toFixed(3)}%  depth $${p.depthUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}  ` +
        `${p.venue}${p.stable !== undefined ? (p.stable ? "/stable" : "/volatile") : `/ts${p.tickSpacing}`} vs ${p.quoteSymbol}  ${p.poolAddress}`,
    );
  }
}
