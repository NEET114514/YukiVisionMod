"use strict";

const { ipcMain, app, shell, desktopCapturer, screen } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const tls = require("tls");
const { spawn } = require("child_process");
const path = require("path");

if (global.__YukiVisionRealtimeMainInstalled) {
  module.exports = global.__YukiVisionRealtimeMainInstalled;
  return;
}
global.__YukiVisionRealtimeMainInstalled = true;

function safeMessage(error) {
  return error && error.message ? error.message : String(error || "unknown error");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function buildRealtimeUrl(realtime) {
  const raw = String(realtime?.baseUrl || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime").trim();
  const url = new URL(raw);
  if (realtime?.model && !url.searchParams.get("model")) {
    url.searchParams.set("model", realtime.model);
  }
  return url;
}

class TinyWebSocket {
  constructor(url, headers, callbacks) {
    this.url = url;
    this.headers = headers || {};
    this.callbacks = callbacks || {};
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.closed = false;
    this.closeNotified = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const port = Number(this.url.port || 443);
      const host = this.url.hostname;
      const pathAndQuery = `${this.url.pathname || "/"}${this.url.search || ""}`;
      const lines = [
        `GET ${pathAndQuery} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13"
      ];
      Object.entries(this.headers).forEach(([name, value]) => {
        if (value) {
          lines.push(`${name}: ${value}`);
        }
      });
      lines.push("", "");

      const socket = tls.connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: true
      });
      this.socket = socket;

      const fail = error => {
        if (!this.handshakeDone) {
          reject(error);
        }
        this.callbacks.onError?.(error);
      };

      socket.once("secureConnect", () => {
        socket.write(lines.join("\r\n"));
      });
      socket.on("data", chunk => {
        try {
          if (!this.handshakeDone) {
            this.consumeHandshake(chunk, resolve, reject);
            return;
          }
          this.buffer = Buffer.concat([this.buffer, chunk]);
          this.consumeFrames();
        } catch (error) {
          fail(error);
        }
      });
      socket.on("error", fail);
      socket.on("close", hadError => {
        const wasClosed = this.closed;
        this.closed = true;
        this.socket = null;
        this.notifyClose({ remote: !wasClosed, transport: true, hadError: !!hadError });
      });
    });
  }

  consumeHandshake(chunk, resolve, reject) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const marker = this.buffer.indexOf("\r\n\r\n");
    if (marker < 0) {
      return;
    }
    const headerText = this.buffer.slice(0, marker).toString("utf8");
    const rest = this.buffer.slice(marker + 4);
    const statusLine = headerText.split(/\r?\n/)[0] || "";
    if (!/^HTTP\/1\.[01]\s+101\b/.test(statusLine)) {
      reject(new Error("Qwen Realtime WebSocket 握手失败：" + statusLine));
      this.close();
      return;
    }
    this.handshakeDone = true;
    this.buffer = rest;
    resolve(true);
    if (this.buffer.length) {
      this.consumeFrames();
    }
  }

  consumeFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;
      const masked = (second & 0x80) !== 0;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        length = high * 4294967296 + low;
        offset += 8;
      }
      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) {
        return;
      }
      let payload = this.buffer.slice(offset, offset + length);
      this.buffer = this.buffer.slice(offset + length);
      if (masked && mask) {
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      if (opcode === 0x8) {
        this.notifyClose(Object.assign({ remote: true, transport: false }, this.parseClosePayload(payload)));
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(payload, 0xA);
        continue;
      }
      if (opcode === 0x1) {
        const text = payload.toString("utf8");
        try {
          this.callbacks.onMessage?.(JSON.parse(text));
        } catch (_) {
          this.callbacks.onMessage?.({ type: "raw", text });
        }
      }
    }
  }

  sendJson(data) {
    this.sendFrame(Buffer.from(JSON.stringify(data), "utf8"), 0x1);
  }

  sendFrame(payload, opcode) {
    if (!this.socket || this.closed) {
      throw new Error("Realtime WebSocket 未连接");
    }
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    header[0] = 0x80 | (opcode || 0x1);
    const mask = crypto.randomBytes(4);
    const maskedPayload = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  parseClosePayload(payload) {
    if (!payload || payload.length < 2) {
      return { code: 0, reason: "" };
    }
    return {
      code: payload.readUInt16BE(0),
      reason: payload.length > 2 ? payload.slice(2).toString("utf8") : ""
    };
  }

  notifyClose(info) {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.callbacks.onClose?.(info || {});
  }

  close() {
    this.closed = true;
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch (_) {
      // Best effort.
    }
    this.socket = null;
  }
}

let activeSocket = null;
let activeSender = null;
let hotkeyProcess = null;
let bridgeServer = null;
let bridgePort = 0;
let eventSeq = 0;
const eventLog = [];
const BRIDGE_PORTS = [35672, 35673, 35674, 35675, 35676, 35677, 35678, 35679, 35680, 35681, 35682];
const MAX_LOG_BYTES = 2 * 1024 * 1024;
let compactCommittedCount = 0;
let compactCommittedLastAt = 0;
const observedRenderers = new WeakSet();

function getLogDir() {
  const base = app?.getPath ? app.getPath("userData") : process.cwd();
  return path.join(base, "yuki-vision-mod", "logs");
}

function getLogPath() {
  const now = new Date();
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
  return path.join(getLogDir(), `mod-${day}.log`);
}

function trimLogFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_LOG_BYTES) {
      return;
    }
    const data = fs.readFileSync(filePath);
    fs.writeFileSync(filePath, data.slice(Math.floor(data.length / 2)));
  } catch (_) {}
}

function summarizeText(value, max = 260) {
  const text = String(value || "");
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + `...<${text.length} chars>`;
}

function summarizePayload(value, depth = 0) {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    const looksBase64 = value.length > 256 && /^[A-Za-z0-9+/=_-]+$/.test(value.slice(0, 256));
    if (looksBase64) {
      return `<base64 chars=${value.length} bytes~${Math.ceil(value.length * 3 / 4)}>`;
    }
    return summarizeText(value);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return depth > 2 ? `<array len=${value.length}>` : value.slice(0, 8).map(item => summarizePayload(item, depth + 1));
  }
  const out = {};
  Object.entries(value).forEach(([key, item]) => {
    const lower = key.toLowerCase();
    const compactKey = lower.replace(/[^a-z0-9]/g, "");
    const sensitiveKey = lower === "authorization" ||
      compactKey === "apikey" ||
      compactKey.endsWith("apikey") ||
      compactKey === "accesstoken" ||
      compactKey === "refreshtoken" ||
      compactKey === "idtoken" ||
      compactKey.includes("authorization") ||
      compactKey.includes("bearer") ||
      compactKey.includes("secret") ||
      compactKey.includes("password");
    if (sensitiveKey) {
      out[key] = item ? "<redacted>" : item;
      return;
    }
    if (lower === "image" || lower === "audio" || lower.includes("base64") || lower.includes("screenshot")) {
      out[key] = typeof item === "string" ? `<base64 chars=${item.length} bytes~${Math.ceil(item.length * 3 / 4)}>` : "<binary>";
      return;
    }
    if (key === "instructions" && typeof item === "string") {
      const hash = crypto.createHash("sha256").update(item).digest("hex").slice(0, 12);
      out[key] = `<instructions chars=${item.length} sha256=${hash}>`;
      return;
    }
    out[key] = depth > 2 ? summarizeText(item, 120) : summarizePayload(item, depth + 1);
  });
  return out;
}

function appendRealtimeLog(source, stage, data) {
  try {
    const dir = getLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = getLogPath();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source: source || "main",
      stage: stage || "event",
      data: summarizePayload(data || {})
    }) + "\n";
    fs.appendFileSync(filePath, line, "utf8");
    trimLogFile(filePath);
  } catch (_) {}
}

function readRecentRealtimeLog(maxBytes = 120000) {
  const filePath = getLogPath();
  if (!fs.existsSync(filePath)) {
    return { success: true, path: filePath, text: "" };
  }
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - Math.max(1000, Number(maxBytes || 120000)));
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return { success: true, path: filePath, text: buffer.toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

function clearRealtimeLog() {
  const filePath = getLogPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf8");
  appendRealtimeLog("main", "log.clear", {});
  return { success: true, path: filePath };
}

async function openRealtimeLogDir() {
  const dir = getLogDir();
  fs.mkdirSync(dir, { recursive: true });
  const error = await shell.openPath(dir);
  return { success: !error, path: dir, error: error || "" };
}

async function captureScreenCore(options) {
  if (!desktopCapturer || typeof desktopCapturer.getSources !== "function") {
    throw new Error("当前 Electron 不支持高清桌面截图");
  }
  const primary = screen?.getPrimaryDisplay ? screen.getPrimaryDisplay() : null;
  const displays = screen?.getAllDisplays ? screen.getAllDisplays() : [];
  const display = primary || displays[0] || null;
  const scaleFactor = Math.max(1, Number(display?.scaleFactor || 1));
  const logicalSize = display?.size || display?.bounds || {};
  const sourceWidth = Math.max(1, Math.round(Number(logicalSize.width || 1920) * scaleFactor));
  const sourceHeight = Math.max(1, Math.round(Number(logicalSize.height || 1080) * scaleFactor));
  const maxDim = Math.round(clampNumber(options?.maxDim, 640, 4096, 1920));
  const scale = Math.min(1, maxDim / Math.max(sourceWidth, sourceHeight));
  const thumbnailSize = {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
    fetchWindowIcons: false
  });
  if (!sources || !sources.length) {
    throw new Error("没有找到可截图的屏幕");
  }
  const displayId = display?.id == null ? "" : String(display.id);
  const source = sources.find(item => String(item.display_id || "") === displayId) || sources[0];
  const thumbnail = source?.thumbnail;
  if (!thumbnail || (typeof thumbnail.isEmpty === "function" && thumbnail.isEmpty())) {
    throw new Error("高清桌面截图为空");
  }
  const size = typeof thumbnail.getSize === "function" ? thumbnail.getSize() : thumbnailSize;
  const dataUrl = thumbnail.toDataURL();
  appendRealtimeLog("main", "capture_screen.success", {
    source: "desktop_capturer",
    name: source?.name || "",
    displayId: source?.display_id || displayId,
    width: size.width,
    height: size.height,
    requestedWidth: thumbnailSize.width,
    requestedHeight: thumbnailSize.height,
    maxDim
  });
  return {
    success: true,
    source: "desktop_capturer",
    dataUrl,
    width: size.width,
    height: size.height,
    displayId: source?.display_id || displayId,
    requestedWidth: thumbnailSize.width,
    requestedHeight: thumbnailSize.height
  };
}

function appendServerToRendererLog(type, payload) {
  const eventType = payload?.type || "";
  if (type === "server" && eventType === "input_audio_buffer.committed") {
    compactCommittedCount += 1;
    const now = Date.now();
    if (compactCommittedCount < 12 && now - compactCommittedLastAt < 5000) {
      return;
    }
    appendRealtimeLog("main", "server.commit_batch", {
      type,
      eventType,
      count: compactCommittedCount,
      itemId: payload?.item_id || "",
      previousItemId: payload?.previous_item_id || ""
    });
    compactCommittedCount = 0;
    compactCommittedLastAt = now;
    return;
  }
  if (compactCommittedCount) {
    appendRealtimeLog("main", "server.commit_batch", {
      type: "server",
      eventType: "input_audio_buffer.committed",
      count: compactCommittedCount
    });
    compactCommittedCount = 0;
    compactCommittedLastAt = Date.now();
  }
  appendRealtimeLog("main", "server.to_renderer", { type, payload });
}

function sendToRenderer(type, payload) {
  const eventPayload = { id: ++eventSeq, type, payload, timestamp: Date.now() };
  appendServerToRendererLog(type, payload);
  eventLog.push(eventPayload);
  while (eventLog.length > 200) {
    eventLog.shift();
  }
  try {
    if (activeSender && !activeSender.isDestroyed()) {
      activeSender.send("yuki-realtime:event", { type, payload });
    } else {
      appendRealtimeLog("main", "server.to_renderer.dropped", {
        type,
        eventType: payload?.type || "",
        reason: activeSender ? "renderer_destroyed" : "no_renderer"
      });
    }
  } catch (error) {
    appendRealtimeLog("main", "server.to_renderer.error", {
      type,
      eventType: payload?.type || "",
      message: safeMessage(error)
    });
  }
}

function clearRealtimeEventCache(reason) {
  eventLog.length = 0;
  appendRealtimeLog("main", "event_cache.clear", { reason: reason || "" });
}

function observeRendererSender(sender) {
  if (!sender || observedRenderers.has(sender)) {
    return;
  }
  observedRenderers.add(sender);
  const describe = () => {
    try {
      return {
        destroyed: typeof sender.isDestroyed === "function" ? sender.isDestroyed() : false,
        url: typeof sender.getURL === "function" ? sender.getURL() : ""
      };
    } catch (error) {
      return { describeError: safeMessage(error) };
    }
  };
  try {
    sender.once("destroyed", () => appendRealtimeLog("main", "renderer.destroyed", describe()));
    sender.once("render-process-gone", (_event, details) => appendRealtimeLog("main", "renderer.gone", details || {}));
    sender.once("unresponsive", () => appendRealtimeLog("main", "renderer.unresponsive", describe()));
  } catch (error) {
    appendRealtimeLog("main", "renderer.observe_error", { message: safeMessage(error) });
  }
}

function closeActiveSocket() {
  if (activeSocket) {
    appendRealtimeLog("main", "socket.close_active", {});
    activeSocket.close();
    activeSocket = null;
  }
}

async function connectRealtimeCore(sender, options) {
  closeActiveSocket();
  clearRealtimeEventCache("connect");
  activeSender = sender || null;
  observeRendererSender(activeSender);
  const realtime = options?.realtime || {};
  const url = buildRealtimeUrl(realtime);
  appendRealtimeLog("main", "connect.start", {
    url: url.origin + url.pathname,
    model: realtime.model || "",
    region: realtime.region || "",
    audioMode: realtime.audioMode || "",
    screenMode: realtime.screenMode || "",
    imagePreset: realtime.imagePreset || "",
    imageMaxDim: realtime.imageMaxDim,
    imageMaxBytes: realtime.imageMaxBytes
  });
  const apiKey = String(realtime.apiKey || "").trim();
  if (!apiKey) {
    appendRealtimeLog("main", "connect.error", { message: "DashScope API Key 未设置" });
    throw new Error("DashScope API Key 未设置");
  }
  const socket = new TinyWebSocket(url, {
    Authorization: "Bearer " + apiKey
  }, {
    onMessage: payload => sendToRenderer("server", payload),
    onError: error => sendToRenderer("error", { message: safeMessage(error) }),
    onClose: info => {
      const isCurrentSocket = activeSocket === socket;
      appendRealtimeLog("main", isCurrentSocket ? "socket.closed" : "socket.closed_stale", info || {});
      if (isCurrentSocket) {
        activeSocket = null;
        sendToRenderer("closed", info || {});
      }
    }
  });
  activeSocket = socket;
  try {
    await socket.connect();
  } catch (error) {
    appendRealtimeLog("main", "connect.error", { message: safeMessage(error) });
    throw error;
  }
  const instructions = String(options?.instructions || "你是桌宠 Yuki，请自然回应用户。").slice(0, 12000);
  const useModelAudio = realtime.audioMode === "qwenAudio";
  const session = {
    modalities: useModelAudio ? ["text", "audio"] : ["text"],
    instructions,
    turn_detection: null,
    input_audio_format: "pcm"
  };
  if (useModelAudio) {
    session.voice = realtime.voice || "Tina";
    session.output_audio_format = "pcm";
  }
  socket.sendJson({
    type: "session.update",
    session
  });
  appendRealtimeLog("main", "connect.session_update", { session });
  sendToRenderer("connected", { model: realtime.model || "" });
  appendRealtimeLog("main", "connect.success", { model: realtime.model || "" });
  return { success: true };
}

async function connectRealtime(event, options) {
  return connectRealtimeCore(event.sender, options);
}

async function sendRealtimePayload(payload) {
  if (!activeSocket) {
    appendRealtimeLog("main", "client.send.error", { type: payload?.type || "", message: "Realtime WebSocket 未连接" });
    throw new Error("Realtime WebSocket 未连接");
  }
  appendRealtimeLog("main", "client.send", payload);
  try {
    activeSocket.sendJson(payload);
  } catch (error) {
    appendRealtimeLog("main", "client.send.error", { type: payload?.type || "", message: safeMessage(error) });
    if (activeSocket?.closed) {
      activeSocket = null;
    }
    throw error;
  }
  return { success: true };
}

async function sendRealtimeEvent(_event, payload) {
  return sendRealtimePayload(payload);
}

function startHotkeyCore(sender) {
  if (sender) {
    activeSender = sender;
  }
  if (process.platform !== "win32") {
    return { success: false, error: "右 Alt 全局按住说话仅支持 Windows" };
  }
  if (hotkeyProcess && !hotkeyProcess.killed) {
    appendRealtimeLog("main", "hotkey.start", { alreadyRunning: true });
    return { success: true, alreadyRunning: true };
  }
  const scriptPath = path.join(__dirname, "hotkey-right-alt.ps1");
  hotkeyProcess = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  hotkeyProcess.stdout.setEncoding("utf8");
  hotkeyProcess.stdout.on("data", data => {
    String(data || "").split(/\r?\n/).forEach(line => {
      const action = line.trim();
      if (action === "down" || action === "up") {
        appendRealtimeLog("main", "hotkey.event", { action });
        sendToRenderer("hotkey", { key: "RightAlt", action });
      }
    });
  });
  hotkeyProcess.stderr.on("data", data => {
    const message = String(data || "").trim();
    if (message) {
      appendRealtimeLog("main", "hotkey.stderr", { message });
      sendToRenderer("hotkey_error", { message });
    }
  });
  hotkeyProcess.on("error", error => {
    appendRealtimeLog("main", "hotkey.error", { message: safeMessage(error) });
    sendToRenderer("hotkey_error", { message: safeMessage(error) });
  });
  hotkeyProcess.on("exit", code => {
    hotkeyProcess = null;
    appendRealtimeLog("main", "hotkey.exit", { code });
    sendToRenderer("hotkey_stopped", { code });
  });
  appendRealtimeLog("main", "hotkey.start", { success: true });
  return { success: true };
}

function startHotkey(event) {
  return startHotkeyCore(event.sender);
}

function stopHotkey() {
  if (hotkeyProcess) {
    try {
      hotkeyProcess.kill();
    } catch (_) {
      // Best effort.
    }
    hotkeyProcess = null;
  }
  appendRealtimeLog("main", "hotkey.stop", {});
  return { success: true };
}

function writeJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data || {}), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > 24 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error("请求 JSON 解析失败：" + safeMessage(error)));
      }
    });
    req.on("error", reject);
  });
}

async function handleBridgeRequest(req, res) {
  if (req.method === "OPTIONS") {
    writeJson(res, 200, { success: true });
    return;
  }
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { success: true, provider: "yuki-qwen-realtime", port: bridgePort });
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      const since = Number(url.searchParams.get("since") || 0);
      writeJson(res, 200, {
        success: true,
        events: eventLog.filter(event => event.id > since),
        latestId: eventSeq
      });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 404, { success: false, error: "unknown endpoint" });
      return;
    }
    const body = await readJsonBody(req);
    if (url.pathname === "/log") {
      appendRealtimeLog(body?.source || "renderer", body?.stage || "event", body?.data || body);
      writeJson(res, 200, { success: true, path: getLogPath() });
      return;
    }
    if (url.pathname === "/read-log") {
      writeJson(res, 200, readRecentRealtimeLog(body?.maxBytes));
      return;
    }
    if (url.pathname === "/clear-log") {
      writeJson(res, 200, clearRealtimeLog());
      return;
    }
    if (url.pathname === "/open-log") {
      writeJson(res, 200, await openRealtimeLogDir());
      return;
    }
    if (url.pathname === "/capture-screen") {
      writeJson(res, 200, await captureScreenCore(body));
      return;
    }
    if (url.pathname === "/connect") {
      writeJson(res, 200, await connectRealtimeCore(null, body));
      return;
    }
    if (url.pathname === "/send") {
      writeJson(res, 200, await sendRealtimePayload(body));
      return;
    }
    if (url.pathname === "/close") {
      closeActiveSocket();
      writeJson(res, 200, { success: true });
      return;
    }
    if (url.pathname === "/start-hotkey") {
      writeJson(res, 200, startHotkeyCore(null));
      return;
    }
    if (url.pathname === "/stop-hotkey") {
      writeJson(res, 200, stopHotkey());
      return;
    }
    writeJson(res, 404, { success: false, error: "unknown endpoint" });
  } catch (error) {
    writeJson(res, 500, { success: false, error: safeMessage(error) });
  }
}

function startHttpBridge() {
  if (bridgeServer) {
    return;
  }
  const server = http.createServer((req, res) => {
    handleBridgeRequest(req, res).catch(error => writeJson(res, 500, { success: false, error: safeMessage(error) }));
  });
  const tryListen = index => {
    if (index >= BRIDGE_PORTS.length) {
      console.warn("[YukiVisionMod] Realtime local bridge failed: no free port");
      return;
    }
    const port = BRIDGE_PORTS[index];
    server.once("error", error => {
      if (error && error.code === "EADDRINUSE") {
        tryListen(index + 1);
      } else {
        console.warn("[YukiVisionMod] Realtime local bridge failed:", safeMessage(error));
      }
    });
    server.listen(port, "127.0.0.1", () => {
      bridgeServer = server;
      bridgePort = port;
      console.log("[YukiVisionMod] Realtime local bridge listening on 127.0.0.1:" + port);
    });
  };
  tryListen(0);
}

function installHandlers() {
  ipcMain.handle("yuki-realtime:connect", connectRealtime);
  ipcMain.handle("yuki-realtime:send", sendRealtimeEvent);
  ipcMain.handle("yuki-realtime:close", async () => {
    closeActiveSocket();
    return { success: true };
  });
  ipcMain.handle("yuki-realtime:start-hotkey", startHotkey);
  ipcMain.handle("yuki-realtime:stop-hotkey", async () => stopHotkey());
  ipcMain.handle("yuki-realtime:log", async (_event, entry) => {
    appendRealtimeLog(entry?.source || "renderer", entry?.stage || "event", entry?.data || entry);
    return { success: true, path: getLogPath() };
  });
  ipcMain.handle("yuki-realtime:read-log", async (_event, options) => readRecentRealtimeLog(options?.maxBytes));
  ipcMain.handle("yuki-realtime:clear-log", async () => clearRealtimeLog());
  ipcMain.handle("yuki-realtime:open-log", async () => openRealtimeLogDir());
  ipcMain.handle("yuki-realtime:capture-screen", async (_event, options) => captureScreenCore(options || {}));
}

installHandlers();
startHttpBridge();
process.once("exit", () => {
  closeActiveSocket();
  stopHotkey();
  try {
    bridgeServer?.close();
  } catch (_) {
    // Best effort.
  }
});

module.exports = true;
