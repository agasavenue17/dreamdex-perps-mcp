# dreamDEX Perps MCP

**An MCP server that lets AI agents trade dreamDEX perpetuals.**

Connect any MCP-compatible agent (Claude, Cursor, or your own) to dreamDEX
perps on the Somnia **Hideki testnet** and it can read markets, inspect a
portfolio, and place real on-chain orders through plain tool calls. No UI
required, no clicking, no hand-rolled ABIs.

Built for the **dreamDEX Perps Builder Bounty** (MVP track).

## Why

dreamDEX is built for the agentic era: the order book is on-chain, the APIs
are open, and agents are first-class participants. What was missing is a
standard, safe way for an LLM agent to actually *use* the perps book. MCP
(Model Context Protocol) is that standard. This server wraps the official
`@somnia-chain/markets-sdk` (v0.32.1, the version the dreamDEX app runs)
and exposes a small, auditable tool surface with guardrails an agent
cannot talk its way around.

## An autonomous agent, not another trading bot

Conventional trading bots are automation. A programmer decides the
strategy in advance, the code repeats it forever, and nothing in the
system can decide that today is a bad day to trade. Change the behavior
and you rewrite and redeploy code.

This project is built the other way around. The server ships no strategy
at all. It gives an AI agent a set of guarded tools, and the agent
decides: it studies the market, argues both sides of the trade, sizes
the position, and can walk away. In live sessions with this build, the
agent's own risk team and portfolio manager have rejected trades that a
rule-based bot would have taken without a second thought.

Risk routines work the same way. Take-profit and stop-loss watching,
margin guarding, funding plays: none of these are baked in as fixed code
paths. They are standing instructions to the agent, changed in plain
language, and the agent can weigh context a rigid strategy cannot, like
closing early because funding flipped hard against the position before
the stop was ever touched.

| | Conventional strategy bot | This project |
| --- | --- | --- |
| Who decides | The programmer, months earlier, in code | The agent, per session, from live data |
| Refusing a trade | Not a concept that exists | The risk team and PM can and do reject |
| Changing behavior | Edit code, redeploy | Change the instruction |
| Judgment inputs | One strategy's signals | An analyst team: funding and open interest, technicals, news, sentiment |
| Risk routines | Hard-coded per strategy | Standing instructions the agent executes and adapts |
| Interface | CLI, config files, logs | Any MCP client, plus a visual Trading Desk |
| The signing key | Usually holds the funds it trades | Holds nothing in trading-key mode: trades for your account, cannot withdraw |

## What's inside

**The MCP server.** Seven tools (below) over the official markets SDK:
markets, account state, voucher claim, and guarded order placement,
cancellation and closing.

**Trading-key mode.** Link a bot key to your DreamDEX account in the app
(wallet, Link a bot, Perps), set `OWNER_ADDRESS`, and the server trades
*for* the account through the pool's `placeOrderFor` entrypoint, the same
pattern as the official bot kit. Margin locks from the account, fills
settle to the account, and the key pays STT gas only. The key holds no
funds and cannot withdraw, and it works with the 1,000 USDso perps credit
sitting in the account, which can never be transferred to a bot wallet
because it is perps margin, not spot funds.

**The agent team.** A reference crew that runs on top of the tools: a
Market Analyst (funding, open interest), a Technical Analyst (candles,
RSI, MACD), news and sentiment readers, a Bull and a Bear that debate the
trade in the open, a Trader that posts a sized proposal, a Risk Team
with three stances (aggressive, neutral, conservative), and a Portfolio
Manager with the final call.

**The Trading Desk.** A visual front end (`npm run ui`) with a live BTC
chart and TradingView-style drawing tools, the debate streamed as it
happens, an order ticket with margin and projected ROE, and a position
panel whose ROE tracks the live mark tick by tick. Paper mode runs the
full session on live market data with nothing sent on-chain.

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

In trading-key mode (`OWNER_ADDRESS` set), the write tools act on the
linked account instead of the key's own account: `place_order` verifies
the pool's operator grant first, pre-flights against the account's
margin, and sends `placeOrderFor`; `cancel_order` and `close_position`
follow the same path.

## Safety model

An agent with a signing key is a loaded weapon, so the server is built
defensive by default:

- **Read-only unless you say otherwise.** No `PRIVATE_KEY` → no signing at
  all. Key present but `TRADING_ENABLED` unset → write tools still refuse.
- **Hard notional cap.** Every order is rejected if its USD value exceeds
  `MAX_ORDER_NOTIONAL_USD` (default $50). The cap is enforced in code, not
  in a prompt.
- **Exchange-side pre-flight.** Before sending, each order is checked with
  the SDK's `getMaxPerpOrderSize`, the same check the dreamDEX app runs,
  so margin, position caps and voucher allowlists are respected instead of
  discovered via reverts.
- **A key that holds nothing.** In trading-key mode the signing key is a
  linked bot key: it can place, cancel and reduce orders for the account
  and pay gas, and that is all. Funds stay in the account, fills settle
  to the account, and withdrawal is not something the key can do.
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
        "MAX_ORDER_NOTIONAL_USD": "50",
        "OWNER_ADDRESS": "0x…your-dreamdex-account, if the key is a linked bot key…"
      }
    }
  }
}
```

### MCA: plug into the harness you already use

People do not need another app to try this. They need it inside the
agent harness they already open every day. MCA ships a ready config for
each of the popular ones, with the path to this checkout filled in for
you:

```bash
npm run mca -- claude     # Claude Code and Claude Desktop
npm run mca -- opencode   # OpenCode (opencode.json)
npm run mca -- codex      # OpenAI Codex (~/.codex/config.toml)
npm run mca -- zcode      # ZCode (~/.zcode/cli/config.json)
npm run mca -- cursor     # Cursor, Windsurf, Gemini CLI, Cline, generic mcpServers clients
```

Static templates live in [`configs/`](configs/) if you prefer to copy by
hand. Every variant starts the same stdio server; only the config shape
differs, because that is the only thing that differs between harnesses.

### Run with Docker

```bash
docker build -t dreamdex-perps-mcp .
docker run -i --rm \
  -e PRIVATE_KEY=0x… \
  -e TRADING_ENABLED=true \
  -e OWNER_ADDRESS=0x… \
  dreamdex-perps-mcp
```

The server speaks MCP over stdio, so run it with `-i`, or point your MCP
client at the `docker run` command directly. Configuration is environment
variables only; see `.env.example`.

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
atomically on-chain. In trading-key mode the writes go to the pool's
`placeOrderFor` / `cancelOrderFor` entrypoints (the markets SDK has no
`…For` writes, so those calls are sent with viem, mirroring the official
bot kit) after a read of the pool's operator registry confirms the
link. Every placement returns the transaction hash and decoded fills,
so an agent's work is verifiable in the
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

## License

MIT
