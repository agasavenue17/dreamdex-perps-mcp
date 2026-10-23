# dreamDEX Perps MCP

**An MCP server that lets AI agents trade dreamDEX perpetuals.**

Connect any MCP-compatible agent (Claude, Cursor, or your own) to dreamDEX
perps on the Somnia **Hideki testnet** and it can read markets, inspect a
portfolio, and place real on-chain orders through plain tool calls — no UI,
no clicking, no hand-rolled ABIs.

Built for the **dreamDEX Perps Builder Bounty** (MVP track).

## Why

dreamDEX is built for the agentic era: the order book is on-chain, the APIs
are open, and agents are first-class participants. What was missing is a
standard, safe way for an LLM agent to actually *use* the perps book. MCP
(Model Context Protocol) is that standard. This server wraps the official
`@somnia-chain/markets-sdk` (v0.32.1, the version the dreamDEX app runs)
and exposes a small, auditable tool surface with guardrails an agent
cannot talk its way around.

## Tools

| Tool | Type | What it does |
| --- | --- | --- |
| `list_markets` | read | All live perp markets: pool, margin bank, tick/lot, min size, max leverage |
| `get_market` | read | One market by symbol (BTC, ETH, SOL, …) |
| `get_account` | read | Open orders, recent fills, open positions, margin account, voucher eligibility |
| `claim_voucher` | write | Claim the one-time 1,000 paper USDso perps credit |
| `place_order` | write | Limit or market (IOC) perp order, pre-checked and capped |
| `cancel_order` | write | Cancel a resting order by id |
| `close_position` | write | Flatten a whole position with one opposite IOC order |

## Safety model

An agent with a signing key is a loaded weapon, so the server is built
defensive by default:

- **Read-only unless you say otherwise.** No `PRIVATE_KEY` → no signing at
  all. Key present but `TRADING_ENABLED` unset → write tools still refuse.
- **Hard notional cap.** Every order is rejected if its USD value exceeds
  `MAX_ORDER_NOTIONAL_USD` (default $50). The cap is enforced in code, not
  in a prompt.
- **Exchange-side pre-flight.** Before sending, each order is checked with
  the SDK's `getMaxPerpOrderSize` — the same check the dreamDEX app runs —
  so margin, position caps and voucher allowlists are respected instead of
  discovered via reverts.
- **Exact sizing.** Quantities and prices are rounded to the market's own
  `lotSize` / `tickSize`, and per-market decimals (6–24 on the base side!)
  are read from the market row, never assumed.
- **Testnet only.** The server is wired to the Hideki testnet chain
  (chain id 50383) and paper USDso. There is no mainnet switch.

## Quick start

```bash
git clone https://github.com/agasavenue17/dreamdex-perps-mcp
cd dreamdex-perps-mcp
npm install
cp .env.example .env   # fill in PRIVATE_KEY if you want trading enabled
npm run build
npm start
```

Verify the wiring without any key (talks to the live testnet indexer):

```bash
node scripts/smoke.mjs
```

### Use it from an MCP client

```json
{
  "mcpServers": {
    "dreamdex-perps": {
      "command": "node",
      "args": ["/path/to/dreamdex-perps-mcp/dist/index.js"],
      "env": {
        "PRIVATE_KEY": "0x…your-testnet-key…",
        "TRADING_ENABLED": "true",
        "MAX_ORDER_NOTIONAL_USD": "50"
      }
    }
  }
}
```

Then ask your agent things like:

- "List the perp markets and show me BTC's max leverage."
- "What's my account state? Any open positions?"
- "Open a $20 long on BTC at market."

### Getting testnet funds

1. **STT for gas:** sign in at
   [app.testnet.dreamdex.io](https://app.testnet.dreamdex.io), use
   **Link a Bot** with your key's address, and use *Send it … for gas* /
   *Top up*. A perp order costs roughly 0.0003–0.003 STT in gas.
2. **Paper USDso:** with a fresh wallet (no positions or orders), call the
   `claim_voucher` tool once to receive the 1,000 USDso perps credit. Note
   the credit can only open positions in the markets on its allowlist.

## How it works

```
AI agent ──MCP (stdio)──> this server ──> @somnia-chain/markets-sdk ──> Somnia Hideki testnet
                                            │                             ├─ Indexer (GraphQL): markets, portfolio
                                            └─ trader (viem signer)       └─ PerpPool contracts: orders settle on-chain
```

Reads go through the unified Somnia Markets indexer; writes are signed
locally and sent straight to the perp pool contracts, where fills settle
atomically on-chain. Every placement returns the transaction result, so
an agent's work is verifiable in the
[testnet explorer](https://explorer.testnet.somnia.network/tokyo).

## Network reference

| | |
| --- | --- |
| Chain | Somnia Hideki testnet (id `50383`) |
| RPC | `https://api.hideki2.infra.testnet.somnia.network` |
| Indexer | `https://hideki-dev.smk.somnia.host/v1/graphql` |
| MarginBank | `0x478769E1177C0773c43A593DCCc4Ad15F15F1394` |
| Collateral | USDso (paper, via voucher) |

## Running behind a proxy

The SDK talks to the chain over a raw WebSocket and has no HTTP fallback,
so networks that force traffic through an HTTP(S) proxy break its chain
reads (`genesis check failed`). If that is your environment, run the
bundled bridge and point the server at it:

```bash
node scripts/ws-bridge.mjs          # ws://127.0.0.1:8787/ws -> Hideki, via HTTPS_PROXY
WS_RPC_URL=ws://127.0.0.1:8787/ws npm start
```

## X posts

Posts about this build, tagging @DreamDEXSomnia:

<!-- Replace the drafts below with the live post links before submitting. -->

1. *(draft)* "AI agents can talk. Now they can trade. I built an MCP server
   that lets an agent place real perps orders on @DreamDEXSomnia testnet —
   with a hard notional cap it can't argue its way past. Repo + demo below."
2. *(draft)* "The interesting part isn't the agent, it's the guardrails:
   read-only by default, exchange-side pre-flight checks, exact lot/tick
   sizing per market. Agent proposes, code disposes. @DreamDEXSomnia"
3. *(draft)* "Shipped: dreamdex-perps-mcp. Seven tools — markets, account,
   claim paper USDso, place/cancel/close — all settling on-chain on Somnia
   testnet. Built for the dreamDEX Perps Builder Bounty. @DreamDEXSomnia"

## License

MIT
