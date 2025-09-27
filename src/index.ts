import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Authless Calculator",
		version: "1.0.0",
	});

	async init() {
		// Simple addition tool
		this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}));

		// Calculator tool with multiple operations
		this.server.tool(
			"calculate",
			{
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			},
			async ({ operation, a, b }) => {
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "subtract":
						result = a - b;
						break;
					case "multiply":
						result = a * b;
						break;
					case "divide":
						if (b === 0)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot divide by zero",
									},
								],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
// 在现有 import 下面保留 zod 引入
import { z } from "zod";

// ……保留你现有的 MyMCP 类，只改 init() 内容：在现有 add/calculate 之后追加 ——>

async init() {
  // 已有 calculator 工具（保留）
  this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }));

  this.server.tool(
    "calculate",
    { operation: z.enum(["add","subtract","multiply","divide"]), a: z.number(), b: z.number() },
    async ({ operation, a, b }) => {
      let r = 0; if (operation === "add") r=a+b; else if (operation==="subtract") r=a-b;
      else if (operation==="multiply") r=a*b; else if (operation==="divide") {
        if (b===0) return { content:[{type:"text", text:"Error: Cannot divide by zero"}] };
        r=a/b;
      }
      return { content: [{ type: "text", text: String(r) }] };
    }
  );

  // === 下面开始新增 Airtable 工具 ===
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN!;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE!;

  const at = async (path: string, init?: RequestInit) =>
    fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });

  // airtable-list
  this.server.tool(
    "airtable-list",
    { maxRecords: z.number().optional(), view: z.string().optional() },
    async ({ maxRecords = 5, view }) => {
      const qs = new URLSearchParams();
      qs.set("maxRecords", String(maxRecords));
      if (view) qs.set("view", view);
      const r = await at(`${encodeURIComponent(AIRTABLE_TABLE)}?${qs.toString()}`);
      return { content: [{ type: "json", json: await r.json() }] };
    }
  );

  // airtable-get
  this.server.tool(
    "airtable-get",
    { id: z.string() },
    async ({ id }) => {
      const r = await at(`${encodeURIComponent(AIRTABLE_TABLE)}/${id}`);
      return { content: [{ type: "json", json: await r.json() }] };
    }
  );

  // airtable-create
  this.server.tool(
    "airtable-create",
    { fields: z.record(z.any()) },
    async ({ fields }) => {
      const r = await at(`${encodeURIComponent(AIRTABLE_TABLE)}`, {
        method: "POST",
        body: JSON.stringify({ fields }),
      });
      return { content: [{ type: "json", json: await r.json() }] };
    }
  );

  // airtable-update
  this.server.tool(
    "airtable-update",
    { id: z.string(), fields: z.record(z.any()) },
    async ({ id, fields }) => {
      const r = await at(`${encodeURIComponent(AIRTABLE_TABLE)}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ fields }),
      });
      return { content: [{ type: "json", json: await r.json() }] };
    }
  );
}
