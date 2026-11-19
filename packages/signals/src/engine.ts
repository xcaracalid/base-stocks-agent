/**
 * Deterministic signal engine. Every factor is computed from stored snapshots
 * and is fully inspectable — no black box. Factors that lack data return
 * `null` with a reason; the composite score only ever combines factors that
 * actually exist, and reports its coverage.
 *
 * Factor status (2026-11-19):
 * - NAV staleness ......... WORKING (from nav_price_updated_at)
 * - Momentum .............. WORKING once the NAV series is old enough for the
 *                           window; returns null until then (needs snapshot
 *                           history — accumulates from day 1, or Chainlink
 *                           round backfill planned Nov 21–22)
 * - Supply flow ........... WORKING once ≥2 snapshots exist
 * - DEX-vs-NAV premium .... WORKING (Aerodrome pool reader, packages/data/dex)
 *                           once a DEX quote is supplied/stored. Only pools
 *                           with depth ≥ DEX_USABLE_DEPTH_USD feed the
 *                           composite; thinner pools are reported but flagged.
 */

import { SnapshotStore, type StoredSnapshot } from "../../data/src/store.ts";
import {
  DEX_THIN_DEPTH_USD,
  DEX_USABLE_DEPTH_USD,
  type DexQuote,
} from "../../data/src/dex.ts";

export type NavFreshness = "fresh" | "stale" | "missing";

/**
 * live      — deepest pool has usable depth; premium feeds the composite.
 * thin      — pool exists with some depth; premium shown, excluded from composite.
 * dust-pool — pools exist but are effectively empty; treated as no signal.
 * no-pool   — no usable quote: no Aerodrome pool found for this token, or
 *             the token publishes no NAV and is therefore outside the DEX
 *             scan set (premium is undefined without a NAV).
 * no-nav    — a quote exists but there is no NAV to compare against.
 */
export type PremiumStatus = "live" | "thin" | "dust-pool" | "no-pool" | "no-nav";

/** Chainlink feeds update on 0.5% deviation or a 24h heartbeat; allow grace. */
export const NAV_STALE_AFTER_HOURS = 26;

export interface MomentumWindows {
  "1h": number | null;
  "24h": number | null;
  "7d": number | null;
}

