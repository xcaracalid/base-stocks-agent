/**
 * Rebalance planner: signals → plan → paper-ledger execution.
 *
 * The planner is deterministic and rule-bound (the published PAPER_RULES):
 * - Targets: top-K tickers by composite score, equal weight, capped at the
 *   max position weight. A ticker is only eligible with a FRESH NAV — the
 *   signal engine already suppresses composite scores on stale/missing NAV,
 *   and the planner re-checks freshness itself (no trading on stale feeds,
 *   in either direction: a held position on a stale feed is frozen, not sold
 *   at a price nobody can verify).
 * - A position is only traded when its weight drifts beyond the ±5%
 *   rebalance band; smaller drifts are recorded as deliberate no-ops.
 * - Buys are blocked when the measured DEX premium over NAV exceeds +3%
 *   (the premium only exists when a pool quote was measured; dust pools
 *   report no premium — see the signal engine's depth gates).
 * - The 24h per-ticker cooldown is pre-checked here (so deferrals show up
 *   in the decision record as plan-level skips) AND enforced again by the
 *   ledger in executePaperTrade, which always has the final say.
 *
 * Every run produces a DecisionRecord: the full scored universe, targets,
 * positions before, every planned action with its outcome, and a plain-
 * English rationale. The agent persists it to the store verbatim.
 */

import type { TokenSignals } from "../../signals/src/engine.ts";
import {
  PAPER_RULES,
  equityUsdc,
  executePaperTrade,
  type PaperPortfolio,
  type PaperTrade,
} from "./paper.ts";

export type PlannedActionStatus =
  | "execute"
  | "skipped-band"
  | "skipped-cooldown"
  | "skipped-premium"
  | "skipped-stale"
  | "skipped-nonav";

export interface PlannedAction {
  symbol: string;
  side: "buy" | "sell";
  /** Weight of equity before the trade (0 if not held). */
  currentWeight: number;
  /** Weight of equity the plan wants (0 for exits). */
  targetWeight: number;
  /** Intended trade size in USD (0 for skips). */
  usdcValue: number;
  status: PlannedActionStatus;
  detail: string;
  /** Filled by applyPlan for "execute" actions. */
  outcome?: "executed" | "rejected";
  outcomeDetail?: string;
  trade?: PaperTrade;
}

export interface RebalancePlan {
  at: string;
  equityUsdc: number;
  cashUsdc: number;
  targets: Array<{ symbol: string; compositeScore: number; targetWeight: number }>;
  actions: PlannedAction[];
}

export interface DecisionRecord {
  version: 1;
  at: string;
  runId: number | null;
  kind: "rebalance" | "hold";
  equityUsdc: number;
  cashBeforeUsdc: number;
  cashAfterUsdc: number;
  rules: {
    topK: number;
    maxBuyPremiumPct: number;
    maxPositionPct: number;
    rebalanceBandPct: number;
    cooldownHoursPerTicker: number;
  };
  /** The decision-relevant universe: every ticker that publishes a NAV. */
  universe: Array<{
    symbol: string;
    compositeScore: number | null;
    coverage: string[];
    navPrice: number | null;
    navAgeHours: number | null;
    navFreshness: string;
    momentum24hPct: number | null;
    supplyFlowPct: number | null;
    premiumDiscountPct: number | null;
    premiumStatus: string;
    dexDepthUsd: number | null;
  }>;
  targets: RebalancePlan["targets"];
  positionsBefore: Array<{
    symbol: string;
    qtyTokens: number;
    navPrice: number | null;
    valueUsdc: number | null;
    weight: number | null;
  }>;
  actions: PlannedAction[];
  rationale: string;
}

const band = PAPER_RULES.rebalanceBandPct / 100;

function cooldownHoursLeft(pf: PaperPortfolio, symbol: string, now: Date): number {
  const last = pf.lastTradeAtBySymbol.get(symbol);
  if (!last) return 0;
  const elapsed = (now.getTime() - new Date(last).getTime()) / 3600_000;
  return Math.max(0, PAPER_RULES.cooldownHoursPerTicker - elapsed);
}

