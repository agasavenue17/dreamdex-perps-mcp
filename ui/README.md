# Trading Desk UI

A working web interface for dreamdex-perps-mcp: a two-screen trading desk
for the BTC perpetual on the Somnia Hideki testnet. Screen A is the market
desk (live candles, funding, open interest, index, and an open-position
panel with a large ROE readout). Screen B is the agent floor, where the
analyst cast reports, Bull and Bear debate, the Trader posts an order
ticket, the Risk team votes, and the Portfolio Manager decides.

Everything on the page is real data or honestly labeled:

- Market data comes from the project SDK: indexer candles and market row
  (funding per 8h, open interest, index price) plus the on-chain perp
  state for the live mark price.
- Market and Technical analysts compute from that data (RSI and MACD are
  calculated locally from the real candles). News and Sentiment are v1
  thin by design and say so on their cards.
- Bull, Bear, Trader, Risk, and the Portfolio Manager are deterministic
  rule-based agents scoring the same real signals. Position size is
  always inside MAX_ORDER_NOTIONAL_USD and the proposal runs the same
  getMaxPerpOrderSize pre-flight the MCP place_order performs.
- ROE is unrealized PnL divided by margin, times 100, with margin equal
  to notional divided by leverage. It moves with every mark poll.
- Paper mode simulates the fill against the live mark and posts no
  margin. Live mode calls the existing MCP server tools over stdio; if
  the key is missing, TRADING_ENABLED is off, the bot holds no STT, or
  the pre-flight says the account cannot place, the desk shows that
  blocker and sends nothing.

## Run it

```sh
npm install
npm run build        # the UI server reuses dist/ (same build as the MCP server)
npm run ui           # or: node ui/server.mjs
```

Then open http://127.0.0.1:4173 (set UI_PORT to change the port).

Optional demo helper: appending ?autostart=paper to the URL starts a
paper session as soon as the feed connects.

## Environment

The server reads the same .env as the MCP server (project root):

- PRIVATE_KEY, TRADING_ENABLED, MAX_ORDER_NOTIONAL_USD, SLIPPAGE_BPS,
  INDEXER_URL: identical meaning to the MCP server. The UI never prints
  the key and never widens these guards.
- WS_RPC_URL: optional chain WebSocket endpoint. Behind an HTTP(S)
  proxy the raw socket cannot connect, so when WS_RPC_URL is unset and
  a proxy is configured, the UI server starts scripts/ws-bridge.mjs
  locally and points the SDK at ws://127.0.0.1:8787/ws. If a bridge is
  already listening it is reused. Without a working chain socket the
  desk still serves indexer data and labels the mark source as indexer;
  chain reads such as the pre-flight report their error in the open.
- UI_PORT: port for this server (default 4173).
