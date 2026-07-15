import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import http from "http";
import fs from "fs";
import path from "path";
import pino from "pino";
import net from "net";
import dns from "dns";

process.on("uncaughtException", (e) => console.error("[FATAL]", e.stack || e.message));
process.on("unhandledRejection", (r) => console.error("[FATAL]", r?.stack || r?.message || r));

const PORT = parseInt(process.env.PORT || "8080", 10);
const APP_URL = (process.env.APP_URL || "https://jobayer-group-career.workers.dev").replace(/\/+$/, "");
const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), "data", "auth");
const ACCOUNT_ID = process.env.WA_ACCOUNT_ID || "web_main";

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const SESSION_FILE = path.join(AUTH_DIR, "wa-session.json");

let sock = null;
let qrCode = null;
let connStatus = "disconnected";
let connError = null;
let sessionCreds = null;
let sessionKeys = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let startTime = null;
let sentCount = 0;
let receivedCount = 0;
let logs = [];

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  logs.unshift({ time: Date.now(), level, msg });
  if (logs.length > 500) logs.length = 500;
}
const logInfo = (m) => log("INFO", m);
const logWarn = (m) => log("WARN", m);
const logError = (m) => log("ERR", m);

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      sessionCreds = data.creds || null;
      sessionKeys = data.keys || null;
      logInfo(`Session loaded (creds: ${!!sessionCreds}, keys: ${!!sessionKeys})`);
    }
  } catch (e) {
    logError(`Session load failed: ${e.message}`);
  }
}

function saveSession(creds, keys) {
  sessionCreds = creds;
  sessionKeys = keys;
  try {
    const data = { creds, keys: exportKeys(keys) };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logError(`Session save failed: ${e.message}`);
  }
}

function clearSession() {
  sessionCreds = null;
  sessionKeys = null;
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {}
}

function exportKeys(keys) {
  if (!keys) return {};
  const out = {};
  for (const [key, value] of Object.entries(keys)) {
    if (value instanceof Map) out[key] = Array.from(value.entries());
    else if (typeof value === "object" && value !== null) out[key] = value;
  }
  return out;
}

function rebuildKeys(saved) {
  if (!saved) return {};
  const keys = {};
  for (const [type, entries] of Object.entries(saved)) {
    if (Array.isArray(entries)) {
      const map = new Map();
      for (const [id, value] of entries) map.set(id, value);
      keys[type] = map;
    } else {
      keys[type] = entries;
    }
  }
  return keys;
}

