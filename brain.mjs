#!/usr/bin/env node
/**
 * Brain Connector local terminal.
 * Install asks which AI. Say grok, gpt, or claude. The brain writes its MCP there.
 * Advertised kinds: website, assistant, automation. No extra editor plugs.
 */
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { addTrail, addTopic, homeDir, listTopics, loadMemory, publicToken, recallFacts, rememberFact, resetOverflow } from "./memory-mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = homeDir();
fs.mkdirSync(home, { recursive: true });
const stateFile = path.join(home, "plug.json");

const KINDS = new Set(["website", "assistant", "automation"]);
const TIERS = { hobby: 1000, learner: 3000, brilliant: 10000 };
const ACTION_KINDS = new Set(["assistant", "automation"]);
const BLOCKED = new Set(["send", "post", "pay", "publish", "delete"]);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    let shop = process.env.BRAIN_SHOP || "";
    if (!shop) {
      try {
        shop = fs.readFileSync(path.join(home, "shop.txt"), "utf8").trim();
      } catch {
        shop = "http://127.0.0.1:8791";
      }
    }
    return { plug: null, shop, source: "", where: "" };
  }
}

function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function shopUrl() {
  return String(readState().shop || process.env.BRAIN_SHOP || "http://127.0.0.1:8791").replace(/\/$/, "");
}

function mcpServer() {
  const beside = path.join(here, "local-mcp.mjs");
  if (fs.existsSync(beside)) return beside;
  const installed = path.join(home, "local-mcp.mjs");
  return installed;
}

