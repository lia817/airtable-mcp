// src/index.ts — Dynamic Airtable tables + health check + SSE/HTTP endpoints
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------- Airtable helpers ----------
function must(name: string, v?: string) {
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

const getEnv = () => ({
  AIRTABLE_API_KEY: must("AIRTABLE_API_KEY", (globalThis as any).AIRTABLE_API_KEY ?? process.env?.AIRTABLE_API_KEY),
  AIRTABLE_BASE_ID: must("AIRTABLE_BASE_ID", (globalThis as any).AIRTABLE_BASE_ID ?? process.env?.AIRTABLE_BASE_ID),
  DEFAULT_TABLE: (globalThis as any).DEFAULT_TABLE ?? process.env?.DEFAULT_TABLE,
});

const encode = (s: string) => encodeURIComponent(s);

async function airtableFetch(path: string, init?: RequestInit) {
  const { AIRTABLE_API_KEY } = getEnv();
  return fetch(`https://api.airtable.com/v0/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

// ---------- MCP Durable Object ----------
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Airtable MCP",
    version: "1.0.0",
  });

  async init() {
    // Demo tools (保留，方便快速验证)
    this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));

    this.server.tool(
      "calculate",
      { operation: z.enum(["add", "subtract", "multiply", "divide"]), a: z.number(), b: z.number() },
      async ({ operation, a, b }) => {
        if (operation === "divide" && b === 0)
          return { content: [{ type: "text", text: "Error: Cannot divide by zero" }] };
        const map = { add: a + b, subtract: a - b, multiply: a * b, divide: a / b } as const;
        return { content: [{ type: "text", text: String(map[operation]) }] };
      }
    );

    // ===== Airtable: list tables in Base =====
    this.server.tool("airtable-tables", {}, async () => {
      const { AIRTABLE_BASE_ID } = getEnv();
      const r = await airtableFetch(`meta/bases/${AIRTABLE_BASE_ID}/tables`);
      return { content: [{ type: "json", json: await r.json() }] };
    });

    // ===== Airtable: list records =====
    this.server.tool(
      "airtable-list",
      {
        table: z.string().optional(), // 不传则走 DEFAULT_TABLE
        maxRecords: z.number().optional(),
        pageSize: z.number().min(1).max(100).optional(),
        view: z.string().optional(),
        filterByFormula: z.string().optional(),
        fields: z.array(z.string()).optional(),
        sort: z
          .array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() }))
          .optional(),
      },
      async ({ table, maxRecords = 5, pageSize, view, filterByFormula, fields, sort }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required (no DEFAULT_TABLE set)" }] };

        const qs = new URLSearchParams();
        qs.set("maxRecords", String(maxRecords));
        if (pageSize) qs.set("pageSize", String(pageSize));
        if (view) qs.set("view", view);
        if (filterByFormula) qs.set("filterByFormula", filterByFormula);
        if (fields?.length) fields.forEach((f) => qs.append("fields[]", f));
        if (sort?.length)
          sort.forEach((s, i) => {
            qs.append(`sort[${i}][field]`, s.field);
            if (s.direction) qs.append(`sort[${i}][direction]`, s.direction);
          });

        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${encode(tbl)}?${qs.toString()}`);
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    // ===== Airtable: get one record =====
    this.server.tool(
      "airtable-get",
      { table: z.string().optional(), id: z.string() },
      async ({ table, id }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required" }] };
        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${encode(tbl)}/${id}`);
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    // ===== Airtable: create record =====
    this.server.tool(
      "airtable-create",
      { table: z.string().optional(), fields: z.record(z.any()) },
      async ({ table, fields }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required" }] };
        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${encode(tbl)}`, {
          method: "POST",
          body: JSON.stringify({ fields }),
        });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    // ===== Airtable: update record =====
    this.server.tool(
      "airtable-update",
      { table: z.string().optional(), id: z.string(), fields: z.record(z.any()) },
      async ({ table, id, fields }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required" }] };
        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${encode(tbl)}/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ fields }),
        });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );
  }
}

// ---------- Worker entry (routes: /health, /sse, /mcp) ----------
export default {
  fetch(request: Request, env: any, ctx: ExecutionContext) {
    // 把 env 暴露到 global（用于 DO 内读取）
    (globalThis as any).AIRTABLE_API_KEY = env?.AIRTABLE_API_KEY ?? (globalThis as any).AIRTABLE_API_KEY;
    (globalThis as any).AIRTABLE_BASE_ID = env?.AIRTABLE_BASE_ID ?? (globalThis as any).AIRTABLE_BASE_ID;
    (globalThis as any).DEFAULT_TABLE = env?.DEFAULT_TABLE ?? (globalThis as any).DEFAULT_TABLE;

    const url = new URL(request.url);

    // 健康检查：方便浏览器直接验证已注册的工具
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          tools: [
            "add",
            "calculate",
            "airtable-tables",
            "airtable-list",
            "airtable-get",
            "airtable-create",
            "airtable-update",
          ],
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // SSE for MCP
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    // Streamable HTTP for MCP
    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
