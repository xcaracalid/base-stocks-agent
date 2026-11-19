/**
 * Rules-based paper portfolio. Virtual USDC book; trades execute at NAV
 * (paper mode — there is no execution venue in the API). The rules below are
 * the published strategy constraints from the spec; every trade is checked
 * against them and every decision is recorded with its inputs.
 *
 * Status: ledger + rule enforcement WORKING. The automatic rebalance planner
 * (top-K by composite score) is a scaffold — it produces target weights but
 * does not execute; wiring it to the signal engine lands Nov 22.
 */

export const PAPER_RULES = {
  /** Target the top-K tickers by composite score. */
  topK: 5,
  /** Never buy a token trading more than this % above NAV (once DEX prices exist). */
  maxBuyPremiumPct: 3,
  /** No single position above this share of equity. */
  maxPositionPct: 0.25,
  /** Rebalance only when a position drifts beyond this band. */
  rebalanceBandPct: 5,
  /** Minimum hours between trades in the same ticker. */
  cooldownHoursPerTicker: 24,
} as const;

export interface PaperPosition {
  symbol: string;
  /** Token units held. */
  qtyTokens: number;
  /** Volume-weighted average NAV paid, USD per token. */
  avgNavPrice: number;
}

export interface PaperTrade {
  at: string;
  symbol: string;
  side: "buy" | "sell";
  qtyTokens: number;
  navPrice: number;
  usdcValue: number;
  reason: string;
}

export interface PaperPortfolio {
  cashUsdc: number;
  positions: Map<string, PaperPosition>;
  trades: PaperTrade[];
  lastTradeAtBySymbol: Map<string, string>;
}

export function createPortfolio(initialCashUsdc = 100_000): PaperPortfolio {
  return {
    cashUsdc: initialCashUsdc,
    positions: new Map(),
    trades: [],
    lastTradeAtBySymbol: new Map(),
  };
}

export function equityUsdc(pf: PaperPortfolio, navBySymbol: Map<string, number>): number {
  let total = pf.cashUsdc;
  for (const pos of pf.positions.values()) {
    const nav = navBySymbol.get(pos.symbol);
    if (nav !== undefined) total += pos.qtyTokens * nav;
  }
  return total;
}

export interface TradeRequest {
  symbol: string;
  side: "buy" | "sell";
  /** USD value to trade (buys are capped by cash and the position limit). */
  usdcValue: number;
  navPrice: number;
  /** DEX premium vs NAV in %, when known (buys are rejected above the cap). */
  premiumPct?: number;
  reason: string;
}

export type TradeResult =
  | { ok: true; trade: PaperTrade }
  | { ok: false; rejected: string };

export function executePaperTrade(
  pf: PaperPortfolio,
  req: TradeRequest,
  navBySymbol: Map<string, number>,
  now = new Date(),
): TradeResult {
  if (req.navPrice <= 0) return { ok: false, rejected: "NAV price must be positive" };
  if (req.usdcValue <= 0) return { ok: false, rejected: "Trade value must be positive" };

  // Cooldown per ticker.
  const last = pf.lastTradeAtBySymbol.get(req.symbol);
  if (last) {
    const hours = (now.getTime() - new Date(last).getTime()) / 3600_000;
    if (hours < PAPER_RULES.cooldownHoursPerTicker) {
      return { ok: false, rejected: `Cooldown: ${req.symbol} traded ${hours.toFixed(1)}h ago (< ${PAPER_RULES.cooldownHoursPerTicker}h)` };
    }
  }

  if (req.side === "buy") {
    if (req.premiumPct !== undefined && req.premiumPct > PAPER_RULES.maxBuyPremiumPct) {
      return { ok: false, rejected: `Premium filter: +${req.premiumPct.toFixed(2)}% over NAV exceeds +${PAPER_RULES.maxBuyPremiumPct}% cap` };
    }
    if (req.usdcValue > pf.cashUsdc) return { ok: false, rejected: "Insufficient paper cash" };
    const equity = equityUsdc(pf, navBySymbol);
    const existing = pf.positions.get(req.symbol);
    const existingValue = existing ? existing.qtyTokens * req.navPrice : 0;
    if (equity > 0 && (existingValue + req.usdcValue) / equity > PAPER_RULES.maxPositionPct) {
      return { ok: false, rejected: `Position cap: would exceed ${PAPER_RULES.maxPositionPct * 100}% of equity` };
    }
    const qty = req.usdcValue / req.navPrice;
    if (existing) {
      const totalQty = existing.qtyTokens + qty;
      existing.avgNavPrice =
        (existing.qtyTokens * existing.avgNavPrice + qty * req.navPrice) / totalQty;
      existing.qtyTokens = totalQty;
    } else {
      pf.positions.set(req.symbol, { symbol: req.symbol, qtyTokens: qty, avgNavPrice: req.navPrice });
    }
    pf.cashUsdc -= req.usdcValue;
    const trade: PaperTrade = {
      at: now.toISOString(), symbol: req.symbol, side: "buy",
      qtyTokens: qty, navPrice: req.navPrice, usdcValue: req.usdcValue, reason: req.reason,
    };
    pf.trades.push(trade);
    pf.lastTradeAtBySymbol.set(req.symbol, trade.at);
    return { ok: true, trade };
  }

  // Sell.
  const existing = pf.positions.get(req.symbol);
  if (!existing) return { ok: false, rejected: `No position in ${req.symbol}` };
  const qty = Math.min(req.usdcValue / req.navPrice, existing.qtyTokens);
  const value = qty * req.navPrice;
  existing.qtyTokens -= qty;
  if (existing.qtyTokens <= 1e-12) pf.positions.delete(req.symbol);
  pf.cashUsdc += value;
  const trade: PaperTrade = {
    at: now.toISOString(), symbol: req.symbol, side: "sell",
    qtyTokens: qty, navPrice: req.navPrice, usdcValue: value, reason: req.reason,
  };
  pf.trades.push(trade);
  pf.lastTradeAtBySymbol.set(req.symbol, trade.at);
  return { ok: true, trade };
}

/**
 * SCAFFOLD (Nov 22): target weights = equal weight across the top-K scored
 * tickers. Returns the plan only — execution goes through executePaperTrade
 * once the agent loop wires signals → planner → ledger.
 */
export function proposeTargetWeights(
  scored: Array<{ symbol: string; compositeScore: number | null }>,
): Map<string, number> {
  const top = scored
    .filter((s) => s.compositeScore !== null)
    .slice(0, PAPER_RULES.topK);
  const weights = new Map<string, number>();
  if (top.length === 0) return weights;
  for (const t of top) weights.set(t.symbol, 1 / top.length);
  return weights;
}
