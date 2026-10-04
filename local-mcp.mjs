#!/usr/bin/env node
/**
 * Per-connector stdio MCP. Answers from attached notes + memory.
 * The model key never lives here.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { addTrail, blockedAction, homeDir, rememberFact } from "./memory-mcp.mjs";

const STOP = new Set([
  "what", "this", "that", "with", "from", "your", "have", "does", "when", "where",
  "which", "about", "into", "they", "them", "then", "than", "just", "only", "also",
  "some", "been", "were", "will", "would", "could", "should", "there", "their", "here",
]);

function loadConnector(recordPath) {
  return JSON.parse(fs.readFileSync(recordPath, "utf8"));
}

function saveConnector(recordPath, rec) {
  fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));
}

function tools(connector) {
  const ask = {
    name: "brain_ask",
    description: "Answer only from the material attached to this connector. Say when the notes do not contain the answer.",
    inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  };
  const memory = [
    {
      name: "brain_remember",
      description: "Store one short fact on this connector and the shared brain memory.",
      inputSchema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
    },
    {
      name: "brain_recall",
      description: "Search remembered facts by keyword. A local read; never spends a call.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
  ];
  if (connector.kind === "assistant" || connector.kind === "automation") {
    return [
      ask,
      {
        name: "brain_act",
        description: "Record one allowed action. Never send, post, or pay.",
        inputSchema: { type: "object", properties: { said: { type: "string" } }, required: ["said"] },
      },
      ...memory,
    ];
  }
  return [
    ask,
    {
      name: "brain_page",
      description: "Answer about one named part of the attached notes.",
      inputSchema: {
        type: "object",
        properties: { question: { type: "string" }, where: { type: "string" } },
        required: ["question"],
      },
    },
    {
      name: "brain_guide",
      description: "Say what to do next using only the attached notes.",
      inputSchema: { type: "object", properties: { where: { type: "string" }, question: { type: "string" } } },
    },
    ...memory,
  ];
}

function pieces(source) {
  return String(source || "")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

function searchFacts(list, query) {
  const facts = (list || []).map((m) => (typeof m === "string" ? m : m.fact)).filter(Boolean);
  const qWords = String(query || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  if (!qWords.length) return facts.slice(-5);
  return facts
    .map((fact) => {
      const lower = fact.toLowerCase();
      let score = 0;
      for (const w of qWords) if (lower.includes(w)) score += 1;
      return { fact, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((r) => r.fact);
}

function answerFrom(connector, question, where) {
  const source = String(connector.source || "");
  const bits = pieces(source);
  const place = String(where || "").trim().toLowerCase();
  if (!source.trim()) return "No notes were attached to this connector.";
  if (place && !source.toLowerCase().includes(place)) {
    return "That part is not in the notes attached to this connector.";
  }
  const pool = place ? bits.filter((s) => s.toLowerCase().includes(place)) : bits;
  const remembered = (connector.memory || []).map((m) => m.fact).filter(Boolean);
  const hay = pool.concat(remembered.map((f) => `Remembered: ${f}`));
  const qWords = words(question);
  if (!qWords.length) {
    return hay.slice(0, 2).join(" ") || "I only know the notes that were attached to this connector.";
  }
  const ranked = hay
    .map((s) => ({ s, n: qWords.filter((w) => s.toLowerCase().includes(w)).length }))
    .filter((row) => row.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!ranked.length) return "That is not in the notes attached to this connector.";
  return ranked[0].s;
}

function act(connector, said) {
  const text = String(said || "").toLowerCase();
  const blocked = ["send", "post", "pay", "publish", "delete"].find((name) => text.includes(name));
  if (blocked) {
    return { action: null, args: {}, say: "I do not send, post, or pay. That stays with you." };
  }
  const allowed = connector.actions || [];
  const action = allowed.find((name) => text.includes(name.replace(/_/g, " ")) || text.includes(name));
  if (!action || blockedAction(action)) {
    return { action: null, args: {}, say: "That action is not on the list." };
  }
  return { action, args: { said: String(said || "") }, say: `Noted ${action}. Nothing was sent, posted, or paid.` };
}

function spend(recordPath, connector) {
  const left = Number(connector.calls);
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return `No calls left on the ${connector.tier || "hobby"} tier.`;
  connector.calls = left - 1;
  connector.used = Number(connector.used || 0) + 1;
  try {
    saveConnector(recordPath, connector);
  } catch {
    /* still answer */
  }
  return null;
}

function callTool(recordPath, connector, name, args) {
  if (name === "brain_remember") {
    const fact = String(args?.fact || "").trim().slice(0, 400);
    if (!fact) return { isError: true, text: "Nothing to remember." };
    const empty = spend(recordPath, connector);
    if (empty) return { isError: true, text: empty };
    connector.memory = [...(connector.memory || []), { fact, at: new Date().toISOString() }].slice(-40);
    saveConnector(recordPath, connector);
    rememberFact(fact);
    return { isError: false, text: "Remembered." };
  }
  if (name === "brain_recall") {
    const local = searchFacts(connector.memory, args?.query);
    if (!local.length) return { isError: false, text: "Nothing remembered about that yet." };
    return { isError: false, text: local.map((f) => `- ${f}`).join("\n") };
  }
  const empty = spend(recordPath, connector);
  if (empty) return { isError: true, text: empty };
  if (name === "brain_act") {
    const result = act(connector, args?.said);
    addTrail("act", result.say);
    return { isError: false, text: JSON.stringify(result) };
  }
  if (name === "brain_ask" || name === "brain_page" || name === "brain_guide") {
    const text = answerFrom(connector, args?.question || "", args?.where || "");
    connector.trail = [
      ...(connector.trail || []),
      {
        at: new Date().toISOString(),
        tool: name,
        q: String(args?.question || "").slice(0, 200),
        a: text.slice(0, 300),
      },
    ].slice(-20);
    saveConnector(recordPath, connector);
    addTrail("ask", String(args?.question || "").slice(0, 120));
    return { isError: false, text };
  }
  return { isError: true, text: "Unknown tool" };
}

function rpc(recordPath, connector, msg) {
  const id = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : null;
  if (msg.method === "notifications/initialized" || msg.method === "initialized") return null;
  if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "brain-connector", version: "1.1.0" },
      },
    };
  }
  if (msg.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: tools(connector) } };
  if (msg.method === "tools/call") {
    const live = loadConnector(recordPath);
    const out = callTool(recordPath, live, msg.params?.name, msg.params?.arguments || {});
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: out.text }], isError: out.isError },
    };
  }
  if (id === null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

function send(obj) {
  if (!obj) return;
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

const runningThis = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
if (runningThis) {
  const recordPath = process.argv[2];
  if (!recordPath) {
    process.stderr.write("Brain Connector: pass a connector.json path.\n");
    process.exit(1);
  }
  homeDir();
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const match = buf.slice(0, headerEnd).toString("utf8").match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const len = Number(match[1]);
      if (buf.length < start + len) return;
      const raw = buf.slice(start, start + len).toString("utf8");
      buf = buf.slice(start + len);
      try {
        const connector = loadConnector(recordPath);
        send(rpc(recordPath, connector, JSON.parse(raw)));
      } catch (e) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message || "Parse error" } });
      }
    }
  });
}

export { answerFrom, act, tools as toolsFor };
