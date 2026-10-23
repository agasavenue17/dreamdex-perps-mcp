/**
 * Configuration for the dreamDEX Perps MCP server.
 *
 * Everything is driven by environment variables so the same build can run
 * read-only (no key) or with guarded trading enabled.
 */

export interface ServerConfig {
  /** Signer key for write operations. Omit for a fully read-only server. */
  privateKey?: `0x${string}`;
  /**
   * Trading-key mode: when set, PRIVATE_KEY is a bot key linked to this
   * DreamDEX account (app → Link a bot → Perps) and orders are placed FOR
   * the account via placeOrderFor. Margin and fills belong to the account;
   * the key only pays gas. Omit to trade the key's own account.
   */
  ownerAddress?: `0x${string}`;
  /** HTTP RPC endpoint for direct pool calls (trading-key writes, link checks). */
  rpcUrl: string;
  /** Master switch for every write tool. Must be the string "true". */
  tradingEnabled: boolean;
  /** Hard cap on a single order's notional value, in USD (quote units). */
  maxOrderNotionalUsd: number;
  /** Slippage tolerance for market (IOC) orders, in basis points. */
  slippageBps: number;
  /** Indexer GraphQL endpoint for the Hideki testnet. */
  indexerUrl: string;
  /** Optional override for the chain WebSocket RPC endpoint. */
  wsRpcUrl?: string;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawKey = env.PRIVATE_KEY?.trim();
  const rawOwner = env.OWNER_ADDRESS?.trim();
  return {
    privateKey:
      rawKey && rawKey.length > 0 ? (rawKey as `0x${string}`) : undefined,
    ownerAddress:
      rawOwner && /^0x[0-9a-fA-F]{40}$/.test(rawOwner)
        ? (rawOwner as `0x${string}`)
        : undefined,
    rpcUrl:
      env.RPC_URL?.trim() || "https://api.hideki2.infra.testnet.somnia.network",
    tradingEnabled: env.TRADING_ENABLED?.trim().toLowerCase() === "true",
    maxOrderNotionalUsd: parseNumber(env.MAX_ORDER_NOTIONAL_USD, 50),
    slippageBps: parseNumber(env.SLIPPAGE_BPS, 100),
    indexerUrl:
      env.INDEXER_URL?.trim() || "https://hideki-dev.smk.somnia.host/v1/graphql",
    wsRpcUrl: env.WS_RPC_URL?.trim() || undefined,
  };
}

/** Throws a descriptive error when a write tool is not allowed to run. */
export function assertTradingAllowed(cfg: ServerConfig): void {
  if (!cfg.privateKey) {
    throw new Error(
      "No PRIVATE_KEY configured: this server is read-only. Set PRIVATE_KEY (testnet key) to enable trading tools.",
    );
  }
  if (!cfg.tradingEnabled) {
    throw new Error(
      "Trading is disabled. Set TRADING_ENABLED=true to allow order placement. This is a deliberate safety switch.",
    );
  }
}
