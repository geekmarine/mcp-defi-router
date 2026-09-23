interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any;
}

const SERVER_CARD = {
  $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
  version: "1.0",
  serverInfo: {
    name: "mcp-defi-router",
    title: "Web3 DeFi Intelligence Router",
    version: "1.0.0",
    description: "Serverless DeFi router for pool liquidity, honeypot screening, and cross-chain execution."
  },
  transport: {
    type: "http",
    url: "https://mcp-defi.datasnag.com/mcp"
  },
  authentication: {
    required: false,
    type: "none"
  },
  tools: [
    {
      name: "dex_liquidity_router",
      description: "Aggregates pool depth, 24h volume, spread, and pricing across DEXs (DexScreener API)."
    },
    {
      name: "contract_security_screener",
      description: "Audits EVM token contracts for blacklists, honeypot traps, and tax anomalies (Honeypot.is API)."
    },
    {
      name: "cross_chain_bridge_optimizer",
      description: "Calculates lowest-slippage bridge routes across EVM and Solana (LI.FI API)."
    }
  ],
  resources: [],
  prompts: []
};

// --- Tool Handlers ---

async function handleDexLiquidity(args: { token_address: string; chain_id?: string }) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${args.token_address}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DexScreener API error: ${resp.status}`);
  const data: any = await resp.json();

  let pairs = data.pairs || [];
  if (args.chain_id) {
    pairs = pairs.filter((p: any) => (p.chainId || "").toLowerCase() === args.chain_id?.toLowerCase());
  }

  if (pairs.length === 0) {
    return { status: "error", message: `No pools found for address ${args.token_address}` };
  }

  pairs.sort((a: any, b: any) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));

  const optimal_pools = pairs.slice(0, 5).map((p: any) => ({
    dex_id: p.dexId,
    chain_id: p.chainId,
    pair_address: p.pairAddress,
    base_symbol: p.baseToken?.symbol,
    quote_symbol: p.quoteToken?.symbol,
    price_usd: p.priceUsd,
    liquidity_usd: p.liquidity?.usd,
    volume_24h_usd: p.volume?.h24,
    price_change_24h_pct: p.priceChange?.h24,
    url: p.url
  }));

  return {
    token_address: args.token_address,
    chain_filter: args.chain_id || "all",
    total_pools_discovered: pairs.length,
    optimal_pools
  };
}

async function handleContractSecurity(args: { token_address: string; chain_id?: number }) {
  const chainId = args.chain_id ?? 1;
  const url = `https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(args.token_address)}&chainID=${chainId}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Honeypot.is API error: ${resp.status}`);
  const data: any = await resp.json();

  return {
    token_address: args.token_address,
    chain_id: chainId,
    token_name: data.token?.name,
    token_symbol: data.token?.symbol,
    is_honeypot: data.honeypotResult?.isHoneypot ?? false,
    honeypot_reason: data.honeypotResult?.honeypotReason,
    buy_tax_pct: data.simulationResult?.buyTax,
    sell_tax_pct: data.simulationResult?.sellTax,
    transfer_tax_pct: data.simulationResult?.transferTax,
    contract_flags: data.flags || []
  };
}

async function handleBridgeOptimizer(args: {
  from_chain: string;
  to_chain: string;
  from_token: string;
  to_token: string;
  from_amount: string;
  from_address: string;
}) {
  const params = new URLSearchParams({
    fromChain: args.from_chain,
    toChain: args.to_chain,
    fromToken: args.from_token,
    toToken: args.to_token,
    fromAmount: args.from_amount,
    fromAddress: args.from_address
  });

  const resp = await fetch(`https://li.quest/v1/quote?${params.toString()}`);
  if (!resp.ok) throw new Error(`LI.FI API error: ${resp.status}`);
  const quote: any = await resp.json();

  return {
    route_id: quote.id,
    bridge_protocol: quote.toolDetails?.name,
    from_chain: args.from_chain,
    to_chain: args.to_chain,
    input_amount: args.from_amount,
    estimated_output_amount: quote.estimate?.toAmount,
    estimated_gas_usd: quote.estimate?.gasCosts?.[0]?.amountUSD,
    estimated_duration_seconds: quote.estimate?.executionDuration
  };
}

// --- Main Worker Dispatcher ---

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, mcp-session-id"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Discovery Cards
    if (url.pathname === "/.well-known/mcp/server-card.json" || url.pathname === "/mcp/.well-known/mcp/server-card.json") {
      return new Response(JSON.stringify(SERVER_CARD), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 2. Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "healthy", runtime: "cloudflare-workers" }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 3. MCP Streamable HTTP Protocol Handshake & Execution (/mcp or /)
    if (url.pathname === "/mcp" || url.pathname === "/") {
      if (request.method === "GET") {
        const accept = request.headers.get("accept") || "";
        if (accept.includes("text/event-stream")) {
          const body = `event: endpoint\ndata: /mcp\n\n`;
          return new Response(body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              ...corsHeaders
            }
          });
        }
        return new Response("MCP Streamable HTTP Endpoint Online", { headers: corsHeaders });
      }

      if (request.method === "POST") {
        try {
          const rpc: JsonRpcRequest = await request.json();

          // Initialize Handshake
          if (rpc.method === "initialize") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: SERVER_CARD.serverInfo
                }
              }),
              { headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          // Tool Discovery
          if (rpc.method === "tools/list") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  tools: [
                    {
                      name: "dex_liquidity_router",
                      description: "Aggregates pool depth, 24h volume, spread, and pricing across DEXs.",
                      inputSchema: {
                        type: "object",
                        properties: {
                          token_address: { type: "string" },
                          chain_id: { type: "string" }
                        },
                        required: ["token_address"]
                      }
                    },
                    {
                      name: "contract_security_screener",
                      description: "Audits EVM token contracts for blacklists, honeypot traps, and tax anomalies.",
                      inputSchema: {
                        type: "object",
                        properties: {
                          token_address: { type: "string" },
                          chain_id: { type: "integer" }
                        },
                        required: ["token_address"]
                      }
                    },
                    {
                      name: "cross_chain_bridge_optimizer",
                      description: "Calculates lowest-slippage bridge routes across EVM and Solana.",
                      inputSchema: {
                        type: "object",
                        properties: {
                          from_chain: { type: "string" },
                          to_chain: { type: "string" },
                          from_token: { type: "string" },
                          to_token: { type: "string" },
                          from_amount: { type: "string" },
                          from_address: { type: "string" }
                        },
                        required: ["from_chain", "to_chain", "from_token", "to_token", "from_amount", "from_address"]
                      }
                    }
                  ]
                }
              }),
              { headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          // Tool Execution
          if (rpc.method === "tools/call") {
            const toolName = rpc.params?.name;
            const toolArgs = rpc.params?.arguments || {};
            let toolOutput: any;

            if (toolName === "dex_liquidity_router") {
              toolOutput = await handleDexLiquidity(toolArgs);
            } else if (toolName === "contract_security_screener") {
              toolOutput = await handleContractSecurity(toolArgs);
            } else if (toolName === "cross_chain_bridge_optimizer") {
              toolOutput = await handleBridgeOptimizer(toolArgs);
            } else {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpc.id,
                  error: { code: -32601, message: `Tool '${toolName}' not found` }
                }),
                { headers: { "Content-Type": "application/json", ...corsHeaders } }
              );
            }

            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(toolOutput) }]
                }
              }),
              { headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32601, message: "Method not found" }
            }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: err.message || "Parse error" }
            }),
            { headers: { "Content-Type": "application/json", ...corsHeaders }, status: 400 }
          );
        }
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
