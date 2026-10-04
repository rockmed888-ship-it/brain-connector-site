#!/usr/bin/env node
/**
 * Brain Connector local terminal.
 * Install, type brain, connect to a site/folder/notes, build an MCP plug.
 * Advertised kinds: website, assistant, automation. No extra editor plugs.
 */
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { addTrail, addTopic, homeDir, listTopics, loadMemory, recallFacts, rememberFact, resetOverflow } from "./memory-mcp.mjs";

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
  return file;
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
  return file;
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
  try {
    await shopBuild({ kind, tier, name, source, actions: actions.join(","), url });
  } catch {
    localBuild({ kind, tier, name, source, actions, url });
  }
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

function askGrok(prompt) {
  const grok = process.env.GROK_BIN || path.join(os.homedir(), ".grok", "bin", "grok.exe");
  if (!fs.existsSync(grok)) return null;
  return new Promise((resolve) => {
    const child = spawn(
      grok,
      [
        "-p",
        prompt,
        "--output-format",
        "plain",
        "--max-turns",
        "1",
        "--disallowed-tools",
        "run_terminal_command,run_terminal_cmd,Agent,open_page,image_gen,image_edit,image_to_video,reference_to_video,spawn_subagent,use_tool,workflow",
      ],
      { windowsHide: true },
    );
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 40000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim() || null);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function answer(question) {
  const state = readState();
  const mem = loadMemory();
  const notes = [
    state.source ? `Attached notes:\n${state.source.slice(0, 4000)}` : "No notes attached yet.",
    mem.facts.length ? `Remembered:\n${mem.facts.map((f) => f.fact).slice(-12).join("\n")}` : "",
    mem.trail.length ? `Trail:\n${mem.trail.slice(-6).map((t) => t.event + " " + (t.detail || "")).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = [
    "You are Brain Connector, installed on this computer.",
    "Answer only from the attached notes, remembered facts, and the trail.",
    "If it is not there, say you do not know. Never claim you sent, posted, or paid.",
    notes,
    `Question: ${question}`,
  ].join("\n");
  const grok = await askGrok(prompt);
  if (grok) {
    addTrail("ask", question.slice(0, 120));
    return grok;
  }
  const hits = recallFacts(question);
  if (hits.length) return hits.map((f) => `- ${f}`).join("\n");
  if (state.source) {
    const words = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const bits = state.source.split(/(?<=[.!?])\s+/);
    const hit = bits.find((s) => words.some((w) => s.toLowerCase().includes(w)));
    return hit || "That is not in the notes attached to this brain.";
  }
  return "Nothing is connected. Type: brain connect <url or folder>";
}

function help() {
  console.log("Brain Connector is on this computer.");
  console.log("plugs                          advertised kinds: website, assistant, automation");
  console.log("connect <url or folder>        inspect the target and attach its notes");
  console.log("build --kind website --tier hobby --name \"Name\" --source \"notes\"");
  console.log("remember <fact>                KEY fact. GPT and Grok both keep this");
  console.log("note <fact>                    working note. drops on overload reset");
  console.log("topic <title>                  current build topic");
  console.log("recall [query]                 search the shared memory bank (free)");
  console.log("trail                          recent connects, builds, topics");
  console.log("reset                          drop overflow. keep key facts");
  console.log("mcp                            print MCP JSON so GPT / Grok share memory");
  console.log("ask <question>                 talk from the attached notes");
}

async function handle(line) {
  const text = String(line || "").trim();
  if (!text) return;
  if (text === "help" || text === "plugs" || text === "scan") return printPlugs();
  if (text === "trail") {
    const trail = loadMemory().trail;
    if (!trail.length) return console.log("No trail yet.");
    return trail.forEach((t) => console.log(`${t.at}  ${t.event}  ${t.detail || ""}`));
  }
  if (text === "mcp") return printMcp();
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
} else if (args[0] === "mcp") {
  printMcp();
} else if (args[0] === "ask") {
  console.log(await answer(args.slice(1).join(" ")));
} else if (args.length) {
  console.log(await answer(args.join(" ")));
} else {
  help();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