export interface TokenSignals {
  symbol: string;
  contractAddress: string;
  navPrice: number | null;
  /** Hours since the NAV was last updated onchain; null if no NAV. */
  navAgeHours: number | null;
  navFreshness: NavFreshness;
  momentum: MomentumWindows;
  /** Total-supply % change across the stored window, and that window in hours. */
  supplyFlow: { pct: number; windowHours: number } | null;
  /** DEX spot price (USD per token) from the token's deepest Aerodrome pool. */
  dexSpotUsd: number | null;
  /** Total value held in that pool, USD (both sides). */
  dexDepthUsd: number | null;
  dexPoolAddress: string | null;
  /** (DEX spot − NAV) / NAV × 100; null unless spot and NAV both exist. */
  premiumDiscountPct: number | null;
  premiumDiscountStatus: PremiumStatus;
  /** Weighted mean of available normalized factors, in [-1, 1]; null if none. */
  compositeScore: number | null;
  /** Names of the factors that actually contributed to the composite. */
  coverage: string[];
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

/** NAV return over a window: latest NAV vs the NAV closest to `windowHours` ago. */
function momentumOver(series: StoredSnapshot[], windowHours: number): number | null {
  const withNav = series.filter((s) => s.navPrice !== undefined);
  if (withNav.length < 2) return null;
  const latest = withNav[withNav.length - 1];
  const targetTime = new Date(latest.takenAt).getTime() - windowHours * 3600_000;
  // Need a snapshot at or before the target time (within 20% tolerance).
  const candidates = withNav.filter((s) => new Date(s.takenAt).getTime() <= targetTime);
  if (candidates.length === 0) return null;
  const base = candidates[candidates.length - 1];
  if (base.navPrice === undefined || latest.navPrice === undefined || base.navPrice === 0) return null;
  return pctChange(base.navPrice, latest.navPrice);
}

export function computeSignals(
  store: SnapshotStore,
  now = new Date(),
  dexQuotes?: Map<string, DexQuote>,
): TokenSignals[] {
  const latest = store.latestSnapshots();
  const dex = dexQuotes ?? store.latestDexQuotes();
  const reports: TokenSignals[] = [];

  for (const snap of latest) {
    const notes: string[] = [];
    const series = store.series(snap.contractAddress);

    // --- NAV staleness (working) ---
    let navAgeHours: number | null = null;
    let navFreshness: NavFreshness = "missing";
    if (snap.navPrice !== undefined && snap.navPriceUpdatedAt) {
      navAgeHours = (now.getTime() - new Date(snap.navPriceUpdatedAt).getTime()) / 3600_000;
      navFreshness = navAgeHours <= NAV_STALE_AFTER_HOURS ? "fresh" : "stale";
      if (navFreshness === "stale") notes.push(`NAV is ${navAgeHours.toFixed(1)}h old — treat as held close, not live.`);
    } else {
      notes.push("No Chainlink NAV published for this token in the API response.");
    }

    // --- Momentum (working, data-permitting) ---
    const momentum: MomentumWindows = {
      "1h": momentumOver(series, 1),
      "24h": momentumOver(series, 24),
      "7d": momentumOver(series, 24 * 7),
    };
    if (momentum["24h"] === null) notes.push("Momentum: insufficient snapshot history for the 24h window yet.");

    // --- Supply flow (working, needs ≥2 snapshots) ---
    let supplyFlow: TokenSignals["supplyFlow"] = null;
    const withSupply = series.filter((s) => s.totalSupply !== undefined);
    if (withSupply.length >= 2) {
      const first = withSupply[0];
      const last = withSupply[withSupply.length - 1];
      if (first.totalSupply && last.totalSupply !== undefined) {
        supplyFlow = {
          pct: pctChange(first.totalSupply, last.totalSupply),
          windowHours:
            (new Date(last.takenAt).getTime() - new Date(first.takenAt).getTime()) / 3600_000,
        };
      }
    }

    // --- DEX-vs-NAV premium/discount (working; needs a stored/live DEX quote) ---
    const quote = dex.get(snap.contractAddress.toLowerCase());
    let dexSpotUsd: number | null = null;
    let dexDepthUsd: number | null = null;
    let dexPoolAddress: string | null = null;
    let premiumDiscountPct: number | null = null;
    let premiumDiscountStatus: PremiumStatus = "no-pool";
    if (quote) {
      dexSpotUsd = quote.spotUsd;
      dexDepthUsd = quote.depthUsd;
      dexPoolAddress = quote.poolAddress;
      if (snap.navPrice === undefined || snap.navPrice === 0) {
        premiumDiscountStatus = "no-nav";
        notes.push("DEX quote exists but no NAV is published — premium not computable.");
      } else {
        premiumDiscountPct = ((quote.spotUsd - snap.navPrice) / snap.navPrice) * 100;
        if (quote.depthUsd >= DEX_USABLE_DEPTH_USD) {
          premiumDiscountStatus = "live";
        } else if (quote.depthUsd >= DEX_THIN_DEPTH_USD) {
          premiumDiscountStatus = "thin";
          notes.push(
            `Deepest pool depth $${quote.depthUsd.toFixed(0)} is thin (< $${DEX_USABLE_DEPTH_USD}) — premium shown but excluded from the composite.`,
          );
        } else {
          premiumDiscountStatus = "dust-pool";
          premiumDiscountPct = null;
          notes.push(
            `${quote.poolsFound} pool(s) found but the deepest holds only $${quote.depthUsd.toFixed(2)} — treated as no usable pool.`,
          );
        }
      }
    }

    // --- Composite (only over factors that exist) ---
    const factors: Array<{ name: string; value: number; weight: number }> = [];
    if (momentum["24h"] !== null) {
      factors.push({ name: "momentum24h", value: clamp(momentum["24h"] / 10, -1, 1), weight: 0.6 });
    }
    if (supplyFlow !== null) {
      factors.push({ name: "supplyFlow", value: clamp(supplyFlow.pct / 5, -1, 1), weight: 0.4 });
    }
    if (premiumDiscountStatus === "live" && premiumDiscountPct !== null) {
      // A discount to NAV is a positive signal; a premium is negative.
      factors.push({
        name: "premiumDiscount",
        value: clamp(-premiumDiscountPct / 5, -1, 1),
        weight: 0.5,
      });
    }
    let compositeScore: number | null = null;
    if (factors.length > 0 && navFreshness === "fresh") {
      const totalWeight = factors.reduce((a, f) => a + f.weight, 0);
      compositeScore = factors.reduce((a, f) => a + f.value * f.weight, 0) / totalWeight;
    } else if (factors.length > 0) {
      notes.push("Composite suppressed: NAV is stale or missing (no trading on stale feeds).");
    }

    reports.push({
      symbol: snap.symbol,
      contractAddress: snap.contractAddress,
      navPrice: snap.navPrice ?? null,
      navAgeHours,
      navFreshness,
      momentum,
      supplyFlow,
      dexSpotUsd,
      dexDepthUsd,
      dexPoolAddress,
      premiumDiscountPct,
      premiumDiscountStatus,
      compositeScore,
      coverage: factors.map((f) => f.name),
      notes,
    });
  }

  // Rank: scored tokens first (desc), then unscored by symbol.
  reports.sort((a, b) => {
    if (a.compositeScore !== null && b.compositeScore !== null) return b.compositeScore - a.compositeScore;
    if (a.compositeScore !== null) return -1;
    if (b.compositeScore !== null) return 1;
    return a.symbol.localeCompare(b.symbol);
  });
  return reports;
}