function memoryServer() {
  const beside = path.join(here, "memory-mcp.mjs");
  if (fs.existsSync(beside)) return beside;
  return path.join(home, "memory-mcp.mjs");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

async function inspectTarget(target) {
  const raw = String(target || "").trim();
  if (!raw) return { error: "Point brain connect at a URL, a folder, or a file." };
  if (/^https?:\/\//i.test(raw)) {
    try {
      const res = await fetch(raw, { signal: AbortSignal.timeout(20000), redirect: "follow" });
      const text = stripHtml(await res.text());
      if (text.length < 20) return { error: "That page did not have enough text to attach." };
      return { where: raw, source: text, kind: "website" };
    } catch (e) {
      return { error: "Could not read that URL. " + (e.message || "") };
    }
  }
  const full = path.resolve(raw);
  if (!fs.existsSync(full)) return { error: "That path is not on this computer." };
  const stat = fs.statSync(full);
  const files = [];
  if (stat.isFile()) files.push(full);
  else {
    for (const name of fs.readdirSync(full)) {
      const ext = path.extname(name).toLowerCase();
      if (![".md", ".txt", ".html", ".json", ".csv"].includes(ext)) continue;
      files.push(path.join(full, name));
      if (files.length >= 12) break;
    }
  }
  const chunks = [];
  for (const file of files) {
    try {
      const body = fs.readFileSync(file, "utf8");
      chunks.push(path.basename(file) + "\n" + stripHtml(body).slice(0, 4000));
    } catch {
      /* skip unreadable */
    }
  }
  const source = chunks.join("\n\n").slice(0, 12000);
  if (source.length < 20) return { error: "That folder did not have enough notes to attach." };
  return { where: full, source, kind: "website" };
}

function printPlugs() {
  const state = readState();
  console.log("ready     website      a URL or a folder of pages");
  console.log("ready     assistant    a computer assistant with listed actions");
  console.log("ready     automation   a workflow with listed actions");
  if (state.where) console.log(`\nConnected to ${state.where}.`);
  else console.log("\nNothing connected. Type: brain connect <url or folder>");
}

async function connect(target) {
  const found = await inspectTarget(target);
  if (found.error) {
    console.log(found.error);
    return;
  }
  const state = readState();
  state.where = found.where;
  state.source = found.source;
  state.plug = { id: found.kind, label: found.kind, where: found.where };
  writeState(state);
  addTrail("connect", found.where);
  console.log(`Connected to ${found.where}.`);
  console.log(`Attached ${found.source.length} characters of notes.`);
  console.log("Next: brain build --kind website --tier hobby --name \"Name\"");
}

function argValue(list, name) {
  const i = list.indexOf(name);
  if (i < 0 || !list[i + 1]) return "";
  return list[i + 1];
}

function usageBuild() {
  return [
    'Usage: brain build --kind website --tier hobby --name "Your shop" --source "What the brain is allowed to know."',
    'For an assistant or an automation, add --actions "book,quote".',
    "If you already ran brain connect, --source can be omitted.",
    "The brain answers only from that note. It does not send, post, or pay.",
  ].join("\n");
}

function localBuild({ kind, tier, name, source, actions, url }) {
  const calls = TIERS[tier];
  const id = "bc_" + Date.now().toString(16);
  const dir = path.join(home, "connectors", id);
  fs.mkdirSync(dir, { recursive: true });
  const server = mcpServer();
  const record = {
    id,
    name,
    kind,
    tier,
    calls,
    used: 0,
    url: url || "",
    source,
    actions: ACTION_KINDS.has(kind) ? actions : [],
    memory: [],
    trail: [],
  };
  const recordPath = path.join(dir, "connector.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shop";
  const mcp = {
    mcpServers: {
      [slug + "-brain"]: {
        command: process.execPath,
        args: [server, recordPath],
      },
      "brain-memory": {
        command: process.execPath,
        args: [memoryServer()],
      },
    },
  };
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify(mcp, null, 2));
  if (!fs.existsSync(server)) {
    console.log("Built the connector, but local-mcp.mjs is missing next to brain.");
    console.log("Run the Brain Connector install again, then rebuild.");
  }
  addTrail("build", `${kind} ${name} ${file}`);
  console.log(`Built ${kind} on ${tier}. ${calls} calls.`);
  console.log(`MCP file: ${file}`);
  console.log("It answers only from the notes you passed. It does not send, post, or pay.");
  console.log("Plug brain-memory in the same MCP file so Grok or Cursor can recall the trail.");
  return id;
}

async function shopBuild(body) {
  const shop = shopUrl();
  const res = await fetch(shop + "/api/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop: true, ...body }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Shop HTTP ${res.status}`);
  const dir = path.join(home, "connectors", data.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify(data.install.mcp, null, 2));
  fs.writeFileSync(path.join(dir, "PASTE.txt"), data.install.paste);
  addTrail("build", `${data.kind || body.kind} ${data.name || body.name} shop ${file}`);
  console.log(`Built ${data.label || body.kind} on ${data.tierLabel || body.tier}. ${data.callsIncluded} calls.`);
  console.log(`MCP file: ${file}`);
  console.log("Tools follow the plug. The material you passed is the only material it may use.");
  const siteUrl = data.install?.httpMcp?.url || "";
  if (siteUrl) fs.writeFileSync(path.join(dir, "url.txt"), siteUrl + "\n");
  return siteUrl;
}

async function buildConnector(list) {
  const state = readState();
  const kind = (argValue(list, "--kind") || "website").toLowerCase();
  const tier = (argValue(list, "--tier") || "hobby").toLowerCase();
  const name = argValue(list, "--name").trim();
  const source = (argValue(list, "--source") || state.source || "").trim();
  const url = argValue(list, "--url") || (/^https?:\/\//i.test(state.where || "") ? state.where : "");
  const actions = (argValue(list, "--actions") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""))
    .filter(Boolean);
  if (!name || !source) {
    console.log(usageBuild());
    return;
  }
  if (!KINDS.has(kind)) {
    console.log("Kind must be website, assistant, or automation.");
    return;
  }
  if (!TIERS[tier]) {
    console.log("Tier must be hobby, learner, or brilliant.");
    return;
  }
  if (ACTION_KINDS.has(kind) && actions.length === 0) {
    console.log('List --actions this assistant or automation may take. Example: --actions "book,quote"');
    return;
  }
  const blocked = actions.filter((a) => BLOCKED.has(a));
  if (blocked.length) {
    console.log("Send, post, and pay stay with you. Leave those off --actions.");
    return;
  }
  if (source.length < 40) {
    console.log("Paste more notes. A few sentences is not enough to build a brain.");
    return;
  }
  let pasteUrl = "";
  let builtId = "";
  try {
    pasteUrl = await shopBuild({ kind, tier, name, source, actions: actions.join(","), url });
  } catch {
    await ensureUrlServer();
    builtId = localBuild({ kind, tier, name, source, actions, url });
  }
  if (!grokCanReach(pasteUrl)) {
    const reached = await reachableUrl(builtId);
    if (reached) pasteUrl = reached;
  }
  if (pasteUrl) {
    console.log("Paste this connector URL into Grok Bot:");
    console.log(pasteUrl);
  }
  if (pasteUrl) {
    const saved = readState();
    saved.mcpUrl = pasteUrl;
    writeState(saved);
  }
  const placed = placeBrain(readState().ai);
  if (placed.length) console.log("That plug is in " + placed.join(", ") + ".");
  else console.log("Say who it is for: brain plug grok");
}

function printMcp() {
  const state = readState();
  const connectors = path.join(home, "connectors");
  let latest = "";
  try {
    const dirs = fs.readdirSync(connectors).map((name) => path.join(connectors, name, "mcp.json"));
    latest = dirs.filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || "";
  } catch {
    latest = "";
  }
  const block = {
    mcpServers: {
      "brain-memory": {
        command: process.execPath,
        args: [memoryServer()],
      },
    },
  };
  if (latest) {
    try {
      const existing = JSON.parse(fs.readFileSync(latest, "utf8"));
      Object.assign(block.mcpServers, existing.mcpServers || {});
    } catch {
      /* memory only */
    }
  }
  console.log(JSON.stringify(block, null, 2));
  if (state.where) console.log(`\nConnected to ${state.where}.`);
}

function urlPort() {
  return Number(process.env.BRAIN_URL_PORT || 8794);
}

function grokCanReach(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const parts = host.split(".").map(Number);
      const [a, b] = parts;
      if (a === 10 || a === 127 || (a === 192 && b === 168)) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 100 && b >= 64 && b <= 127) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function connectorPageUrl(id) {
  const base = `http://127.0.0.1:${urlPort()}`;
  const token = publicToken();
  return id ? `${base}/p/${token}/c/${id}/mcp` : `${base}/p/${token}/mcp`;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

function runCapture(cmd, args, ms = 20000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(out.trim());
    }, ms);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

function parseFunnelHost(text) {
  const found = String(text || "").match(/https:\/\/[a-z0-9.-]+\.ts\.net/i);
  return found ? found[0].replace(/\/$/, "") : "";
}

function cloudflaredBin() {
  const beside = path.join(home, "cloudflared.exe");
  if (fs.existsSync(beside)) return beside;
  if (process.env.CLOUDFLARED_BIN && fs.existsSync(process.env.CLOUDFLARED_BIN)) return process.env.CLOUDFLARED_BIN;
  return "";
}

function readTunnelUrl() {
  const file = path.join(home, "tunnel.txt");
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(text)) return text.replace(/\/$/, "");
  } catch {
    /* not saved yet */
  }
  return "";
}

