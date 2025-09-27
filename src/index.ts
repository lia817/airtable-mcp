// src/index.ts — Airtable MCP (all-in-one)
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/* =============================
   Env helpers
============================= */

function must(name: string, v?: string) {
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

type ResolvedEnv = {
  AIRTABLE_API_KEY: string;
  AIRTABLE_BASE_ID: string;
  DEFAULT_TABLE?: string;
  ALLOWED_TABLES?: Record<string, string>; // name -> tableId (optional whitelist & cache seed)
};

const getEnv = (): ResolvedEnv => {
  const g: any = globalThis as any;
  const ALLOWED_TABLES_RAW =
    g.ALLOWED_TABLES ?? process.env?.ALLOWED_TABLES;

  let ALLOWED_TABLES: Record<string, string> | undefined;
  if (ALLOWED_TABLES_RAW) {
    try { ALLOWED_TABLES = JSON.parse(ALLOWED_TABLES_RAW); } catch { /* ignore */ }
  }

  return {
    AIRTABLE_API_KEY: must("AIRTABLE_API_KEY", g.AIRTABLE_API_KEY ?? process.env?.AIRTABLE_API_KEY),
    AIRTABLE_BASE_ID: must("AIRTABLE_BASE_ID", g.AIRTABLE_BASE_ID ?? process.env?.AIRTABLE_BASE_ID),
    DEFAULT_TABLE: g.DEFAULT_TABLE ?? process.env?.DEFAULT_TABLE,
    ALLOWED_TABLES,
  };
};

const enc = encodeURIComponent;

/* =============================
   HTTP helpers
============================= */

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

/* =============================
   Table name -> tableId resolver with cache
============================= */

type TableCache = { ts: number; byName: Record<string, string> };
let tableCache: TableCache | null = null;

async function refreshTableCache(): Promise<TableCache> {
  const { AIRTABLE_BASE_ID, ALLOWED_TABLES } = getEnv();

  // Seed from ALLOWED_TABLES if provided (no network on first use)
  let map: Record<string, string> = ALLOWED_TABLES ? { ...ALLOWED_TABLES } : {};

  // Always fetch once to stay accurate
  const r = await airtableFetch(`meta/bases/${AIRTABLE_BASE_ID}/tables`);
  const data = await r.json();
  if (Array.isArray(data?.tables)) {
    for (const t of data.tables) {
      if (t?.name && t?.id) map[t.name] = t.id;
    }
  }
  tableCache = { ts: Date.now(), byName: map };
  return tableCache;
}

async function resolveTableId(tableOrId: string): Promise<string> {
  // Looks like an Airtable tableId (tblXXXXXXXX...)
  if (/^tbl[a-zA-Z0-9]{10,}$/.test(tableOrId)) return tableOrId;

  const now = Date.now();
  if (!tableCache || now - tableCache.ts > 5 * 60_000) {
    await refreshTableCache();
  }
  const id = tableCache!.byName[tableOrId];
  if (!id) {
    // one more refresh in case of recent schema change
    await refreshTableCache();
    const id2 = tableCache!.byName[tableOrId];
    if (!id2) throw new Error(`Table not found by name: ${tableOrId}`);
    return id2;
  }
  return id;
}

/* =============================
   MCP Durable Object
============================= */

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Airtable MCP",
    version: "1.0.0",
  });

  async init() {
    /* ----- Demo tools (keep) ----- */
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

    /* ----- Schema: list tables (Meta) ----- */
    this.server.tool("airtable-tables", {}, async () => {
      const { AIRTABLE_BASE_ID } = getEnv();
      const r = await airtableFetch(`meta/bases/${AIRTABLE_BASE_ID}/tables`);
      return { content: [{ type: "json", json: await r.json() }] };
    });

    /* ----- Records: list with offset paging ----- */
    this.server.tool(
      "airtable-list",
      {
        table: z.string().optional(), // name or tableId; default = DEFAULT_TABLE
        maxRecords: z.number().optional(),
        pageSize: z.number().min(1).max(100).optional(),
        view: z.string().optional(),
        filterByFormula: z.string().optional(),
        fields: z.array(z.string()).optional(),
        sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(),
        offset: z.string().optional(),
      },
      async ({ table, maxRecords = 5, pageSize, view, filterByFormula, fields, sort, offset }) => {
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
        if (offset) qs.set("offset", offset);

        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${enc(tbl)}?${qs.toString()}`);
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    /* ----- Records: get one ----- */
    this.server.tool(
      "airtable-get",
      { table: z.string().optional(), id: z.string() },
      async ({ table, id }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required" }] };
        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${enc(tbl)}/${id}`);
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    /* ----- Records: create ----- */
    this.server.tool(
      "airtable-create",
      { table: z.string().optional(), fields: z.record(z.any()) },
      async ({ table, fields }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required" }] };
        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${enc(tbl)}`, {
          method: "POST",
          body: JSON.stringify({ fields }),
        });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    /* ----- Records: update ----- */
    this.server.tool(
      "airtable-update",
      { table: z.string().optional(), id: z.string(), fields: z.record(z.any()) },
      async ({ table, id, fields }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required" }] };
        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${enc(tbl)}/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ fields }),
        });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    /* ----- Records: delete (single or batch up to 10) ----- */
    this.server.tool(
      "airtable-delete",
      { table: z.string().optional(), ids: z.array(z.string()).min(1) },
      async ({ table, ids }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required" }] };
        const qs = new URLSearchParams();
        ids.forEach((id) => qs.append("records[]", id));
        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${enc(tbl)}?${qs.toString()}`, { method: "DELETE" });
        return { content: [{ type: "json", json: (r.status === 200 ? await r.json() : { status: r.status }) }] };
      }
    );

    /* ----- Records: batch create/update ----- */
    this.server.tool(
      "airtable-batch",
      {
        table: z.string().optional(),
        op: z.enum(["create", "update"]),
        // create: [{fields: {...}}, ...]
        // update: [{id: "...", fields: {...}}, ...]
        records: z.array(z.record(z.any())).min(1),
        typecast: z.boolean().optional(),
      },
      async ({ table, op, records, typecast }) => {
        const { AIRTABLE_BASE_ID, DEFAULT_TABLE } = getEnv();
        const tbl = table ?? DEFAULT_TABLE;
        if (!tbl) return { content: [{ type: "text", text: "Error: table is required" }] };
        const method = op === "create" ? "POST" : "PATCH";
        const body = JSON.stringify({ records, ...(typecast !== undefined ? { typecast } : {}) });
        const r = await airtableFetch(`${AIRTABLE_BASE_ID}/${enc(tbl)}`, { method, body });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    /* ----- Comments: list (table name or id) ----- */
    this.server.tool(
      "airtable-comments-list",
      { table: z.string(), recordId: z.string() },
      async ({ table, recordId }) => {
        const { AIRTABLE_BASE_ID } = getEnv();
        const tableId = await resolveTableId(table);
        const path = `bases/${AIRTABLE_BASE_ID}/tables/${tableId}/records/${recordId}/comments`;
        const r = await airtableFetch(path);
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    /* ----- Comments: add ----- */
    this.server.tool(
      "airtable-comments-add",
      { table: z.string(), recordId: z.string(), text: z.string().min(1) },
      async ({ table, recordId, text }) => {
        const { AIRTABLE_BASE_ID } = getEnv();
        const tableId = await resolveTableId(table);
        const path = `bases/${AIRTABLE_BASE_ID}/tables/${tableId}/records/${recordId}/comments`;
        const r = await airtableFetch(path, { method: "POST", body: JSON.stringify({ text }) });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    /* ----- Webhooks: create/list/delete (Base-level) ----- */
    this.server.tool(
      "airtable-webhook-create",
      { notifyUrl: z.string().url(), specification: z.record(z.any()).default({}) },
      async ({ notifyUrl, specification }) => {
        const { AIRTABLE_BASE_ID } = getEnv();
        const r = await airtableFetch(`bases/${AIRTABLE_BASE_ID}/webhooks`, {
          method: "POST",
          body: JSON.stringify({ notificationUrl: notifyUrl, specification }),
        });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    this.server.tool("airtable-webhook-list", {}, async () => {
      const { AIRTABLE_BASE_ID } = getEnv();
      const r = await airtableFetch(`bases/${AIRTABLE_BASE_ID}/webhooks`);
      return { content: [{ type: "json", json: await r.json() }] };
    });

    this.server.tool(
      "airtable-webhook-delete",
      { webhookId: z.string() },
      async ({ webhookId }) => {
        const { AIRTABLE_BASE_ID } = getEnv();
        const r = await airtableFetch(`bases/${AIRTABLE_BASE_ID}/webhooks/${webhookId}`, { method: "DELETE" });
        return {
          content: [{ type: "json", json: (r.status === 204 ? { ok: true } : { status: r.status }) }],
        };
      }
    );

    /* ----- Schema writes (Meta API) ----- */
    this.server.tool(
      "schema-add-field",
      {
        table: z.string(), // name or tableId
        name: z.string(),
        type: z.string(), // e.g., "singleLineText" | "number" | "checkbox" | ...
        options: z.record(z.any()).optional(),
      },
      async ({ table, name, type, options }) => {
        const { AIRTABLE_BASE_ID } = getEnv();
        const tableId = await resolveTableId(table);
        const r = await airtableFetch(`meta/bases/${AIRTABLE_BASE_ID}/tables/${tableId}/fields`, {
          method: "POST",
          body: JSON.stringify({ name, type, options }),
        });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );

    this.server.tool(
      "schema-create-table",
      {
        name: z.string(),
        description: z.string().optional(),
        fields: z
          .array(z.object({ name: z.string(), type: z.string(), options: z.record(z.any()).optional() }))
          .min(1),
        primaryFieldId: z.string().optional(),
      },
      async ({ name, description, fields, primaryFieldId }) => {
        const { AIRTABLE_BASE_ID } = getEnv();
        const body: any = { name, fields, description, primaryFieldId };
        const r = await airtableFetch(`meta/bases/${AIRTABLE_BASE_ID}/tables`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return { content: [{ type: "json", json: await r.json() }] };
      }
    );
  }
}

/* =============================
   Worker entry (routes)
============================= */

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext) {
    // expose env to global for DO context
    (globalThis as any).AIRTABLE_API_KEY = env?.AIRTABLE_API_KEY ?? (globalThis as any).AIRTABLE_API_KEY;
    (globalThis as any).AIRTABLE_BASE_ID = env?.AIRTABLE_BASE_ID ?? (globalThis as any).AIRTABLE_BASE_ID;
    (globalThis as any).DEFAULT_TABLE = env?.DEFAULT_TABLE ?? (globalThis as any).DEFAULT_TABLE;
    (globalThis as any).ALLOWED_TABLES = env?.ALLOWED_TABLES ?? (globalThis as any).ALLOWED_TABLES;

    const url = new URL(request.url);

    // health check for quick validation
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
            "airtable-delete",
            "airtable-batch",
            "airtable-comments-list",
            "airtable-comments-add",
            "airtable-webhook-create",
            "airtable-webhook-list",
            "airtable-webhook-delete",
            "schema-add-field",
            "schema-create-table",
          ],
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
