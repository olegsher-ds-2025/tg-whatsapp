import express from "express";
import baileysPkg from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import winston from "winston";
import "winston-daily-rotate-file";
import fs from "fs";
import path from "path";

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileysPkg;

// ---- Config ----
const PORT = process.env.PORT || 8081;
const AUTH_DIR = process.env.AUTH_DIR || "/app/auth";
const LOG_DIR = process.env.LOG_DIR || "/app/logs";
const LOG_FILE = process.env.LOG_FILE || path.join(LOG_DIR, "app.log");
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const API_KEY = process.env.WHATSAPP_API_KEY || "";
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || "";
const TELEGRAM_PROXY_URL = process.env.TELEGRAM_PROXY_URL || ""; // e.g. http://telegram-proxy:8080
const TELEGRAM_PROXY_API_KEY = process.env.TELEGRAM_PROXY_API_KEY || "";
const ALERT_COOLDOWN_SECONDS = parseInt(process.env.ALERT_COOLDOWN_SECONDS || "60", 10);
const MAX_BUFFERED_MESSAGES = parseInt(process.env.MAX_BUFFERED_MESSAGES || "500", 10);

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

// ---- Logging: rotating file + console ----
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} ${level.toUpperCase()} [whatsapp_proxy] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({ filename: LOG_FILE, maxSize: "5m", maxFiles: "5" }),
  ],
});

// ---- Alerting: reuse the existing Telegram bot/proxy to deliver failure notices ----
const lastAlertAt = new Map();
async function sendAlert(message, key) {
  if (!ALERT_CHAT_ID || !TELEGRAM_PROXY_URL) return;
  const throttleKey = key || message;
  const now = Date.now() / 1000;
  const last = lastAlertAt.get(throttleKey) || 0;
  if (now - last < ALERT_COOLDOWN_SECONDS) return;
  lastAlertAt.set(throttleKey, now);
  try {
    await fetch(`${TELEGRAM_PROXY_URL}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TELEGRAM_PROXY_API_KEY ? { "X-API-Key": TELEGRAM_PROXY_API_KEY } : {}),
      },
      body: JSON.stringify({ chat_id: ALERT_CHAT_ID, text: `⚠️ whatsapp-proxy: ${message}` }),
    });
  } catch (e) {
    logger.error(`Failed to deliver alert via telegram-proxy: ${e}`);
  }
}

// ---- WhatsApp socket state ----
let sock = null;
let latestQR = null;
let isConnected = false;
const messageBuffer = []; // in-memory ring buffer of recent messages (not persisted across restarts)
const knownChats = new Map(); // jid -> { name, lastSeen }

function pushMessage(entry) {
  messageBuffer.push(entry);
  if (messageBuffer.length > MAX_BUFFERED_MESSAGES) messageBuffer.shift();
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }), printQRInTerminal: false });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      latestQR = qr;
      logger.info("New QR code available — fetch GET /qr to scan it");
    }
    if (connection === "open") {
      isConnected = true;
      latestQR = null;
      logger.info("WhatsApp connected");
    } else if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn(`Connection closed (loggedOut=${loggedOut}): ${lastDisconnect?.error}`);
      sendAlert(`WhatsApp connection closed: ${lastDisconnect?.error}`, "connection_closed");
      if (!loggedOut) {
        setTimeout(startSock, 5000);
      } else {
        sendAlert("WhatsApp session was logged out — re-scan QR at /qr", "logged_out");
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) {
      if (!m.message) continue;
      const jid = m.key.remoteJid;
      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        "";
      knownChats.set(jid, { name: m.pushName || jid, lastSeen: Date.now() });
      pushMessage({
        chat_id: jid,
        from: m.key.participant || jid,
        fromMe: !!m.key.fromMe,
        text,
        timestamp: m.messageTimestamp,
      });
      logger.info(`Message in ${jid} from ${m.pushName || "?"}: ${text.slice(0, 80)}`);
    }
  });
}

startSock().catch((e) => {
  logger.error(`Failed to start WhatsApp socket: ${e}`);
  sendAlert(`Failed to start WhatsApp socket: ${e}`, "startup_fail");
});

// ---- HTTP API ----
const app = express();
app.use(express.json());

function checkAuth(req, res) {
  if (API_KEY && req.header("X-API-Key") !== API_KEY) {
    res.status(401).json({ detail: "Invalid or missing X-API-Key" });
    return false;
  }
  return true;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", connected: isConnected });
});

app.get("/qr", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (isConnected) return res.json({ status: "linked" });
  if (!latestQR) return res.status(503).json({ status: "qr_not_ready" });
  const png = await QRCode.toBuffer(latestQR, { type: "png", width: 300 });
  res.setHeader("Content-Type", "image/png");
  res.send(png);
});

app.post("/send", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ detail: "'to' and 'text' are required" });
  if (!isConnected) return res.status(503).json({ detail: "WhatsApp not connected — scan QR at /qr" });
  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  try {
    const result = await sock.sendMessage(jid, { text });
    logger.info(`Sent message to ${jid}`);
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) {
    logger.error(`Failed to send to ${jid}: ${e}`);
    sendAlert(`Failed to send WhatsApp message to ${jid}: ${e}`, `send_fail:${jid}`);
    res.status(502).json({ detail: String(e) });
  }
});

app.get("/messages", (req, res) => {
  if (!checkAuth(req, res)) return;
  const { chat_id, limit } = req.query;
  let results = messageBuffer;
  if (chat_id) results = results.filter((m) => m.chat_id === chat_id);
  const n = Math.min(parseInt(limit || "50", 10), 200);
  res.json(results.slice(-n));
});

app.get("/chats", (req, res) => {
  if (!checkAuth(req, res)) return;
  res.json(Array.from(knownChats.entries()).map(([jid, info]) => ({ chat_id: jid, ...info })));
});

app.listen(PORT, () => logger.info(`whatsapp-proxy listening on ${PORT}`));
