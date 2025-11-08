import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { sseMiddleware } from "@modelcontextprotocol/sdk/server/sse.js";

// ----------- CONFIG VIA ENV -------------
const PORT = process.env.PORT || 8080;

// Your already-deployed Pandoc service:
const PANDOC_BASE = process.env.PANDOC_BASE || "https://mcp-pandoc-production.up.railway.app";
// If you set an API_KEY on that service, put it here (Railway Variable):
const PANDOC_API_KEY = process.env.PANDOC_API_KEY || "";

// Base URL for this MCP server (after you get a Railway domain, set PUBLIC_BASE_URL to it):
let PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

// ----------- EXPRESS APP + STORAGE -------------
const app = express();
app.use(express.json({ limit: "10mb" }));

const TMP_DIR = "/tmp/exports";
fs.mkdirSync(TMP_DIR, { recursive: true });

/** id -> { filepath, mime, t } */
const files = new Map();

// Simple TTL cleanup (15 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of files.entries()) {
    if (now - rec.t > 15 * 60 * 1000) {
      try { fs.unlinkSync(rec.filepath); } catch {}
      files.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ---------- CORE EXPORT FUNCTION ----------
async function doExport({ input_format, output_format, content }) {
  if (!["markdown", "html"].includes(input_format)) throw new Error("input_format must be markdown or html");
  if (!["docx", "pdf"].includes(output_format)) throw new Error("output_format must be docx or pdf");
  if (typeof content !== "string") throw new Error("content must be a string");

  const headers = { "Content-Type": "application/json" };
  if (PANDOC_API_KEY) headers["x-api-key"] = PANDOC_API_KEY;

  const resp = await axios.post(
    `${PANDOC_BASE}/convert`,
    { input_format, output_format, content },
    { responseType: "arraybuffer", headers }
  );

  if (resp.status !== 200) {
    throw new Error(`pandoc convert failed: HTTP ${resp.status}`);
  }

  const id = nanoid(12);
  const ext = output_format === "docx" ? "docx" : "pdf";
  const filepath = path.join(TMP_DIR, `${id}.${ext}`);
  fs.writeFileSync(filepath, Buffer.from(resp.data));

  const mime = output_format === "docx"
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/pdf";

  files.set(id, { filepath, mime, t: Date.now() });

  if (!PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is not set on the MCP server");
  const link = `${PUBLIC_BASE_URL}/download/${id}`;
  return { link };
}

// ---------- HTTP endpoints ----------

// For quick sanity tests without MCP
app.get("/healthz", async (req, res) => {
  try {
    const r = await axios.get(`${PANDOC_BASE}/healthz`);
    return res.json({ ok: true, pandoc: r.data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Public download endpoint (one-time-ish; TTL 15 min)
app.get("/download/:id", (req, res) => {
  const rec = files.get(req.params.id);
  if (!rec) return res.status(404).send("Not found");
  const { filepath, mime } = rec;
  const filename = path.basename(filepath);
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  fs.createReadStream(filepath).pipe(res);
});

// Optional: allow HTTP export for manual testing
app.post("/export", async (req, res) => {
  try {
    const { input_format, output_format, content } = req.body || {};
    const { link } = await doExport({ input_format, output_format, content });
    res.json({ ok: true, link });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// ----------- MCP SERVER (REMOTE) -------------
const mcp = new Server({
  name: "mcp-pandoc-tools",
  version: "1.0.0"
});

// Tool: convert_to_pdf
mcp.tool(
  {
    name: "convert_to_pdf",
    description: "Convert markdown or HTML to PDF and return a download link",
    inputSchema: {
      type: "object",
      properties: {
        input_format: { type: "string", enum: ["markdown", "html"] },
        content: { type: "string" }
      },
      required: ["input_format", "content"]
    }
  },
  async (args) => {
    const { input_format, content } = args;
    const { link } = await doExport({ input_format, output_format: "pdf", content });
    return { content: [{ type: "text", text: `PDF ready: ${link}` }] };
  }
);

// Tool: convert_to_docx
mcp.tool(
  {
    name: "convert_to_docx",
    description: "Convert markdown or HTML to DOCX and return a download link",
    inputSchema: {
      type: "object",
      properties: {
        input_format: { type: "string", enum: ["markdown", "html"] },
        content: { type: "string" }
      },
      required: ["input_format", "content"]
    }
  },
  async (args) => {
    const { input_format, content } = args;
    const { link } = await doExport({ input_format, output_format: "docx", content });
    return { content: [{ type: "text", text: `DOCX ready: ${link}` }] };
  }
);

// Mount the SSE endpoint for Claude
app.use("/sse", sseMiddleware(mcp));

app.listen(PORT, () => {
  console.log(`MCP tools listening on :${PORT}`);
  console.log(`SSE endpoint at /sse`);
});
