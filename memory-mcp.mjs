#!/usr/bin/env node
/**
 * Shared memory MCP for Brain Connector.
 * GPT, Grok, Cursor, and any MCP client plug this in and share one bank
 * on this computer. Key facts stay. Chat overflow is dropped.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const NEVER = new Set(["send", "post", "pay", "publish", "delete"]);
const KEY_MAX = 40;
const NOTE_MAX = 16;
const TOPIC_MAX = 12;
const TRAIL_MAX = 20;

export function homeDir() {
  if (process.env.BRAIN_HOME) return process.env.BRAIN_HOME;
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "BrainConnector");
  return path.join(os.homedir(), "AppData", "Local", "BrainConnector");
}

function memoryFile() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "memory.json");
}

function emptyMemory() {
  return { facts: [], topics: [], trail: [] };
}

export function loadMemory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryFile(), "utf8"));
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      trail: Array.isArray(parsed.trail) ? parsed.trail : [],
    };
  } catch {
    return emptyMemory();
  }
}

export function compact(mem) {
  const facts = mem.facts || [];
  const key = facts.filter((f) => f.keep).slice(-KEY_MAX);
  const notes = facts.filter((f) => !f.keep).slice(-NOTE_MAX);
  return {
    facts: [...key, ...notes],
    topics: (mem.topics || []).slice(-TOPIC_MAX),
    trail: (mem.trail || []).slice(-TRAIL_MAX),
  };
}

export function saveMemory(mem) {
  const next = compact(mem);
  fs.writeFileSync(memoryFile(), JSON.stringify(next, null, 2));
  return next;
}

function pushTrail(mem, event, detail) {
  mem.trail = [...(mem.trail || []), {
    at: new Date().toISOString(),
    event: String(event || "note").slice(0, 40),
    detail: String(detail || "").slice(0, 240),
  }];
}

export function rememberFact(fact, opts = {}) {
  const text = String(fact || "").trim().slice(0, 400);
  if (!text) return { ok: false, text: "Nothing to remember." };
  const keep = opts.keep !== false;
  const source = opts.source === "ai" ? "ai" : "user";
  const mem = loadMemory();
  mem.facts.push({ fact: text, at: new Date().toISOString(), keep, source });
  pushTrail(mem, keep ? "remember" : "note", text.slice(0, 120));
  saveMemory(mem);
  return {
    ok: true,
    text: keep ? "Kept as key memory. GPT and Grok both see this." : "Noted. This can drop when the chat overloads.",
    fact: text,
    keep,
  };
}

export function recallFacts(query) {
  const facts = loadMemory().facts.map((m) => m.fact).filter(Boolean);
  const words = String(query || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  if (!words.length) return facts.filter(Boolean).slice(-8);
  return facts
    .map((fact) => {
      const lower = fact.toLowerCase();
      let score = 0;
      for (const w of words) if (lower.includes(w)) score += 1;
      return { fact, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((r) => r.fact);
}

export function addTrail(event, detail) {
  const mem = loadMemory();
  pushTrail(mem, event, detail);
  saveMemory(mem);
}

export function addTopic(title, detail) {
  const name = String(title || "").trim().slice(0, 80);
  if (!name) return { ok: false, text: "Name the topic." };
  const mem = loadMemory();
  mem.topics.push({
    title: name,
    detail: String(detail || "").trim().slice(0, 240),
    at: new Date().toISOString(),
  });
  pushTrail(mem, "topic", name);
  saveMemory(mem);
  return { ok: true, text: `Topic: ${name}` };
}

export function listTopics() {
  return loadMemory().topics.slice(-TOPIC_MAX);
}

export function resetOverflow() {
  const mem = loadMemory();
  const kept = (mem.facts || []).filter((f) => f.keep);
  const dropped = (mem.facts || []).length - kept.length;
  mem.facts = kept;
  mem.trail = [{
    at: new Date().toISOString(),
    event: "reset",
    detail: `Dropped ${dropped} overflow notes. Kept ${kept.length} key facts.`,
  }];
  saveMemory(mem);
  return {
    ok: true,
    text: `Reset. Kept ${kept.length} key facts. Dropped ${dropped} overflow notes. Topics stay.`,
    dropped,
    kept: kept.length,
  };
}

export function blockedAction(name) {
  return NEVER.has(String(name || "").toLowerCase());
}

function formatFacts(list) {
  if (!list.length) return "Nothing remembered about that yet.";
  return list.map((f) => `- ${f}`).join("\n");
}

const TOOLS = [
  {
    name: "brain_remember",
    description: "Store a KEY fact the user told you to keep. Shared by GPT, Grok, and every MCP client on this computer. Survives chat overload.",
    inputSchema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
  },
  {
    name: "brain_note",
    description: "Store a short working note the AI judged useful. Shared across AIs. Dropped on overload reset.",
    inputSchema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
  },
  {
    name: "brain_recall",
    description: "Search the shared memory bank by keyword. Local read. Never spends a paid call.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "brain_topic",
    description: "Record the current build topic so the next AI continues the same work.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, detail: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "brain_trail",
    description: "Show recent connects, builds, remembers, and topics.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_reset",
    description: "Chat overload reset. Drops overflow notes. Keeps key facts the user asked to remember, and recent topics.",
    inputSchema: { type: "object", properties: {} },
  },
];

function callTool(name, args) {
  if (name === "brain_remember") {
    const out = rememberFact(args?.fact, { keep: true, source: "user" });
    return { isError: !out.ok, text: out.text };
  }
  if (name === "brain_note") {
    const out = rememberFact(args?.fact, { keep: false, source: "ai" });
    return { isError: !out.ok, text: out.text };
  }
  if (name === "brain_recall") {
    return { isError: false, text: formatFacts(recallFacts(args?.query)) };
  }
  if (name === "brain_topic") {
    const out = addTopic(args?.title, args?.detail);
    return { isError: !out.ok, text: out.text };
  }
  if (name === "brain_trail") {
    const mem = loadMemory();
    const topics = (mem.topics || []).slice(-6).map((t) => `topic  ${t.title}`).join("\n");
    const trail = (mem.trail || []).slice(-12).map((t) => `${t.at}  ${t.event}  ${t.detail || ""}`).join("\n");
    const body = [topics, trail].filter(Boolean).join("\n") || "No trail yet.";
    return { isError: false, text: body };
  }
  if (name === "brain_reset") {
    return { isError: false, text: resetOverflow().text };
  }
  return { isError: true, text: `Unknown tool ${name}` };
}

function rpc(msg) {
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
        serverInfo: { name: "brain-memory", version: "1.2.0" },
      },
    };
  }
  if (msg.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (msg.method === "tools/call") {
    const out = callTool(msg.params?.name, msg.params?.arguments || {});
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
        send(rpc(JSON.parse(raw)));
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
  });
}