async function ensureCloudflare() {
  const saved = readTunnelUrl();
  const bin = cloudflaredBin();
  if (!bin) return saved;
  if (saved) {
    try {
      const res = await fetch(saved, { signal: AbortSignal.timeout(8000) });
      if (res.ok || res.status === 404) return saved;
    } catch {
      /* start a new tunnel */
    }
  }
  const log = path.join(home, "tunnel.log");
  const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${urlPort()}`, "--no-autoupdate"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", fs.openSync(log, "w")],
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let text = "";
    try {
      text = fs.readFileSync(log, "utf8");
    } catch {
      text = "";
    }
    const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (found) {
      const url = found[0].replace(/\/$/, "");
      fs.writeFileSync(path.join(home, "tunnel.txt"), url + "\n");
      return url;
    }
  }
  return "";
}

async function ensureFunnel() {
  const status = await runCapture("tailscale", ["funnel", "status"]);
  const port = String(urlPort());
  let host = parseFunnelHost(status);
  if (host && status.includes(port)) return host;
  if (!host) {
    const started = await runCapture("tailscale", ["funnel", "--bg", port], 8000);
    if (!/not enabled/i.test(started)) {
      host = parseFunnelHost(started) || parseFunnelHost(await runCapture("tailscale", ["funnel", "status"]));
      if (host) return host;
    }
  }
  return ensureCloudflare();
}

async function reachableUrl(id) {
  await ensureUrlServer();
  const host = await ensureFunnel();
  if (!host) return "";
  const token = publicToken();
  return id ? `${host}/p/${token}/c/${id}/mcp` : `${host}/p/${token}/mcp`;
}

async function ensureUrlServer() {
  if (await portOpen(urlPort())) return connectorPageUrl();
  const beside = path.join(here, "url-mcp.mjs");
  const file = fs.existsSync(beside) ? beside : path.join(home, "url-mcp.mjs");
  if (!fs.existsSync(file)) return "";
  const child = spawn(process.execPath, [file], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, BRAIN_URL_PORT: String(urlPort()) },
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await portOpen(urlPort())) return connectorPageUrl();
  }
  return "";
}

function aiLabel(which) {
  if (which === "gpt") return "GPT";
  if (which === "claude") return "Claude";
  return "Grok";
}

function findCodex() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const root = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
  if (!fs.existsSync(root)) return "";
  let best = "";
  let bestTime = 0;
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name, "codex.exe");
    if (!fs.existsSync(file)) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime >= bestTime) {
      best = file;
      bestTime = mtime;
    }
  }
  return best;
}

function findClaude() {
  const listed = [process.env.CLAUDE_BIN, path.join(os.homedir(), ".local", "bin", "claude.exe")].filter(Boolean);
  return listed.find((file) => fs.existsSync(file)) || "";
}

function runModel(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, 90000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

async function askModel(prompt, which) {
  const chosen = which === "all" ? "grok" : which || "grok";
  if (chosen === "gpt") {
    const codex = findCodex();
    if (!codex) return "";
    return runModel(codex, ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", prompt]);
  }
  if (chosen === "claude") {
    const claude = findClaude();
    if (!claude) return "";
    return runModel(claude, ["-p", prompt]);
  }
  const grok = process.env.GROK_BIN || path.join(os.homedir(), ".grok", "bin", "grok.exe");
  if (!fs.existsSync(grok)) return "";
  return runModel(grok, [
    "-p",
    prompt,
    "--output-format",
    "plain",
    "--max-turns",
    "1",
    "--effort",
    "low",
    "--no-auto-update",
    "--disallowed-tools",
    "run_terminal_command,run_terminal_cmd,Agent,open_page,image_gen,image_edit,image_to_video,reference_to_video,spawn_subagent,use_tool,search_tool,workflow,web_search,web_fetch",
  ]);
}

async function answer(question) {
  const state = readState();
  const mem = loadMemory();
  const which = state.ai || "grok";
  const notes = [
    state.source ? `Attached notes:\n${state.source.slice(0, 4000)}` : "No notes attached yet.",
    mem.facts.length ? `Remembered:\n${mem.facts.map((f) => f.fact).slice(-12).join("\n")}` : "",
    mem.trail.length ? `Trail:\n${mem.trail.slice(-6).map((t) => t.event + " " + (t.detail || "")).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = [
    "You are Brain Connector in the terminal on this computer.",
    `Answer as ${aiLabel(which)}. Use the attached notes, remembered facts, and the trail.`,
    "If it is not there, say you do not know. Never claim you sent, posted, or paid.",
    "Reply in plain sentences. Do not use tools.",
    notes,
    `Question: ${question}`,
  ].join("\n");
  const spoken = await askModel(prompt, which);
  if (spoken) {
    addTrail("ask", question.slice(0, 120));
    return spoken;
  }
  const hits = recallFacts(question);
  if (hits.length) return hits.map((f) => `- ${f}`).join("\n");
  if (state.source) {
    const words = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const bits = state.source.split(/(?<=[.!?])\s+/);
    const hit = bits.find((s) => words.some((w) => s.toLowerCase().includes(w)));
    return hit || "That is not in the notes attached to this brain.";
  }
  if (which === "gpt" && !findCodex()) return "GPT is not on this computer yet. Plug grok, or install GPT, then ask again.";
  if (which === "claude" && !findClaude()) return "Claude is not on this computer yet. Plug grok, or install Claude, then ask again.";
  return "The connected AI did not answer. Ask again in a moment.";
}

function userHome() {
  return process.env.BRAIN_AI_HOME || os.homedir();
}

function roaming() {
  if (process.env.BRAIN_APPDATA) return process.env.BRAIN_APPDATA;
  if (!process.env.BRAIN_AI_HOME && process.env.APPDATA) return process.env.APPDATA;
  return path.join(userHome(), "AppData", "Roaming");
}

function normalizeAi(text) {
  const said = String(text || "").trim().toLowerCase();
  const key = said.replace(/[\s_]+/g, "-");
  const known = {
    grok: "grok",
    "grok-build": "grok",
    gpt: "gpt",
    chatgpt: "gpt",
    openai: "gpt",
    codex: "gpt",
    cursor: "gpt",
    claude: "claude",
    "claude-code": "claude",
    "claude-desktop": "claude",
    all: "all",
  };
  if (!said) return { which: "all", said: "all", known: true };
  if (known[key]) return { which: known[key], said: key, known: true };
  if (said.includes("grok")) return { which: "grok", said, known: true };
  if (said.includes("claude")) return { which: "claude", said, known: true };
  if (said.includes("gpt") || said.includes("chatgpt") || said.includes("openai")) {
    return { which: "gpt", said, known: true };
  }
  return { which: "all", said, known: false };
}

function tomlLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function stripTomlServer(text, name) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let skipping = false;
  const header = `[mcp_servers.${name}]`;
  const child = `[mcp_servers.${name}.`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header || trimmed.startsWith(child)) {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith("[")) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function upsertToml(file, servers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  for (const server of servers) {
    text = stripTomlServer(text, server.name);
  }
  const blocks = servers.map((server) => {
    if (server.url) {
      const lines = [
        `[mcp_servers.${server.name}]`,
        `url = ${tomlLiteral(server.url)}`,
        "enabled = true",
      ];
      const headers = server.headers && typeof server.headers === "object" ? server.headers : {};
      const keys = Object.keys(headers).filter((key) => /^[A-Za-z0-9-]+$/.test(key));
      if (keys.length) {
        lines.push("", `[mcp_servers.${server.name}.headers]`);
        for (const key of keys) lines.push(`${key} = ${tomlLiteral(headers[key])}`);
      }
      return lines.join("\n");
    }
    const args = (server.args || []).map(tomlLiteral).join(", ");
    return [
      `[mcp_servers.${server.name}]`,
      `command = ${tomlLiteral(server.command)}`,
      `args = [${args}]`,
      "enabled = true",
    ].join("\n");
  });
  const next = [text.trim(), blocks.join("\n\n")].filter(Boolean).join("\n\n") + "\n";
  fs.writeFileSync(file, next);
}

