#!/usr/bin/env node
/**
 * MCA: print a ready-to-paste MCP config for the agent harness you use,
 * with this checkout's absolute path already filled in.
 *
 *   node scripts/mca.mjs <target>
 *   npm run mca -- <target>
 *
 * Targets: claude | opencode | codex | zcode | cursor | generic
 *
 * The env block ships read-only placeholders. Fill PRIVATE_KEY with a
 * bot key linked to your DreamDEX account (app, Link a bot, Perps) and
 * OWNER_ADDRESS with that account to enable trading-key mode, or drop
 * PRIVATE_KEY entirely for a read-only server.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");

const ENV = {
  PRIVATE_KEY: "0x_your_bot_key",
  TRADING_ENABLED: "true",
  OWNER_ADDRESS: "0x_your_dreamdex_account",
  MAX_ORDER_NOTIONAL_USD: "50",
};

const targets = {
  claude() {
    return [
      "# Claude Code (run in a terminal):",
      `claude mcp add dreamdex-perps --env PRIVATE_KEY=${ENV.PRIVATE_KEY} --env TRADING_ENABLED=true --env OWNER_ADDRESS=${ENV.OWNER_ADDRESS} -- node ${entry}`,
      "",
      "# Claude Desktop / Claude Code project scope: paste into claude_desktop_config.json or .mcp.json",
      JSON.stringify({ mcpServers: { "dreamdex-perps": { command: "node", args: [entry], env: ENV } } }, null, 2),
    ].join("\n");
  },
  cursor() {
    return [
      "# Cursor (and Windsurf, Gemini CLI, Cline, any mcpServers client): paste into the client's MCP config",
      JSON.stringify({ mcpServers: { "dreamdex-perps": { command: "node", args: [entry], env: ENV } } }, null, 2),
    ].join("\n");
  },
  generic() {
    return targets.cursor();
  },
  opencode() {
    return [
      "# OpenCode: paste into opencode.json (project root or ~/.config/opencode/opencode.json)",
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "dreamdex-perps": {
              type: "local",
              command: ["node", entry],
              enabled: true,
              environment: ENV,
            },
          },
        },
        null,
        2,
      ),
    ].join("\n");
  },
  codex() {
    return [
      "# Codex (run in a terminal):",
      `codex mcp add dreamdex-perps --env PRIVATE_KEY=${ENV.PRIVATE_KEY} --env TRADING_ENABLED=true --env OWNER_ADDRESS=${ENV.OWNER_ADDRESS} -- node ${entry}`,
      "",
      "# Or append to ~/.codex/config.toml:",
      "[mcp_servers.dreamdex-perps]",
      'command = "node"',
      `args = ["${entry}"]`,
      "",
      "[mcp_servers.dreamdex-perps.env]",
      ...Object.entries(ENV).map(([k, v]) => `${k} = "${v}"`),
    ].join("\n");
  },
  zcode() {
    return [
      "# ZCode: paste into ~/.zcode/cli/config.json",
      JSON.stringify(
        {
          mcp: {
            servers: {
              "dreamdex-perps": { command: "node", args: [entry], env: ENV },
            },
          },
        },
        null,
        2,
      ),
    ].join("\n");
  },
};

const name = (process.argv[2] ?? "").toLowerCase();
if (!name || !targets[name]) {
  console.error(`Usage: node scripts/mca.mjs <${Object.keys(targets).join(" | ")}>`);
  process.exit(name ? 1 : 0);
}
console.log(targets[name]());
