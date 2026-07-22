import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers } from "@whiskeysockets/baileys";
import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import pino from "pino";
import net from "net";
import tls from "tls";
import dns from "dns";

process.on("uncaughtException", (e) => console.error("[FATAL]", e.stack || e.message));
process.on("unhandledRejection", (r) => console.error("[FATAL]", r?.stack || r?.message || r));

const PORT = parseInt(process.env.PORT || "8080", 10);
const APP_URL = (process.env.APP_URL || "https://career.jobayergroup.com").replace(/\/+$/, "");
const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), "data", "auth");
const ACCOUNT_ID = process.env.WA_ACCOUNT_ID || "web_main";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const authBackup = process.env.AUTH_BASE64;
  if (authBackup) {
    try {
      const files = JSON.parse(Buffer.from(authBackup, "base64").toString());
      for (const [name, data] of Object.entries(files)) {
        fs.writeFileSync(path.join(AUTH_DIR, name), Buffer.from(data, "base64"));
      }
      logInfo(`Auth restored from AUTH_BASE64 (${Object.keys(files).length} files)`);
    } catch (e) {
      logError(`Failed to restore auth from AUTH_BASE64: ${e.message}`);
    }
  }
}

let sock = null;
let qrCode = null;
let connStatus = "disconnected";
let connError = null;
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

async function startConnection() {
  if (sock) {
    try { sock.end(undefined); } catch {}
    sock = null;
  }

  connStatus = "connecting";
  connError = null;
  qrCode = null;

    try {
      let waVersion;
      try {
        waVersion = (await fetchLatestBaileysVersion()).version;
        logInfo(`Latest WA protocol v${waVersion.join(".")}`);
      } catch {
        waVersion = [2, 3000, 1018795645];
        logInfo(`Using default Baileys version v${waVersion.join(".")}`);
      }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    logInfo(`Auth state loaded — registered: ${!!state.creds?.registered}`);
    const baileysLogger = pino({ level: "debug", name: "baileys" }, {
      write: (msg) => {
        try {
          const d = JSON.parse(msg);
          const lvl = d.level >= 50 ? "ERR" : d.level >= 40 ? "WARN" : d.level >= 30 ? "INFO" : "DEBUG";
          let line = `[Baileys] ${d.msg || ""}`;
          if (d.err) line += ` — ${d.err.message}${d.err.stack ? " (" + d.err.stack.split("\n")[0] + ")" : ""}`;
          log(lvl, line);
        } catch {}
      },
    });

    const socketConfig = {
      auth: state,
      version: waVersion,
      printQRInTerminal: false,
      browser: Browsers.macOS("Chrome"),
      syncFullHistory: false,
      logger: baileysLogger,
      connectTimeoutMs: 120000,
      keepAliveIntervalMs: 15000,
      markOnlineOnConnect: false,
    };

    let qrTimeout = setTimeout(() => {
      if (!qrCode && connStatus !== "connected") {
        logWarn("No QR/connect after 30s — WebSocket may be blocked");
      }
    }, 30000);

    sock = makeWASocket(socketConfig);

    sock.ev.on("creds.update", saveCreds);

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
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
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
        const phone = msg.key?.remoteJid?.split("@")[0] || "";
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
          if (data.reply && sock && connStatus === "connected") {
            try {
              await sock.sendMessage(msg.key.remoteJid, { text: data.reply });
              sentCount++;
              logInfo(`Reply sent to ${phone}: ${data.reply.substring(0, 80)}`);
            } catch (sendErr) {
              logError(`Send failed for ${phone}: ${sendErr.message}`);
            }
          } else {
            if (!data.reply) logWarn(`No reply in webhook response for ${phone} — reply: ${JSON.stringify(data.reply)}, status: ${res.status}`);
            if (!sock) logWarn(`Socket null for ${phone} — cannot send reply`);
            if (sock && connStatus !== "connected") logWarn(`Socket not ready for ${phone} — connStatus: ${connStatus}`);
          }
        } catch (e) {
          logError(`Webhook call failed for ${phone}: ${e.message}`);
        }
      }
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

