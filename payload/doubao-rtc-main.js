"use strict";

const { ipcMain, app, shell } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const Module = require("module");
const path = require("path");
const { spawn } = require("child_process");

if (global.__YukiVisionDoubaoRtcMainInstalled) {
  module.exports = global.__YukiVisionDoubaoRtcMainInstalled;
  return;
}
global.__YukiVisionDoubaoRtcMainInstalled = true;

const RTC_API_HOST = "rtc.volcengineapi.com";
const RTC_API_VERSION = "2024-12-01";
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const DOUBAO_THINKING_TIMEOUT_MS = 30000;
const BRIDGE_PORTS = [35692, 35693, 35694, 35695, 35696, 35697, 35698, 35699, 35700, 35701, 35702];

let activeSender = null;
let eventSeq = 0;
const eventLog = [];
let hotkeyProcess = null;
let currentSession = null;
let bridgeServer = null;
let bridgePort = 0;
let yuvCanvasShimInstalled = false;

function safeMessage(error) {
  return error && error.message ? error.message : String(error || "unknown error");
}

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
    if (stat.size <= MAX_LOG_BYTES) return;
    const data = fs.readFileSync(filePath);
    fs.writeFileSync(filePath, data.slice(Math.floor(data.length / 2)));
  } catch (_) {}
}

function summarizePayload(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 256 && /^[A-Za-z0-9+/=_-]+$/.test(value.slice(0, 256))) {
      return `<base64 chars=${value.length} bytes~${Math.ceil(value.length * 3 / 4)}>`;
    }
    return value.length > 260 ? value.slice(0, 260) + `...<${value.length} chars>` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return depth > 2 ? `<array len=${value.length}>` : value.slice(0, 8).map(item => summarizePayload(item, depth + 1));
  }
  const out = {};
  Object.entries(value).forEach(([key, item]) => {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compact.includes("key") || compact.includes("secret") || compact.includes("token") || compact.includes("authorization") || compact.includes("password")) {
      out[key] = item ? "<redacted>" : item;
      return;
    }
    if (key === "instructions" || key === "systemMessages" || key === "message") {
      const text = String(item || "");
      out[key] = `<text chars=${text.length} sha256=${crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)}>`;
      return;
    }
    out[key] = depth > 2 ? String(item).slice(0, 120) : summarizePayload(item, depth + 1);
  });
  return out;
}

function appendLog(source, stage, data) {
  try {
    const dir = getLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = getLogPath();
    fs.appendFileSync(filePath, JSON.stringify({
      ts: new Date().toISOString(),
      source: source || "doubao-main",
      stage: stage || "event",
      data: summarizePayload(data || {})
    }) + "\n", "utf8");
    trimLogFile(filePath);
  } catch (_) {}
}

function attachSenderLifecycleWatch(session, sender) {
  if (!session || !sender || typeof sender.once !== "function") {
    return;
  }
  const forceClose = reason => {
    appendLog("doubao-main", "renderer_lifecycle_force_close", {
      reason,
      roomId: session.ids?.roomId,
      taskId: session.ids?.taskId
    });
    stopHotkey();
    closeDoubaoRtc({ notifyRenderer: false, reason }).catch(error => {
      appendLog("doubao-main", "renderer_lifecycle_force_close_failed", {
        reason,
        message: safeMessage(error)
      });
    });
  };
  const onDestroyed = () => forceClose("renderer_destroyed");
  const onRenderProcessGone = () => forceClose("render_process_gone");
  try {
    sender.once("destroyed", onDestroyed);
    sender.once("render-process-gone", onRenderProcessGone);
    session.senderLifecycleCleanup = () => {
      try { sender.removeListener?.("destroyed", onDestroyed); } catch (_) {}
      try { sender.removeListener?.("render-process-gone", onRenderProcessGone); } catch (_) {}
    };
  } catch (error) {
    appendLog("doubao-main", "renderer_lifecycle_watch_failed", { message: safeMessage(error) });
  }
}

