#!/usr/bin/env node
/**
 * Pasteable MCP URL for Brain Connector.
 * http://127.0.0.1:8794/mcp is the shared brain.
 * http://127.0.0.1:8794/c/<id>/mcp is one built connector.
 */
import fs from "fs";
import http from "http";
import path from "path";
import { homeDir, publicToken, rpc as memoryRpc } from "./memory-mcp.mjs";
import { rpc as connectorRpc } from "./local-mcp.mjs";

const port = Number(process.env.BRAIN_URL_PORT || 8794);
const host = "127.0.0.1";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const raw = body == null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(raw);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }
  const url = new URL(req.url || "/", `http://${host}`);
  const token = publicToken();
  const gated = url.pathname.match(new RegExp(`^/p/${token}(?:/c/([^/]+))?/mcp/?$`));
  if (!gated) {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/mcp")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Brain Connector\n");
      return;
    }
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Brain Connector MCP\n");
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  let msg;
  try {
    msg = JSON.parse((await readBody(req)) || "{}");
  } catch {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!gated[1]) {
    const out = memoryRpc(msg);
    if (!out) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 200, out);
    return;
  }
  const recordPath = path.join(homeDir(), "connectors", gated[1], "connector.json");
  if (!fs.existsSync(recordPath)) {
    sendJson(res, 404, { error: "Unknown connector." });
    return;
  }
  try {
    const connector = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const out = connectorRpc(recordPath, connector, msg);
    if (!out) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 200, out);
  } catch (e) {
    sendJson(res, 500, { error: e.message || "Connector failed." });
  }
});

server.listen(port, host, () => {
  const line = `http://${host}:${port}/p/${publicToken()}/mcp`;
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(path.join(homeDir(), "url.txt"), line + "\n");
  } catch {
    /* the URL still works */
  }
  process.stdout.write(line + "\n");
});