export function planRebalance(
  signals: TokenSignals[],
  pf: PaperPortfolio,
  navBySymbol: Map<string, number>,
  now = new Date(),
): RebalancePlan {
  const equity = equityUsdc(pf, navBySymbol);
  const bySymbol = new Map(signals.map((s) => [s.symbol, s]));

  // Targets: fresh-NAV tickers with a composite score, top-K by score
  // (computeSignals already returns them score-sorted).
  const eligible = signals.filter(
    (s) => s.compositeScore !== null && s.navFreshness === "fresh" && s.navPrice !== null,
  );
  const top = eligible.slice(0, PAPER_RULES.topK);
  const targetWeight = top.length > 0 ? Math.min(1 / top.length, PAPER_RULES.maxPositionPct) : 0;
  const targets = top.map((s) => ({
    symbol: s.symbol,
    compositeScore: s.compositeScore!,
    targetWeight,
  }));
  const targetSet = new Map(targets.map((t) => [t.symbol, t.targetWeight]));

  const actions: PlannedAction[] = [];
  const considered = new Set<string>([...targetSet.keys(), ...pf.positions.keys()]);

  for (const symbol of considered) {
    const sig = bySymbol.get(symbol);
    const pos = pf.positions.get(symbol);
    const nav = navBySymbol.get(symbol);
    const currentValue = pos && nav !== undefined ? pos.qtyTokens * nav : 0;
    const currentWeight = equity > 0 ? currentValue / equity : 0;
    const wantWeight = targetSet.get(symbol) ?? 0;
    const drift = wantWeight - currentWeight;
    const side: "buy" | "sell" = drift >= 0 ? "buy" : "sell";
    const base = { symbol, side, currentWeight, targetWeight: wantWeight };

    // A held position we cannot price at all: freeze it, say why.
    if (pos && nav === undefined) {
      actions.push({
        ...base,
        usdcValue: 0,
        status: "skipped-nonav",
        detail: "Held position has no current NAV — cannot value or trade it this cycle.",
      });
      continue;
    }
    // No trading on stale feeds, either direction.
    if (sig && sig.navFreshness !== "fresh") {
      actions.push({
        ...base,
        usdcValue: 0,
        status: "skipped-stale",
        detail: `NAV is ${sig.navFreshness}${sig.navAgeHours !== null ? ` (${sig.navAgeHours.toFixed(1)}h old)` : ""} — no trading on stale feeds.`,
      });
      continue;
    }
    // Inside the rebalance band: deliberate no-op.
    if (Math.abs(drift) <= band) {
      actions.push({
        ...base,
        usdcValue: 0,
        status: "skipped-band",
        detail:
          pos === undefined && wantWeight === 0
            ? "Not held and not a target."
            : `Weight drift ${(drift * 100).toFixed(2)}pp is inside the ±${PAPER_RULES.rebalanceBandPct}% band.`,
      });
      continue;
    }
    // Cooldown (planner-level; the ledger enforces it again at execution).
    const cdLeft = cooldownHoursLeft(pf, symbol, now);
    if (cdLeft > 0) {
      actions.push({
        ...base,
        usdcValue: 0,
        status: "skipped-cooldown",
        detail: `Traded recently — ${cdLeft.toFixed(1)}h of the ${PAPER_RULES.cooldownHoursPerTicker}h per-ticker cooldown remain.`,
      });
      continue;
    }
    // Premium filter for buys (measured premium only; dust pools report none).
    if (side === "buy" && sig?.premiumDiscountPct != null && sig.premiumDiscountPct > PAPER_RULES.maxBuyPremiumPct) {
      actions.push({
        ...base,
        usdcValue: 0,
        status: "skipped-premium",
        detail: `DEX premium +${sig.premiumDiscountPct.toFixed(2)}% over NAV exceeds the +${PAPER_RULES.maxBuyPremiumPct}% buy cap.`,
      });
      continue;
    }
    actions.push({
      ...base,
      usdcValue: Math.abs(drift) * equity,
      status: "execute",
      detail:
        wantWeight === 0
          ? `Exit: no longer in the top-${PAPER_RULES.topK} (weight ${(currentWeight * 100).toFixed(2)}% → 0%).`
          : pos === undefined
            ? `New position: enter at target weight ${(wantWeight * 100).toFixed(1)}%.`
            : `Rebalance: weight ${(currentWeight * 100).toFixed(2)}% → ${(wantWeight * 100).toFixed(1)}% (drift ${(drift * 100).toFixed(2)}pp, outside the band).`,
    });
  }

  // Deterministic order: exits/trims by symbol, then buys by symbol —
  // applyPlan re-sorts sells-first anyway; this keeps records stable.
  actions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { at: now.toISOString(), equityUsdc: equity, cashUsdc: pf.cashUsdc, targets, actions };
}

