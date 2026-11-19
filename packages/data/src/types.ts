/**
 * Types for the Base Tokenized Stocks API (https://api.coinbase.com/v1/tokenized-stocks).
 *
 * The API omits default/empty fields from JSON responses, so almost every
 * field is optional. A missing `navPrice` is NOT a usable price.
 */

export interface TokenizedStock {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  isin?: string;
  adgmIsin?: string;
  iconUrl?: string;
  description?: string;
  /** Normalized token supply (token units, not underlying shares). */
  totalSupply?: number;
  /** Current scaling factor between token units and underlying shares. */
  multiplier?: number;
  /** Most recent Chainlink-based NAV / reference value. NOT an execution price. */
  navPrice?: number;
  /** ISO timestamp of the last onchain NAV update. Check staleness before use. */
  navPriceUpdatedAt?: string;
  firstMintDate?: string;
  pausedFeatures?: string[];
}

export interface ChainInfo {
  chainId: string;
  chain: string;
  policyRegistryAddress?: string;
  tokenSupplyManagerAddress?: string;
  tokenFactoryAddress?: string;
}

export interface CorporateActionAnnouncement {
  announcementId?: string;
  description?: string;
  txHash?: string;
  /** Decimal string in JSON. */
  blockNumber?: string;
  blockTime?: string;
}

export type CorporateActionStatus =
  | "CORPORATE_ACTION_STATUS_UNSPECIFIED"
  | "CORPORATE_ACTION_STATUS_ANNOUNCED"
  | "CORPORATE_ACTION_STATUS_APPLIED";

export interface CorporateAction {
  id: string;
  uri?: string;
  contractAddress?: string;
  symbol?: string;
  description?: string;
  status: CorporateActionStatus;
  announcedAt?: string;
  /** Populated only once the multiplier update has been applied. */
  appliedAt?: string;
  multiplierBefore?: number;
  multiplierAfter?: number;
  announcements?: CorporateActionAnnouncement[];
}

export interface TokenMetadata {
  contractAddress: string;
  symbol: string;
  name: string;
  image?: string;
  prospectusUrl?: string;
  description?: string;
  /** Any additional fields the API returns, preserved verbatim. */
  raw: Record<string, unknown>;
}

/** Error shape returned by the API: JSON `{ code, message }` (code is a service code, not the HTTP status). */
export class TokenizedStocksApiError extends Error {
  readonly httpStatus: number;
  readonly serviceCode?: number;

  constructor(httpStatus: number, message: string, serviceCode?: number) {
    super(message);
    this.name = "TokenizedStocksApiError";
    this.httpStatus = httpStatus;
    this.serviceCode = serviceCode;
  }
}
