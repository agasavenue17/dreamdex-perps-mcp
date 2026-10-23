/**
 * Local WebSocket bridge for proxied environments.
 *
 * The markets SDK speaks to the chain over a raw WebSocket and assumes a
 * direct connection. If your network forces traffic through an HTTP(S)
 * proxy (common on corporate/VPS egress), the SDK's socket never connects.
 * This bridge listens on ws://127.0.0.1:8787/ws and forwards each socket
 * through the proxy from HTTPS_PROXY/http_proxy env vars to the real
 * Hideki endpoint.
 *
 * Usage:
 *   node scripts/ws-bridge.mjs
 *   WS_RPC_URL=ws://127.0.0.1:8787/ws npm start
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.WS_BRIDGE_PORT || 8787);
const UPSTREAM =
  process.env.WS_BRIDGE_UPSTREAM ||
  "wss://api.hideki2.infra.testnet.somnia.network/ws";
const PROXY =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

if (!PROXY) {
  console.error(
    "No HTTP(S)_PROXY env var set; the bridge has nothing to forward through.",
  );
  process.exit(1);
}

const agent = new HttpsProxyAgent(PROXY);
const wss = new WebSocketServer({ port: PORT, path: "/ws" });

wss.on("connection", (downstream, req) => {
  const upstream = new WebSocket(UPSTREAM, { agent });
  const pending = [];
  let upstreamOpen = false;

  downstream.on("message", (data, isBinary) => {
    if (upstreamOpen) upstream.send(data, { binary: isBinary });
    else pending.push([data, isBinary]);
  });
  upstream.on("open", () => {
    upstreamOpen = true;
    for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (downstream.readyState === WebSocket.OPEN) {
      downstream.send(data, { binary: isBinary });
    }
  });
  const closeBoth = () => {
    try { downstream.close(); } catch {}
    try { upstream.close(); } catch {}
  };
  downstream.on("close", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", (err) => {
    console.error("upstream error:", err.message);
    closeBoth();
  });
  downstream.on("error", closeBoth);
  console.log("bridge: client connected from", req.socket.remoteAddress);
});

console.log(
  `ws-bridge listening on ws://127.0.0.1:${PORT}/ws -> ${UPSTREAM} via proxy`,
);