function upsertMcpJson(file, servers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error("Could not read " + file);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  if (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)) {
    data.mcpServers = {};
  }
  for (const server of servers) {
    data.mcpServers[server.name] = server.url
      ? { url: server.url, headers: server.headers || {} }
      : { command: server.command, args: server.args || [] };
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function latestMcpFile() {
  const connectors = path.join(home, "connectors");
  try {
    const dirs = fs.readdirSync(connectors).map((name) => path.join(connectors, name, "mcp.json"));
    return dirs.filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || "";
  } catch {
    return "";
  }
}

function serversToWrite() {
  const servers = [{ name: "brain-memory", command: process.execPath, args: [memoryServer()] }];
  const latest = latestMcpFile();
  if (!latest) return servers;
  try {
    const existing = JSON.parse(fs.readFileSync(latest, "utf8"));
    for (const [name, spec] of Object.entries(existing.mcpServers || {})) {
      if (!spec || name === "brain-memory") continue;
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) continue;
      if (spec.url) {
        servers.push({ name, url: String(spec.url), headers: spec.headers || {} });
        continue;
      }
      servers.push({
        name,
        command: String(spec.command || process.execPath),
        args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      });
    }
  } catch {
    /* memory only */
  }
  return servers;
}

function targetsFor(which) {
  const root = userHome();
  const app = roaming();
  const all = {
    grok: [{ kind: "toml", file: path.join(root, ".grok", "config.toml"), label: "Grok" }],
    gpt: [
      { kind: "toml", file: path.join(root, ".codex", "config.toml"), label: "GPT" },
      { kind: "json", file: path.join(root, ".cursor", "mcp.json"), label: "Cursor" },
    ],
    claude: [
      { kind: "json", file: path.join(root, ".claude.json"), label: "Claude" },
      { kind: "json", file: path.join(app, "Claude", "claude_desktop_config.json"), label: "Claude Desktop" },
    ],
  };
  if (which === "all") return [...all.grok, ...all.gpt, ...all.claude];
  return all[which] || all.grok;
}

