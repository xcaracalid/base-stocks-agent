/**
 * Client for the public Base Tokenized Stocks API.
 *
 * Base URL: https://api.coinbase.com/v1/tokenized-stocks
 * Public, read-only, NO API key / auth. Rate limits are unpublished —
 * callers should poll politely and cache (see the snapshot job).
 *
 * Docs: https://docs.base.org/sdks/tokenized-stocks/overview
 */

import {
  TokenizedStocksApiError,
  type ChainInfo,
  type CorporateAction,
  type TokenMetadata,
  type TokenizedStock,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.coinbase.com/v1/tokenized-stocks";

interface RawToken {
  contract_address: string;
  symbol: string;
  name: string;
  decimals: number;
  isin?: string;
  adgm_isin?: string;
  icon_url?: string;
  description?: string;
  total_supply?: number;
  multiplier?: number;
  nav_price?: number;
  nav_price_updated_at?: string;
  first_mint_date?: string;
  paused_features?: string[];
}

function mapToken(raw: RawToken): TokenizedStock {
  return {
    contractAddress: raw.contract_address,
    symbol: raw.symbol,
    name: raw.name,
    decimals: raw.decimals,
    isin: raw.isin,
    adgmIsin: raw.adgm_isin,
    iconUrl: raw.icon_url,
    description: raw.description,
    totalSupply: raw.total_supply,
    multiplier: raw.multiplier,
    navPrice: raw.nav_price,
    navPriceUpdatedAt: raw.nav_price_updated_at,
    firstMintDate: raw.first_mint_date,
    pausedFeatures: raw.paused_features,
  };
}

export class TokenizedStocksClient {
  readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async getJson<T>(path: string): Promise<T> {
    // A path starting with "?" targets the base URL itself (the list
    // endpoint) — the API 404s on a trailing slash before the query string.
    const url = path.startsWith("?") ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}`;
    // One retry on 503 (documented "data temporarily unavailable").
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) return (await res.json()) as T;
      let serviceCode: number | undefined;
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { code?: number; message?: string };
        if (typeof body.code === "number") serviceCode = body.code;
        if (body.message) message = body.message;
      } catch {
        // Non-JSON error body — keep the HTTP status message.
      }
      if (res.status === 503 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new TokenizedStocksApiError(res.status, message, serviceCode);
    }
    // Unreachable, but keeps the type checker honest.
    throw new TokenizedStocksApiError(0, "request failed");
  }

  /** One page of the token list. Tokens are ordered by contract address. */
  async listTokensPage(
    pageSize = 100,
    pageToken?: string,
  ): Promise<{ tokens: TokenizedStock[]; nextPageToken?: string }> {
    const params = new URLSearchParams({ page_size: String(pageSize) });
    if (pageToken) params.set("page_token", pageToken);
    const body = await this.getJson<{ tokens: RawToken[]; next_page_token?: string }>(
      `?${params.toString()}`,
    );
    return { tokens: body.tokens.map(mapToken), nextPageToken: body.next_page_token };
  }

  /** The full token universe, following pagination to the end. */
  async listAllTokens(pageSize = 500): Promise<TokenizedStock[]> {
    const all: TokenizedStock[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.listTokensPage(pageSize, pageToken);
      all.push(...page.tokens);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return all;
  }

  /** Protocol contract addresses per chain (incl. the Onchain Registry). */
  async getChains(): Promise<ChainInfo[]> {
    const body = await this.getJson<{
      chains: Array<{
        chain_id: string;
        chain: string;
        policy_registry_address?: string;
        token_supply_manager_address?: string;
        token_factory_address?: string;
      }>;
    }>("/chains");
    return body.chains.map((c) => ({
      chainId: c.chain_id,
      chain: c.chain,
      policyRegistryAddress: c.policy_registry_address,
      tokenSupplyManagerAddress: c.token_supply_manager_address,
      tokenFactoryAddress: c.token_factory_address,
    }));
  }

  /** Normalized total supply for one token, by contract address. */
  async getTotalSupply(contractAddress: string): Promise<number> {
    // The endpoint returns a bare JSON number (e.g. `55760.10508015`).
    const body = await this.getJson<unknown>(`/total-supply/${contractAddress}`);
    if (typeof body === "number") return body;
    if (body !== null && typeof body === "object") {
      const obj = body as { total_supply?: unknown; totalSupply?: unknown };
      if (typeof obj.total_supply === "number") return obj.total_supply;
      if (typeof obj.totalSupply === "number") return obj.totalSupply;
    }
    throw new TokenizedStocksApiError(200, "total-supply response had no numeric value");
  }

  /** Metadata for one ticker (e.g. "NVDAc"). */
  async getMetadata(ticker: string): Promise<TokenMetadata> {
    const raw = await this.getJson<Record<string, unknown>>(`/metadata/${encodeURIComponent(ticker)}`);
    return {
      contractAddress: String(raw.contract_address ?? ""),
      symbol: String(raw.symbol ?? ticker),
      name: String(raw.name ?? ""),
      image: typeof raw.image === "string" ? raw.image : undefined,
      prospectusUrl: typeof raw.prospectus_url === "string" ? raw.prospectus_url : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      raw,
    };
  }

  /**
   * One corporate action by UUID. The UUID comes from the `uri` of the token
   * contract's onchain `Announcement` event — there is no list endpoint.
   */
  async getCorporateAction(id: string): Promise<CorporateAction> {
    const raw = await this.getJson<Record<string, unknown>>(`/corporate-actions/${id}`);
    const announcements = Array.isArray(raw.announcements)
      ? (raw.announcements as Array<Record<string, unknown>>).map((a) => ({
          announcementId: typeof a.announcement_id === "string" ? a.announcement_id : undefined,
          description: typeof a.description === "string" ? a.description : undefined,
          txHash: typeof a.tx_hash === "string" ? a.tx_hash : undefined,
          blockNumber: typeof a.block_number === "string" ? a.block_number : undefined,
          blockTime: typeof a.block_time === "string" ? a.block_time : undefined,
        }))
      : undefined;
    return {
      id: String(raw.id ?? id),
      uri: typeof raw.uri === "string" ? raw.uri : undefined,
      contractAddress: typeof raw.contract_address === "string" ? raw.contract_address : undefined,
      symbol: typeof raw.symbol === "string" ? raw.symbol : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      status: (typeof raw.status === "string" ? raw.status : "CORPORATE_ACTION_STATUS_UNSPECIFIED") as CorporateAction["status"],
      announcedAt: typeof raw.announced_at === "string" ? raw.announced_at : undefined,
      appliedAt: typeof raw.applied_at === "string" ? raw.applied_at : undefined,
      multiplierBefore: typeof raw.multiplier_before === "number" ? raw.multiplier_before : undefined,
      multiplierAfter: typeof raw.multiplier_after === "number" ? raw.multiplier_after : undefined,
      announcements,
    };
  }

  /** Cached prospectus list (raw shape preserved — used for reference only). */
  async listProspectuses(): Promise<unknown> {
    return this.getJson("/prospectuses");
  }
}