function requireAuth(req) {
  if (!AUTH_TOKEN) return true;
  const provided = req.headers["x-auth-token"] || "";
  return provided === AUTH_TOKEN;
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
      } else if (path === "/start" && req.method === "POST") {
        if (!requireAuth(req)) { jsonResponse(res, { error: "Unauthorized" }, 401); return; }
        startConnection();
        jsonResponse(res, { ok: true });
      } else if (path === "/stop" && req.method === "POST") {
        if (!requireAuth(req)) { jsonResponse(res, { error: "Unauthorized" }, 401); return; }
        stopConnection();
        jsonResponse(res, { ok: true });
      } else if (path === "/reset" && req.method === "POST") {
        if (!requireAuth(req)) { jsonResponse(res, { error: "Unauthorized" }, 401); return; }
        stopConnection();
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        startConnection();
        jsonResponse(res, { ok: true });
      } else if (path === "/backup-auth" && req.method === "POST") {
        if (!requireAuth(req)) { jsonResponse(res, { error: "Unauthorized" }, 401); return; }
        if (!fs.existsSync(AUTH_DIR) || !fs.readdirSync(AUTH_DIR).length) {
          jsonResponse(res, { error: "No auth data" }, 400); return;
        }
        const backup = {};
        for (const f of fs.readdirSync(AUTH_DIR)) {
          backup[f] = fs.readFileSync(path.join(AUTH_DIR, f), "base64");
        }
        jsonResponse(res, { backup: JSON.stringify(backup), hint: "Set as AUTH_BASE64 env var" });
      } else if (path === "/diag") {
        // diag is public (informational only, no destructive ops)
        (async () => {
          const result = { node: process.version, tests: [] };
          const hosts = ["web.whatsapp.com", "w1.web.whatsapp.com", "w2.web.whatsapp.com", "v1.web.whatsapp.com"];
          for (const host of hosts) {
            try {
              const addrs = await new Promise((res, rej) => dns.resolve4(host, (e, a) => e ? rej(e) : res(a)));
              const conns = [];
              for (const addr of addrs.slice(0, 2)) {
                const tcpOk = await new Promise((r) => {
                  const s = net.connect(443, addr, () => { s.destroy(); r(true); });
                  s.on("error", () => { s.destroy(); r(false); });
                  s.setTimeout(5000, () => { s.destroy(); r(false); });
                });
                let tlsOk = false;
                let tlsCert = null;
                if (tcpOk) {
                  tlsOk = await new Promise((r) => {
                    const s = tls.connect(443, host, { servername: host }, () => {
                      tlsCert = s.getPeerCertificate()?.subject?.CN || null;
                      s.destroy(); r(true);
                    });
                    s.on("error", () => { s.destroy(); r(false); });
                    s.setTimeout(5000, () => { s.destroy(); r(false); });
                  });
                }
                conns.push({ addr, tcp: tcpOk, tls: tlsOk, cert: tlsCert });
              }
              result.tests.push({ host, resolved: addrs, connections: conns });
            } catch (e) {
              result.tests.push({ host, error: e.message });
            }
          }
          try {
            const wsResult = await new Promise((r) => {
              const ws = new WebSocket("wss://web.whatsapp.com/ws/chat", {
                headers: { Origin: "https://web.whatsapp.com" },
                timeout: 8000,
                rejectUnauthorized: true,
              });
              const timer = setTimeout(() => { ws.close(); r({ status: "timeout" }); }, 8000);
              ws.on("open", () => { clearTimeout(timer); ws.close(); r({ status: "open" }); });
              ws.on("error", (e) => { clearTimeout(timer); r({ status: "error", message: e.message }); });
              ws.on("unexpected-response", (req, res) => { clearTimeout(timer); r({ status: "unexpected_response", code: res.statusCode }); });
            });
            result.ws_test = wsResult;
          } catch (e) {
            result.ws_test = { status: "exception", message: e.message };
          }
          jsonResponse(res, result);
        })();
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