async function startConnection() {
  if (sock) {
    try { sock.end(undefined); } catch {}
    sock = null;
  }

  connStatus = "connecting";
  connError = null;
  qrCode = null;

  try {
    try {
      const { version } = await fetchLatestBaileysVersion();
      logInfo(`Latest WA protocol v${version.join(".")}`);
    } catch {
      logInfo("Using default Baileys version");
    }

    const baileysLogger = pino({ level: "warn", name: "baileys" }).child({});

    const socketConfig = {
      printQRInTerminal: false,
      browser: ["Jobayer Group Relay", "Chrome", ""],
      syncFullHistory: false,
      logger: baileysLogger,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false,
    };

    if (sessionCreds) {
      const keyStore = rebuildKeys(sessionKeys || {});
      const keyData = {
        get: async (type, ids) => {
          const map = keyStore[type];
          if (map instanceof Map) {
            const result = {};
            for (const id of ids) result[id] = map.get(id) || null;
            return result;
          }
          const result = {};
          for (const id of ids) result[id] = null;
          return result;
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            if (!keyStore[type]) keyStore[type] = new Map();
            const map = keyStore[type];
            for (const [id, value] of Object.entries(data[type])) {
              if (value) map.set(id, value);
              else map.delete(id);
            }
          }
        },
      };
      socketConfig.auth = {
        creds: sessionCreds,
        keys: keyData,
      };
    }

    let qrTimeout = setTimeout(() => {
      if (!qrCode && connStatus !== "connected") {
        logWarn("No QR/connect after 30s — WebSocket may be blocked");
      }
    }, 30000);

    sock = makeWASocket(socketConfig);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrCode = qr;
        reconnectAttempts = 0;
        clearTimeout(qrTimeout);
        logInfo("QR code generated — scan with WhatsApp phone");
      }

      if (connection === "open") {
        clearTimeout(qrTimeout);
        connStatus = "connected";
        connError = null;
        qrCode = null;
        startTime = Date.now();
        reconnectAttempts = 0;
        logInfo("WhatsApp connected!");

        if (sock?.authState?.creds) {
          const creds = sock.authState.creds;
          const keys = sock.authState.keys;
          const keyData = {};
          if (keys) {
            for (const [type, value] of Object.entries(keys)) {
              if (value instanceof Map) keyData[type] = Array.from(value.entries());
              else if (typeof value === "object") keyData[type] = value;
            }
          }
          saveSession(creds, keyData);
        }
      }

      if (connection === "close") {
        clearTimeout(qrTimeout);
        const code = lastDisconnect?.error?.output?.statusCode || DisconnectReason.loggedOut;
        const errMsg = lastDisconnect?.error?.message || "unknown";
        logWarn(`Connection closed — code: ${code}, message: ${errMsg}`);

        if (code === DisconnectReason.loggedOut) {
          connStatus = "disconnected";
          connError = "Logged out";
          qrCode = null;
          clearSession();
          logWarn("Logged out of WhatsApp");
        } else {
          connStatus = "disconnected";
          connError = `Disconnected (${code})`;
          scheduleReconnect();
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key?.fromMe) continue;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        const phone = msg.key?.remoteJid?.replace("@s.whatsapp.net", "") || "";
        if (!text || !phone) continue;

        receivedCount++;
        logInfo(`Incoming from ${phone}: ${text.substring(0, 80)}`);

        try {
          const res = await fetch(`${APP_URL}/api/whatsapp/webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone, text, name: "", fromBrowser: true }),
          });
          const data = await res.json();
          if (data.reply && sock) {
            await sock.sendMessage(msg.key.remoteJid, { text: data.reply });
            sentCount++;
            logInfo(`Reply sent to ${phone}: ${data.reply.substring(0, 80)}`);
          }
        } catch (e) {
          logError(`Webhook error for ${phone}: ${e.message}`);
        }
      }
    });

    sock.ev.on("creds.update", async () => {
      try {
        if (sock?.authState?.creds) {
          const creds = sock.authState.creds;
          const keys = sock.authState.keys;
          saveSession(creds, keys ? { ...keys } : null);
        }
      } catch {}
    });
  } catch (e) {
    clearTimeout(qrTimeout);
    connStatus = "error";
    connError = e.message;
    logError(`Connection error: ${e.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(60, Math.pow(2, reconnectAttempts)) * 1000;
  reconnectAttempts++;
  logInfo(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startConnection();
  }, delay);
}

function stopConnection() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    try { sock.end(undefined); } catch {}
    sock = null;
  }
  connStatus = "disconnected";
  qrCode = null;
  reconnectAttempts = 0;
  logInfo("Disconnected");
}

async function pollServerQueue() {
  if (connStatus !== "connected" || !sock) return;
  try {
    const res = await fetch(`${APP_URL}/api/whatsapp/queue?account_id=${ACCOUNT_ID}`);
    if (!res.ok) return;
    const data = await res.json();
    const pending = data.pending || [];
    if (pending.length > 0) logInfo(`Queue: ${pending.length} pending`);

    for (const msg of pending) {
      try {
        const phone = msg.to || msg.to_phone;
        const text = msg.text || msg.text_content;
        if (!phone || !text) continue;
        const jid = phone.includes("@s.whatsapp.net") ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text });
        await fetch(`${APP_URL}/api/whatsapp/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "mark_sent", id: msg.id }),
        });
        sentCount++;
        logInfo(`Sent to ${phone}: ${text.substring(0, 60)}`);
      } catch (e) {
        logError(`Send failed: ${e.message}`);
      }
    }
  } catch {}
}

function htmlResponse(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function serveDashboard(req, res) {
  const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  const uptimeStr = elapsed > 86400
    ? `${Math.floor(elapsed / 86400)}d ${Math.floor((elapsed % 86400) / 3600)}h`
    : elapsed > 3600
      ? `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`
      : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

  const statusColors = {
    connected: "#00e676", connecting: "#ffab00", disconnected: "#ff5252", error: "#ff1744"
  };
  const color = statusColors[connStatus] || "#888";

  const qrSection = qrCode
    ? `<div style="text-align:center;margin:20px 0">
         <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrCode)}"
              style="width:260px;height:260px;border-radius:12px;border:2px solid #333" />
         <p style="color:#888;font-size:13px;margin-top:8px">Scan with WhatsApp → Linked Devices</p>
       </div>`
    : connStatus === "connected"
      ? `<p style="color:#00e676;text-align:center;font-size:16px">✅ Connected and running</p>`
      : `<p style="text-align:center;color:#888">⏳ Waiting for QR code...</p>`;

  const logRows = logs.slice(0, 50).map(l => {
    const cls = l.level === "ERR" ? "color:#ff5252" : l.level === "WARN" ? "color:#ffab00" : "color:#aaa";
    return `<tr><td style="${cls};font-size:12px">${new Date(l.time).toISOString().slice(11,19)}</td><td style="${cls};font-size:12px">${l.msg.substring(0, 120)}</td></tr>`;
  }).join("");

  htmlResponse(res, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WA Relay — Jobayer Group</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f0f1a;color:#e0e0e0;padding:20px}
.container{max-width:700px;margin:0 auto}
h1{color:#00e676;font-size:22px;margin-bottom:16px}
.card{background:#1a1a2e;border-radius:12px;padding:16px;margin-bottom:12px;border:1px solid #2a2a4a}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0}
.stat{padding:12px;background:#16213e;border-radius:8px;text-align:center}
.stat-value{font-size:24px;font-weight:700;color:#00e676}
.stat-label{font-size:11px;color:#888;margin-top:4px}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:12px}
td{padding:4px 6px;border-bottom:1px solid #1a1a2e}
a{color:#69f0ae;text-decoration:none;margin:0 8px;font-size:13px}
.nav{padding:10px 0;margin-bottom:16px;border-bottom:1px solid #2a2a4a}
</style></head><body><div class="container">
<div class="nav">
  <a href="/">Dashboard</a>
  <a href="/health">Health</a>
  <a href="/logs">Logs</a>
</div>
<h1>WA Relay</h1>
<div class="card" style="text-align:center">
  <span class="badge" style="background:${color}22;color:${color};border:1px solid ${color}">
    ${connStatus.toUpperCase()}
  </span>
  <p style="color:#888;margin-top:6px;font-size:13px">${connError || "Running 24/7 on Railway"}</p>
</div>
${qrSection}
<div class="card">
  <div class="grid">
    <div class="stat"><div class="stat-value">${sentCount}</div><div class="stat-label">Sent</div></div>
    <div class="stat"><div class="stat-value">${receivedCount}</div><div class="stat-label">Received</div></div>
    <div class="stat"><div class="stat-value">${uptimeStr}</div><div class="stat-label">Uptime</div></div>
    <div class="stat"><div class="stat-value">${reconnectAttempts}</div><div class="stat-label">Reconnects</div></div>
  </div>
</div>
<div class="card">
  <h2 style="font-size:14px;color:#69f0ae;margin-bottom:8px">Activity</h2>
  <table>${logRows || "<tr><td style='color:#666'>No activity</td></tr>"}</table>
</div>
</div></body></html>`);
}

