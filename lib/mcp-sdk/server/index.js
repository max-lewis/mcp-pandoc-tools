import EventEmitter from "events";

/**
 * Minimal standalone subset of @modelcontextprotocol/sdk/server.
 * Implements basic SSE middleware and tool registration.
 */
export class Server {
  constructor(meta) {
    this.name = meta.name;
    this.version = meta.version;
    this.tools = new Map();
  }

  tool(schema, handler) {
    const tool = typeof schema === "object" ? schema : { name: schema };
    this.tools.set(tool.name, { schema: tool, handler });
  }

  async handleInvoke(req, res) {
    const { name, arguments: args } = req.body;
    const tool = this.tools.get(name);
    if (!tool) return res.status(404).json({ error: "tool not found" });

    try {
      const result = await tool.handler(args);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  }
}

/**
 * Simple SSE middleware that keeps the connection open.
 * Claude connects to this endpoint to list available tools.
 */
export function sseMiddleware(server) {
  const emitter = new EventEmitter();

  return (req, res, next) => {
    if (req.path !== "/sse") return next();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`event: ready\ndata: {"ok": true, "server":"${server.name}"}\n\n`);
    emitter.on("message", (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
  };
}