function placeBrain(which) {
  if (!which) return [];
  const servers = serversToWrite();
  const labels = [];
  for (const target of targetsFor(which)) {
    try {
      if (target.kind === "toml") upsertToml(target.file, servers);
      else upsertMcpJson(target.file, servers);
      labels.push(target.label);
    } catch (e) {
      console.log(target.label + " was left unchanged. " + (e.message || "Could not write the connector."));
    }
  }
  return labels;
}

async function plugIn(text) {
  const choice = normalizeAi(text);
  const state = readState();
  state.ai = choice.which;
  state.aiSaid = choice.said;
  writeState(state);
  addTrail("plug", choice.said || choice.which);
  const placed = placeBrain(choice.which);
  if (!placed.length) {
    console.log("The brain could not be written into an AI config.");
    return;
  }
  const url = await reachableUrl();
  const saved = readState();
  saved.mcpUrl = url;
  writeState(saved);
  console.log("Plugged the brain into " + placed.join(", ") + ".");
  if (url) {
    console.log("Paste this connector URL into Grok Bot:");
    console.log(url);
  } else {
    console.log("Grok Bot needs a public address. Tailscale Funnel did not start, so there is no URL to paste yet.");
  }
  console.log("Ask in this terminal. " + aiLabel(choice.which) + " answers.");
  console.log("It remembers key facts. Chat overflow can drop. Send, post, and pay stay with you.");
}

