#!/usr/bin/env node
/**
 * dreamdex-perps-mcp — an MCP server that gives AI agents hands on
 * dreamDEX perpetuals (Somnia Hideki testnet).
 *
 * Read tools work without a key. Write tools (claim voucher, place /
 * cancel / close) require PRIVATE_KEY and TRADING_ENABLED=true, and every
 * order is capped by MAX_ORDER_NOTIONAL_USD and pre-checked against the
 * account's real max order size before anything is sent on-chain.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Address } from "viem";
import { z } from "zod";
import {
  getMarkets,
  resolveMarket,
  roundDownToStep,
  roundUpToStep,
  summarizeMarket,
  toHuman,
  toJson,
  toRaw,
  walletAddress,
} from "./client.js";
import { assertTradingAllowed, loadConfig } from "./config.js";

const cfg = loadConfig();

const server = new McpServer({
  name: "dreamdex-perps-mcp",
  version: "0.1.0",
});

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/* ------------------------------ read tools ------------------------------ */

server.registerTool(
  "list_markets",
  {
    description:
      "List all dreamDEX perpetual markets live on the Somnia Hideki testnet, with pool addresses, margin requirements and order-size rules.",
    inputSchema: {},
  },
  async () => {
    try {
      const markets = await getMarkets(cfg).client.listPerpMarkets();
      return ok(toJson(markets.map(summarizeMarket)));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_market",
  {
    description:
      "Get one perp market by base symbol (e.g. BTC, ETH, SOL): pool, tick/lot sizes, min quantity, margin and leverage.",
    inputSchema: {
      symbol: z.string().describe("Base symbol, e.g. BTC"),
    },
  },
  async ({ symbol }) => {
    try {
      const market = await resolveMarket(cfg, symbol);
      return ok(toJson(summarizeMarket(market)));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_account",
  {
    description:
      "Full perp account snapshot for an address (defaults to the server wallet): open orders, recent fills, open positions, margin account and paper-USDso voucher eligibility.",
    inputSchema: {
      address: z
        .string()
        .optional()
        .describe("Account address; defaults to the configured wallet"),
    },
  },
  async ({ address }) => {
    try {
      const account = address ?? walletAddress(cfg);
      if (!account) {
        throw new Error(
          "No address given and no PRIVATE_KEY configured, so there is no default wallet.",
        );
      }
      const markets = getMarkets(cfg);
      const marketRows = await markets.client.listPerpMarkets();
      const marginBank = marketRows[0]?.marginBank;

      const [portfolio, positions, eligibility, marginAccount] =
        await Promise.all([
          markets.client.getPerpPortfolio(account),
          markets.client.listPerpPositions(account),
          marginBank
            ? markets.client.getPerpVoucherEligibility(
                marginBank,
                account as Address,
              )
            : Promise.resolve(null),
          marginBank
            ? markets.client
                .getMarginAccount(marginBank, account as Address)
                .catch((e: unknown) => ({
                  error: e instanceof Error ? e.message : String(e),
                }))
            : Promise.resolve(null),
        ]);

      const symbolByPool = new Map(
        marketRows.map((m) => [m.poolAddress.toLowerCase(), m.baseSymbol]),
      );
      const openPositions = positions
        .filter((p) => p.size !== "0")
        .map((p) => ({
          symbol: symbolByPool.get(p.pool.toLowerCase()) ?? null,
          pool: p.pool,
          sizeRaw: p.size,
          avgEntryPriceRaw: p.avgEntryPrice,
        }));

      return ok(
        toJson({
          account,
          marginBank,
          voucherEligibility: eligibility,
          marginAccount,
          openPositions,
          openOrders: portfolio.openOrders,
          recentTrades: portfolio.trades.slice(0, 10),
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

/* ------------------------------ write tools ----------------------------- */

server.registerTool(
  "claim_voucher",
  {
    description:
      "Claim the one-time 1,000 paper USDso perps credit for the server wallet (testnet play money). Only works if the wallet holds no perp positions or orders.",
    inputSchema: {},
  },
  async () => {
    try {
      assertTradingAllowed(cfg);
      const markets = getMarkets(cfg);
      const account = markets.walletAddress;
      if (!account) throw new Error("SDK returned no wallet address.");
      const rows = await markets.client.listPerpMarkets();
      const marginBank = rows[0]?.marginBank;
      if (!marginBank) throw new Error("No perp markets found.");
      const eligibility = await markets.client.getPerpVoucherEligibility(
        marginBank,
        account,
      );
      if (!eligibility.eligible) {
        return ok(
          `Not eligible for the paper USDso voucher: ${toJson(eligibility)}`,
        );
      }
      const result = await markets.trader.claimPerpVoucher({ marginBank });
      return ok(`Voucher claimed. Result: ${toJson(result)}`);
    } catch (err) {
      return fail(err);
    }
  },
);

const placeOrderSchema = {
  symbol: z.string().describe("Base symbol, e.g. BTC"),
  side: z
    .enum(["long", "short"])
    .describe("long = buy/bid, short = sell/ask"),
  type: z
    .enum(["limit", "market"])
    .describe("market = IOC order priced through the book with slippage"),
  quantity: z
    .string()
    .describe("Order size in whole base units, e.g. '0.001' BTC"),
  price: z
    .string()
    .optional()
    .describe("Limit price in USD per whole base. Required for limit orders."),
};

server.registerTool(
  "place_order",
  {
    description:
      "Place a perp order on dreamDEX testnet for the server wallet. Guarded: trading must be enabled, notional is capped by MAX_ORDER_NOTIONAL_USD, quantity/price are rounded to the market's lot/tick, and the order is pre-checked with getMaxPerpOrderSize before sending.",
    inputSchema: placeOrderSchema,
  },
  async ({ symbol, side, type, quantity, price }) => {
    try {
      assertTradingAllowed(cfg);
      const markets = getMarkets(cfg);
      const account = markets.walletAddress;
      if (!account) throw new Error("SDK returned no wallet address.");
      const market = await resolveMarket(cfg, symbol);
      const isBid = side === "long";

      // Quantity: human -> raw, rounded DOWN to the market's lot size.
      const lot = BigInt(market.lotSize);
      let qtyRaw = roundDownToStep(
        toRaw(quantity, market.baseDecimals),
        lot,
      );
      if (qtyRaw < BigInt(market.minQuantity)) {
        throw new Error(
          `Quantity ${quantity} ${market.baseSymbol} is below the market minimum of ${toHuman(BigInt(market.minQuantity), market.baseDecimals)} (after lot rounding).`,
        );
      }

      // Price: limit uses the given price; market crosses the book using the
      // market's reference price plus configured slippage (IOC).
      const tick = BigInt(market.tickSize);
      let priceRaw: bigint;
      let orderType = 0;
      if (type === "limit") {
        if (!price) throw new Error("Limit orders require a price.");
        const parsed = toRaw(price, market.quoteDecimals);
        priceRaw = isBid
          ? roundDownToStep(parsed, tick)
          : roundUpToStep(parsed, tick);
      } else {
        const ref =
          market.indexPrice ?? market.lastPrice ?? null;
        if (!ref || BigInt(ref) === 0n) {
          throw new Error(
            "No live reference price for this market, cannot price a market order.",
          );
        }
        const refRaw = BigInt(ref);
        const scaled = isBid
          ? (refRaw * BigInt(10_000 + cfg.slippageBps)) / 10_000n
          : (refRaw * BigInt(10_000 - cfg.slippageBps)) / 10_000n;
        priceRaw = isBid
          ? roundDownToStep(scaled, tick)
          : roundUpToStep(scaled, tick);
        orderType = 2; // IOC market
      }

      // Notional cap (quote is USDso; price is per whole base).
      const notionalUsd =
        Number(toHuman(qtyRaw, market.baseDecimals)) *
        Number(toHuman(priceRaw, market.quoteDecimals));
      if (notionalUsd > cfg.maxOrderNotionalUsd) {
        throw new Error(
          `Order notional $${notionalUsd.toFixed(2)} exceeds the configured cap of $${cfg.maxOrderNotionalUsd} (MAX_ORDER_NOTIONAL_USD).`,
        );
      }

      // Pre-flight against the account's real limits (margin, caps, voucher
      // allowlist) — the same check the dreamDEX app performs.
      const max = await markets.client.getMaxPerpOrderSize({
        pool: market.poolAddress,
        marginBank: market.marginBank,
        account,
        isBid,
        price: priceRaw,
      });
      if (!max.priceable) {
        throw new Error(
          "Market has no live mark price to size against right now. Try again shortly.",
        );
      }
      if (!max.placeable || qtyRaw > max.maxQuantity) {
        throw new Error(
          `Order exceeds this account's max size for ${market.baseSymbol}: max ${toHuman(max.maxQuantity, market.baseDecimals)} (limited by ${max.limitedBy}).`,
        );
      }

      const result = await markets.trader.placePerpOrder({
        pool: market.poolAddress,
        isBid,
        price: priceRaw,
        quantity: qtyRaw,
        orderType,
      });
      return ok(
        `Order placed on ${market.baseSymbol} (${side}, ${type}): ` +
          `${toHuman(qtyRaw, market.baseDecimals)} @ ${toHuman(priceRaw, market.quoteDecimals)} USD. ` +
          `Result: ${toJson(result)}`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "cancel_order",
  {
    description:
      "Cancel a resting perp order by its order id (see get_account for open orders).",
    inputSchema: {
      symbol: z.string().describe("Base symbol of the market, e.g. BTC"),
      orderId: z.string().describe("uint128 order id, decimal string"),
    },
  },
  async ({ symbol, orderId }) => {
    try {
      assertTradingAllowed(cfg);
      const market = await resolveMarket(cfg, symbol);
      const result = await getMarkets(cfg).trader.cancelOrder({
        pool: market.poolAddress,
        orderId,
      });
      return ok(`Cancel sent for order ${orderId}: ${toJson(result)}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "close_position",
  {
    description:
      "Close the server wallet's entire position in one market with an opposite-side IOC market order sized exactly to the open position.",
    inputSchema: {
      symbol: z.string().describe("Base symbol, e.g. BTC"),
    },
  },
  async ({ symbol }) => {
    try {
      assertTradingAllowed(cfg);
      const markets = getMarkets(cfg);
      const account = markets.walletAddress;
      if (!account) throw new Error("SDK returned no wallet address.");
      const market = await resolveMarket(cfg, symbol);
      const positions = await markets.client.listPerpPositions(account);
      const position = positions.find(
        (p) =>
          p.pool.toLowerCase() === market.poolAddress.toLowerCase() &&
          p.size !== "0",
      );
      if (!position) {
        return ok(`No open position in ${market.baseSymbol} to close.`);
      }
      const size = BigInt(position.size);
      const qtyRaw = size < 0n ? -size : size;
      const isBid = size < 0n; // short -> buy to close; long -> sell to close
      const ref = market.indexPrice ?? market.lastPrice ?? null;
      if (!ref || BigInt(ref) === 0n) {
        throw new Error("No live reference price; cannot price the close.");
      }
      const refRaw = BigInt(ref);
      const tick = BigInt(market.tickSize);
      const scaled = isBid
        ? (refRaw * BigInt(10_000 + cfg.slippageBps)) / 10_000n
        : (refRaw * BigInt(10_000 - cfg.slippageBps)) / 10_000n;
      const priceRaw = isBid
        ? roundDownToStep(scaled, tick)
        : roundUpToStep(scaled, tick);
      const result = await markets.trader.placePerpOrder({
        pool: market.poolAddress,
        isBid,
        price: priceRaw,
        quantity: qtyRaw,
        orderType: 2,
      });
      return ok(
        `Close order sent for ${market.baseSymbol} position of ${toHuman(size, market.baseDecimals)}: ${toJson(result)}`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

/* --------------------------------- main --------------------------------- */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = cfg.privateKey
    ? cfg.tradingEnabled
      ? "trading enabled"
      : "key loaded, trading disabled"
    : "read-only";
  console.error(`dreamdex-perps-mcp running on stdio (${mode})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