/**
 * Execute a plan against the ledger. Sells run first so exits fund buys;
 * buys are clamped to the cash actually available at their turn. Every
 * "execute" action gets its outcome recorded back onto the plan.
 */
export function applyPlan(
  pf: PaperPortfolio,
  plan: RebalancePlan,
  signalsBySymbol: Map<string, TokenSignals>,
  navBySymbol: Map<string, number>,
  now = new Date(),
): { executed: PaperTrade[]; rejected: Array<{ symbol: string; side: string; reason: string }> } {
  const executed: PaperTrade[] = [];
  const rejected: Array<{ symbol: string; side: string; reason: string }> = [];
  const runnable = plan.actions
    .filter((a) => a.status === "execute")
    .sort((a, b) => (a.side === b.side ? a.symbol.localeCompare(b.symbol) : a.side === "sell" ? -1 : 1));

  for (const action of runnable) {
    const nav = navBySymbol.get(action.symbol);
    if (nav === undefined) {
      action.outcome = "rejected";
      action.outcomeDetail = "No NAV available at execution time.";
      rejected.push({ symbol: action.symbol, side: action.side, reason: action.outcomeDetail });
      continue;
    }
    let value = action.usdcValue;
    if (action.side === "buy") {
      value = Math.min(value, pf.cashUsdc);
      if (value < 1) {
        action.outcome = "rejected";
        action.outcomeDetail = "Insufficient paper cash after sells executed.";
        rejected.push({ symbol: action.symbol, side: action.side, reason: action.outcomeDetail });
        continue;
      }
    }
    const sig = signalsBySymbol.get(action.symbol);
    const res = executePaperTrade(
      pf,
      {
        symbol: action.symbol,
        side: action.side,
        usdcValue: value,
        navPrice: nav,
        premiumPct: sig?.premiumDiscountPct ?? undefined,
        reason: `rebalance: ${action.detail}`,
      },
      navBySymbol,
      now,
    );
    if (res.ok) {
      action.outcome = "executed";
      action.trade = res.trade;
      executed.push(res.trade);
    } else {
      action.outcome = "rejected";
      action.outcomeDetail = res.rejected;
      rejected.push({ symbol: action.symbol, side: action.side, reason: res.rejected });
    }
  }
  return { executed, rejected };
}