function help() {
  console.log("Brain Connector is on this computer.");
  console.log("plug grok                      write the brain into Grok, GPT, or Claude");
  console.log("plugs                          advertised kinds: website, assistant, automation");
  console.log("connect <url or folder>        inspect the target and attach its notes");
  console.log("build --kind website --tier hobby --name \"Name\" --source \"notes\"");
  console.log("remember <fact>                KEY fact. GPT and Grok both keep this");
  console.log("note <fact>                    working note. drops on overload reset");
  console.log("topic <title>                  current build topic");
  console.log("recall [query]                 search the shared memory bank (free)");
  console.log("trail                          recent connects, builds, topics");
  console.log("reset                          drop overflow. keep key facts");
  console.log("mcp                            print the connector URL");
  console.log("ask <question>                 the connected AI answers in this terminal");
}

async function handle(line) {
  const text = String(line || "").trim();
  if (!text) return;
  if (text === "help" || text === "plugs" || text === "scan") return printPlugs();
  if (text === "plug" || text.startsWith("plug ")) return plugIn(text === "plug" ? "" : text.slice(5));
  if (text === "trail") {
    const trail = loadMemory().trail;
    if (!trail.length) return console.log("No trail yet.");
    return trail.forEach((t) => console.log(`${t.at}  ${t.event}  ${t.detail || ""}`));
  }
  if (text === "mcp") {
    const url = await reachableUrl();
    console.log("Paste this connector URL into Grok Bot:");
    console.log(url || "No public address yet.");
    return printMcp();
  }
  if (text.startsWith("connect ")) return connect(text.slice(8).trim());
  if (text.startsWith("remember ")) {
    const out = rememberFact(text.slice(9), { keep: true, source: "user" });
    return console.log(out.text);
  }
  if (text.startsWith("note ")) {
    const out = rememberFact(text.slice(5), { keep: false, source: "ai" });
    return console.log(out.text);
  }
  if (text.startsWith("topic ")) {
    const out = addTopic(text.slice(6));
    return console.log(out.text);
  }
  if (text === "topics") {
    const topics = listTopics();
    if (!topics.length) return console.log("No topics yet.");
    return topics.forEach((t) => console.log(`${t.at}  ${t.title}`));
  }
  if (text === "reset") {
    return console.log(resetOverflow().text);
  }
  if (text === "recall" || text.startsWith("recall ")) {
    const query = text === "recall" ? "" : text.slice(7);
    const facts = recallFacts(query);
    return console.log(facts.length ? facts.map((f) => `- ${f}`).join("\n") : "Nothing remembered about that yet.");
  }
  if (text === "build" || text.startsWith("build ")) {
    return buildConnector(text.split(/\s+/));
  }
  if (text.startsWith("ask ")) return console.log(await answer(text.slice(4)));
  console.log(await answer(text));
}

