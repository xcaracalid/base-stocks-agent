/**
 * Agent entry point. One cycle =
 *   1. snapshot the live Tokenized Stocks API into the store,
 *   2. cross-check the Chainlink feeds onchain against the API NAV,
 *   3. read Aerodrome pools for the NAV tokens and store the deepest
 *      quote per token (drives the premium/discount signal),
 *   4. compute signals and print a summary.
 *
 * With `--loop <minutes>` it repeats on that cadence (the plan's snapshot
 * cadence is 5 minutes once deployed). All chain access is read-only
 * eth_call against the public Base RPC — no wallet, no transactions.
 *
 * The portfolio/LLM layers join this loop on Nov 22–23 and Nov 26
 * respectively (see BUILD-LOG.md).
 */

import { TokenizedStocksClient } from "../../../packages/data/src/client.ts";
import { SnapshotStore } from "../../../packages/data/src/store.ts";
import { runSnapshot } from "../../../packages/data/src/snapshot-run.ts";
import { BaseRpc } from "../../../packages/data/src/rpc.ts";
import { ETH_USD_FEED, crossCheckFeeds, readChainlinkFeed } from "../../../packages/data/src/feeds.ts";
import { readDexQuotes } from "../../../packages/data/src/dex.ts";
import { computeSignals } from "../../../packages/signals/src/engine.ts";

async function cycle(
  client: TokenizedStocksClient,
  store: SnapshotStore,
  rpc: BaseRpc,
): Promise<void> {
  const snap = await runSnapshot(client, store);

  // Chainlink cross-check: onchain feed vs the NAV the API just published.
  const checks = await crossCheckFeeds(rpc, snap.tokens);
  const exact = checks.filter((c) => c.timestampsMatch && c.driftPct === 0).length;
  const drifted = checks.filter((c) => c.driftPct !== null && Math.abs(c.driftPct) > 0.01);

  // DEX reads for the tokens that publish a NAV.
  const navTokens = snap.tokens.filter((t) => t.navPrice !== undefined);
  const eth = await readChainlinkFeed(rpc, ETH_USD_FEED);
  const { quotes, pools } = await readDexQuotes(
    rpc,
    navTokens.map((t) => ({
      symbol: t.symbol,
      contractAddress: t.contractAddress,
      decimals: t.decimals,
    })),
    eth.priceUsd,
  );
  store.recordDexQuotes(snap.runId, [...quotes.values()]);

  const signals = computeSignals(store, new Date(), quotes);
  const scored = signals.filter((s) => s.compositeScore !== null);
  const fresh = signals.filter((s) => s.navFreshness === "fresh").length;
  const livePremium = signals.filter((s) => s.premiumDiscountStatus === "live");

  console.log(
    `[${snap.takenAt}] snapshot #${snap.runId}: ${snap.tokenCount} tokens (${snap.withNav} with NAV, ` +
      `${fresh} fresh) — Chainlink cross-check ${exact}/${checks.length} exact` +
      (drifted.length > 0
        ? `, drift >0.01% on ${drifted.map((d) => `${d.symbol} ${d.driftPct! >= 0 ? "+" : ""}${d.driftPct!.toFixed(3)}%`).join(", ")}`
        : "") +
      `; ${pools.length} Aerodrome pools found, ${livePremium.length} live premium signals; ` +
      `${scored.length} composite scores.`,
  );
  for (const s of livePremium) {
    console.log(
      `  ${s.symbol.padEnd(8)} DEX $${s.dexSpotUsd!.toFixed(4)} vs NAV $${s.navPrice!.toFixed(4)} → ` +
        `${s.premiumDiscountPct! >= 0 ? "+" : ""}${s.premiumDiscountPct!.toFixed(3)}% ` +
        `(pool depth $${s.dexDepthUsd!.toLocaleString("en-US", { maximumFractionDigits: 0 })})`,
    );
  }
  for (const s of scored.slice(0, 5)) {
    console.log(
      `  ${s.symbol.padEnd(8)} score ${s.compositeScore!.toFixed(3)} via [${s.coverage.join(", ")}]`,
    );
  }
}

const loopIdx = process.argv.indexOf("--loop");
const client = new TokenizedStocksClient();
const store = new SnapshotStore();
const rpc = new BaseRpc();
try {
  await cycle(client, store, rpc);
  if (loopIdx >= 0) {
    const minutes = Number(process.argv[loopIdx + 1] ?? "5");
    console.log(`Looping every ${minutes} minute(s). Ctrl-C to stop.`);
    setInterval(() => {
      cycle(client, store, rpc).catch((err) => console.error("cycle failed:", err));
    }, minutes * 60_000);
  }
} finally {
  if (loopIdx < 0) store.close();
}