function readRecentLog(maxBytes = 120000) {
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

function clearLog() {
  const filePath = getLogPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf8");
  appendLog("doubao-main", "log.clear", {});
  return { success: true, path: filePath };
}

async function openLogDir() {
  const dir = getLogDir();
  fs.mkdirSync(dir, { recursive: true });
  const error = await shell.openPath(dir);
  return { success: !error, path: dir, error: error || "" };
}

function sendToRenderer(type, payload) {
  const eventPayload = { id: ++eventSeq, type, payload, timestamp: Date.now() };
  appendLog("doubao-main", "server.to_renderer", { type, payload });
  eventLog.push(eventPayload);
  while (eventLog.length > 200) eventLog.shift();
  try {
    if (activeSender && !activeSender.isDestroyed()) {
      activeSender.send("yuki-doubao-rtc:event", { type, payload });
    }
  } catch (error) {
    appendLog("doubao-main", "server.to_renderer.error", { message: safeMessage(error) });
  }
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function hmacSha256(key, text) {
  return crypto.createHmac("sha256", key).update(String(text || ""), "utf8").digest();
}

function signVolcRequest(config, action, bodyText) {
  const region = config.region || "cn-north-1";
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = xDate.slice(0, 8);
  const xContentSha256 = sha256Hex(bodyText);
  const canonicalQueryString = `Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(RTC_API_VERSION)}`;
  const signedHeadersVec = [
    ["content-type", "application/json"],
    ["host", RTC_API_HOST],
    ["x-content-sha256", xContentSha256],
    ["x-date", xDate]
  ];
  const canonicalHeaders = signedHeadersVec.map(pair => pair.join(":")).join("\n") + "\n";
  const signedHeaders = signedHeadersVec.map(pair => pair[0]).join(";");
  const canonicalRequest = ["POST", "/", canonicalQueryString, canonicalHeaders, signedHeaders, xContentSha256].join("\n");
  const credentialScope = `${date}/${region}/rtc/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  let signature = Buffer.from(config.secretAccessKey || "", "utf8");
  credentialScope.split("/").concat([stringToSign]).forEach(part => {
    signature = hmacSha256(signature, part);
  });
  const authorization = `HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature.toString("hex")}`;
  return {
    path: `/?${canonicalQueryString}`,
    headers: {
      "Content-Type": "application/json",
      "Host": RTC_API_HOST,
      "X-Content-Sha256": xContentSha256,
      "X-Date": xDate,
      "Authorization": authorization
    }
  };
}

function requestRtcApi(config, action, body) {
  const bodyText = JSON.stringify(body || {});
  const signed = signVolcRequest(config, action, bodyText);
  appendLog("doubao-main", "openapi.request", { action, body });
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "POST",
      host: RTC_API_HOST,
      path: signed.path,
      headers: signed.headers,
      timeout: 20000
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : {};
        } catch (_) {
          json = { raw: text };
        }
        appendLog("doubao-main", "openapi.response", { action, statusCode: res.statusCode, body: json });
        if (res.statusCode >= 200 && res.statusCode < 300 && (json.Result === "ok" || json.ResponseMetadata || json.Result)) {
          const error = json.ResponseMetadata?.Error;
          if (error?.Message || error?.Code) {
            reject(new Error(`${action} 失败：${error.Message || error.Code}`));
            return;
          }
          resolve(json);
          return;
        }
        const message = json?.ResponseMetadata?.Error?.Message || json?.Message || json?.message || text || `HTTP ${res.statusCode}`;
        reject(new Error(`${action} 失败：${message}`));
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`${action} 请求超时`));
    });
    req.on("error", reject);
    req.write(bodyText);
    req.end();
  });
}

function packUInt16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(Number(value || 0), 0);
  return buffer;
}

function packUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(Number(value || 0) >>> 0, 0);
  return buffer;
}

function packBytes(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  return Buffer.concat([packUInt16(bytes.length), bytes]);
}

function packString(value) {
  return packBytes(Buffer.from(String(value || ""), "utf8"));
}

function packMapUInt32(map) {
  const entries = Object.entries(map || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  const chunks = [packUInt16(entries.length)];
  entries.forEach(([key, value]) => {
    chunks.push(packUInt16(Number(key)));
    chunks.push(packUInt32(Number(value)));
  });
  return Buffer.concat(chunks);
}

function generateRtcToken(appId, appKey, roomId, userId, ttlSec) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expireAt = issuedAt + Math.max(300, Math.min(604800, Number(ttlSec || 172800)));
  const nonce = crypto.randomInt(1, 99999999);
  const privileges = {
    0: expireAt,
    1: expireAt,
    2: expireAt,
    3: expireAt,
    4: expireAt
  };
  const message = Buffer.concat([
    packUInt32(nonce),
    packUInt32(issuedAt),
    packUInt32(expireAt),
    packString(roomId),
    packString(userId),
    packMapUInt32(privileges)
  ]);
  const signature = crypto.createHmac("sha256", Buffer.from(String(appKey || ""), "utf8")).update(message).digest();
  return "001" + String(appId || "") + Buffer.concat([packBytes(message), packBytes(signature)]).toString("base64");
}

function makeSessionIds(config) {
  const uuid = crypto.randomBytes(16).toString("hex");
  const roomId = `${config.roomIdPrefix || "yuki_mod_"}${uuid}`.replace(/[^A-Za-z0-9_@-]/g, "_").slice(0, 128);
  const userId = `${config.userIdPrefix || "user_"}${uuid}`.replace(/[^A-Za-z0-9_@-]/g, "_").slice(0, 128);
  const screenUserId = `${config.userIdPrefix || "user_"}${uuid}_screen`.replace(/[^A-Za-z0-9_@-]/g, "_").slice(0, 128);
  const botUserId = `${config.botUserId || "yuki_bot"}_${uuid.slice(0, 8)}`.replace(/[^A-Za-z0-9_@-]/g, "_").slice(0, 128);
  return { roomId, userId, screenUserId, botUserId, taskId: uuid };
}

function buildAsrProviderParams(config) {
  return {
    Mode: "bigmodel",
    AppId: config.asrAppId,
    AccessToken: config.asrAccessToken,
    ApiResourceId: "volc.bigasr.sauc.duration",
    StreamMode: 0
  };
}

function buildTtsConfig(config) {
  return {
    IgnoreBracketText: [1, 2, 3, 4, 5],
    Provider: "volcano_bidirection",
    ProviderParams: {
      app: {
        appid: config.ttsAppId || "",
        token: config.ttsAccessToken || ""
      },
      audio: {
        voice_type: config.ttsVoiceType || "zh_female_meilinvyou_moon_bigtts",
        pitch_rate: 0,
        speech_rate: 0
      },
      ResourceId: "volc.service_type.10029"
    }
  };
}

function getScreenShareEngine(config) {
  if (config?.screenShareEngine === "native") return "native";
  if (config?.screenShareEngine === "web") return "web";
  return config?.nativeScreenShareEnabled === true ? "native" : "web";
}

function shouldUseRtcVision(config) {
  return config?.screenMode !== "off";
}

function shouldUseNativeScreenShare(config) {
  return shouldUseRtcVision(config) && getScreenShareEngine(config) === "native";
}

function shouldUseWebScreenShare(config) {
  return shouldUseRtcVision(config) && getScreenShareEngine(config) === "web";
}

function buildStartVoiceChatBody(config, ids, instructions) {
  const visionEnabled = shouldUseRtcVision(config);
  const targetUserIds = [shouldUseWebScreenShare(config) && !config.__forceMainTarget && ids.screenUserId ? ids.screenUserId : ids.userId];
  const interval = config.screenMode === "low_frequency"
    ? Math.max(1000, Math.round(1000 / Math.max(0.2, Number(config.screenFps || 0.2))))
    : 1000;
  const snapshotConfig = {
    // VolcEngine AIGC uses StreamType 1 for the RTC screen-sharing stream.
    // The MOD publishes screen video with publishScreen(), so the LLM snapshot
    // must read the screen stream rather than the normal camera/main stream.
    StreamType: 1,
    ImageDetail: config.imageDetail || "high",
    Height: Math.max(360, Math.min(1080, Number(config.imageHeight || 720))),
    Interval: interval,
    ImagesLimit: 1
  };
  const voiceChatConfig = {
    ASRConfig: {
      Provider: "volcano",
      ProviderParams: buildAsrProviderParams(config),
      VADConfig: { SilenceTime: config.vadSilenceTimeMs || 800 },
      VolumeGain: 0.3,
      InterruptConfig: { InterruptSpeechDuration: config.interruptSpeechDurationMs || 0 },
      TurnDetectionMode: 0
    },
    LLMConfig: {
      Mode: "ArkV3",
      EndPointId: config.endpointId,
      MaxTokens: 1024,
      Temperature: 0.35,
      TopP: 0.7,
      SystemMessages: [String(instructions || "").slice(0, 12000)],
      UserPrompts: [],
      Prefill: false,
      HistoryLength: 3,
      VisionConfig: {
        Enable: visionEnabled,
        SnapshotConfig: snapshotConfig
      }
    },
    SubtitleConfig: {
      DisableRTSSubtitle: false,
      SubtitleMode: 0
    },
    TTSConfig: buildTtsConfig(config),
    InterruptMode: 1
  };
  if (!isRemoteTtsEnabled(config)) {
    appendLog("doubao-main", "connect.tts_config_required_for_local_tts", {
      audioMode: config.audioMode || "",
      enableVoice: config.enableVoice !== false,
      reason: "doubao_voice_chat_requires_tts_config"
    });
  }
  return {
    AppId: config.appId,
    RoomId: ids.roomId,
    TaskId: ids.taskId,
    Config: voiceChatConfig,
    AgentConfig: {
      TargetUserId: targetUserIds,
      WelcomeMessage: "",
      UserId: ids.botUserId,
      EnableConversationStateCallback: true,
      Burst: {
        Enable: false,
        BufferSize: 500,
        Interval: 20
      }
    }
  };
}

function getSdkModulePath() {
  const candidates = [
    path.join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", "@volcengine", "vertc-electron-sdk"),
    path.join(__dirname, "..", "app.asar.unpacked", "node_modules", "@volcengine", "vertc-electron-sdk")
  ];
  return candidates.find(item => item && fs.existsSync(path.join(item, "package.json"))) || "";
}

function installYuvCanvasShim() {
  if (yuvCanvasShimInstalled || global.__YukiVisionDoubaoYuvCanvasShimInstalled) {
    yuvCanvasShimInstalled = true;
    return;
  }
  const originalLoad = Module._load;
  Module._load = function patchedYukiVisionLoad(request, parent, isMain) {
    if (request === "yuv-canvas") {
      return {
        attach() {
          return {
            clear() {},
            drawFrame() {}
          };
        }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  global.__YukiVisionDoubaoYuvCanvasShimInstalled = true;
  yuvCanvasShimInstalled = true;
  appendLog("doubao-main", "sdk.yuv_canvas_shim_installed", {});
}

function loadRtcSdk() {
  const sdkPath = getSdkModulePath();
  if (!sdkPath) {
    throw new Error("找不到 @volcengine/vertc-electron-sdk，无法启动豆包 RTC");
  }
  installYuvCanvasShim();
  const sdk = require(sdkPath);
  const types = require(path.join(sdkPath, "js", "types"));
  return { sdk, types, sdkPath };
}

function selectScreenSource(engine, types) {
  if (!engine?.getScreenCaptureSourceList) return null;
  const list = engine.getScreenCaptureSourceList() || [];
  if (!Array.isArray(list) || !list.length) return null;
  return list.find(item => item?.primary_monitor) ||
    list.find(item => item?.type === types.ScreenCaptureSourceType?.kScreenCaptureSourceTypeScreen) ||
    list[0];
}

function parseSubtitleText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  const direct = item.text || item.Text || item.message || item.Message || item.content || item.Content ||
    item.transcript || item.Transcript || item.subtitle || item.Subtitle || item.value || item.Value;
  if (typeof direct === "string") return direct;
  if (Array.isArray(item.texts)) return item.texts.map(parseSubtitleText).join("");
  if (Array.isArray(item.words)) return item.words.map(parseSubtitleText).join("");
  if (Array.isArray(item.data)) return item.data.map(parseSubtitleText).join("");
  if (Array.isArray(item.subtitles)) return item.subtitles.map(parseSubtitleText).join("");
  const chunks = [];
  const collect = (value, hinted, depth) => {
    if (!value || depth > 5) return;
    if (typeof value === "string") {
      if (hinted) chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(child => collect(child, hinted, depth + 1));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => {
        const compact = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const textLike = /^(text|message|content|transcript|subtitle|sentence|utterance|paragraph|value|result|output)$/.test(compact);
        const containerLike = /^(data|payload|items|texts|words|segments|subtitles|results|choices|delta)$/.test(compact);
        collect(child, hinted || textLike, depth + (containerLike || textLike ? 1 : 2));
      });
    }
  };
  collect(item, false, 0);
  if (chunks.length) return chunks.join("");
  return "";
}

function parseSubtitleUid(item) {
  if (!item || typeof item !== "object") return "";
  return item.user_id || item.userId || item.UserId || item.userID || item.uid || item.UID ||
    item.speaker_id || item.speakerId || item.speaker || item.data?.userId || "";
}

function getLocalSubtitleRole(uid) {
  if (!uid || !currentSession?.ids) return "";
  if (uid === currentSession.ids.userId) return "rtc_user";
  if (uid === currentSession.ids.screenUserId) return "screen_target";
  return "";
}

function isBotSubtitleUid(uid) {
  if (!uid) return true;
  const botUserId = currentSession?.ids?.botUserId || "";
  return !!botUserId && uid === botUserId;
}

function clearThinkingTimer(session) {
  if (session?.thinkingTimer) {
    clearTimeout(session.thinkingTimer);
    session.thinkingTimer = null;
  }
}

function getEndpointThinkingTimeoutMessage() {
  return "豆包 RTC 卡在 thinking，30 秒内没有返回字幕。已暂停自动观察，请检查方舟 Endpoint 是否可用并支持当前 RTC/视觉链路。";
}

function scheduleThinkingTimeout(session, payload) {
  if (!session || currentSession !== session) return;
  clearThinkingTimer(session);
  const thinkingAt = Date.now();
  session.lastThinkingAt = thinkingAt;
  session.thinkingTimer = setTimeout(() => {
    if (currentSession !== session) return;
    if ((session.lastSubtitleAt || 0) >= thinkingAt || (session.lastConversationErrorAt || 0) >= thinkingAt) return;
    appendLog("doubao-main", "conversation.thinking_timeout", {
      roomId: session.ids?.roomId,
      taskId: session.ids?.taskId,
      roundId: payload?.RoundID || payload?.roundId,
      endpointId: session.config?.endpointId
    });
    sendToRenderer("error", {
      code: "doubao_thinking_timeout",
      message: getEndpointThinkingTimeoutMessage(),
      detail: "若日志只有 conv/thinking、没有 subv 字幕，通常是方舟 Endpoint 没有正确连接可用模型，或该 Endpoint 不支持当前 RTC/视觉链路。"
    });
  }, DOUBAO_THINKING_TIMEOUT_MS);
}

function isSubtitleComplete(item) {
  if (!item || typeof item !== "object") return true;
  if (Array.isArray(item.data)) return item.data.some(isSubtitleComplete);
  if (Object.prototype.hasOwnProperty.call(item, "paragraph") && item.paragraph !== true) return false;
  if (Object.prototype.hasOwnProperty.call(item, "definite") && item.definite !== true) return false;
  return true;
}

function ensureSubtitleStream(session, source) {
  if (!session) return null;
  if (!session.subtitleStream || session.subtitleStream.done) {
    const responseId = "doubao_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    session.subtitleStream = {
      responseId,
      text: "",
      partialText: "",
      source: source || "doubao_rtc",
      done: false,
      updatedAt: Date.now()
    };
    sendToRenderer("server", { type: "response.created", response: { id: responseId } });
  }
  return session.subtitleStream;
}

function mergeSubtitleStreamText(previous, incoming, stream) {
  const left = String(previous || "");
  const right = String(incoming || "");
  if (!left) return { text: right, delta: right };
  if (!right) return { text: left, delta: "" };
  const previousPartial = String(stream?.partialText || "");
  if (right === left || right === previousPartial) {
    if (stream) stream.partialText = right;
    return { text: left, delta: "" };
  }
  if (right.startsWith(left)) return { text: right, delta: right.slice(left.length) };
  if (previousPartial && right.startsWith(previousPartial)) {
    const delta = right.slice(previousPartial.length);
    return { text: left + delta, delta };
  }
  if (right.length >= 4 && left.endsWith(right)) {
    if (stream) stream.partialText = right;
    return { text: left, delta: "" };
  }
  return { text: left + right, delta: right };
}

function emitTextResponseDelta(text, source) {
  const reply = String(text || "").trim();
  if (!reply || !currentSession) return;
  clearThinkingTimer(currentSession);
  const stream = ensureSubtitleStream(currentSession, source);
  if (!stream) return;
  const merged = mergeSubtitleStreamText(stream.text, reply, stream);
  stream.text = merged.text;
  stream.partialText = reply;
  stream.updatedAt = Date.now();
  if (!merged.delta) return;
  sendToRenderer("server", {
    type: "response.text.delta",
    response_id: stream.responseId,
    delta: merged.delta,
    source: stream.source
  });
}

function emitTextResponse(text, source) {
  let reply = String(text || "").trim();
  if (!reply) return;
  clearThinkingTimer(currentSession);
  const stream = ensureSubtitleStream(currentSession, source);
  const responseId = stream?.responseId || ("doubao_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
  if (stream) {
    const merged = mergeSubtitleStreamText(stream.text, reply, stream);
    reply = String(merged.text || reply).trim();
    stream.done = true;
    stream.text = reply;
    stream.partialText = "";
    stream.updatedAt = Date.now();
  } else {
    sendToRenderer("server", { type: "response.created", response: { id: responseId } });
  }
  sendToRenderer("server", { type: "response.text.done", response_id: responseId, text: reply, source: source || "doubao_rtc" });
  sendToRenderer("server", {
    type: "response.done",
    response_id: responseId,
    response: {
      id: responseId,
      output: [{ content: [{ type: "output_text", text: reply }] }]
    }
  });
  if (currentSession?.subtitleStream?.responseId === responseId) {
    currentSession.subtitleStream = null;
  }
}

function handleSubtitleMessage(subtitles) {
  const list = Array.isArray(subtitles) ? subtitles : (Array.isArray(subtitles?.data) ? subtitles.data : [subtitles]);
  list.forEach(item => {
    const uid = parseSubtitleUid(item);
    const text = parseSubtitleText(item);
    appendLog("doubao-main", "subtitle.message", {
      uid,
      textChars: text.length,
      definite: item?.definite,
      paragraph: item?.paragraph,
      sequence: item?.sequence,
      roundId: item?.roundId,
      firstCharPos: item?.firstCharPos,
      lastCharPos: item?.lastCharPos
    });
    if (!text) {
      appendLog("doubao-main", "subtitle.empty_text", { uid });
      return;
    }
    const localRole = getLocalSubtitleRole(uid);
    if (localRole) {
      if (currentSession) {
        currentSession.lastUserSubtitleText = text;
        currentSession.lastUserSubtitleAt = Date.now();
      }
      appendLog("doubao-main", "subtitle.ignored_local_user", { uid, role: localRole, textChars: text.length });
      return;
    }
    if (!isBotSubtitleUid(uid)) {
      appendLog("doubao-main", "subtitle.ignored_non_bot", {
        uid,
        botUserId: currentSession?.ids?.botUserId || "",
        textChars: text.length
      });
      return;
    }
    const complete = isSubtitleComplete(item);
    if (!complete) {
      if (currentSession) {
        currentSession.lastSubtitleAt = Date.now();
      }
      appendLog("doubao-main", "subtitle.bot_partial", { uid, textChars: text.length, definite: item?.definite, paragraph: item?.paragraph });
      emitTextResponseDelta(text, "doubao_rtc");
      return;
    }
    if (currentSession?.lastSubtitleText === text && Date.now() - (currentSession.lastSubtitleAt || 0) < 5000) {
      appendLog("doubao-main", "subtitle.ignored_duplicate", { uid, textChars: text.length });
      return;
    }
    if (currentSession) {
      currentSession.lastSubtitleText = text;
      currentSession.lastSubtitleAt = Date.now();
    }
    appendLog("doubao-main", "subtitle.bot", { uid, textChars: text.length });
    emitTextResponse(text, "doubao_rtc");
  });
}

function messageToBuffer(message) {
  if (message == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  if (ArrayBuffer.isView(message)) return Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  if (typeof message === "string") return Buffer.from(message, "utf8");
  return Buffer.from(String(message || ""), "utf8");
}

function decodeRtcMessage(message) {
  const buffer = messageToBuffer(message);
  if (!buffer.length) return { text: "", bytes: 0, tlvType: "" };
  if (buffer.length >= 8) {
    const tlvType = buffer.subarray(0, 4).toString("ascii");
    const length = buffer.readUInt32BE(4);
    if (length > 0 && length <= buffer.length - 8 && /^[\x20-\x7e]{4}$/.test(tlvType)) {
      return {
        text: buffer.subarray(8, 8 + length).toString("utf8"),
        bytes: buffer.length,
        tlvType
      };
    }
  }
  const raw = buffer.toString("utf8");
  const jsonStart = raw.search(/[\[{]/);
  return {
    text: jsonStart > 0 ? raw.slice(jsonStart) : raw,
    bytes: buffer.length,
    tlvType: ""
  };
}

function handleRtcMessage(uid, message, source) {
  const decoded = decodeRtcMessage(message);
  const text = decoded.text;
  appendLog("doubao-main", source || "rtc.message", {
    uid,
    bytes: decoded.bytes,
    tlvType: decoded.tlvType,
    preview: text ? text.slice(0, 220) : ""
  });
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    if (decoded.tlvType === "conv" || parsed?.Stage || parsed?.ErrorInfo) {
      handleConversationEvent(uid, parsed);
      return;
    }
    if (parsed?.type === "subtitle" && Array.isArray(parsed.data)) {
      handleSubtitleMessage(parsed.data);
      return;
    }
    const reply = parseSubtitleText(parsed);
    if (reply) {
      handleSubtitleMessage([{ ...parsed, text: reply, userId: parsed.userId || parsed.uid || uid }]);
    }
  } catch (_) {
    if (uid && currentSession?.ids?.userId && uid === currentSession.ids.userId) return;
    handleSubtitleMessage([{ text, userId: uid }]);
  }
}

function explainDoubaoConversationError(info) {
  const reason = String(info?.Reason || info?.reason || info?.Message || info?.message || "");
  const code = info?.ErrorCode || info?.errorCode || "";
  if (/asr.*bad handshake/i.test(reason)) {
    return `豆包 RTC ASR 连接失败：${code ? code + " / " : ""}${reason}。请检查 ASR AppId、AccessToken 是否属于同一个火山语音服务应用，并确认 ASR 服务已开通。`;
  }
  if (/tts/i.test(reason)) {
    return `豆包 RTC TTS 配置失败：${code ? code + " / " : ""}${reason}。虽然 MOD 用游戏 TTS 播放，但豆包 RTC 任务仍需要可用的火山 TTS 配置。`;
  }
  return `豆包 RTC 任务错误：${code ? code + " / " : ""}${reason || "未知错误"}`;
}

function isNonBlockingAsrError(info) {
  const reason = String(info?.Reason || info?.reason || info?.Message || info?.message || "");
  return /asr:websocket:\s*bad handshake/i.test(reason) ||
    /asr:asr Reconnection failed too many times/i.test(reason);
}

function handleConversationEvent(uid, payload) {
  const stage = payload?.Stage || {};
  const description = stage.Description || stage.description || "";
  const code = stage.Code ?? stage.code;
  const errorInfo = payload?.ErrorInfo || payload?.errorInfo;
  appendLog("doubao-main", "conversation.event", {
    uid,
    stage: description,
    code,
    hasError: !!errorInfo,
    errorCode: errorInfo?.ErrorCode,
    reason: errorInfo?.Reason
  });
  if (description === "thinking" && !errorInfo) {
    scheduleThinkingTimeout(currentSession, payload);
    return;
  }
  if (description && description !== "thinking") {
    clearThinkingTimer(currentSession);
  }
  if (description === "errorOccurred" || errorInfo) {
    const info = errorInfo || payload;
    if (isNonBlockingAsrError(info) && !currentSession?.micPublished) {
      appendLog("doubao-main", "conversation.nonblocking_asr_error", {
        uid,
        errorCode: info?.ErrorCode || info?.errorCode,
        reason: info?.Reason || info?.reason || info?.Message || info?.message
      });
      return;
    }
    if (currentSession) currentSession.lastConversationErrorAt = Date.now();
    sendToRenderer("error", { message: explainDoubaoConversationError(info) });
  }
}

function startSubtitleSubscription(session, reason) {
  if (!session || currentSession !== session || session.subtitleSdkSkipLogged) return;
  session.subtitleSdkSkipLogged = true;
  appendLog("doubao-main", "subtitle.sdk_skipped", {
    reason,
    detail: "VoiceChat subtitles are enabled by StartVoiceChat SubtitleConfig and received from room messages; SDK startSubtitle requires the separate RTC subtitle service."
  });
}

function isRemoteTtsEnabled(config) {
  return config?.enableVoice !== false && config?.audioMode !== "localTts";
}

function isAudioStreamType(types, mediaStreamType) {
  const audio = types.MediaStreamType?.kMediaStreamTypeAudio ?? 1;
  const both = types.MediaStreamType?.kMediaStreamTypeBoth ?? 3;
  const value = Number(mediaStreamType);
  return value === audio || value === both || ((value & audio) === audio);
}

function getRemoteKeyUserId(remoteKey) {
  if (!remoteKey || typeof remoteKey !== "object") return "";
  return remoteKey.user_id || remoteKey.userId || remoteKey.uid || remoteKey.UserId || remoteKey.userID || "";
}

function emitRemoteAudioState(session, playing, detail) {
  if (!session || currentSession !== session || !isRemoteTtsEnabled(session.config)) return;
  if (!!session.remoteAudioPlaying === !!playing) return;
  session.remoteAudioPlaying = !!playing;
  appendLog("doubao-main", playing ? "rtc.remote_audio.started" : "rtc.remote_audio.done", detail || {});
  sendToRenderer("server", {
    type: playing ? "response.audio.remote_started" : "response.audio.remote_done",
    source: "doubao_rtc",
    detail: detail || {}
  });
}

async function startRtcMedia(session) {
  const { config, ids, rtc, types } = session;
  const remoteTtsEnabled = isRemoteTtsEnabled(config);
  const engine = new rtc.sdk.RTCVideo();
  session.engine = engine;
  engine.on?.("onError", (code, message) => sendToRenderer("error", { message: `豆包 RTC SDK 错误：${code} ${message || ""}` }));
  engine.on?.("onWarning", (code, message) => appendLog("doubao-main", "rtc.warning", { code, message }));
  engine.on?.("onFirstRemoteAudioFrame", remoteKey => {
    const uid = getRemoteKeyUserId(remoteKey);
    appendLog("doubao-main", "rtc.first_remote_audio", { uid, remoteKey });
    if (uid && uid !== ids.userId) {
      emitRemoteAudioState(session, true, { uid, event: "first_remote_audio" });
    }
  });
  engine.on?.("onRemoteAudioStateChanged", (remoteKey, state, reason) => {
    const uid = getRemoteKeyUserId(remoteKey);
    appendLog("doubao-main", "rtc.remote_audio_state", { uid, state, reason, remoteKey });
    if (!uid || uid === ids.userId) return;
    const decoding = types.RemoteAudioState?.kRemoteAudioStateDecoding ?? 2;
    const stopped = types.RemoteAudioState?.kRemoteAudioStateStopped ?? 0;
    const failed = types.RemoteAudioState?.kRemoteAudioStateFailed ?? 4;
    if (state === decoding) {
      emitRemoteAudioState(session, true, { uid, state, reason });
    } else if (state === stopped || state === failed) {
      emitRemoteAudioState(session, false, { uid, state, reason });
    }
  });
  const createResult = engine.createRTCVideo(config.appId, "{}");
  appendLog("doubao-main", "rtc.create_video", { result: createResult });
  if (createResult !== 0 && createResult !== undefined) {
    throw new Error("RTC 引擎创建失败：" + createResult);
  }
  engine.startAudioCapture?.();
  engine.setAudioCaptureDeviceMute?.(true);
  const room = engine.createRTCRoom(ids.roomId);
  if (!room) {
    throw new Error("RTC 房间创建失败");
  }
  session.room = room;
  room.on?.("onRoomStateChanged", (roomId, uid, state, extraInfo) => {
    appendLog("doubao-main", "rtc.room_state", { roomId, uid, state, extraInfo });
    sendToRenderer("server", { type: "session.updated", room_id: roomId, state });
    startSubtitleSubscription(session, "room_state");
    if (state === 0 || state === "0" || state === "connected") {
      scheduleScreenPublish(session, "room_state", 900);
    }
  });
  room.on?.("onSubtitleStateChanged", (state, errorCode, errorMessage) => {
    appendLog("doubao-main", "subtitle.state", { state, errorCode, errorMessage });
    if (!errorCode) {
      session.subtitleStarted = true;
    }
    if (errorCode) {
      sendToRenderer("error", { message: `豆包 RTC 字幕错误：${errorCode} ${errorMessage || ""}` });
    }
  });
  room.on?.("onSubtitleMessageReceived", subtitles => handleSubtitleMessage(subtitles));
  room.on?.("onRoomMessageReceived", (uid, message) => handleRtcMessage(uid, message, "rtc.room_message"));
  room.on?.("onRoomBinaryMessageReceived", (uid, message) => handleRtcMessage(uid, message, "rtc.room_binary_message"));
  room.on?.("onUserMessageReceived", (uid, message) => {
    handleRtcMessage(uid, message, "rtc.user_message");
  });
  room.on?.("onUserBinaryMessageReceived", (uid, message) => handleRtcMessage(uid, message, "rtc.user_binary_message"));
  room.on?.("onUserPublishStream", (uid, mediaStreamType) => {
    appendLog("doubao-main", "rtc.user_publish_stream", { uid, mediaStreamType, remoteTtsEnabled });
    if (!remoteTtsEnabled || !uid || uid === ids.userId || !isAudioStreamType(types, mediaStreamType)) return;
    const audioType = types.MediaStreamType?.kMediaStreamTypeAudio ?? 1;
    try {
      const result = room.subscribeStream?.(uid, audioType);
      engine.setRemoteAudioPlaybackVolume?.(ids.roomId, uid, 100);
      appendLog("doubao-main", "rtc.subscribe_remote_audio", { uid, result });
    } catch (error) {
      appendLog("doubao-main", "rtc.subscribe_remote_audio_failed", { uid, message: safeMessage(error) });
    }
  });
  room.on?.("onUserUnpublishStream", (uid, mediaStreamType, reason) => {
    appendLog("doubao-main", "rtc.user_unpublish_stream", { uid, mediaStreamType, reason });
    if (!uid || uid === ids.userId || !isAudioStreamType(types, mediaStreamType)) return;
    emitRemoteAudioState(session, false, { uid, mediaStreamType, reason });
  });
  room.on?.("onStreamSubscribed", (stateCode, userId, info) => {
    appendLog("doubao-main", "rtc.stream_subscribed", { stateCode, userId, info });
  });
  const token = config.manualToken || generateRtcToken(config.appId, config.appKey, ids.roomId, ids.userId, config.tokenTtlSec);
  session.userToken = token;
  const joinConfig = {
    room_profile_type: types.RoomProfileType?.kRoomProfileTypeCommunication ?? 0,
    is_auto_publish: false,
    is_auto_subscribe_audio: remoteTtsEnabled,
    is_auto_subscribe_video: false
  };
  const joinResult = room.joinRoom(token, { uid: ids.userId, extra_info: JSON.stringify({ source_language: "zh" }) }, joinConfig);
  appendLog("doubao-main", "rtc.join_room", { result: joinResult, roomId: ids.roomId, userId: ids.userId });
  if (joinResult !== 0 && joinResult !== undefined) {
    throw new Error("RTC 进房失败：" + joinResult);
  }
  session.subtitleTimer = setTimeout(() => {
    session.subtitleTimer = null;
    startSubtitleSubscription(session, "join_room");
  }, 800);
  if (shouldUseNativeScreenShare(config) && config.screenMode !== "ptt_1fps") {
    appendLog("doubao-main", "rtc.screen_publish_wait_room_state", {
      screenMode: config.screenMode,
      videoPreset: config.videoPreset
    });
  } else if (shouldUseWebScreenShare(config)) {
    appendLog("doubao-main", "rtc.screen_publish_web_mode", {
      reason: "renderer_web_sdk_screen_share",
      screenUserId: ids.screenUserId,
      screenMode: config.screenMode,
      videoPreset: config.videoPreset
    });
  }
}

function scheduleScreenPublish(session, reason, delayMs) {
  if (!session || currentSession !== session) return false;
  const { config } = session;
  if (!shouldUseNativeScreenShare(config) || config.screenMode === "ptt_1fps" || session.screenPublished) {
    return false;
  }
  if (session.screenPublishTimer) {
    return true;
  }
  appendLog("doubao-main", "rtc.screen_publish_scheduled", {
    reason,
    delayMs,
    screenMode: config.screenMode,
    videoPreset: config.videoPreset
  });
  session.screenPublishTimer = setTimeout(() => {
    session.screenPublishTimer = null;
    if (!session || currentSession !== session || session.screenPublished) {
      return;
    }
    try {
      startScreenPublish(session);
    } catch (error) {
      appendLog("doubao-main", "rtc.screen_publish_failed", { reason, message: safeMessage(error) });
      sendToRenderer("error", {
        message: "豆包 RTC 屏幕流启动失败，已保持语音/字幕连接。可以把屏幕帧模式改成关闭或按住说话时 1fps。"
      });
    }
  }, Math.max(0, Number(delayMs || 0)));
  return true;
}

function startScreenPublish(session) {
  const { config, engine, room, types } = session;
  if (!engine || !room) return false;
  if (!shouldUseNativeScreenShare(config)) {
    appendLog("doubao-main", "rtc.screen_publish_skipped_safe_mode", {
      reason: "native_screen_share_disabled",
      screenMode: config.screenMode,
      videoPreset: config.videoPreset
    });
    return false;
  }
  const presets = {
    economy: { width: 960, height: 540, bitrate: 800 },
    standard: { width: 1280, height: 720, bitrate: 1200 },
    clear: { width: 1600, height: 900, bitrate: 1800 },
    max: { width: 1920, height: 1080, bitrate: 2500 },
    custom: { width: 1280, height: 720, bitrate: 1200 }
  };
  const preset = presets[config.videoPreset] || presets.standard;
  const fps = config.screenMode === "low_frequency" ? Math.max(1, Math.round(Number(config.screenFps || 0.2))) : 1;
  appendLog("doubao-main", "rtc.screen_publish_begin", {
    screenMode: config.screenMode,
    videoPreset: config.videoPreset,
    width: preset.width,
    height: preset.height,
    fps
  });
  appendLog("doubao-main", "rtc.screen_encoder_config_start", {
    width: preset.width,
    height: preset.height,
    fps,
    bitrate: preset.bitrate
  });
  engine.setScreenVideoEncoderConfig?.({
    width: preset.width,
    height: preset.height,
    frame_rate: fps,
    max_bitrate: preset.bitrate
  });
  appendLog("doubao-main", "rtc.screen_encoder_config_ok", {});
  appendLog("doubao-main", "rtc.screen_source_select_start", {});
  const source = selectScreenSource(engine, types);
  if (!source) {
    throw new Error("未找到可共享的屏幕源");
  }
  appendLog("doubao-main", "rtc.screen_publish_source", { source });
  appendLog("doubao-main", "rtc.screen_capture_start", {});
  const captureResult = engine.startScreenVideoCapture(source, {
    capture_mouse_cursor: types.MouseCursorCaptureState?.kMouseCursorCaptureStateOn ?? 0
  });
  appendLog("doubao-main", "rtc.screen_capture_started", { captureResult });
  appendLog("doubao-main", "rtc.screen_publish_call_start", {});
  const publishResult = room.publishScreen(types.MediaStreamType?.kMediaStreamTypeVideo ?? 2);
  session.screenPublished = publishResult === 0 || publishResult === undefined;
  appendLog("doubao-main", "rtc.screen_publish", {
    captureResult,
    publishResult,
    streamTypeForVision: 1,
    videoPreset: config.videoPreset,
    encoder: {
      width: preset.width,
      height: preset.height,
      frameRate: fps,
      maxBitrate: preset.bitrate
    },
    source
  });
  return session.screenPublished;
}

function stopScreenPublish(session) {
  if (session?.screenPublishTimer) {
    clearTimeout(session.screenPublishTimer);
    session.screenPublishTimer = null;
  }
  if (!session?.screenPublished) return;
  try {
    session.room?.unpublishScreen?.(session.rtc.types.MediaStreamType?.kMediaStreamTypeVideo ?? 2);
  } catch (_) {}
  try {
    session.engine?.stopScreenVideoCapture?.();
  } catch (_) {}
  session.screenPublished = false;
  appendLog("doubao-main", "rtc.screen_unpublish", {});
}

async function connectDoubaoRtc(event, options) {
  activeSender = event?.sender || activeSender;
  await closeDoubaoRtc({ notifyRenderer: false, reason: "replace" });
  const config = {
    ...(options?.doubaoRtc || options?.realtime || {}),
    __forceMainTarget: options?.testMode === true
  };
  const instructions = String(options?.instructions || "");
  const ids = makeSessionIds(config);
  const rtc = loadRtcSdk();
  currentSession = {
    config,
    ids,
    rtc,
    types: rtc.types,
    instructions,
    connectedAt: Date.now(),
    micPublished: false,
    screenPublished: false
  };
  attachSenderLifecycleWatch(currentSession, activeSender);
  appendLog("doubao-main", "connect.start", { config, ids, instructions });
  const startBody = buildStartVoiceChatBody(config, ids, instructions);
  appendLog("doubao-main", "connect.vision_config", {
    visionEnabled: startBody.Config?.LLMConfig?.VisionConfig?.Enable,
    snapshotConfig: startBody.Config?.LLMConfig?.VisionConfig?.SnapshotConfig,
    screenShareEngine: getScreenShareEngine(config),
    nativeScreenShareEnabled: shouldUseNativeScreenShare(config),
    webScreenShareEnabled: shouldUseWebScreenShare(config),
    targetUserId: startBody.AgentConfig?.TargetUserId,
    screenMode: config.screenMode,
    screenFps: config.screenFps,
    videoPreset: config.videoPreset
  });
  await requestRtcApi(config, "StartVoiceChat", startBody);
  await startRtcMedia(currentSession);
  if (shouldUseWebScreenShare(config) && config.appKey) {
    currentSession.screenToken = generateRtcToken(config.appId, config.appKey, ids.roomId, ids.screenUserId, config.tokenTtlSec);
  } else if (shouldUseWebScreenShare(config) && config.manualToken) {
    currentSession.screenToken = config.manualToken;
    appendLog("doubao-main", "connect.screen_token_manual_fallback", {
      reason: "missing_app_key_for_screen_user"
    });
  }
  const connectedPayload = {
    provider: "doubao",
    appId: config.appId,
    roomId: ids.roomId,
    userId: ids.userId,
    token: currentSession.userToken,
    screenUserId: ids.screenUserId,
    screenToken: currentSession.screenToken || "",
    botUserId: ids.botUserId,
    screenShareEngine: getScreenShareEngine(config)
  };
  sendToRenderer("connected", connectedPayload);
  appendLog("doubao-main", "connect.success", {
    roomId: ids.roomId,
    userId: ids.userId,
    screenUserId: ids.screenUserId,
    botUserId: ids.botUserId,
    screenShareEngine: connectedPayload.screenShareEngine,
    hasScreenToken: !!connectedPayload.screenToken
  });
  return { success: true, ...connectedPayload };
}

async function updateVoiceChat(command, message, interruptMode) {
  if (!currentSession) {
    throw new Error("豆包 RTC 尚未连接");
  }
  const { config, ids } = currentSession;
  const body = {
    AppId: config.appId,
    RoomId: ids.roomId,
    TaskId: ids.taskId,
    Command: command
  };
  if (message != null && message !== "") body.Message = String(message);
  if (interruptMode) body.InterruptMode = interruptMode;
  await requestRtcApi(config, "UpdateVoiceChat", body);
  return { success: true };
}

async function startDoubaoInput() {
  if (!currentSession?.room) {
    throw new Error("豆包 RTC 尚未连接");
  }
  if (shouldUseWebScreenShare(currentSession.config)) {
    appendLog("doubao-main", "ptt.start_web_sdk_target", {
      targetUserId: currentSession.ids?.screenUserId
    });
    return { success: true, webSdkTarget: true };
  }
  if (shouldUseNativeScreenShare(currentSession.config) && currentSession.config?.screenMode === "ptt_1fps" && !currentSession.screenPublished) {
    startScreenPublish(currentSession);
  }
  const { room, engine, rtc } = currentSession;
  engine?.setAudioCaptureDeviceMute?.(false);
  const result = room.publishStream(rtc.types.MediaStreamType?.kMediaStreamTypeAudio ?? 1);
  currentSession.micPublished = true;
  appendLog("doubao-main", "ptt.start", { result });
  return { success: true, result };
}

async function stopDoubaoInput() {
  if (!currentSession?.room) {
    throw new Error("豆包 RTC 尚未连接");
  }
  const { room, engine, rtc } = currentSession;
  if (shouldUseWebScreenShare(currentSession.config)) {
    await updateVoiceChat("FinishSpeechRecognition").catch(error => {
      appendLog("doubao-main", "ptt.finish_speech_failed", { message: safeMessage(error) });
    });
    appendLog("doubao-main", "ptt.stop_web_sdk_target", {
      targetUserId: currentSession.ids?.screenUserId
    });
    sendToRenderer("server", { type: "input_audio_buffer.committed", item_id: "doubao_" + Date.now() });
    return { success: true, webSdkTarget: true };
  }
  let unpublishResult = 0;
  if (currentSession.micPublished) {
    unpublishResult = room.unpublishStream(rtc.types.MediaStreamType?.kMediaStreamTypeAudio ?? 1);
  }
  currentSession.micPublished = false;
  engine?.setAudioCaptureDeviceMute?.(true);
  appendLog("doubao-main", "ptt.stop", { unpublishResult });
  await updateVoiceChat("FinishSpeechRecognition").catch(error => {
    appendLog("doubao-main", "ptt.finish_speech_failed", { message: safeMessage(error) });
  });
  sendToRenderer("server", { type: "input_audio_buffer.committed", item_id: "doubao_" + Date.now() });
  return { success: true, unpublishResult };
}

async function sendDoubaoPayload(_event, payload) {
  const type = payload?.type || "";
  appendLog("doubao-main", "client.send", payload || {});
  if (!currentSession) {
    throw new Error("豆包 RTC 未连接");
  }
  if (type === "doubao.input.start") {
    return startDoubaoInput();
  }
  if (type === "doubao.input.stop") {
    return stopDoubaoInput();
  }
  if (type === "input_audio_buffer.append" || type === "input_image_buffer.append") {
    return { success: true, ignored: true };
  }
  if (type === "input_audio_buffer.commit") {
    await updateVoiceChat("FinishSpeechRecognition").catch(error => {
      appendLog("doubao-main", "input.commit_finish_failed", { message: safeMessage(error) });
    });
    if (shouldUseNativeScreenShare(currentSession?.config) && currentSession?.config?.screenMode === "ptt_1fps") {
      stopScreenPublish(currentSession);
    }
    sendToRenderer("server", { type: "input_audio_buffer.committed", item_id: "doubao_" + Date.now() });
    return { success: true };
  }
  if (type === "session.update") {
    const instructions = payload?.session?.instructions || payload?.instructions || "";
    if (instructions) {
      currentSession.instructions = String(instructions);
    }
    sendToRenderer("server", { type: "session.updated" });
    return { success: true };
  }
  if (type === "response.cancel") {
    await updateVoiceChat("Interrupt").catch(error => {
      appendLog("doubao-main", "response.cancel_failed", { message: safeMessage(error) });
    });
    return { success: true };
  }
  if (type === "response.create") {
    const instructions = payload?.response?.instructions || payload?.instructions || currentSession.instructions || "";
    sendToRenderer("server", { type: "response.created", response: { id: "doubao_pending_" + Date.now() } });
    if (instructions) {
      await updateVoiceChat("ExternalTextToLLM", instructions, 1);
    }
    return { success: true };
  }
  return { success: true, ignored: true };
}

async function closeDoubaoRtc(options = {}) {
  const session = currentSession;
  if (!session) return { success: true };
  emitRemoteAudioState(session, false, { event: "session_close" });
  currentSession = null;
  appendLog("doubao-main", "session.close", { roomId: session.ids?.roomId, taskId: session.ids?.taskId });
  try {
    try { session.senderLifecycleCleanup?.(); } catch (_) {}
    try { stopHotkey(); } catch (_) {}
    clearThinkingTimer(session);
    if (session.subtitleTimer) {
      clearTimeout(session.subtitleTimer);
      session.subtitleTimer = null;
    }
    if (session.room) {
      try { session.room.unpublishStream?.(session.rtc.types.MediaStreamType?.kMediaStreamTypeAudio ?? 1); } catch (_) {}
      try { stopScreenPublish(session); } catch (_) {}
      try { session.room.stopSubtitle?.(); } catch (_) {}
      try { session.room.leaveRoom?.(); } catch (_) {}
    }
    if (session.engine) {
      try { session.engine.stopScreenVideoCapture?.(); } catch (_) {}
      try { session.engine.stopAudioCapture?.(); } catch (_) {}
      try { session.engine.destroyRTCVideo?.(); } catch (_) {}
    }
    await requestRtcApi(session.config, "StopVoiceChat", {
      AppId: session.config.appId,
      RoomId: session.ids.roomId,
      TaskId: session.ids.taskId
    }).catch(error => appendLog("doubao-main", "stop_voice_chat_failed", { message: safeMessage(error) }));
  } finally {
    if (options.notifyRenderer !== false) {
      sendToRenderer("closed", {
        remote: false,
        provider: "doubao",
        reason: options.reason || "local_close",
        roomId: session.ids?.roomId,
        taskId: session.ids?.taskId
      });
    } else {
      appendLog("doubao-main", "session.close_silent", {
        reason: options.reason || "",
        roomId: session.ids?.roomId,
        taskId: session.ids?.taskId
      });
    }
  }
  return { success: true };
}

function getHotkeyScriptPath() {
  return path.join(__dirname, "hotkey-right-alt.ps1");
}

function startHotkey(event) {
  activeSender = event?.sender || activeSender;
  if (hotkeyProcess) {
    return { success: true, alreadyRunning: true };
  }
  const script = getHotkeyScriptPath();
  if (!fs.existsSync(script)) {
    throw new Error("找不到右 Alt 热键小桥脚本");
  }
  hotkeyProcess = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    cwd: __dirname,
    windowsHide: true
  });
  hotkeyProcess.stdout.on("data", chunk => {
    String(chunk || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).forEach(action => {
      if (action === "down" || action === "up") {
        appendLog("doubao-main", "hotkey.event", { action });
        sendToRenderer("hotkey", { key: "RightAlt", action });
      }
    });
  });
  hotkeyProcess.stderr.on("data", chunk => {
    const message = String(chunk || "").trim();
    if (message) {
      appendLog("doubao-main", "hotkey.stderr", { message });
      sendToRenderer("hotkey_error", { message });
    }
  });
  hotkeyProcess.on("exit", code => {
    appendLog("doubao-main", "hotkey.exit", { code });
    hotkeyProcess = null;
  });
  appendLog("doubao-main", "hotkey.start", { success: true });
  return { success: true };
}

function stopHotkey() {
  if (!hotkeyProcess) {
    return { success: true };
  }
  try {
    hotkeyProcess.kill();
  } catch (_) {}
  hotkeyProcess = null;
  appendLog("doubao-main", "hotkey.stop", {});
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
      writeJson(res, 200, { success: true, provider: "yuki-doubao-rtc", port: bridgePort });
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
    if (url.pathname === "/connect") {
      writeJson(res, 200, await connectDoubaoRtc(null, body));
      return;
    }
    if (url.pathname === "/send") {
      writeJson(res, 200, await sendDoubaoPayload(null, body));
      return;
    }
    if (url.pathname === "/close") {
      writeJson(res, 200, await closeDoubaoRtc());
      return;
    }
    if (url.pathname === "/start-hotkey") {
      writeJson(res, 200, startHotkey(null));
      return;
    }
    if (url.pathname === "/stop-hotkey") {
      writeJson(res, 200, stopHotkey());
      return;
    }
    if (url.pathname === "/log") {
      appendLog(body?.source || "renderer", body?.stage || "doubao.event", body?.data || body);
      writeJson(res, 200, { success: true, path: getLogPath() });
      return;
    }
    if (url.pathname === "/read-log") {
      writeJson(res, 200, readRecentLog(body?.maxBytes));
      return;
    }
    if (url.pathname === "/clear-log") {
      writeJson(res, 200, clearLog());
      return;
    }
    if (url.pathname === "/open-log") {
      writeJson(res, 200, await openLogDir());
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
      console.warn("[YukiVisionMod] Doubao RTC local bridge failed: no free port");
      return;
    }
    const port = BRIDGE_PORTS[index];
    server.once("error", error => {
      if (error && error.code === "EADDRINUSE") {
        tryListen(index + 1);
      } else {
        console.warn("[YukiVisionMod] Doubao RTC local bridge failed:", safeMessage(error));
      }
    });
    server.listen(port, "127.0.0.1", () => {
      bridgeServer = server;
      bridgePort = port;
      console.log("[YukiVisionMod] Doubao RTC local bridge listening on 127.0.0.1:" + port);
    });
  };
  tryListen(0);
}

function installHandlers() {
  ipcMain.handle("yuki-doubao-rtc:connect", connectDoubaoRtc);
  ipcMain.handle("yuki-doubao-rtc:send", sendDoubaoPayload);
  ipcMain.handle("yuki-doubao-rtc:close", async () => closeDoubaoRtc());
  ipcMain.on("yuki-doubao-rtc:force-close", (_event, payload) => {
    const reason = payload?.reason || "renderer_force_close";
    appendLog("doubao-main", "force_close.request", { reason });
    stopHotkey();
    closeDoubaoRtc({ notifyRenderer: false, reason }).catch(error => {
      appendLog("doubao-main", "force_close.failed", { reason, message: safeMessage(error) });
    });
  });
  ipcMain.handle("yuki-doubao-rtc:start-hotkey", startHotkey);
  ipcMain.handle("yuki-doubao-rtc:stop-hotkey", async () => stopHotkey());
  ipcMain.handle("yuki-doubao-rtc:log", async (_event, entry) => {
    appendLog(entry?.source || "renderer", entry?.stage || "doubao.event", entry?.data || entry);
    return { success: true, path: getLogPath() };
  });
  ipcMain.handle("yuki-doubao-rtc:read-log", async (_event, options) => readRecentLog(options?.maxBytes));
  ipcMain.handle("yuki-doubao-rtc:clear-log", async () => clearLog());
  ipcMain.handle("yuki-doubao-rtc:open-log", async () => openLogDir());
}

installHandlers();
startHttpBridge();
process.once("exit", () => {
  closeDoubaoRtc().catch(() => {});
  stopHotkey();
  try {
    bridgeServer?.close();
  } catch (_) {}
});

module.exports = true;