function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    try {
      if (path === "/" || path === "/dashboard") {
        serveDashboard(req, res);
      } else if (path === "/health") {
        jsonResponse(res, {
          status: connStatus,
          error: connError,
          connected: connStatus === "connected",
          qr: !!qrCode,
          uptime: startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
          sentCount, receivedCount, reconnectAttempts,
          node: process.version,
        });
      } else if (path === "/qr") {
        jsonResponse(res, { qr: qrCode });
      } else if (path === "/logs") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
        jsonResponse(res, logs.slice(0, limit));
      } else if (path === "/diag") {
        (async () => {
          const result = { node: process.version, tests: [] };
          const hosts = ["web.whatsapp.com", "w1.web.whatsapp.com", "w2.web.whatsapp.com", "v1.web.whatsapp.com"];
          for (const host of hosts) {
            try {
              const addrs = await new Promise((res, rej) => dns.resolve4(host, (e, a) => e ? rej(e) : res(a)));
              const tcpResults = [];
              for (const addr of addrs.slice(0, 2)) {
                const ok = await new Promise((r) => {
                  const s = net.connect(443, addr, () => { s.destroy(); r(true); });
                  s.on("error", () => { s.destroy(); r(false); });
                  s.setTimeout(5000, () => { s.destroy(); r(false); });
                });
                tcpResults.push({ addr, port443: ok });
              }
              result.tests.push({ host, resolved: addrs, tcp: tcpResults });
            } catch (e) {
              result.tests.push({ host, error: e.message });
            }
          }
          jsonResponse(res, result);
        })();
      } else if (path === "/start" && req.method === "POST") {
        startConnection();
        jsonResponse(res, { ok: true });
      } else if (path === "/stop" && req.method === "POST") {
        stopConnection();
        jsonResponse(res, { ok: true });
      } else {
        jsonResponse(res, { error: "Not found" }, 404);
      }
    } catch (e) {
      jsonResponse(res, { error: e.message }, 500);
    }
  });

  server.listen(PORT, () => {
    logInfo(`Server: http://localhost:${PORT}`);
    logInfo(`App URL: ${APP_URL}`);
    logInfo(`Node version: ${process.version}`);
  });
}

loadSession();
startServer();
startConnection();
setInterval(pollServerQueue, 5000);

setInterval(() => {
  if (connStatus === "connected") {
    const uptime = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
    logInfo(`Heartbeat — uptime: ${uptime}s, sent: ${sentCount}, received: ${receivedCount}`);
  }
}, 300000);

logInfo("Relay started");