function fmtUsd(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildRationale(
  plan: RebalancePlan,
  executed: PaperTrade[],
  rejected: Array<{ symbol: string; side: string; reason: string }>,
  scoredCount: number,
): string {
  const parts: string[] = [];
  parts.push(
    `Equity ${fmtUsd(plan.equityUsdc)}; ${scoredCount} ticker(s) carried a composite score this cycle (fresh NAV + at least one live factor required).`,
  );
  if (plan.targets.length > 0) {
    parts.push(
      `Targets — top-${plan.targets.length} by composite: ${plan.targets
        .map((t) => `${t.symbol} (${t.compositeScore.toFixed(3)})`)
        .join(", ")}; equal target weight ${(plan.targets[0].targetWeight * 100).toFixed(1)}% each (position cap ${PAPER_RULES.maxPositionPct * 100}%).`,
    );
  } else {
    parts.push("No eligible targets — the book holds cash this cycle.");
  }
  if (executed.length > 0) {
    const total = executed.reduce((a, t) => a + t.usdcValue, 0);
    parts.push(
      `Executed ${executed.length} trade(s) totalling ${fmtUsd(total)}: ${executed
        .map((t) => `${t.side.toUpperCase()} ${t.symbol} ${fmtUsd(t.usdcValue)} @ NAV $${t.navPrice.toFixed(4)}`)
        .join("; ")}.`,
    );
  } else {
    parts.push("No trades executed.");
  }
  const skips = plan.actions.filter((a) => a.status !== "execute");
  if (skips.length > 0) {
    const byStatus = new Map<string, string[]>();
    for (const s of skips) {
      const list = byStatus.get(s.status) ?? [];
      list.push(s.symbol);
      byStatus.set(s.status, list);
    }
    parts.push(
      `Deliberate no-ops: ${[...byStatus.entries()].map(([k, v]) => `${k.replace("skipped-", "")}: ${v.join(", ")}`).join("; ")}.`,
    );
  }
  if (rejected.length > 0) {
    parts.push(
      `Ledger rejections: ${rejected.map((r) => `${r.side.toUpperCase()} ${r.symbol} — ${r.reason}`).join("; ")}.`,
    );
  }
  return parts.join(" ");
}

/** Plan + execute + assemble the full decision record for one agent cycle. */
export function runRebalance(
  signals: TokenSignals[],
  pf: PaperPortfolio,
  navBySymbol: Map<string, number>,
  runId: number | null,
  now = new Date(),
): { record: DecisionRecord; plan: RebalancePlan; executed: PaperTrade[] } {
  const cashBefore = pf.cashUsdc;
  const equityBefore = equityUsdc(pf, navBySymbol);
  const positionsBefore = [...pf.positions.values()].map((p) => {
    const nav = navBySymbol.get(p.symbol);
    const value = nav !== undefined ? p.qtyTokens * nav : null;
    return {
      symbol: p.symbol,
      qtyTokens: p.qtyTokens,
      navPrice: nav ?? null,
      valueUsdc: value,
      weight: value !== null && equityBefore > 0 ? value / equityBefore : null,
    };
  });

  const plan = planRebalance(signals, pf, navBySymbol, now);
  const signalsBySymbol = new Map(signals.map((s) => [s.symbol, s]));
  const { executed, rejected } = applyPlan(pf, plan, signalsBySymbol, navBySymbol, now);
  const scoredCount = signals.filter((s) => s.compositeScore !== null).length;

  const record: DecisionRecord = {
    version: 1,
    at: now.toISOString(),
    runId,
    kind: executed.length > 0 ? "rebalance" : "hold",
    equityUsdc: equityBefore,
    cashBeforeUsdc: cashBefore,
    cashAfterUsdc: pf.cashUsdc,
    rules: {
      topK: PAPER_RULES.topK,
      maxBuyPremiumPct: PAPER_RULES.maxBuyPremiumPct,
      maxPositionPct: PAPER_RULES.maxPositionPct,
      rebalanceBandPct: PAPER_RULES.rebalanceBandPct,
      cooldownHoursPerTicker: PAPER_RULES.cooldownHoursPerTicker,
    },
    universe: signals
      .filter((s) => s.navPrice !== null)
      .map((s) => ({
        symbol: s.symbol,
        compositeScore: s.compositeScore,
        coverage: s.coverage,
        navPrice: s.navPrice,
        navAgeHours: s.navAgeHours,
        navFreshness: s.navFreshness,
        momentum24hPct: s.momentum["24h"],
        supplyFlowPct: s.supplyFlow?.pct ?? null,
        premiumDiscountPct: s.premiumDiscountPct,
        premiumStatus: s.premiumDiscountStatus,
        dexDepthUsd: s.dexDepthUsd,
      })),
    targets: plan.targets,
    positionsBefore,
    actions: plan.actions,
    rationale: buildRationale(plan, executed, rejected, scoredCount),
  };
  return { record, plan, executed };
}