const args = process.argv.slice(2);
if (args[0] === "build") {
  await buildConnector(args);
} else if (args[0] === "plugs") {
  printPlugs();
} else if (args[0] === "connect") {
  await connect(args.slice(1).join(" "));
} else if (args[0] === "remember") {
  console.log(rememberFact(args.slice(1).join(" "), { keep: true, source: "user" }).text);
} else if (args[0] === "note") {
  console.log(rememberFact(args.slice(1).join(" "), { keep: false, source: "ai" }).text);
} else if (args[0] === "topic") {
  console.log(addTopic(args.slice(1).join(" ")).text);
} else if (args[0] === "topics") {
  const topics = listTopics();
  if (!topics.length) console.log("No topics yet.");
  else topics.forEach((t) => console.log(`${t.at}  ${t.title}`));
} else if (args[0] === "reset") {
  console.log(resetOverflow().text);
} else if (args[0] === "recall") {
  const facts = recallFacts(args.slice(1).join(" "));
  console.log(facts.length ? facts.map((f) => `- ${f}`).join("\n") : "Nothing remembered about that yet.");
} else if (args[0] === "trail") {
  const trail = loadMemory().trail;
  if (!trail.length) console.log("No trail yet.");
  else trail.forEach((t) => console.log(`${t.at}  ${t.event}  ${t.detail || ""}`));
} else if (args[0] === "plug") {
  await plugIn(args.slice(1).join(" "));
} else if (args[0] === "mcp") {
  const url = await reachableUrl();
  console.log("Paste this connector URL into Grok Bot:");
  console.log(url || "No public address yet.");
  printMcp();
} else if (args[0] === "ask") {
  console.log(await answer(args.slice(1).join(" ")));
} else if (args.length) {
  console.log(await answer(args.join(" ")));
} else {
  help();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!readState().ai) {
    console.log("");
    console.log("Which AI should this brain plug into?");
    console.log("Say grok, gpt, claude, or all.");
    const first = await new Promise((resolve) => rl.question("brain> ", resolve));
    await plugIn(first);
  }
  const loop = () =>
    rl.question("brain> ", async (line) => {
      if (line.trim() === "exit") {
        rl.close();
        return;
      }
      await handle(line);
      loop();
    });
  loop();
}
