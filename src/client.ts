/**
 * Thin wrapper around @somnia-chain/markets-sdk for dreamDEX perps on the
 * Somnia Hideki testnet (the chain the dreamDEX app shows as its testnet
 * region, explorer: explorer.testnet.somnia.network/tokyo).
 *
 * Reference: https://docs.dreamdex.io — "Perps on Testnet for Developers"
 * (SDK version pinned to 0.32.1, the version the app itself runs).
 */

import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
  type PerpMarket,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { formatUnits, parseUnits } from "viem";
import type { ServerConfig } from "./config.js";

export type Markets = InstanceType<typeof SomniaMarkets>;

let cached: { markets: Markets; withKey: boolean } | null = null;

/** Lazily build (and reuse) the SDK instance. */
export function getMarkets(cfg: ServerConfig): Markets {
  const withKey = Boolean(cfg.privateKey);
  if (cached && cached.withKey === withKey) return cached.markets;
  const markets = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: cfg.indexerUrl,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    ...(cfg.wsRpcUrl ? { wsRpcUrl: cfg.wsRpcUrl } : {}),
    ...(cfg.privateKey ? { privateKey: cfg.privateKey } : {}),
  });
  cached = { markets, withKey };
  return markets;
}

/** The signer's address, or null when the server runs read-only. */
export function walletAddress(cfg: ServerConfig): string | null {
  if (!cfg.privateKey) return null;
  return getMarkets(cfg).walletAddress ?? null;
}

/**
 * The account perp reads and orders belong to: the OWNER account in
 * trading-key mode (OWNER_ADDRESS set), otherwise the signer's own.
 */
export function effectiveAccount(cfg: ServerConfig): string | null {
  return cfg.ownerAddress ?? walletAddress(cfg);
}

/** Find a perp market by base symbol, e.g. "BTC" (case-insensitive). */
export async function resolveMarket(
  cfg: ServerConfig,
  symbol: string,
): Promise<PerpMarket> {
  const markets = await getMarkets(cfg).client.listPerpMarkets();
  const wanted = symbol.trim().toUpperCase();
  const market = markets.find(
    (m) => (m.baseSymbol ?? "").toUpperCase() === wanted,
  );
  if (!market) {
    const available = markets
      .map((m) => m.baseSymbol)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Unknown perp market "${symbol}". Available: ${available || "(none)"}`,
    );
  }
  return market;
}

/** Human decimal string -> raw bigint units for the given decimals. */
export function toRaw(human: string, decimals: number): bigint {
  return parseUnits(human, decimals);
}

/** Raw bigint units -> human decimal string. */
export function toHuman(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

/** Round a raw value DOWN to a multiple of step (used for quantities/bids). */
export function roundDownToStep(value: bigint, step: bigint): bigint {
  if (step <= 0n) return value;
  return (value / step) * step;
}

/** Round a raw value UP to a multiple of step (used for ask prices). */
export function roundUpToStep(value: bigint, step: bigint): bigint {
  if (step <= 0n) return value;
  const rem = value % step;
  return rem === 0n ? value : ((value / step) + 1n) * step;
}

/** JSON.stringify that survives bigint values (renders them as strings). */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

/** Summarize a PerpMarket row into agent-friendly plain data. */
export function summarizeMarket(m: PerpMarket) {
  return {
    symbol: m.baseSymbol,
    pool: m.poolAddress,
    marginBank: m.marginBank,
    quoteSymbol: m.quoteSymbol,
    baseDecimals: m.baseDecimals,
    quoteDecimals: m.quoteDecimals,
    tickSize: m.tickSize,
    lotSize: m.lotSize,
    minQuantity: m.minQuantity,
    minQuantityHuman: toHuman(BigInt(m.minQuantity), m.baseDecimals),
    initialMarginBps: m.initialMarginBps,
    maxLeverage: m.initialMarginBps
      ? Math.floor(10_000 / m.initialMarginBps)
      : null,
  };
}
