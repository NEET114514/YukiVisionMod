(function () {
    "use strict";

    if (window.YukiVisionMod) {
        return;
    }

    const QWEN_REALTIME_MAX_IMAGE_BYTES = 185000;
    const DOUBAO_IMAGE_HEIGHT_PRESETS = [360, 480, 540, 720, 900, 1080];
    const DOUBAO_VIDEO_PRESET_HEIGHTS = {
        economy: 540,
        standard: 720,
        clear: 900,
        max: 1080,
        custom: 720
    };

    const REALTIME_IMAGE_PRESETS = {
        tiny: {
            imageMaxDim: 640,
            imageMaxBytes: 45000,
            imageJpegQuality: 62,
            description: "极省流量：画面最小，适合只想保留大致场景。"
        },
        low: {
            imageMaxDim: 800,
            imageMaxBytes: 65000,
            imageJpegQuality: 68,
            description: "低流量：比极省流量清楚一点，适合网络或成本敏感。"
        },
        economy: {
            imageMaxDim: 960,
            imageMaxBytes: 90000,
            imageJpegQuality: 72,
            description: "省流量：适合成本敏感，识别小字会弱一些。"
        },
        standard: {
            imageMaxDim: 1080,
            imageMaxBytes: 130000,
            imageJpegQuality: 78,
            description: "标准：兼顾稳定和流量，适合长期常驻。"
        },
        clear: {
            imageMaxDim: 1440,
            imageMaxBytes: 160000,
            imageJpegQuality: 88,
            description: "高清：更适合游戏 UI、小字和远处目标。"
        },
        max: {
            imageMaxDim: 1920,
            imageMaxBytes: QWEN_REALTIME_MAX_IMAGE_BYTES,
            imageJpegQuality: 92,
            description: "极限吃满：尽量贴近 Qwen WebSocket 单帧安全上限，优先识别效果。"
        }
    };

    const DEFAULT_CONFIG = {
        version: 1,
        enabled: true,
        userDisabled: false,
        engine: "http",
        apiMode: "inherit",
        uploadIntervalSec: 2,
        idleTimeoutSec: 25,
        autoCooldownSec: 60,
        includeActiveWindow: true,
        enableVoice: true,
        httpStreamSegmented: true,
        replyMinChars: 20,
        replyMaxChars: 40,
        maxOutputTokens: 0,
        extraPrompt: "",
        visionPreset: "balanced",
        visionSampleIntervalSec: 2,
        visionCollageMaxDim: 0,
        visionCollageJpegQuality: 0,
        imageMaxDim: 1280,
        imageJpegQuality: 78,
        openai: {
            baseurl: "",
            modelname: "",
            apiKey: ""
        },
        custom: {
            endpoint: "",
            apiKey: ""
        },
        inheritedApi: {
            baseurl: "",
            modelname: "",
            apiKey: "",
            updatedAt: ""
        },
        realtime: {
            enabled: false,
            provider: "qwen",
            region: "cn-beijing",
            baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
            model: "qwen3.5-omni-flash-realtime-2026-03-15",
            customModel: "",
            apiKey: "",
            audioMode: "gameTts",
            voice: "Tina",
            hotkey: "RightAlt",
            screenMode: "always_1fps",
            screenFps: 1,
            imagePreset: "standard",
            imageMaxBytes: 130000,
            imageMaxDim: 1080,
            imageJpegQuality: 78,
            autoObserveEnabled: false,
            autoObserveIntervalSec: 60,
            autoObserveSilenceSec: 60,
            autoObserveStyle: "game_assist"
        },
        doubaoRtc: {
            enabled: false,
            provider: "doubao",
            region: "cn-north-1",
            accessKeyId: "",
            secretAccessKey: "",
            appId: "",
            appKey: "",
            manualToken: "",
            roomIdPrefix: "yuki_mod_",
            userIdPrefix: "user_",
            botUserId: "yuki_bot",
            tokenTtlSec: 172800,
            endpointId: "",
            asrMode: "bigmodel",
            asrAppId: "",
            asrAccessToken: "",
            asrApiResourceId: "volc.bigasr.sauc.duration",
            audioMode: "remoteTts",
            ttsAppId: "",
            ttsAccessToken: "",
            ttsVoiceType: "zh_female_meilinvyou_moon_bigtts",
            screenShareEngine: "web",
            screenMode: "always_1fps",
            screenFps: 1,
            videoPreset: "standard",
            imageHeight: 720,
            imageDetail: "high",
            autoObserveEnabled: true,
            autoObserveIntervalSec: 60,
            autoObserveSilenceSec: 60,
            autoObserveStyle: "game_assist",
            vadSilenceTimeMs: 800,
            interruptSpeechDurationMs: 0
        },
        runtimeStatus: {
            lastState: "",
            lastMessage: "",
            lastUpdated: ""
        }
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function mergeConfig(config) {
        const incoming = config && typeof config === "object" ? config : {};
        const merged = {
            ...clone(DEFAULT_CONFIG),
            ...incoming,
            openai: { ...DEFAULT_CONFIG.openai, ...(incoming.openai || {}) },
            custom: { ...DEFAULT_CONFIG.custom, ...(incoming.custom || {}) },
            inheritedApi: { ...DEFAULT_CONFIG.inheritedApi, ...(incoming.inheritedApi || {}) },
            realtime: { ...DEFAULT_CONFIG.realtime, ...(incoming.realtime || {}) },
            doubaoRtc: { ...DEFAULT_CONFIG.doubaoRtc, ...(incoming.doubaoRtc || {}) },
            runtimeStatus: { ...DEFAULT_CONFIG.runtimeStatus, ...(incoming.runtimeStatus || {}) }
        };
        merged.engine = merged.engine === "doubaoRtc" || incoming.doubaoRtc?.enabled === true
            ? "doubaoRtc"
            : (merged.engine === "qwenRealtime" || incoming.realtime?.enabled === true ? "qwenRealtime" : "http");
        merged.realtime.enabled = merged.engine === "qwenRealtime";
        merged.doubaoRtc.enabled = merged.engine === "doubaoRtc";
        if (incoming.enabled === false && incoming.userDisabled !== true) {
            merged.enabled = true;
        }
        merged.replyMinChars = Math.round(clampNumber(
            merged.replyMinChars,
            10,
            500,
            DEFAULT_CONFIG.replyMinChars
        ));
        merged.replyMaxChars = Math.round(clampNumber(
            merged.replyMaxChars,
            20,
            800,
            DEFAULT_CONFIG.replyMaxChars
        ));
        if (merged.replyMaxChars < merged.replyMinChars) {
            merged.replyMaxChars = merged.replyMinChars;
        }
        merged.uploadIntervalSec = 2;
        merged.visionSampleIntervalSec = 2;
        delete merged.personaMemoryMode;
        delete merged.personaSummary;
        delete merged.replyLengthMode;
        return merged;
    }

    function encodeText(text) {
        return Array.from(new TextEncoder().encode(text));
    }

    function decodeText(bytes) {
        return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    }

    function trimSlash(value) {
        return String(value || "").replace(/\/+$/, "");
    }

    function clampNumber(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return fallback;
        }
        return Math.min(max, Math.max(min, number));
    }

    function ensureChatCompletionsUrl(baseurl) {
        const raw = trimSlash(baseurl);
        if (!raw) {
            return "";
        }
        if (/\/chat\/completions$/i.test(raw)) {
            return raw;
        }
        return raw + "/chat/completions";
    }

    function maskKey(key) {
        if (!key) {
            return "未设置";
        }
        if (key.length <= 8) {
            return "已设置";
        }
        return key.slice(0, 4) + "..." + key.slice(-4);
    }

    function isNoReply(text) {
        const normalized = String(text || "").trim().toLowerCase();
        return !normalized ||
            normalized === "no_reply" ||
            normalized === "__no_reply__" ||
            normalized === "无需回复" ||
            normalized === "不回复";
    }

    function summarizeForLog(value, max = 240) {
        const text = String(value || "");
        return text.length > max ? text.slice(0, max) + "...<" + text.length + " chars>" : text;
    }

    function safeUrlForLog(raw) {
        const text = String(raw || "").trim();
        if (!text) {
            return "";
        }
        try {
            const url = new URL(text);
            return url.origin + url.pathname;
        } catch (_) {
            return text.split("?")[0].slice(0, 160);
        }
    }

    function estimateDataUrlBytes(dataUrl) {
        const text = String(dataUrl || "");
        if (!text) {
            return 0;
        }
        const base64 = text.includes(",") ? text.split(",").pop() : text;
        return Math.ceil(String(base64 || "").length * 3 / 4);
    }

    function summarizeOpenAIMessages(messages) {
        const list = Array.isArray(messages) ? messages : [];
        let textChars = 0;
        let imageCount = 0;
        let imageBytes = 0;
        const roles = [];
        list.forEach(message => {
            roles.push(message?.role || "");
            const content = message?.content;
            if (typeof content === "string") {
                textChars += content.length;
                return;
            }
            if (Array.isArray(content)) {
                content.forEach(part => {
                    if (!part || typeof part !== "object") {
                        return;
                    }
                    if (part.type === "text") {
                        textChars += String(part.text || "").length;
                    }
                    const url = part.image_url?.url || part.image || part.url || "";
                    if (url) {
                        imageCount += 1;
                        imageBytes += estimateDataUrlBytes(url);
                    }
                });
            }
        });
        return {
            count: list.length,
            roles,
            textChars,
            imageCount,
            imageBytes
        };
    }

    function summarizeResponseShape(data, parsedText, depth = 0) {
        if (typeof data === "string") {
            return {
                type: "string",
                chars: data.length,
                parsedChars: String(parsedText || "").length,
                preview: summarizeForLog(data, 120)
            };
        }
        if (!data || typeof data !== "object") {
            return { type: String(typeof data), parsedChars: 0 };
        }
        const summary = {
            type: "object",
            keys: Object.keys(data).slice(0, 16),
            parsedChars: String(parsedText || "").length,
            finishReason: getFinishReason(data),
            usage: data.usage || data.token_usage || data.usage_metadata || null
        };
        if ("code" in data) {
            summary.code = String(data.code).slice(0, 40);
        }
        if ("status" in data) {
            summary.status = String(data.status).slice(0, 40);
        }
        if ("success" in data) {
            summary.success = data.success;
        }
        if ("msg" in data) {
            summary.msgPreview = summarizeForLog(data.msg, 160);
        }
        if ("message" in data && typeof data.message === "string") {
            summary.messagePreview = summarizeForLog(data.message, 160);
        }
        if (Array.isArray(data.choices)) {
            summary.choices = data.choices.slice(0, 3).map(choice => {
                const message = choice?.message || {};
                const content = message.content ?? choice?.text ?? choice?.delta?.content;
                return {
                    finishReason: choice?.finish_reason || choice?.finishReason || "",
                    messageKeys: Object.keys(message || {}).slice(0, 12),
                    contentType: Array.isArray(content) ? "array" : typeof content,
                    contentChars: typeof content === "string" ? content.length : 0,
                    contentPartTypes: Array.isArray(content) ? content.slice(0, 8).map(part => part?.type || typeof part) : [],
                    reasoningChars: typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0,
                    refusalChars: typeof message.refusal === "string" ? message.refusal.length : 0
                };
            });
        }
        if (depth < 2) {
            ["data", "result", "payload"].forEach(key => {
                if (!Object.prototype.hasOwnProperty.call(data, key)) {
                    return;
                }
                const value = data[key];
                summary[key + "Type"] = Array.isArray(value) ? "array" : String(typeof value);
                if (typeof value === "string") {
                    summary[key + "Preview"] = summarizeForLog(value, 160);
                }
                if (value != null && (typeof value === "object" || typeof value === "string")) {
                    summary[key + "Shape"] = summarizeResponseShape(value, parsedText, depth + 1);
                }
            });
        }
        if (Array.isArray(data.candidates)) {
            summary.candidates = data.candidates.slice(0, 3).map(candidate => ({
                finishReason: candidate?.finishReason || "",
                partCount: candidate?.content?.parts?.length || 0,
                partTypes: (candidate?.content?.parts || []).slice(0, 8).map(part => Object.keys(part || {}).join(","))
            }));
        }
        return summary;
    }

    async function writeDebugLog(options, stage, data) {
        try {
            if (typeof options?.debugLog === "function") {
                await options.debugLog(stage, data || {});
            }
        } catch (_) {
            // Debug logging must never affect API calls.
        }
    }

    async function getConfigPath() {
        if (!window.electronAPI || !window.electronAPI.getUserDataPath) {
            return null;
        }
        const userDataPath = await window.electronAPI.getUserDataPath();
        const sep = userDataPath.includes("/") ? "/" : "\\";
        const base = userDataPath.replace(/[\\/]+$/, "") + sep + "yuki-vision-mod";
        if (window.electronAPI.ensureDirectory) {
            await window.electronAPI.ensureDirectory(base);
        }
        return base + sep + "config.json";
    }

    async function readConfigFile() {
        const filePath = await getConfigPath();
        if (!filePath || !window.electronAPI || !window.electronAPI.readSQLiteFile) {
            const cached = localStorage.getItem("yuki_vision_mod_config");
            return cached ? JSON.parse(cached) : null;
        }
        const result = await window.electronAPI.readSQLiteFile(filePath);
        if (!result || !result.success || !Array.isArray(result.data)) {
            return null;
        }
        return JSON.parse(decodeText(result.data));
    }

    async function writeConfigFile(config) {
        const normalized = mergeConfig(config);
        normalized.version = 1;
        const json = JSON.stringify(normalized, null, 2);
        const filePath = await getConfigPath();
        if (!filePath || !window.electronAPI || !window.electronAPI.writeSQLiteFile) {
            localStorage.setItem("yuki_vision_mod_config", json);
            return normalized;
        }
        const result = await window.electronAPI.writeSQLiteFile(filePath, encodeText(json));
        if (!result || !result.success) {
            throw new Error(result && result.error ? result.error : "保存配置失败");
        }
        return normalized;
    }

    async function loadConfig() {
        try {
            const config = await readConfigFile();
            return mergeConfig(config);
        } catch (error) {
            console.warn("[YukiVisionMod] 读取配置失败，使用默认配置:", error);
            return mergeConfig(null);
        }
    }

    async function saveConfig(config) {
        return await writeConfigFile(mergeConfig(config));
    }

    async function updateRuntimeStatus(state, message) {
        try {
            const config = await loadConfig();
            config.runtimeStatus = {
                lastState: String(state || ""),
                lastMessage: String(message || "").slice(0, 300),
                lastUpdated: new Date().toISOString()
            };
            await saveConfig(config);
        } catch (error) {
            console.warn("[YukiVisionMod] 保存运行状态失败:", error);
        }
    }

    function resolveApiConfig(config) {
        const merged = mergeConfig(config);
        if (merged.apiMode === "inherit") {
            return {
                kind: "openai",
                baseurl: merged.inheritedApi.baseurl,
                modelname: merged.inheritedApi.modelname,
                apiKey: merged.inheritedApi.apiKey
            };
        }
        if (merged.apiMode === "openai") {
            return {
                kind: "openai",
                baseurl: merged.openai.baseurl,
                modelname: merged.openai.modelname,
                apiKey: merged.openai.apiKey
            };
        }
        return {
            kind: "custom",
            endpoint: merged.custom.endpoint,
            apiKey: merged.custom.apiKey
        };
    }

    function getRealtimeRegionBaseUrl(region) {
        return region === "intl-singapore"
            ? "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime"
            : "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
    }

    function getDefaultRealtimeVoice(model) {
        const normalized = String(model || "").toLowerCase();
        if (normalized.includes("qwen3.5-omni")) {
            return "Tina";
        }
        return "Cherry";
    }

    function normalizeRealtimeVoice(model, voice) {
        const raw = String(voice || "").trim();
        const fallback = getDefaultRealtimeVoice(model);
        if (!raw) {
            return fallback;
        }
        if (String(model || "").toLowerCase().includes("qwen3.5-omni") && raw.toLowerCase() === "cherry") {
            return fallback;
        }
        return raw;
    }

    function getRealtimeImagePresetConfig(realtime) {
        const source = realtime || {};
        const presetId = REALTIME_IMAGE_PRESETS[source.imagePreset] ? source.imagePreset : "standard";
        const preset = REALTIME_IMAGE_PRESETS[presetId] || REALTIME_IMAGE_PRESETS.standard;
        return {
            imagePreset: presetId,
            imageMaxBytes: Math.round(clampNumber(
                preset.imageMaxBytes,
                30000,
                QWEN_REALTIME_MAX_IMAGE_BYTES,
                preset.imageMaxBytes
            )),
            imageMaxDim: Math.round(clampNumber(
                preset.imageMaxDim,
                360,
                1920,
                preset.imageMaxDim
            )),
            imageJpegQuality: Math.round(clampNumber(
                preset.imageJpegQuality,
                40,
                95,
                preset.imageJpegQuality
            ))
        };
    }

    function getRealtimeConfig(config) {
        const merged = mergeConfig(config);
        const realtime = { ...DEFAULT_CONFIG.realtime, ...(merged.realtime || {}) };
        const region = "cn-beijing";
        const model = realtime.model === "custom"
            ? String(realtime.customModel || "").trim()
            : String(realtime.model || "").trim();
        const baseUrl = getRealtimeRegionBaseUrl(region);
        const audioMode = realtime.audioMode === "qwenAudio" ? "qwenAudio" : "gameTts";
        const imagePreset = getRealtimeImagePresetConfig(realtime);
        const autoObserveDelaySec = Math.max(5, Math.min(600, Number(realtime.autoObserveIntervalSec || 60)));
        return {
            ...realtime,
            region,
            baseUrl,
            model,
            audioMode,
            voice: normalizeRealtimeVoice(model, realtime.voice),
            screenFps: 1,
            imagePreset: imagePreset.imagePreset,
            imageMaxBytes: imagePreset.imageMaxBytes,
            imageMaxDim: imagePreset.imageMaxDim,
            imageJpegQuality: imagePreset.imageJpegQuality,
            autoObserveEnabled: realtime.autoObserveEnabled === true,
            autoObserveIntervalSec: autoObserveDelaySec,
            autoObserveSilenceSec: autoObserveDelaySec,
            autoObserveStyle: ["quiet", "game_assist", "active"].includes(realtime.autoObserveStyle) ? realtime.autoObserveStyle : "game_assist"
        };
    }

    function isRealtimeEngine(config) {
        const engine = mergeConfig(config).engine;
        return engine === "qwenRealtime" || engine === "doubaoRtc";
    }

    function isQwenRealtimeEngine(config) {
        return mergeConfig(config).engine === "qwenRealtime";
    }

    function isDoubaoRtcEngine(config) {
        return mergeConfig(config).engine === "doubaoRtc";
    }

    function normalizeDoubaoImageHeight(value, videoPreset) {
        const numeric = Number(value);
        const maxHeight = DOUBAO_VIDEO_PRESET_HEIGHTS[videoPreset] || DOUBAO_VIDEO_PRESET_HEIGHTS.standard;
        const allowed = DOUBAO_IMAGE_HEIGHT_PRESETS.filter(preset => preset <= maxHeight);
        const presets = allowed.length ? allowed : [DOUBAO_IMAGE_HEIGHT_PRESETS[0]];
        if (!Number.isFinite(numeric)) {
            return presets[presets.length - 1] || 720;
        }
        return presets.reduce((best, preset) => {
            return Math.abs(preset - numeric) < Math.abs(best - numeric) ? preset : best;
        }, presets[presets.length - 1] || 720);
    }

    function getDoubaoRtcConfig(config) {
        const merged = mergeConfig(config);
        const rawDoubao = merged.doubaoRtc || {};
        const source = { ...DEFAULT_CONFIG.doubaoRtc, ...rawDoubao };
        const screenMode = ["always_1fps", "ptt_1fps", "low_frequency", "off"].includes(source.screenMode)
            ? source.screenMode
            : "always_1fps";
        const videoPreset = ["economy", "standard", "clear", "max", "custom"].includes(source.videoPreset)
            ? source.videoPreset
            : "standard";
        const autoStyle = ["quiet", "game_assist", "active"].includes(source.autoObserveStyle)
            ? source.autoObserveStyle
            : "game_assist";
        const audioMode = source.audioMode === "localTts" ? "localTts" : "remoteTts";
        const screenShareEngine = rawDoubao.screenShareEngine === "native" || (!rawDoubao.screenShareEngine && source.nativeScreenShareEnabled === true)
            ? "native"
            : "web";
        const autoObserveDelaySec = Math.max(5, Math.min(600, Number(source.autoObserveIntervalSec || 60)));
        return {
            ...source,
            provider: "doubao",
            enabled: merged.engine === "doubaoRtc",
            region: "cn-north-1",
            accessKeyId: String(source.accessKeyId || "").trim(),
            secretAccessKey: String(source.secretAccessKey || "").trim(),
            appId: String(source.appId || "").trim(),
            appKey: String(source.appKey || "").trim(),
            manualToken: "",
            roomIdPrefix: "yuki_mod_",
            userIdPrefix: "user_",
            botUserId: "yuki_bot",
            tokenTtlSec: 172800,
            endpointId: String(source.endpointId || "").trim(),
            asrMode: "bigmodel",
            asrAppId: String(source.asrAppId || "").trim(),
            asrAccessToken: String(source.asrAccessToken || "").trim(),
            asrApiResourceId: "volc.bigasr.sauc.duration",
            audioMode,
            ttsAppId: String(source.ttsAppId || "").trim(),
            ttsAccessToken: String(source.ttsAccessToken || "").trim(),
            ttsVoiceType: String(source.ttsVoiceType || "zh_female_meilinvyou_moon_bigtts").trim() || "zh_female_meilinvyou_moon_bigtts",
            screenShareEngine,
            nativeScreenShareEnabled: screenShareEngine === "native",
            screenMode,
            screenFps: 1,
            videoPreset,
            imageHeight: normalizeDoubaoImageHeight(source.imageHeight || 720, videoPreset),
            imageDetail: source.imageDetail === "low" ? "low" : "high",
            autoObserveEnabled: source.autoObserveEnabled !== false,
            autoObserveIntervalSec: autoObserveDelaySec,
            autoObserveSilenceSec: autoObserveDelaySec,
            autoObserveStyle: autoStyle,
            vadSilenceTimeMs: 800,
            interruptSpeechDurationMs: 0
        };
    }

    function isDeepSeekOpenAIConfig(api) {
        if (!api || api.kind !== "openai") {
            return false;
        }
        const text = [api.baseurl, api.modelname].filter(Boolean).join(" ").toLowerCase();
        return text.includes("deepseek") || /(^|[-_])deepseek([-_]|$)/i.test(String(api.modelname || ""));
    }

    function isGeminiOpenAIConfig(api) {
        if (!api || api.kind !== "openai") {
            return false;
        }
        const text = [api.baseurl, api.modelname].filter(Boolean).join(" ").toLowerCase();
        return text.includes("gemini") || text.includes("googleapis.com");
    }

    function isQwenOpenAIConfig(api) {
        if (!api || api.kind !== "openai") {
            return false;
        }
        const text = [api.baseurl, api.modelname].filter(Boolean).join(" ").toLowerCase();
        return text.includes("dashscope") ||
            text.includes("aliyuncs.com/compatible-mode") ||
            text.includes("qwen") ||
            text.includes("通义") ||
            /(^|[/\s_-])qvq([/\s_-]|$)/i.test(String(api.modelname || ""));
    }

    function isDashScopeOpenAIConfig(api) {
        if (!api || api.kind !== "openai") {
            return false;
        }
        const baseurl = String(api.baseurl || "").toLowerCase();
        return baseurl.includes("dashscope") ||
            baseurl.includes("aliyuncs.com/compatible-mode") ||
            baseurl.includes("bailian");
    }

    function isQwenVisionModel(api) {
        const model = String(api?.modelname || "").toLowerCase();
        return /(^|[/\s_-])qwen(2\.5|3)?[-_.]?vl([/\s_-]|$)/i.test(model) ||
            model.includes("qwen-vl") ||
            model.includes("qwen3-vl") ||
            model.includes("qwen2.5-vl") ||
            model.includes("qwen-vl-ocr") ||
            /(^|[/\s_-])qvq([/\s_-]|$)/i.test(model) ||
            model.includes("qwen-omni") ||
            model.includes("qwen3-omni");
    }

    function isQwenStreamOnlyModel(api) {
        const model = String(api?.modelname || "").toLowerCase();
        return /(^|[/\s_-])qvq([/\s_-]|$)/i.test(model);
    }

    function supportsHttpStreaming(config) {
        const api = resolveApiConfig(config);
        if (!api || api.kind !== "openai") {
            return false;
        }
        if (isQwenStreamOnlyModel(api)) {
            return true;
        }
        const text = [api.baseurl, api.modelname].filter(Boolean).join(" ").toLowerCase();
        return [
            "openai",
            "azure",
            "dashscope",
            "aliyuncs.com/compatible-mode",
            "qwen",
            "通义",
            "moonshot",
            "kimi",
            "siliconflow",
            "openrouter",
            "groq",
            "mistral",
            "x.ai",
            "xai",
            "grok",
            "deepseek",
            "gemini",
            "googleapis.com",
            "gptsapi",
            "volcengine",
            "ark",
            "bigmodel",
            "zhipu",
            "01.ai",
            "lingyiwanwu"
        ].some(keyword => text.includes(keyword));
    }

    function isLikelyStreamingUnsupportedError(error) {
        const message = String(error?.message || error || "");
        return /stream|streaming|event-stream|sse/i.test(message) &&
            /unsupported|not\s+support|does\s+not\s+support|invalid|unknown|400|422/i.test(message);
    }

    function supportsImageInput(config) {
        const api = resolveApiConfig(config);
        if (api.kind === "custom") {
            return true;
        }
        if (isQwenOpenAIConfig(api)) {
            return isQwenVisionModel(api);
        }
        return !isDeepSeekOpenAIConfig(api);
    }

    function getCompatibilityMessage(config) {
        const api = resolveApiConfig(config);
        if (isDeepSeekOpenAIConfig(api)) {
            return "DeepSeek 官方 Chat Completions 接口当前按纯文本消息解析，不支持 image_url 截图输入。MOD 已自动改用文字模式；如需真正识别屏幕，请换支持图片输入的多模态模型或自定义端点。";
        }
        if (isQwenOpenAIConfig(api) && !isQwenVisionModel(api)) {
            return "当前 Qwen 模型看起来不是视觉模型，MOD 已自动改用文字模式；如需截图识别，请使用 qwen-vl、qwen3-vl、qwen2.5-vl、qwen-vl-ocr、qvq 或 Qwen-Omni 系列模型。";
        }
        if (isQwenStreamOnlyModel(api)) {
            return "当前 Qwen/QVQ 模型需要流式输出，MOD 已自动使用 Qwen 流式兼容模式。";
        }
        return "";
    }

    function getReplyMaxTokensForChars(maxChars) {
        const max = Number(maxChars || 90);
        if (max <= 40) {
            return 384;
        }
        if (max <= 90) {
            return 640;
        }
        if (max <= 180) {
            return 1024;
        }
        return Math.round(clampNumber(max * 6, 1024, 3072, 1536));
    }

    function getReplySentenceLimit(maxChars) {
        const max = Number(maxChars || 90);
        if (max <= 40) {
            return 2;
        }
        if (max <= 90) {
            return 3;
        }
        if (max <= 180) {
            return 5;
        }
        return Math.round(clampNumber(Math.ceil(max / 45) + 1, 5, 8, 6));
    }

    function getReplyLengthProfile(config) {
        const minChars = Math.round(clampNumber(config?.replyMinChars, 10, 500, DEFAULT_CONFIG.replyMinChars));
        const maxChars = Math.max(
            minChars,
            Math.round(clampNumber(config?.replyMaxChars, 20, 800, DEFAULT_CONFIG.replyMaxChars))
        );
        const maxSentences = getReplySentenceLimit(maxChars);
        const guidance = `回复长度硬性限制：必须控制在 ${minChars}-${maxChars} 个中文字之间，最多 ${maxSentences} 句。不要分段，不要列清单，不要写长篇解释；如果想说更多，也必须压缩到这个字数范围内。`;
        const repairGuidance = `硬性要求：必须控制在 ${minChars}-${maxChars} 个中文字之间，最多 ${maxSentences} 句；必须用完整句号、感叹号或问号收尾。`;
        return {
            mode: "custom",
            guidance,
            repairGuidance,
            minChars,
            maxTokens: getReplyMaxTokensForChars(maxChars),
            maxSentences,
            maxChars
        };
    }

    function getExtraPrompt(config) {
        return String(config?.extraPrompt || "").trim().slice(0, 2000);
    }

    function buildDefaultReplyRules() {
        return [
            "输出格式：只输出角色对话本身，不要输出角色动作、神情、旁白、舞台指示、括号描述或表情标签。",
            "避免刻板复读：不要因为前几轮说过某个独特词、比喻、外号或梗，就在后续对话里反复使用它；除非当前画面或用户明确再次提到，否则要换一种新鲜、自然的说法。",
            "可以提及刚刚发生的事，但不要把一次临时形容变成口头禅；同一个醒目的词或玩笑最近出现过，就主动避开或换表达。",
            "如果判断玩家正在游戏，请将对话仅专注于当前游戏画面和游玩决策，不要跑题聊软件、窗口或泛泛情绪。",
            "游戏状态下优先给玩家有效信息：例如可见敌人的大致位置、方向、距离感、危险点、路线、资源、任务目标、可交互物、UI 状态或下一步建议；不确定时要说“好像/可能”。",
            "可以识别画面里的文字，但回复时不要复读、照抄屏幕文字内容；只在必要时概括含义、提醒重点或结合上下文回应。"
        ].join("\n");
    }

    function buildUserGuidance(config) {
        const profile = getReplyLengthProfile(config);
        const extraPrompt = getExtraPrompt(config);
        return [
            profile.guidance,
            buildDefaultReplyRules(),
            "回复长度设置优先级最高；即使截图内容很多，也必须遵守上面的句数和字数范围。",
            "字数按中文字符粗略计算，不要为了凑字数复读同一个信息、同一个词或同一句话。",
            "不要使用项目符号、编号列表、换行分段或长篇分析；只输出一段自然角色对话。",
            "必须一次性完整回答，不要把同一段话拆成两次补充；每次回复都用完整句子收尾。",
            "不要以逗号、冒号、顿号、省略号或半句话结尾；如果内容太长，就主动缩短到能完整说完。",
            extraPrompt ? "用户附加 Prompt：" + extraPrompt : ""
        ].filter(Boolean).join("\n");
    }

    function getMaxOutputTokens(config, api) {
        const configured = Number(config?.maxOutputTokens);
        if (Number.isFinite(configured) && configured > 0) {
            return Math.round(clampNumber(configured, 128, 4096, 1024));
        }
        if (isGeminiOpenAIConfig(api)) {
            return null;
        }
        const profile = getReplyLengthProfile(config);
        return profile.maxTokens;
    }

    const VISION_PRESETS = {
        single: {
            id: "single",
            frameCount: 1,
            sampleEnabled: false,
            sampleIntervalSec: 2,
            collageMaxDim: 1280,
            collageJpegQuality: 80,
            targetSpanSec: 0,
            minFrameGapSec: 0,
            highFrameIntervalSec: 0,
            captureMaxDim: 1280,
            captureJpegQuality: 80
        },
        lite: {
            id: "lite",
            frameCount: 3,
            sampleEnabled: true,
            sampleIntervalSec: 2,
            collageMaxDim: 2560,
            collageJpegQuality: 76,
            targetSpanSec: 8,
            minFrameGapSec: 2,
            highFrameIntervalSec: 3,
            captureMaxDim: 1280,
            captureJpegQuality: 80
        },
        balanced: {
            id: "balanced",
            frameCount: 4,
            sampleEnabled: true,
            sampleIntervalSec: 2,
            collageMaxDim: 2816,
            collageJpegQuality: 76,
            targetSpanSec: 12,
            minFrameGapSec: 2,
            highFrameIntervalSec: 4,
            captureMaxDim: 1408,
            captureJpegQuality: 82
        },
        dynamic: {
            id: "dynamic",
            frameCount: 6,
            sampleEnabled: true,
            sampleIntervalSec: 2,
            collageMaxDim: 3200,
            collageJpegQuality: 76,
            targetSpanSec: 30,
            minFrameGapSec: 3,
            highFrameIntervalSec: 6,
            captureMaxDim: 1440,
            captureJpegQuality: 82
        },
        premium: {
            id: "premium",
            frameCount: 8,
            sampleEnabled: true,
            sampleIntervalSec: 2,
            collageMaxDim: 3584,
            collageJpegQuality: 78,
            targetSpanSec: 48,
            minFrameGapSec: 4,
            highFrameIntervalSec: 7,
            captureMaxDim: 1440,
            captureJpegQuality: 82
        },
        ultra: {
            id: "ultra",
            frameCount: 10,
            sampleEnabled: true,
            sampleIntervalSec: 2,
            collageMaxDim: 4096,
            collageJpegQuality: 78,
            targetSpanSec: 60,
            minFrameGapSec: 5,
            highFrameIntervalSec: 7,
            captureMaxDim: 1440,
            captureJpegQuality: 82
        },
        extreme: {
            id: "extreme",
            frameCount: 12,
            sampleEnabled: true,
            sampleIntervalSec: 2,
            collageMaxDim: 4096,
            collageJpegQuality: 80,
            targetSpanSec: 90,
            minFrameGapSec: 6,
            highFrameIntervalSec: 8,
            captureMaxDim: 1536,
            captureJpegQuality: 84
        }
    };

    function getVisionPresetConfig(config) {
        const merged = mergeConfig(config);
        const preset = VISION_PRESETS[merged.visionPreset] || VISION_PRESETS.balanced;
        const sampleIntervalSec = Math.round(clampNumber(merged.visionSampleIntervalSec, 1, 10, preset.sampleIntervalSec));
        const customMaxDim = Number(merged.visionCollageMaxDim);
        const customQuality = Number(merged.visionCollageJpegQuality);
        const defaultHighFrameIntervalSec = Math.max(2, Number(preset.highFrameIntervalSec || sampleIntervalSec));
        const uploadIntervalSec = Math.max(2, Number(merged.uploadIntervalSec || DEFAULT_CONFIG.uploadIntervalSec));
        const autoCooldownSec = Math.max(5, Number(merged.autoCooldownSec || merged.idleTimeoutSec || uploadIntervalSec));
        const internalTargetSpanSec = Number(merged.visionTargetSpanSec || 0);
        const targetFrameCount = Math.max(1, Number(preset.frameCount || 1));
        const targetSpanSec = preset.sampleEnabled
            ? Math.max(2, internalTargetSpanSec > 0 ? internalTargetSpanSec : autoCooldownSec)
            : preset.targetSpanSec;
        const adaptiveHighFrameIntervalSec = preset.sampleEnabled
            ? Math.max(0.5, targetSpanSec / Math.max(1, targetFrameCount))
            : defaultHighFrameIntervalSec;
        const adaptiveMinFrameGapSec = preset.sampleEnabled
            ? 0
            : Math.max(1, Math.min(Number(preset.minFrameGapSec || 1), adaptiveHighFrameIntervalSec));
        return {
            ...preset,
            sampleIntervalSec,
            collageMaxDim: customMaxDim > 0 ? Math.round(clampNumber(customMaxDim, 640, 4096, preset.collageMaxDim)) : preset.collageMaxDim,
            collageJpegQuality: customQuality > 0 ? Math.round(clampNumber(customQuality, 40, 95, preset.collageJpegQuality)) : preset.collageJpegQuality,
            targetSpanSec,
            defaultTargetSpanSec: preset.targetSpanSec,
            minFrameGapSec: adaptiveMinFrameGapSec,
            highFrameIntervalSec: adaptiveHighFrameIntervalSec,
            defaultHighFrameIntervalSec,
            captureMaxDim: preset.captureMaxDim || DEFAULT_CONFIG.imageMaxDim,
            captureJpegQuality: preset.captureJpegQuality || DEFAULT_CONFIG.imageJpegQuality
        };
    }

    function validateConfig(config, requireEnabled) {
        const merged = mergeConfig(config);
        if (requireEnabled && !merged.enabled) {
            return { ok: false, message: "桌宠 MOD 全模态未启用" };
        }
        if (isDoubaoRtcEngine(merged)) {
            const doubao = getDoubaoRtcConfig(merged);
            if (!doubao.accessKeyId || !doubao.secretAccessKey) {
                return { ok: false, message: "请填写火山 OpenAPI AK/SK" };
            }
            if (!doubao.appId || !doubao.appKey) {
                return { ok: false, message: "请填写 RTC AppId 和 AppKey" };
            }
            if (!doubao.endpointId) {
                return { ok: false, message: "请填写火山方舟 Endpoint ID" };
            }
            if (!doubao.asrAppId) {
                return { ok: false, message: "请填写豆包语音 ASR AppId" };
            }
            if (!doubao.asrAccessToken) {
                return { ok: false, message: "大模型 ASR 需要填写 ASR Access Token" };
            }
            if (!doubao.ttsAppId || !doubao.ttsAccessToken) {
                return { ok: false, message: "豆包 RTC 需要填写 TTS AppId 和 TTS Access Token" };
            }
            if (!["always_1fps", "ptt_1fps", "low_frequency", "off"].includes(doubao.screenMode)) {
                return { ok: false, message: "请选择有效的豆包 RTC 屏幕流模式" };
            }
            return { ok: true, message: "配置可用" };
        }
        if (isQwenRealtimeEngine(merged)) {
            const realtime = getRealtimeConfig(merged);
            if (realtime.provider !== "qwen") {
                return { ok: false, message: "Realtime v1 仅支持 Qwen" };
            }
            if (!realtime.apiKey) {
                return { ok: false, message: "请填写 DashScope API Key" };
            }
            if (!realtime.baseUrl || !/^wss:\/\//i.test(realtime.baseUrl)) {
                return { ok: false, message: "请填写有效的 Qwen Realtime WebSocket 地址" };
            }
            if (!realtime.model) {
                return { ok: false, message: "请选择或填写 Qwen Realtime 模型" };
            }
            if (!["always_1fps", "ptt_1fps", "low_frequency", "off"].includes(realtime.screenMode)) {
                return { ok: false, message: "请选择有效的 Realtime 屏幕帧模式" };
            }
            return { ok: true, message: "配置可用" };
        }
        const api = resolveApiConfig(merged);
        if (api.kind === "openai") {
            if (!api.baseurl || !api.modelname || !api.apiKey) {
                return { ok: false, message: "请填写 Base URL、模型名称和 API Key" };
            }
        } else if (!api.endpoint) {
            return { ok: false, message: "请填写自定义端点 URL" };
        }
        if (!Number.isFinite(Number(merged.uploadIntervalSec)) || Number(merged.uploadIntervalSec) < 2) {
            return { ok: false, message: "上传间隔不能小于 2 秒" };
        }
        if (!Number.isFinite(Number(merged.idleTimeoutSec)) || Number(merged.idleTimeoutSec) < 5) {
            return { ok: false, message: "闲置触发不能小于 5 秒" };
        }
        if (!Number.isFinite(Number(merged.autoCooldownSec)) || Number(merged.autoCooldownSec) < 5) {
            return { ok: false, message: "自动回复冷却不能小于 5 秒" };
        }
        const maxOutputTokens = Number(merged.maxOutputTokens || 0);
        if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 0 || maxOutputTokens > 4096) {
            return { ok: false, message: "单次 token 上限需要填 0-4096" };
        }
        const replyMinChars = Number(merged.replyMinChars || 0);
        const replyMaxChars = Number(merged.replyMaxChars || 0);
        if (!Number.isFinite(replyMinChars) || replyMinChars < 10 || replyMinChars > 500) {
            return { ok: false, message: "最低回复字数需要填 10-500" };
        }
        if (!Number.isFinite(replyMaxChars) || replyMaxChars < 20 || replyMaxChars > 800) {
            return { ok: false, message: "最高回复字数需要填 20-800" };
        }
        if (replyMaxChars < replyMinChars) {
            return { ok: false, message: "最高回复字数不能小于最低回复字数" };
        }
        if (!VISION_PRESETS[merged.visionPreset]) {
            return { ok: false, message: "请选择有效的画面理解预设" };
        }
        if (!Number.isFinite(Number(merged.visionSampleIntervalSec)) || Number(merged.visionSampleIntervalSec) < 1 || Number(merged.visionSampleIntervalSec) > 10) {
            return { ok: false, message: "动态采样间隔需要在 1-10 秒之间" };
        }
        return { ok: true, message: "配置可用" };
    }

    function isSuccessfulBusinessCode(value) {
        if (value == null || value === "") {
            return true;
        }
        if (typeof value === "boolean") {
            return value;
        }
        const text = String(value).trim().toLowerCase();
        return text === "0" ||
            text === "200" ||
            text === "ok" ||
            text === "success" ||
            text === "succeeded" ||
            text === "true";
    }

    function getApiBusinessErrorMessage(data) {
        if (!data || typeof data !== "object") {
            return "";
        }
        const hasCode = Object.prototype.hasOwnProperty.call(data, "code");
        const hasStatus = Object.prototype.hasOwnProperty.call(data, "status");
        const hasSuccess = Object.prototype.hasOwnProperty.call(data, "success");
        const codeValue = hasCode ? data.code : (hasStatus ? data.status : (hasSuccess ? data.success : null));
        if (!hasCode && !hasStatus && !hasSuccess) {
            return "";
        }
        if (isSuccessfulBusinessCode(codeValue)) {
            return "";
        }
        const message = data.error?.message ||
            data.error ||
            data.msg ||
            data.message ||
            data.detail ||
            data.reason ||
            "接口返回了非成功状态";
        return "API 返回 code/status=" + String(codeValue) + ": " + String(message);
    }

    function unwrapApiEnvelope(data, depth = 0) {
        if (!data || typeof data !== "object" || depth >= 4) {
            return data;
        }
        const keys = Object.keys(data);
        const looksWrapped = (
            ("code" in data || "status" in data || "success" in data || "msg" in data) &&
            ("data" in data || "result" in data || "payload" in data)
        );
        if (looksWrapped) {
            const nested = data.data ?? data.result ?? data.payload;
            if (nested != null) {
                return unwrapApiEnvelope(nested, depth + 1);
            }
        }
        if (keys.length === 1 && (keys[0] === "data" || keys[0] === "result" || keys[0] === "payload")) {
            return unwrapApiEnvelope(data[keys[0]], depth + 1);
        }
        return data;
    }

    function extractResponseText(data, depth = 0) {
        if (depth > 8) {
            return "";
        }
        if (typeof data === "string") {
            return data;
        }
        if (Array.isArray(data)) {
            return data.map(item => extractResponseText(item, depth + 1)).filter(Boolean).join("");
        }
        if (!data || typeof data !== "object") {
            return "";
        }
        const choice = data.choices?.[0] || {};
        const messageContent = choice.message?.content;
        const messageText = Array.isArray(messageContent)
            ? messageContent.map(part => part?.text || part?.content || "").join("")
            : messageContent;
        const outputContent = Array.isArray(data.output?.[0]?.content)
            ? data.output[0].content.map(part => part?.text || part?.content || "").join("")
            : "";
        const candidateText = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("");
        const directText = data.text ||
            data.reply ||
            data.answer ||
            data.output_text ||
            choice.delta?.content ||
            choice.text ||
            outputContent ||
            candidateText ||
            messageText ||
            "";
        if (directText) {
            return directText;
        }
        const recursiveKeys = ["content", "message", "response", "result", "data", "payload", "output"];
        for (const key of recursiveKeys) {
            if (!Object.prototype.hasOwnProperty.call(data, key)) {
                continue;
            }
            const value = data[key];
            if (typeof value === "string") {
                return value;
            }
            const nestedText = extractResponseText(value, depth + 1);
            if (nestedText) {
                return nestedText;
            }
        }
        return "";
    }

    function parseResponseText(data) {
        return extractResponseText(unwrapApiEnvelope(data));
    }

    function getFinishReason(data) {
        data = unwrapApiEnvelope(data);
        return String(data?.choices?.[0]?.finish_reason ||
            data?.choices?.[0]?.finishReason ||
            data?.candidates?.[0]?.finishReason ||
            "").toLowerCase();
    }

    function isLikelyIncompleteReply(text, data) {
        const reply = String(text || "").trim();
        if (!reply) {
            return false;
        }
        const finishReason = getFinishReason(data);
        if (finishReason === "length" || finishReason === "max_tokens" || finishReason === "max_output_tokens") {
            return true;
        }
        if (/[，,、：:；;（(「『“‘《【\[]$/.test(reply)) {
            return true;
        }
        if (/[。！？!?~～」』”’》】\]]$/.test(reply)) {
            return false;
        }
        return reply.length >= 16;
    }

    function isContentSafetyError(error) {
        const message = String(error?.message || error || "");
        return !!(error?.yukiVisionContentRejected) ||
            /(^|\b)safety($|\b)|prohibited[_\s-]*content|blocklist|spii|inappropriate content|content[_\s-]*filter|content[_\s-]*policy|policy[_\s-]*violation|data[_\s-]*inspection|responsibleai|responsible ai|content management policy|sensitive content|prohibited content|blocked by safety|blocked due to safety|safety system|safety filter|moderation|input data may contain|output data may contain|content exists risk|risk control|内容安全|安全策略|安全审核|不合适|违规|敏感内容|风险内容|内容风险|审核拒绝/i.test(message);
    }

    function detectContentSafetyProvider(value) {
        const text = String(value?.message || value || "").toLowerCase();
        if (/dashscope|aliyun|qwen|data[_\s-]*inspection|inappropriate-content/.test(text)) {
            return "Qwen/DashScope";
        }
        if (/gemini|google|promptfeedback|finishreason.*safety|prohibited_content|safetyratings/.test(text)) {
            return "Gemini";
        }
        if (/azure|responsibleai|content management policy/.test(text)) {
            return "Azure OpenAI";
        }
        if (/openai|content_policy_violation|content[_\s-]*filter|moderation/.test(text)) {
            return "OpenAI";
        }
        if (/deepseek|content exists risk|risk control/.test(text)) {
            return "DeepSeek";
        }
        if (/anthropic|claude/.test(text)) {
            return "Claude/Anthropic";
        }
        return "模型服务商";
    }

    function getContentSafetyErrorMessage(error) {
        const provider = error?.yukiVisionProvider || detectContentSafetyProvider(error);
        return provider + " 内容安全拒绝了当前输入。通常是截图、文字或上下文里包含敏感/不合适内容；可以换个画面、关闭敏感窗口，或改用审查更适合该场景的模型。";
    }

    function markContentSafetyError(error, fallbackMessage) {
        const target = error instanceof Error ? error : new Error(String(error || fallbackMessage || "Content safety rejected"));
        target.yukiVisionContentRejected = true;
        target.yukiVisionProvider = detectContentSafetyProvider(target.message || fallbackMessage);
        target.yukiVisionContentMessage = getContentSafetyErrorMessage(target);
        return target;
    }

    function getContentSafetyMessageFromResponse(data) {
        data = unwrapApiEnvelope(data);
        if (!data || typeof data !== "object") {
            return "";
        }
        const directError = data.error?.message || data.error || data.message || "";
        if (directError && isContentSafetyError(directError)) {
            return String(directError);
        }
        const promptBlockReason = data.promptFeedback?.blockReason || data.prompt_feedback?.block_reason || "";
        if (promptBlockReason && /safety|prohibited|blocklist|spi|sensitive|recitation|other/i.test(String(promptBlockReason))) {
            return "Gemini prompt was blocked by safety policy: " + promptBlockReason;
        }
        const choiceReasons = Array.isArray(data.choices)
            ? data.choices.map(choice => choice?.finish_reason || choice?.finishReason || "").filter(Boolean)
            : [];
        const candidateReasons = Array.isArray(data.candidates)
            ? data.candidates.map(candidate => candidate?.finishReason || candidate?.finish_reason || "").filter(Boolean)
            : [];
        const reasons = choiceReasons.concat(candidateReasons);
        const blockedReason = reasons.find(reason => /content[_\s-]*filter|safety|prohibited|blocklist|spi|sensitive/i.test(String(reason)));
        if (blockedReason) {
            const reasonText = String(blockedReason);
            if (/content[_\s-]*filter/i.test(reasonText)) {
                return "OpenAI/Azure response was blocked by content_filter: " + reasonText;
            }
            if (/safety|prohibited|blocklist|spi/i.test(reasonText)) {
                return "Gemini response was blocked by safety policy: " + reasonText;
            }
            return "Response was blocked by safety policy: " + reasonText;
        }
        const serializedSafety = [
            data.prompt_filter_results,
            data.promptFilterResults,
            data.safetyRatings,
            data.candidates?.[0]?.safetyRatings
        ].filter(Boolean).map(item => {
            try {
                return JSON.stringify(item);
            } catch (_) {
                return String(item);
            }
        }).join(" ");
        if (serializedSafety && /blocked|filtered|high|medium|danger|harassment|hate|sex|violence|self[_\s-]*harm|safety/i.test(serializedSafety)) {
            return "Response was blocked by safety policy";
        }
        return "";
    }

    function buildVisionSequenceGuidance(options) {
        const frameCount = Number(options?.visionFrameCount || 1);
        const naturalRule = "回复时请自然描述画面和氛围，不要提到具体秒数、帧数、拼图或“检测到变化”这些技术词。";
        if (!options?.isVisionCollage || frameCount <= 1) {
            return naturalRule;
        }
        return [
            "动态画面要求：这张图片是一组按时间排列的关键截图，不是同一时刻的静态画面。",
            "请先按左上到右下的顺序理解整张拼图，再根据标注为“当前画面”的最后一帧给出当前判断或建议；不要只看最后一帧，也不要把拼图当成同一时刻的多个窗口。",
            "图片里的“约 xx 秒前”标签只用于帮助你理解先后顺序，回复时不要直接说出这些秒数或帧数。",
            "如果前后帧有移动、战斗、切换视角、状态变化或 UI 变化，请把这种变化自然用于回复。",
            "如果前后帧显示角色、窗口或画面在移动，不要说用户一直停在某处；只有连续多帧几乎没变化时，才可以判断画面基本静止。",
            naturalRule
        ].filter(Boolean).join("\n");
    }

    function buildOpenAIImagePart(dataUrl, api) {
        const imageUrl = { url: dataUrl };
        if (!isQwenOpenAIConfig(api)) {
            imageUrl.detail = "high";
        }
        return {
            type: "image_url",
            image_url: imageUrl
        };
    }

    function buildOpenAIMessages(options, config) {
        const api = resolveApiConfig(config);
        const systemPrompt = options.systemPrompt || "你是一个可以看到用户屏幕的桌面宠物，请用 1-2 句话自然回应。";
        const history = Array.isArray(options.history) ? options.history.slice(-8) : [];
        const text = options.text || "根据当前屏幕内容，自然地说一句。如果没有值得回应的内容，只回复 NO_REPLY。";
        const visualGuidance = [
            "视觉要求：请先观察截图里的窗口标题、主要文字和界面内容，再结合上下文回答。优先说确定能看清的内容；不确定就说“好像/可能”，不要编造。",
            buildVisionSequenceGuidance(options),
            buildUserGuidance(config)
        ].filter(Boolean).join("\n");
        const content = [{ type: "text", text: visualGuidance + "\n\n用户/触发内容：" + text }];
        if (options.activeWindowName) {
            content[0].text += "\n当前前台程序：" + options.activeWindowName;
        }
        if (options.screenshotDataUrl) {
            const imagePart = buildOpenAIImagePart(options.screenshotDataUrl, api);
            if (isQwenOpenAIConfig(api)) {
                content.unshift(imagePart);
            } else {
                content.push(imagePart);
            }
        }
        return [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content }
        ];
    }

    function buildOpenAIRepairMessages(options, incompleteText, config) {
        const api = resolveApiConfig(config);
        const systemPrompt = options.systemPrompt || "你是一个可以看到用户屏幕的桌面宠物，请自然回应。";
        const text = options.text || "根据当前屏幕内容，自然地说一句。";
        const profile = getReplyLengthProfile(config);
        const extraPrompt = getExtraPrompt(config);
        const repairText = [
            "上一条回复疑似被接口截断，请不要续写上一条，而是重新输出一条完整回复。",
            buildVisionSequenceGuidance(options),
            buildDefaultReplyRules(),
            profile.repairGuidance + " 不要以逗号、冒号、顿号、省略号或半句话结尾。",
            extraPrompt ? "用户附加 Prompt：" + extraPrompt : "",
            "用户/触发内容：" + text,
            incompleteText ? "被截断的上一条仅作参考，不要原样延续：" + String(incompleteText).slice(0, 300) : ""
        ].filter(Boolean).join("\n");
        const content = [{ type: "text", text: repairText }];
        if (options.activeWindowName) {
            content[0].text += "\n当前前台程序：" + options.activeWindowName;
        }
        if (options.screenshotDataUrl) {
            const imagePart = buildOpenAIImagePart(options.screenshotDataUrl, api);
            if (isQwenOpenAIConfig(api)) {
                content.unshift(imagePart);
            } else {
                content.push(imagePart);
            }
        }
        return [
            { role: "system", content: systemPrompt },
            { role: "user", content }
        ];
    }

    function buildOpenAITextOnlyMessages(options, config) {
        const systemPrompt = options.systemPrompt || "你是一个桌面宠物，请用自然、简短的方式回应。";
        const history = Array.isArray(options.history) ? options.history.slice(-8) : [];
        const text = options.text || "自然地回应一句。";
        const parts = [
            "当前 API 不支持图片输入，本轮不会发送截图。不要声称自己看到了截图或屏幕细节；只能根据触发文本、当前前台程序名和上下文自然回应。",
            "如果用户需要真正的屏幕识别能力，需要换成支持 image_url 的视觉模型或自定义端点。",
            buildUserGuidance(config),
            "用户/触发内容：" + text
        ];
        if (options.activeWindowName) {
            parts.push("当前前台程序：" + options.activeWindowName);
        }
        return [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: parts.join("\n") }
        ];
    }

    async function fetchJsonWithTimeout(url, fetchOptions, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || 45000);
        try {
            const response = await fetch(url, {
                ...fetchOptions,
                signal: controller.signal
            });
            const text = await response.text();
            let data = text;
            try {
                data = text ? JSON.parse(text) : {};
            } catch (_) {
                data = text;
            }
            if (!response.ok) {
                const message = typeof data === "string" ? data : (data.error?.message || data.message || response.statusText);
                throw new Error("HTTP " + response.status + ": " + message);
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    function parseOpenAIStreamEvent(data) {
        if (!data || data === "[DONE]") {
            return "";
        }
        try {
            const json = JSON.parse(data);
            const safetyMessage = getContentSafetyMessageFromResponse(json);
            if (safetyMessage) {
                throw markContentSafetyError(new Error(safetyMessage), safetyMessage);
            }
            const choice = json?.choices?.[0] || {};
            return choice.delta?.content ||
                choice.message?.content ||
                choice.text ||
                json.output?.text ||
                "";
        } catch (error) {
            if (error?.yukiVisionContentRejected) {
                throw error;
            }
            return "";
        }
    }

    async function fetchOpenAIStreamWithTimeout(url, fetchOptions, timeoutMs, handlers = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
        try {
            const response = await fetch(url, {
                ...fetchOptions,
                signal: controller.signal
            });
            if (!response.ok) {
                const text = await response.text();
                let data = text;
                try {
                    data = text ? JSON.parse(text) : {};
                } catch (_) {
                    data = text;
                }
                const message = typeof data === "string" ? data : (data.error?.message || data.message || response.statusText);
                throw new Error("HTTP " + response.status + ": " + message);
            }

            const reader = response.body?.getReader?.();
            if (!reader) {
                return "";
            }
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let output = "";
            let done = false;
            while (!done) {
                const chunk = await reader.read();
                done = !!chunk.done;
                buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !done });
                const events = buffer.split(/\n\n+/);
                buffer = events.pop() || "";
                events.forEach(eventText => {
                    const dataLines = eventText
                        .split(/\r?\n/)
                        .map(line => line.trim())
                        .filter(line => line.startsWith("data:"))
                        .map(line => line.slice(5).trim());
                    dataLines.forEach(dataLine => {
                        const delta = parseOpenAIStreamEvent(dataLine);
                        if (!delta) {
                            return;
                        }
                        output += delta;
                        try {
                            handlers.onDelta?.(delta, output);
                        } catch (callbackError) {
                            console.warn("[YukiVisionMod] stream delta callback failed:", callbackError);
                        }
                    });
                });
            }
            if (buffer.trim()) {
                buffer.split(/\r?\n/).forEach(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("data:")) {
                        const delta = parseOpenAIStreamEvent(trimmed.slice(5).trim());
                        if (delta) {
                            output += delta;
                            try {
                                handlers.onDelta?.(delta, output);
                            } catch (callbackError) {
                                console.warn("[YukiVisionMod] stream delta callback failed:", callbackError);
                            }
                        }
                    }
                });
            }
            return output;
        } finally {
            clearTimeout(timer);
        }
    }

    function getOpenAIExtraBody(api, options) {
        if (isDashScopeOpenAIConfig(api) && isQwenVisionModel(api) && options?.screenshotDataUrl) {
            return { vl_high_resolution_images: true };
        }
        return {};
    }

    function isUnsupportedTemperatureError(error) {
        return /unsupported\s+parameter:\s*['"]?temperature|temperature['"]?\s+is\s+not\s+supported|temperature.*unsupported/i.test(String(error?.message || error || ""));
    }

    function buildOpenAIChatBody(api, messages, config, extraBody, stream, includeTemperature) {
        const maxTokens = getMaxOutputTokens(config, api);
        const body = {
            model: api.modelname,
            messages,
            stream: !!stream,
            ...(extraBody || {})
        };
        if (Number.isFinite(maxTokens) && maxTokens > 0 && body.max_tokens === undefined) {
            body.max_tokens = maxTokens;
        }
        if (includeTemperature !== false) {
            body.temperature = 0.55;
        }
        return body;
    }

    async function callOpenAIChatOnce(api, messages, options, config, extraBody) {
        const url = ensureChatCompletionsUrl(api.baseurl);
        const send = includeTemperature => fetchJsonWithTimeout(url, {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + api.apiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(buildOpenAIChatBody(api, messages, config, extraBody, false, includeTemperature))
        }, options?.timeoutMs || 45000);
        try {
            return await send(true);
        } catch (error) {
            if (!isUnsupportedTemperatureError(error)) {
                throw error;
            }
            await writeDebugLog(options, "http.api.retry_without_temperature", {
                message: error.message || String(error)
            });
            return await send(false);
        }
    }

    async function callOpenAIChatStream(api, messages, options, config, extraBody) {
        const url = ensureChatCompletionsUrl(api.baseurl);
        const handlers = {
            onDelta: typeof options?.onStreamDelta === "function" ? options.onStreamDelta : null
        };
        const send = includeTemperature => fetchOpenAIStreamWithTimeout(url, {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + api.apiKey,
                "Content-Type": "application/json",
                "Accept": "text/event-stream"
            },
            body: JSON.stringify(buildOpenAIChatBody(api, messages, config, extraBody, true, includeTemperature))
        }, options?.timeoutMs || 60000, handlers);
        try {
            return await send(true);
        } catch (error) {
            if (!isUnsupportedTemperatureError(error)) {
                throw error;
            }
            await writeDebugLog(options, "http.api.retry_without_temperature", {
                stream: true,
                message: error.message || String(error)
            });
            return await send(false);
        }
    }

    async function callVisionApi(config, options) {
        const merged = mergeConfig(config);
        const api = resolveApiConfig(merged);
        const startedAt = Date.now();
        if (api.kind === "openai") {
            const messages = supportsImageInput(merged)
                ? buildOpenAIMessages(options || {}, merged)
                : buildOpenAITextOnlyMessages(options || {}, merged);
            const extraBody = getOpenAIExtraBody(api, options || {});
            const requestedStreaming = options?.enableStreaming !== false &&
                merged.httpStreamSegmented !== false &&
                supportsHttpStreaming(merged);
            const shouldStream = !!(isQwenStreamOnlyModel(api) || requestedStreaming);
            const requestSummary = {
                source: options?.source || "",
                apiKind: api.kind,
                mode: merged.apiMode,
                provider: isQwenOpenAIConfig(api) ? "qwen" : (isGeminiOpenAIConfig(api) ? "gemini" : "openai_compatible"),
                url: safeUrlForLog(ensureChatCompletionsUrl(api.baseurl)),
                model: api.modelname || "",
                supportsImage: supportsImageInput(merged),
                messages: summarizeOpenAIMessages(messages),
                maxTokens: getMaxOutputTokens(merged, api),
                stream: shouldStream,
                streamSegmented: !!requestedStreaming,
                hasExtraBody: !!Object.keys(extraBody || {}).length,
                timeoutMs: options?.timeoutMs || (isQwenStreamOnlyModel(api) ? 60000 : 45000)
            };
            await writeDebugLog(options, "http.api.start", requestSummary);
            try {
                if (shouldStream) {
                    let streamChars = 0;
                    const streamOptions = {
                        ...(options || {}),
                        onStreamDelta: (delta, fullText) => {
                            streamChars = String(fullText || "").length;
                            if (typeof options?.onStreamDelta === "function") {
                                options.onStreamDelta(delta, fullText);
                            }
                        }
                    };
                    try {
                        const streamText = await callOpenAIChatStream(api, messages, streamOptions, merged, extraBody);
                        await writeDebugLog(options, streamText ? "http.api.response" : "http.api.empty_response", {
                            durationMs: Date.now() - startedAt,
                            stream: true,
                            segmented: !!requestedStreaming,
                            parsedChars: String(streamText || "").length,
                            textPreview: summarizeForLog(streamText, 160)
                        });
                        return streamText;
                    } catch (streamError) {
                        if (isQwenStreamOnlyModel(api) || streamChars > 0 || !isLikelyStreamingUnsupportedError(streamError)) {
                            throw streamError;
                        }
                        await writeDebugLog(options, "http.api.stream_fallback_once", {
                            durationMs: Date.now() - startedAt,
                            message: streamError.message || String(streamError)
                        });
                    }
                }
                let data;
                data = await callOpenAIChatOnce(api, messages, options, merged, extraBody);
                const safetyResponseMessage = getContentSafetyMessageFromResponse(data);
                if (safetyResponseMessage) {
                    throw markContentSafetyError(new Error(safetyResponseMessage), safetyResponseMessage);
                }
                const businessErrorMessage = getApiBusinessErrorMessage(data);
                if (businessErrorMessage) {
                    throw new Error(businessErrorMessage);
                }
                let text = parseResponseText(data);
                await writeDebugLog(options, text ? "http.api.response" : "http.api.empty_response", {
                    durationMs: Date.now() - startedAt,
                    stream: false,
                    response: summarizeResponseShape(data, text),
                    textPreview: summarizeForLog(text, 160)
                });
                if (isGeminiOpenAIConfig(api) && isLikelyIncompleteReply(text, data)) {
                    await writeDebugLog(options, "http.api.repair_start", {
                        reason: getFinishReason(data) || "likely_incomplete",
                        currentChars: String(text || "").length
                    });
                    const repairMessages = buildOpenAIRepairMessages(options || {}, text, merged);
                    data = await callOpenAIChatOnce(api, repairMessages, options, merged, extraBody);
                    const repairSafetyMessage = getContentSafetyMessageFromResponse(data);
                    if (repairSafetyMessage) {
                        throw markContentSafetyError(new Error(repairSafetyMessage), repairSafetyMessage);
                    }
                    const repairBusinessErrorMessage = getApiBusinessErrorMessage(data);
                    if (repairBusinessErrorMessage) {
                        throw new Error(repairBusinessErrorMessage);
                    }
                    const repairedText = parseResponseText(data);
                    await writeDebugLog(options, repairedText ? "http.api.repair_response" : "http.api.repair_empty", {
                        durationMs: Date.now() - startedAt,
                        response: summarizeResponseShape(data, repairedText),
                        textPreview: summarizeForLog(repairedText, 160)
                    });
                    if (repairedText) {
                        text = repairedText;
                    }
                }
                return text;
            } catch (error) {
                if (isQwenOpenAIConfig(api) && isQwenVisionModel(api) && /HTTP\s+400/i.test(String(error?.message || error))) {
                    if (isContentSafetyError(error)) {
                        markContentSafetyError(error);
                        await writeDebugLog(options, "http.api.content_rejected", {
                            durationMs: Date.now() - startedAt,
                            provider: error.yukiVisionProvider || "",
                            userMessage: error.yukiVisionContentMessage || "",
                            message: error.message || String(error)
                        });
                        throw error;
                    }
                    console.warn("[YukiVisionMod] Qwen 非流式请求失败，尝试流式兼容模式:", error);
                    await writeDebugLog(options, "http.api.fallback_stream", {
                        durationMs: Date.now() - startedAt,
                        message: error.message || String(error)
                    });
                    try {
                        const fallbackText = await callOpenAIChatStream(api, messages, options, merged, extraBody);
                        await writeDebugLog(options, fallbackText ? "http.api.response" : "http.api.empty_response", {
                            durationMs: Date.now() - startedAt,
                            stream: true,
                            fallback: true,
                            parsedChars: String(fallbackText || "").length,
                            textPreview: summarizeForLog(fallbackText, 160)
                        });
                        return fallbackText;
                    } catch (fallbackError) {
                        await writeDebugLog(options, "http.api.error", {
                            durationMs: Date.now() - startedAt,
                            fallback: true,
                            message: fallbackError.message || String(fallbackError)
                        });
                        throw fallbackError;
                    }
                }
                if (isContentSafetyError(error)) {
                    markContentSafetyError(error);
                    await writeDebugLog(options, "http.api.content_rejected", {
                        durationMs: Date.now() - startedAt,
                        provider: error.yukiVisionProvider || "",
                        userMessage: error.yukiVisionContentMessage || "",
                        message: error.message || String(error)
                    });
                    throw error;
                }
                await writeDebugLog(options, "http.api.error", {
                    durationMs: Date.now() - startedAt,
                    message: error.message || String(error)
                });
                throw error;
            }
        }

        const body = {
            prompt: [options?.systemPrompt || "", "视觉要求：先读截图里的窗口标题、主要文字和界面内容；只说确定能看清的内容，不确定就说明不确定。", buildVisionSequenceGuidance(options || {}), buildUserGuidance(merged)].filter(Boolean).join("\n\n"),
            text: options?.text || "",
            screenshotDataUrl: options?.screenshotDataUrl || "",
            activeWindowName: options?.activeWindowName || "",
            history: Array.isArray(options?.history) ? options.history.slice(-8) : [],
            replyMinChars: Number(merged.replyMinChars || DEFAULT_CONFIG.replyMinChars),
            replyMaxChars: Number(merged.replyMaxChars || DEFAULT_CONFIG.replyMaxChars),
            maxOutputTokens: Number(merged.maxOutputTokens || 0),
            extraPrompt: getExtraPrompt(merged),
            visionPreset: options?.visionPreset || getVisionPresetConfig(merged).id,
            visionFrameCount: Number(options?.visionFrameCount || 1),
            visionTargetFrameCount: Number(options?.visionTargetFrameCount || 0),
            visionCandidateFrameCount: Number(options?.visionCandidateFrameCount || 0),
            visionSpanSeconds: Number(options?.visionSpanSeconds || 0),
            visionTargetSpanSeconds: Number(options?.visionTargetSpanSeconds || 0),
            visionObservationSpanSeconds: Number(options?.visionObservationSpanSeconds || 0),
            isVisionCollage: !!options?.isVisionCollage,
            visionCollageMaxDim: Number(options?.visionCollageMaxDim || 0),
            visionCollageJpegQuality: Number(options?.visionCollageJpegQuality || 0),
            imageMaxDim: Number(options?.captureMaxDim || merged.imageMaxDim),
            imageJpegQuality: Number(options?.captureJpegQuality || merged.imageJpegQuality),
            capturedAt: new Date().toISOString()
        };
        const headers = { "Content-Type": "application/json" };
        if (api.apiKey) {
            headers.Authorization = "Bearer " + api.apiKey;
        }
        await writeDebugLog(options, "http.api.start", {
            source: options?.source || "",
            apiKind: api.kind,
            mode: merged.apiMode,
            url: safeUrlForLog(api.endpoint),
            supportsImage: !!body.screenshotDataUrl,
            imageBytes: estimateDataUrlBytes(body.screenshotDataUrl),
            visionPreset: body.visionPreset,
            visionFrameCount: body.visionFrameCount,
            visionTargetFrameCount: body.visionTargetFrameCount,
            visionCandidateFrameCount: body.visionCandidateFrameCount,
            visionTargetSpanSeconds: body.visionTargetSpanSeconds,
            isVisionCollage: body.isVisionCollage,
            promptChars: String(body.prompt || "").length,
            textChars: String(body.text || "").length,
            historyItems: body.history.length,
            timeoutMs: options?.timeoutMs || 45000
        });
        try {
            const data = await fetchJsonWithTimeout(api.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(body)
            }, options?.timeoutMs || 45000);
            const safetyResponseMessage = getContentSafetyMessageFromResponse(data);
            if (safetyResponseMessage) {
                throw markContentSafetyError(new Error(safetyResponseMessage), safetyResponseMessage);
            }
            const businessErrorMessage = getApiBusinessErrorMessage(data);
            if (businessErrorMessage) {
                throw new Error(businessErrorMessage);
            }
            const text = parseResponseText(data);
            await writeDebugLog(options, text ? "http.api.response" : "http.api.empty_response", {
                durationMs: Date.now() - startedAt,
                response: summarizeResponseShape(data, text),
                textPreview: summarizeForLog(text, 160)
            });
            return text;
        } catch (error) {
            if (isContentSafetyError(error)) {
                markContentSafetyError(error);
                await writeDebugLog(options, "http.api.content_rejected", {
                    durationMs: Date.now() - startedAt,
                    provider: error.yukiVisionProvider || "",
                    userMessage: error.yukiVisionContentMessage || "",
                    message: error.message || String(error)
                });
                throw error;
            }
            await writeDebugLog(options, "http.api.error", {
                durationMs: Date.now() - startedAt,
                message: error.message || String(error)
            });
            throw error;
        }
    }

    function getElectronModule() {
        try {
            const electronRequire = typeof window.require === "function"
                ? window.require
                : (typeof require === "function" ? require : null);
            return electronRequire ? electronRequire("electron") : null;
        } catch (_) {
            return null;
        }
    }

    function getIpcRendererModule() {
        try {
            const electron = getElectronModule();
            return electron?.ipcRenderer || null;
        } catch (_) {
            return null;
        }
    }

    function getHighResCaptureBridge() {
        try {
            const directBridge = window.electronAPI?.yukiRealtime;
            if (directBridge?.captureScreen) {
                return options => directBridge.captureScreen(options || {});
            }
        } catch (_) {}

        const ipcRenderer = getIpcRendererModule();
        if (ipcRenderer?.invoke) {
            return options => ipcRenderer.invoke("yuki-realtime:capture-screen", options || {});
        }
        return null;
    }

    function getPreferredCaptureSize(electron, maxDim) {
        try {
            const display = electron?.screen?.getPrimaryDisplay?.();
            if (display?.size?.width && display?.size?.height) {
                const scaleFactor = display.scaleFactor || 1;
                return {
                    width: Math.round(display.size.width * scaleFactor),
                    height: Math.round(display.size.height * scaleFactor)
                };
            }
        } catch (_) {
            // Fall through to DOM screen dimensions.
        }

        const pixelRatio = Number(window.devicePixelRatio || 1);
        const width = Math.round((window.screen?.width || maxDim) * pixelRatio);
        const height = Math.round((window.screen?.height || Math.round(maxDim * 9 / 16)) * pixelRatio);
        return {
            width: Math.max(320, width),
            height: Math.max(200, height)
        };
    }

    async function compressDataUrlToJpeg(dataUrl, maxDim, jpegQuality) {
        if (!dataUrl) {
            return "";
        }
        const image = await loadDataUrlImage(dataUrl);
        const width = image.naturalWidth || image.width || 1;
        const height = image.naturalHeight || image.height || 1;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", Math.max(0.4, Math.min(0.95, jpegQuality / 100)));
    }

    async function captureScreenDataUrlFromBridge(maxDim, jpegQuality) {
        const captureScreen = getHighResCaptureBridge();
        if (!captureScreen) {
            return "";
        }
        try {
            const result = await captureScreen({
                maxDim,
                maxBytes: 0
            });
            const rawDataUrl = typeof result === "string"
                ? result
                : (result?.dataUrl || result?.image || result?.screenshotDataUrl || "");
            if (!rawDataUrl) {
                return "";
            }
            return await compressDataUrlToJpeg(rawDataUrl, maxDim, jpegQuality);
        } catch (error) {
            console.warn("[YukiVisionMod] high-res bridge capture failed; falling back.", error);
            return "";
        }
    }

    async function captureScreenDataUrlHighQuality(maxDim, jpegQuality) {
        try {
            const bridgeDataUrl = await captureScreenDataUrlFromBridge(maxDim, jpegQuality);
            if (bridgeDataUrl) {
                return bridgeDataUrl;
            }

            const electron = getElectronModule();
            const desktopCapturer = electron?.desktopCapturer;
            if (!desktopCapturer || typeof desktopCapturer.getSources !== "function") {
                return "";
            }

            const sourceSize = getPreferredCaptureSize(electron, maxDim);
            const scale = Math.min(1, maxDim / Math.max(sourceSize.width, sourceSize.height));
            const thumbnailSize = {
                width: Math.max(320, Math.round(sourceSize.width * scale)),
                height: Math.max(200, Math.round(sourceSize.height * scale))
            };
            const sources = await desktopCapturer.getSources({
                types: ["screen"],
                thumbnailSize,
                fetchWindowIcons: false
            });
            const source = Array.isArray(sources) && sources.length ? sources[0] : null;
            let image = source?.thumbnail;
            if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
                return "";
            }

            if (typeof image.getSize === "function" && typeof image.resize === "function") {
                const size = image.getSize();
                const longest = Math.max(size.width || 0, size.height || 0);
                if (longest > maxDim) {
                    const resizeScale = maxDim / longest;
                    image = image.resize({
                        width: Math.max(320, Math.round((size.width || thumbnailSize.width) * resizeScale)),
                        height: Math.max(200, Math.round((size.height || thumbnailSize.height) * resizeScale))
                    });
                }
            }

            const buffer = image.toJPEG(jpegQuality);
            return buffer ? "data:image/jpeg;base64," + buffer.toString("base64") : "";
        } catch (error) {
            console.warn("[YukiVisionMod] 高清截图失败，回退原截图接口:", error);
            return "";
        }
    }

    async function captureScreenDataUrl(options) {
        const config = options?.config ? mergeConfig(options.config) : await loadConfig();
        const preset = getVisionPresetConfig(config);
        const maxDim = Math.round(clampNumber(
            Math.max(Number(config.imageMaxDim || 0), Number(preset.captureMaxDim || 0), DEFAULT_CONFIG.imageMaxDim),
            640,
            4096,
            DEFAULT_CONFIG.imageMaxDim
        ));
        const jpegQuality = Math.round(clampNumber(
            Math.max(Number(config.imageJpegQuality || 0), Number(preset.captureJpegQuality || 0), DEFAULT_CONFIG.imageJpegQuality),
            40,
            95,
            DEFAULT_CONFIG.imageJpegQuality
        ));
        const highQualityDataUrl = await captureScreenDataUrlHighQuality(maxDim, jpegQuality);
        if (highQualityDataUrl) {
            return highQualityDataUrl;
        }
        if (!window.electronAPI || !window.electronAPI.getScreenCapture) {
            return "";
        }
        const base64 = await window.electronAPI.getScreenCapture();
        return base64 ? "data:image/jpeg;base64," + base64 : "";
    }

    function loadDataUrlImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("图片加载失败"));
            image.src = dataUrl;
        });
    }

    async function captureScreenFrame(options) {
        const dataUrl = await captureScreenDataUrl(options);
        if (!dataUrl) {
            return null;
        }
        return {
            dataUrl,
            timestamp: Date.now()
        };
    }

    function getFrameTimestamp(frame) {
        const timestamp = Number(frame?.timestamp || 0);
        return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function chooseClosestFrame(candidates, targetTime, usedFrames, minGapMs) {
        let best = null;
        let bestDistance = Infinity;
        candidates.forEach(frame => {
            if (usedFrames.has(frame)) {
                return;
            }
            const timestamp = getFrameTimestamp(frame);
            const distance = Math.abs(timestamp - targetTime);
            if (distance < bestDistance) {
                best = frame;
                bestDistance = distance;
            }
        });
        return best;
    }

    function selectRepresentativeFrames(previousFrames, currentFrame, preset) {
        const currentTime = getFrameTimestamp(currentFrame) || Date.now();
        const targetCount = Math.max(1, Number(preset.frameCount || 1));
        if (targetCount <= 1) {
            return [currentFrame];
        }
        const targetSpanMs = Math.max(0, Number(preset.targetSpanSec || 0)) * 1000;
        const minGapMs = Math.max(0, Number(preset.minFrameGapSec || 0) * 1000);
        const windowStart = targetSpanMs > 0 ? currentTime - targetSpanMs : 0;
        const candidates = (Array.isArray(previousFrames) ? previousFrames : [])
            .filter(frame => frame?.dataUrl)
            .filter(frame => {
                const timestamp = getFrameTimestamp(frame);
                return timestamp >= windowStart && timestamp < currentTime;
            })
            .sort((a, b) => getFrameTimestamp(a) - getFrameTimestamp(b));
        if (!candidates.length) {
            return [currentFrame];
        }

        const previousSlots = targetCount - 1;
        const usedFrames = new Set();
        const selected = [];
        for (let i = 0; i < previousSlots; i++) {
            const ratio = previousSlots === 1 ? 0 : i / previousSlots;
            const targetTime = (currentTime - targetSpanMs) + ratio * targetSpanMs;
            const frame = chooseClosestFrame(candidates, targetTime, usedFrames, minGapMs);
            if (frame) {
                selected.push(frame);
                usedFrames.add(frame);
            }
        }

        if (selected.length < previousSlots) {
            const recentCandidates = candidates
                .slice()
                .sort((a, b) => getFrameTimestamp(b) - getFrameTimestamp(a));
            for (const frame of recentCandidates) {
                if (selected.length >= previousSlots) {
                    break;
                }
                if (usedFrames.has(frame)) {
                    continue;
                }
                selected.push(frame);
                usedFrames.add(frame);
            }
        }

        if (!selected.length) {
            return [currentFrame];
        }
        const frames = selected.sort((a, b) => getFrameTimestamp(a) - getFrameTimestamp(b)).concat(currentFrame);
        const span = currentTime - getFrameTimestamp(frames[0]);
        if (span < minGapMs) {
            return [currentFrame];
        }
        return frames;
    }

    function getCollageGrid(count) {
        if (count <= 1) {
            return { columns: 1, rows: 1 };
        }
        if (count === 2) {
            return { columns: 2, rows: 1 };
        }
        if (count >= 12) {
            return { columns: 3, rows: Math.ceil(count / 3) };
        }
        return { columns: 2, rows: Math.ceil(count / 2) };
    }

    function fitInside(sourceWidth, sourceHeight, targetWidth, targetHeight) {
        const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        return {
            width,
            height,
            x: Math.round((targetWidth - width) / 2),
            y: Math.round((targetHeight - height) / 2)
        };
    }

    function getNaturalFrameLabel(frame, index, frames) {
        const count = frames.length;
        if (index === count - 1) {
            return "当前画面";
        }
        const isSyntheticTest = frames.some(item => item?.syntheticTestTimestamp);
        const prefix = isSyntheticTest ? "测试模拟约 " : "约 ";
        const currentTime = getFrameTimestamp(frames[count - 1]) || Date.now();
        const frameTime = getFrameTimestamp(frame);
        if (!frameTime || !currentTime) {
            return "之前";
        }
        const diffSeconds = Math.max(1, Math.round((currentTime - frameTime) / 1000));
        if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) {
            return "之前";
        }
        return `${prefix}${diffSeconds} 秒前`;
    }

    function getCollageHeaderText(count) {
        return `连续截图拼图：按编号和秒前标签理解变化，最后一格是当前画面（共 ${count} 格）`;
    }

    async function composeFrameCollage(frames, preset) {
        const validFrames = frames.filter(frame => frame?.dataUrl);
        if (validFrames.length <= 1) {
            return validFrames[0]?.dataUrl || "";
        }
        const images = await Promise.all(validFrames.map(frame => loadDataUrlImage(frame.dataUrl)));
        const first = images[0];
        const cellWidth = first.naturalWidth || first.width || 1280;
        const cellHeight = first.naturalHeight || first.height || 720;
        const grid = getCollageGrid(validFrames.length);
        const headerHeight = Math.max(72, Math.round(cellWidth / 16));
        const rawCanvas = document.createElement("canvas");
        rawCanvas.width = cellWidth * grid.columns;
        rawCanvas.height = headerHeight + cellHeight * grid.rows;
        const rawContext = rawCanvas.getContext("2d");
        rawContext.fillStyle = "#111";
        rawContext.fillRect(0, 0, rawCanvas.width, rawCanvas.height);
        rawContext.fillStyle = "#050505";
        rawContext.fillRect(0, 0, rawCanvas.width, headerHeight);
        rawContext.strokeStyle = "rgba(255,255,255,0.62)";
        rawContext.lineWidth = 3;
        rawContext.strokeRect(2, 2, rawCanvas.width - 4, headerHeight - 4);
        rawContext.fillStyle = "#fff";
        rawContext.font = "bold " + Math.max(24, Math.round(headerHeight * 0.38)) + "px sans-serif";
        rawContext.fillText(getCollageHeaderText(validFrames.length), 24, Math.round(headerHeight * 0.58));
        rawContext.fillStyle = "#ffef8a";
        rawContext.font = "bold " + Math.max(18, Math.round(headerHeight * 0.22)) + "px sans-serif";
        rawContext.fillText("时间标签只用于理解先后；回复不要提具体秒数，也不要只看最后一格。", 24, Math.round(headerHeight * 0.86));

        images.forEach((image, index) => {
            const column = index % grid.columns;
            const row = Math.floor(index / grid.columns);
            const cellX = column * cellWidth;
            const cellY = headerHeight + row * cellHeight;
            const sourceWidth = image.naturalWidth || image.width || cellWidth;
            const sourceHeight = image.naturalHeight || image.height || cellHeight;
            const fit = fitInside(sourceWidth, sourceHeight, cellWidth, cellHeight);
            rawContext.drawImage(image, cellX + fit.x, cellY + fit.y, fit.width, fit.height);
            rawContext.strokeStyle = "rgba(255,255,255,0.7)";
            rawContext.lineWidth = 4;
            rawContext.strokeRect(cellX + 2, cellY + 2, cellWidth - 4, cellHeight - 4);

            const label = `${index + 1}/${validFrames.length} ${getNaturalFrameLabel(validFrames[index], index, validFrames)}`;
            const fontSize = Math.max(24, Math.round(cellWidth / 28));
            rawContext.font = "bold " + fontSize + "px sans-serif";
            const labelWidth = rawContext.measureText(label).width + 24;
            const labelHeight = fontSize + 18;
            rawContext.fillStyle = "rgba(0,0,0,0.68)";
            rawContext.fillRect(cellX + 12, cellY + 12, labelWidth, labelHeight);
            rawContext.fillStyle = "#fff";
            rawContext.fillText(label, cellX + 24, cellY + 12 + fontSize);
        });

        const longest = Math.max(rawCanvas.width, rawCanvas.height);
        const maxDim = preset.collageMaxDim || 1536;
        const outputCanvas = document.createElement("canvas");
        if (longest > maxDim) {
            const scale = maxDim / longest;
            outputCanvas.width = Math.max(320, Math.round(rawCanvas.width * scale));
            outputCanvas.height = Math.max(200, Math.round(rawCanvas.height * scale));
            outputCanvas.getContext("2d").drawImage(rawCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
        } else {
            outputCanvas.width = rawCanvas.width;
            outputCanvas.height = rawCanvas.height;
            outputCanvas.getContext("2d").drawImage(rawCanvas, 0, 0);
        }
        return outputCanvas.toDataURL("image/jpeg", (preset.collageJpegQuality || 72) / 100);
    }

    async function buildVisionPayload(config, cachedFrames, currentFrame) {
        const merged = mergeConfig(config);
        const preset = getVisionPresetConfig(merged);
        const current = currentFrame || null;
        if (!current?.dataUrl) {
            return {
                screenshotDataUrl: "",
                visionPreset: preset.id,
                visionFrameCount: 0,
                visionTargetFrameCount: preset.frameCount || 1,
                visionCandidateFrameCount: 0,
                visionSpanSeconds: 0,
                visionTargetSpanSeconds: preset.targetSpanSec || 0,
                isVisionCollage: false,
                visionCollageMaxDim: preset.collageMaxDim,
                visionCollageJpegQuality: preset.collageJpegQuality,
                captureMaxDim: preset.captureMaxDim,
                captureJpegQuality: preset.captureJpegQuality
            };
        }

        const currentTimestamp = getFrameTimestamp(current) || Date.now();
        const previousFrames = (Array.isArray(cachedFrames) ? cachedFrames : [])
            .filter(frame => frame?.dataUrl && getFrameTimestamp(frame) < currentTimestamp)
            .sort((a, b) => getFrameTimestamp(a) - getFrameTimestamp(b));
        const selectedFrames = selectRepresentativeFrames(previousFrames, current, preset);
        const shouldUseCollage = preset.sampleEnabled &&
            selectedFrames.length > 1;

        if (!shouldUseCollage) {
            return {
                screenshotDataUrl: current.dataUrl,
                visionPreset: preset.id,
                visionFrameCount: 1,
                visionTargetFrameCount: preset.frameCount || 1,
                visionCandidateFrameCount: previousFrames.length,
                visionSpanSeconds: 0,
                visionTargetSpanSeconds: preset.targetSpanSec || 0,
                isVisionCollage: false,
                visionCollageMaxDim: preset.collageMaxDim,
                visionCollageJpegQuality: preset.collageJpegQuality,
                captureMaxDim: preset.captureMaxDim,
                captureJpegQuality: preset.captureJpegQuality
            };
        }

        const collageDataUrl = await composeFrameCollage(selectedFrames, preset);
        const firstTimestamp = selectedFrames[0].timestamp || current.timestamp;
        const spanSeconds = Math.max(0, Math.round(((current.timestamp || Date.now()) - firstTimestamp) / 1000));
        return {
            screenshotDataUrl: collageDataUrl || current.dataUrl,
            visionPreset: preset.id,
            visionFrameCount: collageDataUrl ? selectedFrames.length : 1,
            visionTargetFrameCount: preset.frameCount || 1,
            visionCandidateFrameCount: previousFrames.length,
            visionSpanSeconds: collageDataUrl ? spanSeconds : 0,
            visionTargetSpanSeconds: preset.targetSpanSec || 0,
            isVisionCollage: !!collageDataUrl,
            visionCollageMaxDim: preset.collageMaxDim,
            visionCollageJpegQuality: preset.collageJpegQuality,
            captureMaxDim: preset.captureMaxDim,
            captureJpegQuality: preset.captureJpegQuality
        };
    }

    async function getActiveWindowName() {
        try {
            if (!window.electronAPI || !window.electronAPI.getActiveWindow) {
                return "";
            }
            const result = await window.electronAPI.getActiveWindow();
            return result?.success && result.data?.owner?.name ? result.data.owner.name : "";
        } catch (_) {
            return "";
        }
    }

    window.YukiVisionMod = {
        DEFAULT_CONFIG,
        REALTIME_IMAGE_PRESETS,
        mergeConfig,
        loadConfig,
        saveConfig,
        updateRuntimeStatus,
        validateConfig,
        resolveApiConfig,
        isRealtimeEngine,
        isQwenRealtimeEngine,
        isDoubaoRtcEngine,
        getRealtimeConfig,
        getDoubaoRtcConfig,
        getRealtimeImagePresetConfig,
        getRealtimeRegionBaseUrl,
        getDefaultRealtimeVoice,
        normalizeRealtimeVoice,
        buildUserGuidance,
        supportsHttpStreaming,
        supportsImageInput,
        getCompatibilityMessage,
        getVisionPresetConfig,
        callVisionApi,
        captureScreenDataUrl,
        captureScreenFrame,
        buildVisionPayload,
        getActiveWindowName,
        maskKey,
        isNoReply,
        isContentSafetyError,
        getContentSafetyErrorMessage
    };
})();
