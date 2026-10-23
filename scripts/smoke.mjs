import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env },
});
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const markets = await client.callTool({ name: "list_markets", arguments: {} });
const text = markets.content[0].text;
console.log("LIST_MARKETS isError:", !!markets.isError);
console.log(text.slice(0, 600));

const btc = await client.callTool({ name: "get_market", arguments: { symbol: "BTC" } });
console.log("GET_MARKET BTC isError:", !!btc.isError);
console.log(btc.content[0].text.slice(0, 400));

const guarded = await client.callTool({
  name: "place_order",
  arguments: { symbol: "BTC", side: "long", type: "limit", quantity: "0.001", price: "50000" },
});
console.log("PLACE_ORDER (read-only server) isError:", !!guarded.isError);
console.log(guarded.content[0].text.slice(0, 200));

await client.close();
process.exit(0);
