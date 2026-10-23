/**
 * Trading-key mode: the server key is a bot key linked to a DreamDEX
 * account in the app (wallet → Link a bot → Perps). That link writes an
 * operator grant to the OperatorPermissionsRegistry for three selectors
 * per perp pool: placeOrderFor, cancelOrderFor, reduceOrderFor.
 *
 * In this mode the bot key calls `placeOrderFor(owner, …)` directly on the
 * pool contract: margin locks from the OWNER's MarginBank balance and every
 * fill settles to the owner. The key pays gas (STT) and nothing else, and
 * it cannot withdraw. The markets SDK has no perp `…For` writes, so these
 * calls go through viem — the same pattern as the official
 * somnia-chain/dreamdex-bot-kit (packages/perp-core/src/operator.ts,
 * MIT-style license, Copyright DreamDEX S.A.), adapted to this server's
 * config.
 */

import { contractErrorsAbi, decodePlaceOrder } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Chain,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ServerConfig } from "./config.js";

/** The three selectors a trading key is granted, as the registry keys them. */
export const TRADING_KEY_SELECTOR = {
  placeOrderFor: "0x80054449",
  cancelOrderFor: "0xe37b444b",
  reduceOrderFor: "0x364c2587",
} as const;

const OPERATOR_ABI = [
  ...parseAbi([
    "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function cancelOrderFor(address owner, uint128 orderId)",
    "function reduceOrderFor(address owner, uint128 orderId, uint256 newQuantityRemaining)",
    "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  ]),
  // The pool reverts with named errors (ImmediateOrCancelNoFill,
  // PostOnlyWouldCross, OnlyApprovedContracts, …). With them in the ABI the
  // simulation error carries the name, which callers can match on.
  ...contractErrorsAbi,
] as const;

/** The same gas the SDK sends a perp order with. Somnia bills gas used, not the limit. */
const ORDER_GAS = 10_000_000n;

/** The SDK's resting-order expiry: fifty years out, in nanoseconds. */
function farFutureNs(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 50 * 365 * 24 * 3600) * 1_000_000_000n;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** A bot key acting for one DreamDEX account. */
export interface TradingKey {
  /** The DreamDEX account the orders belong to. */
  owner: Address;
  /** The bot key's own address: the operator the account granted. */
  operator: Address;
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

let cachedKey: TradingKey | null = null;

/**
 * Build the trading key when OWNER_ADDRESS and PRIVATE_KEY are both set,
 * else null (the server then trades the key's own account, as before).
 */
export function getTradingKey(cfg: ServerConfig): TradingKey | null {
  if (!cfg.ownerAddress || !cfg.privateKey) return null;
  if (cachedKey && cachedKey.owner === cfg.ownerAddress) return cachedKey;
  const account = privateKeyToAccount(cfg.privateKey);
  if (account.address.toLowerCase() === cfg.ownerAddress.toLowerCase()) {
    throw new Error(
      "OWNER_ADDRESS is the signing key's own address. Leave OWNER_ADDRESS unset to trade the key's own account, or set it to the DreamDEX account this bot key is linked to.",
    );
  }
  const chain = hidekiTestnet as unknown as Chain;
  const transport = http(cfg.rpcUrl);
  cachedKey = {
    owner: cfg.ownerAddress,
    operator: account.address,
    account,
    publicClient: createPublicClient({ chain, transport }) as PublicClient,
    walletClient: createWalletClient({ account, chain, transport }),
  };
  return cachedKey;
}

export interface LinkStatus {
  place: boolean;
  cancel: boolean;
  reduce: boolean;
}

/** What the pool itself says this key may do for the owner. The pool's answer is the one it enforces. */
export async function linkStatus(
  key: TradingKey,
  pool: Address,
): Promise<LinkStatus> {
  const ask = (selector: `0x${string}`) =>
    key.publicClient.readContract({
      address: pool,
      abi: OPERATOR_ABI,
      functionName: "isOperatorAuthorized",
      args: [key.owner, key.operator, selector],
    }) as Promise<boolean>;
  const [place, cancel, reduce] = await Promise.all([
    ask(TRADING_KEY_SELECTOR.placeOrderFor),
    ask(TRADING_KEY_SELECTOR.cancelOrderFor),
    ask(TRADING_KEY_SELECTOR.reduceOrderFor),
  ]);
  return { place, cancel, reduce };
}

/** One line saying what to do when the key is not linked, or undefined when it is. */
export function linkProblem(status: LinkStatus, market: string): string | undefined {
  if (status.place && status.cancel) return undefined;
  const missing = [
    status.place ? undefined : "place",
    status.cancel ? undefined : "cancel",
    status.reduce ? undefined : "reduce",
  ].filter(Boolean);
  return (
    `This bot key cannot ${missing.join("/")} orders for the owner account on ${market}. ` +
    "In the DreamDEX app open the wallet, choose Link a bot, tick Perps and paste this key's address. " +
    "A market listed after the link needs the same address added again. " +
    "Check that OWNER_ADDRESS is the account the key was linked on."
  );
}

/** Send a write the way the SDK does: simulate first, so a revert arrives as its named error, then send and wait. */
async function send(
  key: TradingKey,
  pool: Address,
  functionName: "placeOrderFor" | "cancelOrderFor" | "reduceOrderFor",
  args: readonly unknown[],
) {
  const { request } = await key.publicClient.simulateContract({
    address: pool,
    abi: OPERATOR_ABI,
    functionName,
    args: args as never,
    account: key.account,
    gas: ORDER_GAS,
  });
  const hash = await key.walletClient.writeContract(request as never);
  const receipt = await key.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${functionName} REVERTED on-chain (tx ${hash}).`);
  }
  return { hash, receipt };
}

export interface OperatorPlacement {
  hash: `0x${string}`;
  orderId?: bigint;
  filledQuantity: bigint;
  fillsCount: number;
}

/** `placeOrderFor` on a perp pool, decoded the way the SDK decodes `placeOrder`. */
export async function placeFor(
  key: TradingKey,
  p: { pool: Address; isBid: boolean; price: bigint; quantity: bigint; orderType: number },
): Promise<OperatorPlacement> {
  const { hash, receipt } = await send(key, p.pool, "placeOrderFor", [
    key.owner,
    p.isBid,
    0n,
    p.price,
    p.quantity,
    farFutureNs(),
    p.orderType,
    0,
    ZERO_ADDRESS,
    0n,
  ]);
  const { orderId, fills } = decodePlaceOrder(receipt, p.pool) as {
    orderId?: bigint;
    fills?: Array<{ quantityFilled: bigint }>;
  };
  const list = fills ?? [];
  return {
    hash,
    orderId,
    filledQuantity: list.reduce((sum, f) => sum + f.quantityFilled, 0n),
    fillsCount: list.length,
  };
}

/** `cancelOrderFor`: the order's collateral goes back to the owner, never to the key. */
export async function cancelFor(
  key: TradingKey,
  pool: Address,
  orderId: bigint,
): Promise<`0x${string}`> {
  return (await send(key, pool, "cancelOrderFor", [key.owner, orderId])).hash;
}
