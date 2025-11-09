import { createServer } from "http";
import { randomUUID, createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- config ---------- */
const PORT = process.env.PORT || 8080;
const PANDOC_BASE = process.env.PANDOC_BASE || ""; // e.g. https://mcp-pandoc-production.up.railway.app
const PANDOC_API_KEY = process.env.PANDOC_API_KEY || ""; // optional
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ""; // e.g. https://mcp-pandoc-tools.up.railway.app

if (!PANDOC_BASE) console.warn("WARNING: PANDOC_BASE is not set.");
if (!PUBLIC_BASE_URL) console.warn("WARNING: PUBLIC_BASE_URL is not set; links will fail.");

/* ---------- tiny store ---------- */
const TMP_DIR = "/tmp/exports";
fs.mkdirSync(TMP_DIR, { recursive: true });
const files = new Map(); // id -> {path, mime, t}

/* ---------- helpers ---------- */
function ok(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

function bad(res, code, msg) {
  const body = JSON.stringify({ error: msg });
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

async function readJSON(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try { resolve(JSON.parse(buf || "{}")); } catch (e) { reject(e); }
    });
  });
}

function fileId(ext) {
  const raw = randomUUID() + Date.now();
  const id = createHash("sha1").update(raw).digest("base64url").slice(0, 16);
  return `${id}.${ext}`;
}

async function doExport({ input_format, output_format, content }) {
  if (!["markdown", "html"].includes(input_format)) {
    throw new Error("input_format must be 'markdown' or 'html'");
  }
  if (!["pdf", "docx"].includes(output_format)) {
    throw new Error("output_format must be 'pdf' or 'docx'");
  }
  if (typeof content !== "string" || !content.length) {
    throw new Error("content must be a non-empty string");
  }

  const headers = { "Content-Type": "application/json" };
  if (PANDOC_API_KEY) headers["x-api-key"] = PANDOC_API_KEY;

  const resp = await fetch(`${PANDOC_BASE}/convert`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input_format, output_format, content }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`pandoc error ${resp.status}: ${text}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  const ext = output_format === "docx" ? "docx" : "pdf";
  const fname = fileId(ext);
  const fpath = path.join(TMP_DIR, fname);
  fs.writeFileSync(fpath, buf);

  const mime = output_format === "docx"
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/pdf";

  files.set(fname, { path: fpath, mime, t: Date.now() });
  return `${PUBLIC_BASE_URL}/download/${fname}`;
}

/* ---------- cleanup ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of files.entries()) {
    if (now - v.t > 15 * 60 * 1000) { try { fs.unlinkSync(v.path); } catch {} files.delete(k); }
  }
}, 5 * 60 * 1000);

/* ---------- tool schemas (for Claude) ---------- */
const tools = [
  {
    name: "convert_to_pdf",
    description: "Convert markdown or HTML to PDF and return a download link.",
    inputSchema: {
      type: "object",
      properties: {
        input_format: { type: "string", enum: ["markdown", "html"] },
        content: { type: "string" }
      },
      required: ["input_format", "content"]
    }
  },
  {
    name: "convert_to_docx",
    description: "Convert markdown or HTML to DOCX and return a download link.",
    inputSchema: {
      type: "object",
      properties: {
        input_format: { type: "string", enum: ["markdown", "html"] },
        content: { type: "string" }
      },
      required: ["input_format", "content"]
    }
  }
];

/* ---------- server ---------- */
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    // health
    if (req.method === "GET" && pathname === "/healthz") {
      return ok(res, { ok: true, server: "mcp-pandoc-tools" });
    }

    // SSE for Claude Remote MCP
    if (req.method === "GET" && pathname === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Announce tools immediately
      res.write(`event: tools\n`);
      res.write(`data: ${JSON.stringify({ tools })}\n\n`);
      // Keep alive
      const iv = setInterval(() => res.write(`: ping\n\n`), 25000);
      req.on("close", () => clearInterval(iv));
      return;
    }

    // Claude will POST tool invocations here
    if (req.method === "POST" && pathname === "/invoke") {
      const body = await readJSON(req);
      const name = body?.name;
      const args = body?.arguments || {};
      if (name === "convert_to_pdf") {
        const link = await doExport({ input_format: args.input_format, output_format: "pdf", content: args.content });
        return ok(res, { content: [{ type: "text", text: `PDF ready: ${link}` }] });
      }
      if (name === "convert_to_docx") {
        const link = await doExport({ input_format: args.input_format, output_format: "docx", content: args.content });
        return ok(res, { content: [{ type: "text", text: `DOCX ready: ${link}` }] });
      }
      return bad(res, 404, "unknown tool");
    }

    // Direct HTTP export (optional)
    if (req.method === "POST" && pathname === "/export") {
      const body = await readJSON(req);
      const link = await doExport({
        input_format: body.input_format,
        output_format: body.output_format,
        content: body.content
      });
      return ok(res, { ok: true, link });
    }

    // file download
    if (req.method === "GET" && pathname.startsWith("/download/")) {
      const id = pathname.split("/").pop();
      const rec = files.get(id);
      if (!rec) return bad(res, 404, "not found");
      res.writeHead(200, {
        "Content-Type": rec.mime,
        "Content-Disposition": `attachment; filename="${id}"`
      });
      fs.createReadStream(rec.path).pipe(res);
      return;
    }

    bad(res, 404, "not found");
  } catch (e) {
    bad(res, 500, String(e?.message || e));
  }
});

server.listen(PORT, () => {
  console.log(`mcp-pandoc-tools listening on :${PORT}`);
});
