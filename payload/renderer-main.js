(function () {
    "use strict";

    if (window.YukiVisionModMainLoaded) {
        return;
    }
    window.YukiVisionModMainLoaded = true;

    const MOD = () => window.YukiVisionMod;
    const GPTSAPI_PRESET = {
        baseurl: "https://api.gptsapi.net",
        modelname: "gemini-3-flash-preview",
        registerUrl: "https://gptsapi.net/"
    };
    let currentConfig = null;
    let apiStoragePatched = false;
    const GEMINI_CHAT_LOW_TOKEN_LIMIT = 2048;

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isGeminiLikeValue(value) {
        return typeof value === "string" && /gemini|googleapis\.com|gptsapi/i.test(value);
    }

    function readChatPartText(part) {
        if (typeof part === "string") {
            return part;
        }
        if (!part || typeof part !== "object") {
            return "";
        }
        if (typeof part.text === "string") {
            return part.text;
        }
        if (typeof part.content === "string") {
            return part.content;
        }
        if (typeof part.value === "string") {
            return part.value;
        }
        if (part.type === "text" && typeof part.text === "string") {
            return part.text;
        }
        return "";
    }

    function readGeminiCandidateText(data) {
        const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts)) {
            return parts.map(readChatPartText).join("").trim();
        }
        if (typeof data?.output_text === "string") {
            return data.output_text.trim();
        }
        if (typeof data?.text === "string") {
            return data.text.trim();
        }
        if (typeof data?.reply === "string") {
            return data.reply.trim();
        }
        if (typeof data?.answer === "string") {
            return data.answer.trim();
        }
        return "";
    }

    function normalizeGeminiChatResponse(data) {
        if (!data || typeof data !== "object") {
            return data;
        }
        const choice = Array.isArray(data.choices) ? data.choices[0] : null;
        if (choice?.message) {
            if (Array.isArray(choice.message.content)) {
                choice.message.content = choice.message.content.map(readChatPartText).join("");
            } else if (choice.message.content == null) {
                const fallbackText = readGeminiCandidateText(data);
                if (fallbackText) {
                    choice.message.content = fallbackText;
                }
            }
            if (!choice.finish_reason && choice.finishReason) {
                choice.finish_reason = choice.finishReason;
            }
        } else {
            const fallbackText = readGeminiCandidateText(data);
            if (fallbackText) {
                const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
                data.choices = [{
                    message: { role: "assistant", content: fallbackText },
                    finish_reason: candidate?.finishReason || "stop"
                }];
            }
        }
        const finishReason = String(
            choice?.finish_reason ||
            choice?.finishReason ||
            data.choices?.[0]?.finish_reason ||
            data.candidates?.[0]?.finishReason ||
            ""
        ).toLowerCase();
        if (/max_tokens|max_output_tokens|length/.test(finishReason)) {
            console.warn("[YukiVisionMod] Gemini reply may be truncated, finish_reason:", finishReason);
        }
        return data;
    }

    function patchGeminiChatFetch() {
        if (window.__YukiVisionGeminiFetchPatched || typeof window.fetch !== "function") {
            return;
        }
        window.__YukiVisionGeminiFetchPatched = true;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async function yukiVisionGeminiFetch(input, init) {
            let nextInit = init;
            let shouldNormalize = false;
            try {
                const url = typeof input === "string" ? input : (input && input.url) || "";
                const method = String(init?.method || (input && input.method) || "GET").toUpperCase();
                const bodyText = typeof init?.body === "string" ? init.body : "";
                const isChatEndpoint = /\/chat\/(?:completions|forward)(?:\?|$)/i.test(url);
                if (method === "POST" && isChatEndpoint && bodyText) {
                    const body = JSON.parse(bodyText);
                    const geminiLike = isGeminiLikeValue(url) ||
                        isGeminiLikeValue(body?.model) ||
                        isGeminiLikeValue(body?.provider) ||
                        isGeminiLikeValue(body?.base_url) ||
                        isGeminiLikeValue(body?.baseURL);
                    if (geminiLike) {
                        shouldNormalize = true;
                        const maxTokens = Number(body.max_tokens ?? body.maxOutputTokens);
                        if (Number.isFinite(maxTokens) && maxTokens > 0 && maxTokens <= GEMINI_CHAT_LOW_TOKEN_LIMIT) {
                            delete body.max_tokens;
                            delete body.maxOutputTokens;
                            nextInit = { ...init, body: JSON.stringify(body) };
                            console.log("[YukiVisionMod] Removed low Gemini chat max token cap:", maxTokens);
                        }
                    }
                }
            } catch (error) {
                console.warn("[YukiVisionMod] Gemini chat request guard skipped:", error);
            }

            const response = await originalFetch(input, nextInit);
            if (shouldNormalize && response && typeof response.json === "function") {
                const originalJson = response.json.bind(response);
                response.json = async function patchedGeminiJson() {
                    return normalizeGeminiChatResponse(await originalJson());
                };
            }
            return response;
        };
    }

    async function waitForReady() {
        for (let i = 0; i < 120; i++) {
            if (MOD() && document.querySelector(".ai-settings-group")) {
                return true;
            }
            await wait(250);
        }
        return false;
    }

    function setResult(message, type) {
        const result = document.getElementById("pet-vision-test-result");
        if (!result) {
            return;
        }
        result.textContent = message;
        result.className = "test-result " + (type || "success");
        result.style.display = "block";
    }

    function clearResult() {
        const result = document.getElementById("pet-vision-test-result");
        if (result) {
            result.textContent = "";
            result.style.display = "none";
        }
        clearPreview();
    }

    function clearPreview() {
        const preview = document.getElementById("pet-vision-test-preview");
        const image = document.getElementById("pet-vision-test-preview-img");
        const meta = document.getElementById("pet-vision-test-preview-meta");
        if (image) {
            image.removeAttribute("src");
        }
        if (meta) {
            meta.textContent = "";
        }
        if (preview) {
            preview.style.display = "none";
        }
    }

    function showCloudPresetResult(message, type) {
        const result = document.getElementById("api-test-result");
        if (!result) {
            return;
        }
        result.textContent = message;
        result.className = "test-result " + (type || "success");
        result.style.display = "block";
    }

    function ensureCloudCustomMode() {
        const customSection = document.getElementById("cloud-custom-section");
        const serverSection = document.getElementById("cloud-server-section");
        const customBtn = document.getElementById("cloud-mode-custom");
        const serverBtn = document.getElementById("cloud-mode-server");
        const presetSidebar = document.getElementById("cloud-preset-sidebar");
        if (customSection) {
            customSection.style.display = "block";
        }
        if (serverSection) {
            serverSection.style.display = "none";
        }
        if (customBtn) {
            customBtn.classList.add("active");
        }
        if (serverBtn) {
            serverBtn.classList.remove("active");
        }
        if (presetSidebar) {
            presetSidebar.style.display = "";
        }
    }

    function applyCloudGptsApiPreset() {
        ensureCloudCustomMode();
        const baseInput = document.getElementById("api-baseurl");
        const modelInput = document.getElementById("api-modelname");
        if (baseInput) {
            baseInput.value = GPTSAPI_PRESET.baseurl;
        }
        if (modelInput) {
            modelInput.value = GPTSAPI_PRESET.modelname;
        }
        document.querySelectorAll("#cloud-preset-sidebar .preset-btn").forEach(btn => {
            btn.classList.toggle("active", btn.id === "preset-gptsapi");
        });
        const registrationLinkDisplay = document.getElementById("registration-link-display");
        if (registrationLinkDisplay) {
            registrationLinkDisplay.textContent = "注册链接：" + GPTSAPI_PRESET.registerUrl;
            registrationLinkDisplay.style.display = "block";
        }
        showCloudPresetResult("已应用国外模型合集预设，请填写你自己的 API Key 后保存或测试。", "success");
    }

    function installCloudGptsApiPreset() {
        const sidebar = document.getElementById("cloud-preset-sidebar");
        if (!sidebar || document.getElementById("preset-gptsapi")) {
            return Boolean(sidebar);
        }
        const button = document.createElement("button");
        button.id = "preset-gptsapi";
        button.className = "preset-btn mj-sidebar-item";
        button.type = "button";
        button.textContent = "国外模型合集";
        button.addEventListener("click", applyCloudGptsApiPreset);
        sidebar.appendChild(button);
        return true;
    }

    const REALTIME_BRIDGE_PORTS = [35672, 35673, 35674, 35675, 35676, 35677, 35678, 35679, 35680, 35681, 35682];
    const DOUBAO_RTC_BRIDGE_PORTS = [35692, 35693, 35694, 35695, 35696, 35697, 35698, 35699, 35700, 35701, 35702];
    let realtimeBridgeCache = null;
    let doubaoRtcBridgeCache = null;

    function getIpcRenderer() {
        try {
            const electronRequire = typeof require === "function" ? require : window.require;
            return electronRequire?.("electron")?.ipcRenderer || null;
        } catch (_) {
            return null;
        }
    }

    function createIpcBridge(prefix, eventChannel) {
        const ipcRenderer = getIpcRenderer();
        if (!ipcRenderer) {
            return null;
        }
        return {
            connect: options => ipcRenderer.invoke(prefix + ":connect", options),
            send: payload => ipcRenderer.invoke(prefix + ":send", payload),
            close: () => ipcRenderer.invoke(prefix + ":close"),
            startHotkey: () => ipcRenderer.invoke(prefix + ":start-hotkey"),
            stopHotkey: () => ipcRenderer.invoke(prefix + ":stop-hotkey"),
            log: entry => ipcRenderer.invoke(prefix + ":log", entry),
            readLog: options => ipcRenderer.invoke(prefix + ":read-log", options || {}),
            clearLog: () => ipcRenderer.invoke(prefix + ":clear-log"),
            openLog: () => ipcRenderer.invoke(prefix + ":open-log"),
            onEvent: cb => {
                const handler = (_event, payload) => cb(payload);
                ipcRenderer.on(eventChannel, handler);
                return () => ipcRenderer.removeListener(eventChannel, handler);
            }
        };
    }

    async function getDoubaoRtcBridge() {
        if (doubaoRtcBridgeCache) {
            return doubaoRtcBridgeCache;
        }
        if (window.electronAPI?.yukiDoubaoRtc) {
            doubaoRtcBridgeCache = window.electronAPI.yukiDoubaoRtc;
            return doubaoRtcBridgeCache;
        }
        const bridge = createIpcBridge("yuki-doubao-rtc", "yuki-doubao-rtc:event");
        if (bridge) {
            doubaoRtcBridgeCache = bridge;
            return bridge;
        }
        for (const port of DOUBAO_RTC_BRIDGE_PORTS) {
            const baseUrl = "http://127.0.0.1:" + port;
            try {
                const response = await fetch(baseUrl + "/health", { cache: "no-store" });
                if (!response.ok) {
                    continue;
                }
                const data = await response.json().catch(() => ({}));
                if (data?.provider === "yuki-doubao-rtc") {
                    doubaoRtcBridgeCache = createHttpRealtimeBridge(baseUrl);
                    return doubaoRtcBridgeCache;
                }
            } catch (_) {
                // Try the next local Doubao RTC bridge port.
            }
        }
        throw new Error("豆包 RTC 本地桥未加载，请重新安装 MOD 或重启游戏");
    }

    async function getRealtimeBridge() {
        if (window.electronAPI?.yukiRealtime) {
            const directBridge = window.electronAPI.yukiRealtime;
            if (directBridge.captureScreen) {
                return directBridge;
            }
            try {
                const electronRequire = typeof require === "function" ? require : window.require;
                const ipcRenderer = electronRequire?.("electron")?.ipcRenderer;
                if (ipcRenderer) {
                    const wrappedBridge = Object.create(directBridge);
                    wrappedBridge.captureScreen = options => ipcRenderer.invoke("yuki-realtime:capture-screen", options || {});
                    return wrappedBridge;
                }
            } catch (_) {}
            return directBridge;
        }
        if (realtimeBridgeCache) {
            return realtimeBridgeCache;
        }
        for (const port of REALTIME_BRIDGE_PORTS) {
            const baseUrl = "http://127.0.0.1:" + port;
            try {
                const response = await fetch(baseUrl + "/health", { cache: "no-store" });
                if (!response.ok) {
                    continue;
                }
                const data = await response.json().catch(() => ({}));
                if (data?.provider === "yuki-qwen-realtime") {
                    realtimeBridgeCache = createHttpRealtimeBridge(baseUrl);
                    return realtimeBridgeCache;
                }
            } catch (_) {
                // Try the next local bridge port.
            }
        }
        throw new Error("Realtime 本地桥未启动，请完全重启游戏或重新安装 MOD");
    }

    function createHttpRealtimeBridge(baseUrl) {
        let lastEventId = 0;
        let polling = false;
        let priming = null;
        const listeners = new Set();

        async function post(path, body) {
            const response = await fetch(baseUrl + path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body || {})
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data.error || ("Realtime 本地桥请求失败：" + response.status));
            }
            return data;
        }

        async function primeEventCursor() {
            if (priming) {
                return priming;
            }
            priming = (async () => {
                try {
                    const response = await fetch(baseUrl + "/events?since=0", { cache: "no-store" });
                    const data = await response.json().catch(() => ({}));
                    const latestFromEvents = Array.isArray(data?.events)
                        ? data.events.reduce((max, event) => Math.max(max, Number(event.id || 0)), 0)
                        : 0;
                    lastEventId = Math.max(lastEventId, Number(data?.latestId || 0), latestFromEvents);
                } catch (_) {
                    // If priming fails, normal polling will surface live bridge failures.
                } finally {
                    priming = null;
                }
            })();
            return priming;
        }

        async function pollEvents() {
            if (polling) {
                return;
            }
            polling = true;
            await primeEventCursor();
            while (listeners.size > 0) {
                try {
                    const response = await fetch(baseUrl + "/events?since=" + encodeURIComponent(lastEventId), { cache: "no-store" });
                    const data = await response.json().catch(() => ({}));
                    if (data?.events?.length) {
                        data.events.forEach(event => {
                            lastEventId = Math.max(lastEventId, Number(event.id || 0));
                            listeners.forEach(listener => listener({
                                id: event.id,
                                type: event.type,
                                payload: event.payload,
                                timestamp: event.timestamp
                            }));
                        });
                    } else if (data?.latestId) {
                        lastEventId = Math.max(lastEventId, Number(data.latestId || 0));
                    }
                } catch (_) {
                    // Keep polling; request actions surface real failures.
                }
                await wait(180);
            }
            polling = false;
        }

        return {
            connect: options => post("/connect", options),
            send: payload => post("/send", payload),
            close: () => post("/close", {}),
            startHotkey: () => post("/start-hotkey", {}),
            stopHotkey: () => post("/stop-hotkey", {}),
            log: entry => post("/log", entry),
            readLog: options => post("/read-log", options || {}),
            clearLog: () => post("/clear-log", {}),
            openLog: () => post("/open-log", {}),
            captureScreen: options => post("/capture-screen", options || {}),
            onEvent: cb => {
                const wasEmpty = listeners.size === 0;
                listeners.add(cb);
                if (wasEmpty) {
                    primeEventCursor();
                }
                pollEvents();
                return () => listeners.delete(cb);
            }
        };
    }

    async function getRealtimeLogBridge() {
        const bridge = await getRealtimeBridge();
        if (bridge?.openLog && bridge?.readLog && bridge?.clearLog) {
            return bridge;
        }
        realtimeBridgeCache = null;
        for (const port of REALTIME_BRIDGE_PORTS) {
            const baseUrl = "http://127.0.0.1:" + port;
            try {
                const response = await fetch(baseUrl + "/health", { cache: "no-store" });
                const data = await response.json().catch(() => ({}));
                if (response.ok && data?.provider === "yuki-qwen-realtime") {
                    realtimeBridgeCache = createHttpRealtimeBridge(baseUrl);
                    return realtimeBridgeCache;
                }
            } catch (_) {}
        }
        throw new Error("Realtime 日志桥未加载，请重启游戏或重新安装 MOD。");
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            return document.execCommand("copy");
        } finally {
            textarea.remove();
        }
    }

    async function openRealtimeLogFolder() {
        try {
            const bridge = await getRealtimeLogBridge();
            const result = await bridge.openLog();
            if (result?.success === false) {
                throw new Error(result.error || "打开日志文件夹失败");
            }
            setResult("已打开 MOD 日志文件夹：" + (result?.path || ""), "success");
        } catch (error) {
            setResult("打开日志失败：" + (error.message || error), "error");
        }
    }

    async function copyRecentRealtimeLog() {
        try {
            const bridge = await getRealtimeLogBridge();
            const result = await bridge.readLog({ maxBytes: 180000 });
            const text = result?.text || "";
            if (!text) {
                setResult("今天还没有 MOD 调试日志。", "success");
                return;
            }
            await copyTextToClipboard(text);
            setResult("已复制最近 MOD 调试日志，可以直接粘贴出来排查。", "success");
        } catch (error) {
            setResult("复制日志失败：" + (error.message || error), "error");
        }
    }

    async function clearRealtimeLogFile() {
        try {
            const bridge = await getRealtimeLogBridge();
            const result = await bridge.clearLog();
            setResult("已清空今天的 MOD 调试日志：" + (result?.path || ""), "success");
        } catch (error) {
            setResult("清空日志失败：" + (error.message || error), "error");
        }
    }

    function writeSettingsDebugLog(stage, data) {
        getRealtimeLogBridge()
            .then(bridge => bridge?.log?.({
                source: "settings",
                stage: stage || "http.settings",
                data: data || {}
            }))
            .catch(() => {});
    }

    function isContentRejectedError(error) {
        if (error?.yukiVisionContentRejected || MOD().isContentSafetyError?.(error)) {
            return true;
        }
        const message = String(error?.message || error || "");
        return /(^|\b)safety($|\b)|prohibited[_\s-]*content|blocklist|spii|inappropriate content|content[_\s-]*filter|content[_\s-]*policy|policy[_\s-]*violation|data[_\s-]*inspection|responsibleai|responsible ai|content management policy|sensitive content|prohibited content|blocked by safety|blocked due to safety|safety system|safety filter|moderation|input data may contain|output data may contain|content exists risk|risk control|内容安全|安全策略|安全审核|不合适|违规|敏感内容|风险内容|内容风险|审核拒绝/i.test(message);
    }

    function getContentRejectedTestMessage(error) {
        return MOD().getContentSafetyErrorMessage?.(error) ||
            error?.yukiVisionContentMessage ||
            "模型内容安全拒绝了本次测试输入。通常是测试截图、文字或上下文里包含敏感/不合适内容；可以换个画面、关闭敏感窗口，或改用审查更适合该场景的模型。";
    }

    function estimatePreviewDataUrlBytes(dataUrl) {
        const text = String(dataUrl || "");
        if (!text) {
            return 0;
        }
        const base64 = text.includes(",") ? text.split(",").pop() : text;
        return Math.ceil(String(base64 || "").length * 3 / 4);
    }

    function formatPreviewBytes(bytes) {
        const value = Number(bytes || 0);
        if (!Number.isFinite(value) || value <= 0) {
            return "";
        }
        if (value >= 1024 * 1024) {
            return `${(value / 1024 / 1024).toFixed(2)}MB`;
        }
        return `${(value / 1024).toFixed(1)}KB`;
    }

    function setPreview(visionPayload, isSyntheticTest) {
        const preview = document.getElementById("pet-vision-test-preview");
        const image = document.getElementById("pet-vision-test-preview-img");
        const meta = document.getElementById("pet-vision-test-preview-meta");
        if (!preview || !image || !meta) {
            return;
        }
        if (!visionPayload?.screenshotDataUrl) {
            clearPreview();
            return;
        }
        const frameCount = Number(visionPayload.visionFrameCount || 1);
        const spanSeconds = Math.round(Number(visionPayload.visionSpanSeconds || 0));
        const kind = visionPayload.previewKind || (visionPayload.isVisionCollage ? "拼图" : "单图");
        const preset = visionPayload.visionPreset || "unknown";
        const imageBytes = Number(visionPayload.imageBytes || 0) || estimatePreviewDataUrlBytes(visionPayload.screenshotDataUrl);
        const bytesText = imageBytes ? ` / 储存大小 ${formatPreviewBytes(imageBytes)}` : "";
        const qualityText = visionPayload.imageQuality ? ` / JPEG ${visionPayload.imageQuality}` : "";
        const note = visionPayload.previewNote || (isSyntheticTest && frameCount > 1
            ? "测试页会短时间采集多张图来模拟当前预设；正式桌宠会使用真实运行时缓存。"
            : "这就是本次测试发送给接口的图片。");
        const renderMeta = (width, height) => {
            const imageSize = width && height ? ` / ${width}x${height}` : "";
            meta.textContent = `${visionPayload.previewLabel || "测试发送图片"}：${kind} / ${frameCount} 帧 / ${preset}${spanSeconds ? ` / 约 ${spanSeconds} 秒窗口` : ""}${imageSize}${bytesText}${qualityText}。${note}`;
        };
        image.onload = () => {
            renderMeta(image.naturalWidth || image.width, image.naturalHeight || image.height);
        };
        image.src = visionPayload.screenshotDataUrl;
        image.title = "点击查看原图";
        image.onclick = () => {
            const viewer = window.open("", "_blank");
            if (viewer?.document) {
                viewer.document.write(`<title>桌宠测试图片</title><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;"><img src="${visionPayload.screenshotDataUrl}" style="max-width:100vw;max-height:100vh;object-fit:contain;"></body>`);
                viewer.document.close();
            }
        };
        renderMeta(visionPayload.imageWidth, visionPayload.imageHeight);
        preview.style.display = "block";
    }

    function showModal() {
        const modal = document.getElementById("pet-vision-settings-modal");
        if (modal) {
            modal.style.display = "flex";
            loadConfigToForm();
        }
    }

    function hideModal() {
        const modal = document.getElementById("pet-vision-settings-modal");
        if (modal) {
            modal.style.display = "none";
            clearResult();
        }
    }

    function setMode(mode) {
        const rawEngine = document.getElementById("pet-vision-engine")?.value || "http";
        const engine = rawEngine === "qwenRealtime" || rawEngine === "doubaoRtc" ? rawEngine : "http";
        document.querySelectorAll("[data-pet-vision-mode]").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.petVisionMode === mode);
        });
        document.querySelectorAll(".pet-vision-api-section").forEach(section => {
            section.style.display = engine === "http" && section.dataset.petVisionSection === mode ? "block" : "none";
        });
    }

    function setEngine(engine) {
        const selected = engine === "qwenRealtime" || engine === "doubaoRtc" ? engine : "http";
        const engineInput = document.getElementById("pet-vision-engine");
        if (engineInput) {
            engineInput.value = selected;
        }
        document.querySelectorAll(".pet-vision-http-only").forEach(section => {
            section.style.display = selected === "http" ? "" : "none";
        });
        document.querySelectorAll(".pet-vision-realtime-only").forEach(section => {
            section.style.display = selected === "qwenRealtime" ? "" : "none";
        });
        document.querySelectorAll(".pet-vision-doubao-only").forEach(section => {
            section.style.display = selected === "doubaoRtc" ? "" : "none";
        });
        const testBtn = document.getElementById("pet-vision-test-btn");
        if (testBtn) {
            testBtn.textContent = selected === "doubaoRtc"
                ? "测试豆包 RTC"
                : (selected === "qwenRealtime" ? "测试 Realtime" : "测试API");
        }
        const modeButton = document.querySelector("[data-pet-vision-mode].active");
        setMode(modeButton ? modeButton.dataset.petVisionMode : "inherit");
    }

    function updateRealtimeModelInput() {
        const modelMode = document.getElementById("pet-vision-realtime-model")?.value || "";
        const customWrap = document.getElementById("pet-vision-realtime-custom-model-wrap");
        if (customWrap) {
            customWrap.style.display = modelMode === "custom" ? "block" : "none";
        }
        const model = getSelectedRealtimeModel();
        const voiceInput = document.getElementById("pet-vision-realtime-voice");
        if (voiceInput) {
            const suggestedVoice = MOD().getDefaultRealtimeVoice?.(model) || "Tina";
            const currentVoice = String(voiceInput.value || "").trim();
            if (!currentVoice || (String(model || "").toLowerCase().includes("qwen3.5-omni") && currentVoice.toLowerCase() === "cherry")) {
                voiceInput.value = suggestedVoice;
            }
            voiceInput.placeholder = suggestedVoice;
        }
        const voiceHint = document.getElementById("pet-vision-realtime-voice-hint");
        if (voiceHint) {
            voiceHint.textContent = String(model || "").toLowerCase().includes("qwen3.5-omni")
                ? "Qwen3.5 Realtime 推荐使用 Tina；Cherry 会被服务端拒绝。"
                : "如果当前模型提示音色不支持，请按 DashScope 控制台/文档中的音色名填写。";
        }
        updateRealtimeAudioMode();
    }

    function updateRealtimeAudioMode() {
        const audioMode = document.getElementById("pet-vision-realtime-audio-mode")?.value || "gameTts";
        const qwenVoiceWrap = document.getElementById("pet-vision-realtime-qwen-voice-wrap");
        if (qwenVoiceWrap) {
            qwenVoiceWrap.style.display = audioMode === "qwenAudio" ? "block" : "none";
        }
        const voiceHint = document.getElementById("pet-vision-realtime-audio-mode-hint");
        if (voiceHint) {
            voiceHint.textContent = audioMode === "qwenAudio"
                ? "使用模型实时语音时必须填写该模型支持的音色。"
                : "默认只让 Qwen 返回字幕文字，再调用游戏内置 Yuki 语音播报。";
        }
    }

    function updateRealtimeImagePresetInput() {
        const presetId = document.getElementById("pet-vision-realtime-image-preset")?.value || "standard";
        const presets = MOD().REALTIME_IMAGE_PRESETS || {};
        const preset = presets[presetId] || presets.standard || {};
        const hint = document.getElementById("pet-vision-realtime-image-preset-hint");
        if (hint) {
            hint.textContent = preset.description || "选择图片档位后会自动设置分辨率、质量和字节上限。";
        }
    }

    function updateDoubaoScreenShareEngineInput() {
        const engine = document.getElementById("pet-vision-doubao-screen-share-engine")?.value === "native" ? "native" : "web";
        const status = document.getElementById("pet-vision-doubao-screen-share-engine-status");
        if (status) {
            status.textContent = engine === "native"
                ? "已选择原生 veRTC 方案：这是之前的实现，少数电脑可能在启动屏幕采集时闪退，建议只用于对比和诊断。"
                : "已选择作者 Web SDK 方案：仿照原版在桌宠窗口发布屏幕流，通常比原生 veRTC 屏幕采集更稳。";
        }
    }

    function updateDoubaoAudioModeInput() {
        const mode = document.getElementById("pet-vision-doubao-audio-mode")?.value === "localTts" ? "localTts" : "remoteTts";
        const voiceWrap = document.getElementById("pet-vision-doubao-tts-voice-wrap");
        if (voiceWrap) {
            voiceWrap.style.display = mode === "remoteTts" ? "" : "none";
        }
    }

    const DOUBAO_IMAGE_HEIGHT_OPTIONS = [
        { value: 360, label: "极省流量：360" },
        { value: 480, label: "低流量：480" },
        { value: 540, label: "轻量：540" },
        { value: 720, label: "标准：720" },
        { value: 900, label: "高清：900" },
        { value: 1080, label: "最高：1080" }
    ];
    const DOUBAO_VIDEO_HEIGHT_LIMITS = {
        economy: 540,
        standard: 720,
        clear: 900,
        max: 1080
    };

    function updateDoubaoImageHeightOptions(preferredValue) {
        const select = document.getElementById("pet-vision-doubao-image-height");
        if (!select) {
            return;
        }
        const videoPreset = document.getElementById("pet-vision-doubao-video-preset")?.value || "standard";
        const maxHeight = DOUBAO_VIDEO_HEIGHT_LIMITS[videoPreset] || DOUBAO_VIDEO_HEIGHT_LIMITS.standard;
        const current = Number(preferredValue ?? (select.value || 720));
        const options = DOUBAO_IMAGE_HEIGHT_OPTIONS.filter(option => option.value <= maxHeight);
        const allowed = options.length ? options : [DOUBAO_IMAGE_HEIGHT_OPTIONS[0]];
        const chosen = allowed.some(option => option.value === current)
            ? current
            : allowed[allowed.length - 1].value;
        select.innerHTML = allowed
            .map(option => `<option value="${option.value}">${option.label}</option>`)
            .join("");
        select.value = String(chosen);
    }

    function getSelectedRealtimeModel() {
        const modelMode = document.getElementById("pet-vision-realtime-model")?.value || "";
        if (modelMode === "custom") {
            return document.getElementById("pet-vision-realtime-custom-model")?.value.trim() || modelMode;
        }
        return modelMode;
    }

    function getNumber(id, fallback) {
        const value = Number(document.getElementById(id)?.value);
        return Number.isFinite(value) ? value : fallback;
    }

    async function syncInheritedApi(config, strict) {
        const merged = MOD().mergeConfig(config);
        try {
            if (!window.apiKeyStorage) {
                if (typeof APIKeyStorage !== "undefined") {
                    window.apiKeyStorage = new APIKeyStorage();
                    await window.apiKeyStorage.init();
                } else {
                    throw new Error("普通 API 配置模块尚未加载");
                }
            }
            const apiConfig = await window.apiKeyStorage.loadConfig();
            const looksCustom = apiConfig && apiConfig.baseurl && apiConfig.modelname && apiConfig.apiKey && apiConfig.mode !== "server";
            if (!looksCustom) {
                if (strict) {
                    throw new Error("当前普通对话不是自定义 API，或缺少 BaseURL/模型/API Key");
                }
                return { ok: false, config: merged, message: "未同步：普通对话未配置自定义 API" };
            }
            merged.inheritedApi = {
                baseurl: apiConfig.baseurl,
                modelname: apiConfig.modelname,
                apiKey: apiConfig.apiKey,
                updatedAt: new Date().toISOString()
            };
            await MOD().saveConfig(merged);
            currentConfig = merged;
            updateInheritedDisplay(merged);
            return { ok: true, config: merged, message: "已同步当前自定义 API" };
        } catch (error) {
            return { ok: false, config: merged, message: error.message || String(error) };
        }
    }

    function readFormConfig() {
        const base = MOD().mergeConfig(currentConfig);
        const modeButton = document.querySelector("[data-pet-vision-mode].active");
        const mode = modeButton ? modeButton.dataset.petVisionMode : "inherit";
        base.enabled = !!document.getElementById("pet-vision-enabled")?.checked;
        base.userDisabled = !base.enabled;
        const selectedEngine = document.getElementById("pet-vision-engine")?.value || "http";
        base.engine = selectedEngine === "qwenRealtime" || selectedEngine === "doubaoRtc" ? selectedEngine : "http";
        base.apiMode = mode;
        base.uploadIntervalSec = 2;
        base.autoCooldownSec = Math.max(5, getNumber("pet-vision-auto-cooldown", 60));
        base.idleTimeoutSec = base.autoCooldownSec;
        base.includeActiveWindow = !!document.getElementById("pet-vision-include-window")?.checked;
        base.enableVoice = document.getElementById("pet-vision-enable-voice")?.checked !== false;
        base.httpStreamSegmented = document.getElementById("pet-vision-http-stream-segmented")?.checked !== false;
        base.visionPreset = document.getElementById("pet-vision-preset")?.value || "balanced";
        base.replyMinChars = Math.max(10, Math.min(500, getNumber("pet-vision-reply-min-chars", 20)));
        base.replyMaxChars = Math.max(20, Math.min(800, getNumber("pet-vision-reply-max-chars", 40)));
        if (base.replyMaxChars < base.replyMinChars) {
            base.replyMaxChars = base.replyMinChars;
        }
        base.maxOutputTokens = Math.max(0, Math.min(4096, getNumber("pet-vision-max-output-tokens", 0)));
        base.extraPrompt = document.getElementById("pet-vision-extra-prompt")?.value.trim() || "";
        base.openai.baseurl = document.getElementById("pet-vision-openai-baseurl")?.value.trim() || base.openai.baseurl;
        base.openai.modelname = document.getElementById("pet-vision-openai-model")?.value.trim() || base.openai.modelname;
        base.openai.apiKey = document.getElementById("pet-vision-openai-key")?.value.trim() || base.openai.apiKey;
        base.custom.endpoint = document.getElementById("pet-vision-custom-endpoint")?.value.trim() || base.custom.endpoint;
        base.custom.apiKey = document.getElementById("pet-vision-custom-key")?.value.trim() || base.custom.apiKey;
        const realtimeModel = document.getElementById("pet-vision-realtime-model")?.value || base.realtime.model;
        const resolvedRealtimeModel = realtimeModel === "custom"
            ? document.getElementById("pet-vision-realtime-custom-model")?.value.trim()
            : realtimeModel;
        const realtimeVoiceInput = document.getElementById("pet-vision-realtime-voice")?.value.trim() || "";
        const realtimeVoice = MOD().normalizeRealtimeVoice?.(resolvedRealtimeModel, realtimeVoiceInput) ||
            realtimeVoiceInput ||
            "Tina";
        const realtimeImagePresetId = document.getElementById("pet-vision-realtime-image-preset")?.value || "standard";
        const realtimeImagePreset = MOD().getRealtimeImagePresetConfig?.({ imagePreset: realtimeImagePresetId }) || {
            imagePreset: "standard",
            imageMaxBytes: 130000,
            imageMaxDim: 1080,
            imageJpegQuality: 78
        };
        const realtimeAutoDelaySec = Math.max(5, Math.min(600, getNumber("pet-vision-realtime-auto-interval", 60)));
        base.realtime = {
            ...base.realtime,
            enabled: base.engine === "qwenRealtime",
            provider: "qwen",
            region: "cn-beijing",
            baseUrl: MOD().getRealtimeRegionBaseUrl?.("cn-beijing") || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
            model: realtimeModel,
            customModel: document.getElementById("pet-vision-realtime-custom-model")
                ? document.getElementById("pet-vision-realtime-custom-model").value.trim()
                : base.realtime.customModel,
            apiKey: document.getElementById("pet-vision-realtime-key")?.value.trim() || base.realtime.apiKey,
            audioMode: document.getElementById("pet-vision-realtime-audio-mode")?.value === "qwenAudio" ? "qwenAudio" : "gameTts",
            voice: realtimeVoice,
            hotkey: "RightAlt",
            screenMode: document.getElementById("pet-vision-realtime-screen-mode")?.value || "always_1fps",
            screenFps: 1,
            imagePreset: realtimeImagePreset.imagePreset,
            imageMaxBytes: realtimeImagePreset.imageMaxBytes,
            imageMaxDim: realtimeImagePreset.imageMaxDim,
            imageJpegQuality: realtimeImagePreset.imageJpegQuality,
            autoObserveEnabled: !!document.getElementById("pet-vision-realtime-auto-observe")?.checked,
            autoObserveIntervalSec: realtimeAutoDelaySec,
            autoObserveSilenceSec: realtimeAutoDelaySec,
            autoObserveStyle: document.getElementById("pet-vision-realtime-auto-style")?.value || "game_assist"
        };
        const doubaoAutoDelaySec = Math.max(5, Math.min(600, getNumber("pet-vision-doubao-auto-interval", 60)));
        base.doubaoRtc = {
            ...base.doubaoRtc,
            enabled: base.engine === "doubaoRtc",
            provider: "doubao",
            region: "cn-north-1",
            accessKeyId: document.getElementById("pet-vision-doubao-ak")?.value.trim() || base.doubaoRtc.accessKeyId,
            secretAccessKey: document.getElementById("pet-vision-doubao-sk")?.value.trim() || base.doubaoRtc.secretAccessKey,
            appId: document.getElementById("pet-vision-doubao-rtc-appid")?.value.trim() || base.doubaoRtc.appId,
            appKey: document.getElementById("pet-vision-doubao-rtc-appkey")?.value.trim() || base.doubaoRtc.appKey,
            manualToken: "",
            roomIdPrefix: "yuki_mod_",
            userIdPrefix: "user_",
            botUserId: "yuki_bot",
            tokenTtlSec: 172800,
            endpointId: document.getElementById("pet-vision-doubao-endpoint")?.value.trim() || base.doubaoRtc.endpointId,
            asrMode: "bigmodel",
            asrAppId: document.getElementById("pet-vision-doubao-asr-appid")?.value.trim() || base.doubaoRtc.asrAppId,
            asrAccessToken: document.getElementById("pet-vision-doubao-asr-token")?.value.trim() || base.doubaoRtc.asrAccessToken,
            asrApiResourceId: "volc.bigasr.sauc.duration",
            audioMode: document.getElementById("pet-vision-doubao-audio-mode")?.value === "localTts" ? "localTts" : "remoteTts",
            ttsAppId: document.getElementById("pet-vision-doubao-tts-appid")?.value.trim() || base.doubaoRtc.ttsAppId,
            ttsAccessToken: document.getElementById("pet-vision-doubao-tts-token")?.value.trim() || base.doubaoRtc.ttsAccessToken,
            ttsVoiceType: document.getElementById("pet-vision-doubao-tts-voice")?.value.trim() || base.doubaoRtc.ttsVoiceType,
            screenShareEngine: document.getElementById("pet-vision-doubao-screen-share-engine")?.value === "native" ? "native" : "web",
            screenMode: document.getElementById("pet-vision-doubao-screen-mode")?.value || "always_1fps",
            screenFps: 1,
            videoPreset: document.getElementById("pet-vision-doubao-video-preset")?.value || "standard",
            imageHeight: getNumber("pet-vision-doubao-image-height", 720),
            imageDetail: document.getElementById("pet-vision-doubao-image-detail")?.value === "low" ? "low" : "high",
            autoObserveEnabled: !!document.getElementById("pet-vision-doubao-auto-observe")?.checked,
            autoObserveIntervalSec: doubaoAutoDelaySec,
            autoObserveSilenceSec: doubaoAutoDelaySec,
            autoObserveStyle: document.getElementById("pet-vision-doubao-auto-style")?.value || "game_assist",
            vadSilenceTimeMs: 800,
            interruptSpeechDurationMs: 0
        };
        return base;
    }

    function updateInheritedDisplay(config) {
        const inherited = MOD().mergeConfig(config).inheritedApi;
        const status = inherited.baseurl && inherited.modelname && inherited.apiKey
            ? `${inherited.baseurl} / ${inherited.modelname} / ${MOD().maskKey(inherited.apiKey)}`
            : "未同步";
        const node = document.getElementById("pet-vision-inherited-current");
        if (node) {
            node.textContent = status;
        }
    }

    function fillForm(config) {
        const merged = MOD().mergeConfig(config);
        currentConfig = merged;
        document.getElementById("pet-vision-enabled").checked = !!merged.enabled;
        setEngine(merged.engine || "http");
        document.getElementById("pet-vision-auto-cooldown").value = merged.autoCooldownSec;
        document.getElementById("pet-vision-include-window").checked = !!merged.includeActiveWindow;
        const voiceToggle = document.getElementById("pet-vision-enable-voice");
        if (voiceToggle) {
            voiceToggle.checked = merged.enableVoice !== false;
        }
        const streamToggle = document.getElementById("pet-vision-http-stream-segmented");
        if (streamToggle) {
            streamToggle.checked = merged.httpStreamSegmented !== false;
        }
        const visionPreset = document.getElementById("pet-vision-preset");
        if (visionPreset) {
            visionPreset.value = merged.visionPreset || "balanced";
        }
        const replyMinChars = document.getElementById("pet-vision-reply-min-chars");
        if (replyMinChars) {
            replyMinChars.value = Number(merged.replyMinChars || 20);
        }
        const replyMaxChars = document.getElementById("pet-vision-reply-max-chars");
        if (replyMaxChars) {
            replyMaxChars.value = Number(merged.replyMaxChars || 40);
        }
        const maxOutput = document.getElementById("pet-vision-max-output-tokens");
        if (maxOutput) {
            maxOutput.value = Number(merged.maxOutputTokens || 0);
        }
        const extraPrompt = document.getElementById("pet-vision-extra-prompt");
        if (extraPrompt) {
            extraPrompt.value = merged.extraPrompt || "";
        }
        document.getElementById("pet-vision-openai-baseurl").value = merged.openai.baseurl || "";
        document.getElementById("pet-vision-openai-model").value = merged.openai.modelname || "";
        document.getElementById("pet-vision-openai-key").value = "";
        document.getElementById("pet-vision-openai-key-current").textContent = MOD().maskKey(merged.openai.apiKey);
        document.getElementById("pet-vision-custom-endpoint").value = merged.custom.endpoint || "";
        document.getElementById("pet-vision-custom-key").value = "";
        document.getElementById("pet-vision-custom-key-current").textContent = MOD().maskKey(merged.custom.apiKey);
        const realtime = MOD().getRealtimeConfig?.(merged) || merged.realtime || {};
        const knownRealtimeModels = [
            "qwen3.5-omni-flash-realtime-2026-03-15",
            "qwen3.5-omni-plus-realtime-2026-03-15",
            "custom"
        ];
        const realtimeModelValue = knownRealtimeModels.includes(realtime.model) ? realtime.model : "custom";
        document.getElementById("pet-vision-realtime-model").value = realtimeModelValue;
        document.getElementById("pet-vision-realtime-custom-model").value = realtimeModelValue === "custom" ? (realtime.customModel || realtime.model || "") : (realtime.customModel || "");
        document.getElementById("pet-vision-realtime-key").value = "";
        document.getElementById("pet-vision-realtime-key-current").textContent = MOD().maskKey(realtime.apiKey);
        const realtimeAudioMode = document.getElementById("pet-vision-realtime-audio-mode");
        if (realtimeAudioMode) {
            realtimeAudioMode.value = realtime.audioMode === "qwenAudio" ? "qwenAudio" : "gameTts";
        }
        document.getElementById("pet-vision-realtime-voice").value = MOD().normalizeRealtimeVoice?.(realtime.model, realtime.voice) || realtime.voice || "Tina";
        document.getElementById("pet-vision-realtime-screen-mode").value = realtime.screenMode || "always_1fps";
        document.getElementById("pet-vision-realtime-image-preset").value = realtime.imagePreset || "standard";
        document.getElementById("pet-vision-realtime-auto-observe").checked = !!realtime.autoObserveEnabled;
        document.getElementById("pet-vision-realtime-auto-interval").value = Number(realtime.autoObserveIntervalSec || 60);
        document.getElementById("pet-vision-realtime-auto-style").value = realtime.autoObserveStyle || "game_assist";
        const doubao = MOD().getDoubaoRtcConfig?.(merged) || merged.doubaoRtc || {};
        document.getElementById("pet-vision-doubao-ak").value = "";
        document.getElementById("pet-vision-doubao-ak-current").textContent = MOD().maskKey(doubao.accessKeyId);
        document.getElementById("pet-vision-doubao-sk").value = "";
        document.getElementById("pet-vision-doubao-sk-current").textContent = MOD().maskKey(doubao.secretAccessKey);
        document.getElementById("pet-vision-doubao-rtc-appid").value = doubao.appId || "";
        document.getElementById("pet-vision-doubao-rtc-appkey").value = "";
        document.getElementById("pet-vision-doubao-rtc-appkey-current").textContent = MOD().maskKey(doubao.appKey);
        document.getElementById("pet-vision-doubao-endpoint").value = doubao.endpointId || "";
        document.getElementById("pet-vision-doubao-asr-appid").value = doubao.asrAppId || "";
        document.getElementById("pet-vision-doubao-asr-token").value = "";
        document.getElementById("pet-vision-doubao-asr-token-current").textContent = MOD().maskKey(doubao.asrAccessToken);
        document.getElementById("pet-vision-doubao-audio-mode").value = doubao.audioMode === "localTts" ? "localTts" : "remoteTts";
        document.getElementById("pet-vision-doubao-tts-appid").value = doubao.ttsAppId || "";
        document.getElementById("pet-vision-doubao-tts-token").value = "";
        document.getElementById("pet-vision-doubao-tts-token-current").textContent = MOD().maskKey(doubao.ttsAccessToken);
        document.getElementById("pet-vision-doubao-tts-voice").value = doubao.ttsVoiceType || "zh_female_meilinvyou_moon_bigtts";
        document.getElementById("pet-vision-doubao-screen-share-engine").value = doubao.screenShareEngine === "native" ? "native" : "web";
        document.getElementById("pet-vision-doubao-screen-mode").value = doubao.screenMode || "always_1fps";
        document.getElementById("pet-vision-doubao-video-preset").value = doubao.videoPreset || "standard";
        updateDoubaoImageHeightOptions(doubao.imageHeight || 720);
        document.getElementById("pet-vision-doubao-image-detail").value = doubao.imageDetail || "high";
        document.getElementById("pet-vision-doubao-auto-observe").checked = doubao.autoObserveEnabled !== false;
        document.getElementById("pet-vision-doubao-auto-interval").value = Number(doubao.autoObserveIntervalSec || 60);
        document.getElementById("pet-vision-doubao-auto-style").value = doubao.autoObserveStyle || "game_assist";
        updateDoubaoScreenShareEngineInput();
        updateDoubaoAudioModeInput();
        updateRealtimeModelInput();
        updateRealtimeImagePresetInput();
        updateInheritedDisplay(merged);
        setMode(merged.apiMode || "inherit");
    }

    async function loadConfigToForm() {
        currentConfig = await MOD().loadConfig();
        fillForm(currentConfig);
    }

    async function saveSettings() {
        try {
            let config = readFormConfig();
            if (config.engine === "http" && config.apiMode === "inherit") {
                const synced = await syncInheritedApi(config, true);
                if (!synced.ok) {
                    setResult(synced.message, "error");
                    return;
                }
                config = synced.config;
            }
            const validation = MOD().validateConfig(config, config.enabled);
            if (!validation.ok) {
                setResult(validation.message, "error");
                return;
            }
            currentConfig = await MOD().saveConfig(config);
            fillForm(currentConfig);
            setResult("桌宠设置已保存", "success");
        } catch (error) {
            setResult("保存失败：" + (error.message || error), "error");
        }
    }

    async function makeTestVisionPayload(config) {
        const preset = MOD().getVisionPresetConfig?.(config) || { sampleEnabled: false, frameCount: 1, targetSpanSec: 0 };
        const targetCount = Math.max(1, Math.min(12, Math.round(Number(preset.frameCount || 1))));
        if (!preset.sampleEnabled || targetCount <= 1) {
            setResult("正在抓取测试截图...", "success");
            const currentFrame = await MOD().captureScreenFrame({ config });
            return {
                payload: await MOD().buildVisionPayload(config, [], currentFrame),
                synthetic: false
            };
        }

        const frames = [];
        const captureDelayMs = targetCount >= 10 ? 300 : 450;
        for (let index = 0; index < targetCount; index++) {
            setResult(`正在采集拼图测试帧 ${index + 1}/${targetCount}...`, "success");
            const frame = await MOD().captureScreenFrame({ config });
            if (frame?.dataUrl) {
                frames.push(frame);
            }
            if (index < targetCount - 1) {
                await wait(captureDelayMs);
            }
        }
        if (frames.length <= 1) {
            const currentFrame = frames[frames.length - 1] || await MOD().captureScreenFrame({ config });
            return {
                payload: await MOD().buildVisionPayload(config, [], currentFrame),
                synthetic: false
            };
        }

        const now = Date.now();
        const spanMs = Math.max(1000, Math.round(Number(preset.targetSpanSec || frames.length)) * 1000);
        frames.forEach((frame, index) => {
            const progress = frames.length <= 1 ? 0 : index / (frames.length - 1);
            frame.timestamp = now - Math.round((1 - progress) * spanMs);
            frame.syntheticTestTimestamp = true;
        });
        frames[frames.length - 1].timestamp = now;
        setResult("正在生成测试拼图并请求接口...", "success");
        return {
            payload: await MOD().buildVisionPayload(config, frames.slice(0, -1), frames[frames.length - 1]),
            synthetic: true
        };
    }

    function extractRealtimeTestText(payload) {
        if (!payload || typeof payload !== "object") {
            return "";
        }
        const direct = payload.text || payload.transcript || payload.content;
        if (typeof direct === "string") {
            return direct;
        }
        const chunks = [];
        const collect = value => {
            if (!value) {
                return;
            }
            if (typeof value === "string") {
                chunks.push(value);
                return;
            }
            if (Array.isArray(value)) {
                value.forEach(collect);
                return;
            }
            if (typeof value === "object") {
                ["text", "transcript", "content", "message", "output", "item", "part", "response"].forEach(key => collect(value[key]));
            }
        };
        collect(payload.response || payload.item || payload.part || payload.output);
        return chunks.join("");
    }

    async function testRealtimeSettings(config) {
        const bridge = await getRealtimeBridge();
        const realtimeConfig = MOD().getRealtimeConfig(config);
        setResult("正在连接 Qwen Realtime...", "success");
        let resultDeltaText = "";
        let resultFinalText = "";
        let resultText = "";
        let errorText = "";
        let responseId = "";
        const audioChunks = [];
        let cleanup = null;
        try {
            const events = [];
            const listenerStartedAt = Date.now();
            cleanup = bridge.onEvent(event => {
                if (event?.timestamp && Number(event.timestamp) < listenerStartedAt - 1000) {
                    return;
                }
                events.push(event);
                const payload = event?.payload || {};
                if (event?.type === "server") {
                    const eventType = payload.type || "";
                    if (eventType === "error") {
                        const errorMessage = payload.error?.message || payload.message || "未知错误";
                        setResult(isContentRejectedError(errorMessage)
                            ? "Realtime 测试被内容安全拒绝：" + getContentRejectedTestMessage(errorMessage)
                            : "Realtime 测试失败：" + errorMessage, "error");
                        return;
                    }
                    if (eventType === "response.created") {
                        responseId = payload.response?.id || payload.response_id || responseId;
                        return;
                    }
                    const payloadResponseId = payload.response_id || payload.response?.id || "";
                    if (eventType.startsWith("response.") && responseId && payloadResponseId && payloadResponseId !== responseId) {
                        return;
                    }
                    if (eventType === "response.audio.delta" && payload.delta) {
                        audioChunks.push(String(payload.delta));
                    }
                    if (eventType === "response.text.delta" || eventType === "response.audio_transcript.delta" || eventType === "response.output_text.delta") {
                        const delta = payload.delta || payload.text || payload.transcript || "";
                        if (typeof delta === "string") {
                            resultDeltaText += delta;
                            resultText = resultFinalText || resultDeltaText;
                        }
                    }
                    if (eventType === "response.text.done" || eventType === "response.audio_transcript.done" || eventType === "response.output_text.done") {
                        const text = payload.text || payload.transcript || payload.output?.text || "";
                        if (text) {
                            resultFinalText = String(text);
                            resultText = resultFinalText;
                        }
                    }
                    if (eventType === "response.done") {
                        const text = extractRealtimeTestText(payload);
                        if (text) {
                            resultFinalText = text;
                            resultText = resultFinalText;
                        }
                    }
                } else if (event?.type === "error") {
                    const errorMessage = payload.message || payload.error || "未知错误";
                    setResult(isContentRejectedError(errorMessage)
                        ? "Realtime 测试被内容安全拒绝：" + getContentRejectedTestMessage(errorMessage)
                        : "Realtime 测试失败：" + errorMessage, "error");
                }
            });
            const instructions = "你是桌宠 Realtime 测试助手。收到测试音频和截图后，只回复 OK。";
            await bridge.connect({
                realtime: realtimeConfig,
                instructions
            });
            await wait(900);
            const image = await captureRealtimeImage(config, bridge);
            if (image?.dataUrl) {
                setPreview({
                    screenshotDataUrl: image.dataUrl,
                    visionFrameCount: 1,
                    visionPreset: realtimeConfig.imagePreset || "qwenRealtime",
                    isVisionCollage: false,
                    previewLabel: "Realtime 测试发送图片",
                    previewKind: "单帧",
                    previewNote: "这就是本次 Realtime 测试发给 Qwen 的压缩后图片。",
                    imageWidth: image.width,
                    imageHeight: image.height,
                    imageBytes: image.bytes,
                    imageQuality: image.quality
                }, false);
            }
            await bridge.send({
                type: "input_audio_buffer.append",
                audio: createSilencePcm16Base64(320)
            });
            if (image?.base64) {
                await bridge.send({
                    type: "input_image_buffer.append",
                    image: image.base64
                });
            }
            await bridge.send({ type: "input_audio_buffer.commit" });
            await bridge.send({
                type: "response.create",
                response: {
                    modalities: realtimeConfig.audioMode === "qwenAudio" ? ["text", "audio"] : ["text"],
                    instructions: "这是一次连接测试，请只回复 OK。"
                }
            });
            setResult("已发送测试音频和截图，等待 Realtime 回复...", "success");
            const startedAt = Date.now();
            while (Date.now() - startedAt < 20000) {
                if (events.some(event => {
                    const payload = event?.payload || {};
                    const eventResponseId = payload.response_id || payload.response?.id || "";
                    return payload.type === "response.done" && (!responseId || !eventResponseId || eventResponseId === responseId);
                })) {
                    break;
                }
                await wait(250);
            }
            if (realtimeConfig.audioMode === "qwenAudio" && audioChunks.length) {
                await playRealtimeTestAudio(audioChunks).catch(() => {});
            } else if (realtimeConfig.audioMode !== "qwenAudio" && config.enableVoice !== false && resultText.trim()) {
                await playGameTtsTestAudio(resultText.trim()).catch(() => {});
            }
            setResult("Realtime 测试完成：" + (resultText.trim().slice(0, 80) || "已收到服务端事件"), "success");
        } finally {
            if (cleanup) {
                cleanup();
            }
            await bridge.close().catch(() => {});
        }
    }

    async function testDoubaoRtcSettings(config) {
        const bridge = await getDoubaoRtcBridge();
        const doubaoConfig = {
            ...MOD().getDoubaoRtcConfig(config),
            enableVoice: config.enableVoice !== false
        };
        setResult("正在连接豆包 RTC...", "success");
        let cleanup = null;
        let resultText = "";
        let errorText = "";
        try {
            const events = [];
            const listenerStartedAt = Date.now();
            cleanup = bridge.onEvent(event => {
                if (event?.timestamp && Number(event.timestamp) < listenerStartedAt - 1000) {
                    return;
                }
                events.push(event);
                const payload = event?.payload || {};
                if (event?.type === "server") {
                    const eventType = payload.type || "";
                    if (eventType === "error") {
                        errorText = payload.error?.message || payload.message || "未知错误";
                        setResult("豆包 RTC 测试失败：" + errorText, "error");
                        return;
                    }
                    if (eventType === "response.text.delta" || eventType === "response.output_text.delta") {
                        const delta = payload.delta || payload.text || payload.transcript || "";
                        if (typeof delta === "string" && delta) {
                            resultText += delta;
                            setResult("豆包 RTC 正在返回：" + resultText.trim().slice(0, 80), "success");
                        }
                    }
                    if (eventType === "response.text.done" || eventType === "response.output_text.done") {
                        resultText = payload.text || payload.transcript || resultText;
                    }
                    if (eventType === "response.done") {
                        resultText = extractRealtimeTestText(payload) || resultText;
                    }
                } else if (event?.type === "error") {
                    errorText = payload.message || payload.error || "未知错误";
                    setResult("豆包 RTC 测试失败：" + errorText, "error");
                }
            });
            await bridge.connect({
                doubaoRtc: doubaoConfig,
                realtime: doubaoConfig,
                testMode: true,
                instructions: "你是桌宠豆包 RTC 测试助手。收到测试请求后，只回复 OK。"
            });
            await bridge.send({
                type: "response.create",
                response: {
                    instructions: "这是一次连接测试，请只回复 OK。"
                }
            });
            setResult("已创建豆包 RTC 房间并发送测试请求，等待字幕...", "success");
            const startedAt = Date.now();
            while (Date.now() - startedAt < 30000) {
                if (errorText || resultText.trim() || events.some(event => event?.payload?.type === "response.done")) {
                    break;
                }
                await wait(300);
            }
            if (errorText) {
                return;
            }
            if (!resultText.trim()) {
                setResult("豆包 RTC 已进入房间并发送请求，但 30 秒内没有收到字幕。若日志只有 conv/thinking，没有 subv 字幕，优先检查火山方舟 Endpoint ID：必须是已部署且能连接可用模型的 Endpoint，不是模型名、API Key ID 或其它资源 ID。", "error");
                return;
            }
            if (doubaoConfig.audioMode === "localTts" && config.enableVoice !== false && resultText.trim()) {
                await playGameTtsTestAudio(resultText.trim()).catch(() => {});
            }
            setResult("豆包 RTC 测试完成：" + (resultText.trim().slice(0, 80) || "已收到服务端事件"), "success");
        } finally {
            if (cleanup) {
                cleanup();
            }
            await bridge.close().catch(() => {});
        }
    }

    async function playRealtimeTestAudio(chunks) {
        const bytes = concatBase64Chunks(chunks);
        if (!bytes.length) {
            return;
        }
        const wav = wrapPcmAsWav(bytes, 24000, 1);
        const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
        try {
            const audio = new Audio(url);
            await audio.play();
            await new Promise(resolve => {
                audio.onended = resolve;
                audio.onerror = resolve;
                setTimeout(resolve, 20000);
            });
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async function playGameTtsTestAudio(text) {
        if (!window.electronAPI?.generateTTS) {
            return;
        }
        try {
            if (window.electronAPI.toggleTTSService) {
                await window.electronAPI.toggleTTSService(true).catch(() => {});
            }
            if (window.electronAPI.warmupTTS) {
                await window.electronAPI.warmupTTS("YUKI").catch(() => {});
            }
            const result = await window.electronAPI.generateTTS({
                text: String(text || "OK").slice(0, 120),
                character: "YUKI",
                useCloud: false
            });
            const audioPath = result?.audioPath || result?.audio_path || result?.path || result?.url || result?.data?.audioPath || result?.data?.audio_path || (typeof result === "string" ? result : "");
            const audioUrl = resolveTtsAudioUrl(audioPath);
            if (!audioUrl) {
                return;
            }
            const audio = new Audio(audioUrl);
            await audio.play();
            await new Promise(resolve => {
                audio.onended = resolve;
                audio.onerror = resolve;
                setTimeout(resolve, 20000);
            });
        } catch (error) {
            console.warn("[YukiVisionMod] Realtime 测试内置 TTS 播放失败:", error);
        }
    }

    function resolveTtsAudioUrl(audioPath) {
        const raw = String(audioPath || "").trim();
        if (!raw) {
            return "";
        }
        if (/^(https?:|file:|data:)/i.test(raw)) {
            return raw;
        }
        const normalized = raw.replace(/\\/g, "/");
        if (/^[A-Za-z]:\//.test(normalized)) {
            return "file:///" + normalized.replace(/ /g, "%20").replace(/#/g, "%23").replace(/\?/g, "%3F");
        }
        const filename = normalized.replace(/^\/?audio\//i, "").split("/").pop();
        return "http://127.0.0.1:8765/audio/" + encodeURIComponent(filename || normalized);
    }

    function concatBase64Chunks(chunks) {
        const arrays = chunks.map(chunk => {
            const binary = atob(String(chunk || ""));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        });
        const total = arrays.reduce((sum, bytes) => sum + bytes.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        arrays.forEach(bytes => {
            out.set(bytes, offset);
            offset += bytes.length;
        });
        return out;
    }

    function wrapPcmAsWav(pcmBytes, sampleRate, channels) {
        const dataSize = pcmBytes.length;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const writeString = (offset, value) => {
            for (let i = 0; i < value.length; i++) {
                view.setUint8(offset + i, value.charCodeAt(i));
            }
        };
        writeString(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * 2, true);
        view.setUint16(32, channels * 2, true);
        view.setUint16(34, 16, true);
        writeString(36, "data");
        view.setUint32(40, dataSize, true);
        new Uint8Array(buffer, 44).set(pcmBytes);
        return buffer;
    }

    function createSilencePcm16Base64(durationMs) {
        const sampleRate = 16000;
        const samples = Math.max(1, Math.round(sampleRate * (durationMs || 300) / 1000));
        const bytes = new Uint8Array(samples * 2);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function estimateImageBytes(dataUrl) {
        const text = String(dataUrl || "");
        const comma = text.indexOf(",");
        const length = comma >= 0 ? text.length - comma - 1 : text.length;
        return Math.ceil(length * 3 / 4);
    }

    async function captureRealtimeImage(config, bridge) {
        const realtime = MOD().getRealtimeConfig(config);
        let rawCapture = "";
        let captureSource = "legacy_getScreenCapture";
        try {
            if (bridge?.captureScreen) {
                const result = await bridge.captureScreen({
                    maxDim: realtime.imageMaxDim,
                    maxBytes: realtime.imageMaxBytes
                });
                rawCapture = result?.dataUrl || result?.image || result;
                if (rawCapture) {
                    captureSource = result?.source || "desktop_capturer";
                }
            }
        } catch (_) {
            // Fall back to the game's original screenshot helper.
        }
        if (!rawCapture) {
            rawCapture = await window.electronAPI?.getScreenCapture?.();
        }
        const dataUrl = normalizeImageDataUrl(rawCapture);
        if (!dataUrl) {
            return null;
        }
        const image = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("Realtime 测试截图加载失败"));
            img.src = dataUrl;
        });
        const maxDim = Number(realtime.imageMaxDim || 1080);
        const maxBytes = Number(realtime.imageMaxBytes || 185000);
        const scale = Math.min(1, maxDim / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
        let canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
        canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        let quality = Math.max(0.4, Math.min(0.95, Number(realtime.imageJpegQuality || 78) / 100));
        let output = canvas.toDataURL("image/jpeg", quality);
        while (quality > 0.42 && estimateImageBytes(output) > maxBytes) {
            quality -= 0.04;
            output = canvas.toDataURL("image/jpeg", quality);
        }
        let shrinkAttempts = 0;
        while (estimateImageBytes(output) > maxBytes && shrinkAttempts < 8 && canvas.width > 640 && canvas.height > 360) {
            const nextCanvas = document.createElement("canvas");
            nextCanvas.width = Math.max(1, Math.round(canvas.width * 0.86));
            nextCanvas.height = Math.max(1, Math.round(canvas.height * 0.86));
            nextCanvas.getContext("2d").drawImage(canvas, 0, 0, nextCanvas.width, nextCanvas.height);
            canvas = nextCanvas;
            quality = Math.max(0.52, Math.min(0.82, Number(realtime.imageJpegQuality || 78) / 100 - 0.12));
            output = canvas.toDataURL("image/jpeg", quality);
            while (quality > 0.42 && estimateImageBytes(output) > maxBytes) {
                quality -= 0.04;
                output = canvas.toDataURL("image/jpeg", quality);
            }
            shrinkAttempts += 1;
        }
        const finalBytes = estimateImageBytes(output);
        if (finalBytes > maxBytes) {
            return null;
        }
        return {
            dataUrl: output,
            base64: output.replace(/^data:image\/jpeg;base64,/, ""),
            source: captureSource,
            sourceWidth: image.naturalWidth || image.width,
            sourceHeight: image.naturalHeight || image.height,
            width: canvas.width,
            height: canvas.height,
            bytes: finalBytes,
            quality: Math.round(quality * 100)
        };
    }

    function normalizeImageDataUrl(value) {
        const text = String(value || "").trim();
        if (!text) {
            return "";
        }
        if (/^data:image\//i.test(text)) {
            return text;
        }
        return "data:image/jpeg;base64," + text.replace(/^data:image\/jpeg;base64,/i, "");
    }

    async function testSettings() {
        const btn = document.getElementById("pet-vision-test-btn");
        try {
            if (btn) {
                btn.disabled = true;
            }
            clearPreview();
            let config = readFormConfig();
            if (config.engine === "qwenRealtime" || config.engine === "doubaoRtc") {
                const validation = MOD().validateConfig(config, false);
                if (!validation.ok) {
                    setResult(validation.message, "error");
                    return;
                }
                if (config.engine === "doubaoRtc") {
                    await testDoubaoRtcSettings(config);
                } else {
                    await testRealtimeSettings(config);
                }
                return;
            }
            if (config.apiMode === "inherit") {
                const synced = await syncInheritedApi(config, true);
                if (!synced.ok) {
                    setResult(synced.message, "error");
                    return;
                }
                config = synced.config;
            }
            const validation = MOD().validateConfig(config, false);
            if (!validation.ok) {
                setResult(validation.message, "error");
                return;
            }
            const canSendImage = MOD().supportsImageInput?.(config) !== false;
            const compatibilityMessage = MOD().getCompatibilityMessage?.(config) || "";
            setResult(canSendImage ? "正在准备测试图片..." : "当前 API 不支持图片，正在按文字模式测试接口...", "success");
            let visionPayload = null;
            let syntheticPreview = false;
            if (canSendImage) {
                const testPayload = await makeTestVisionPayload(config);
                visionPayload = testPayload.payload;
                syntheticPreview = testPayload.synthetic;
                setPreview(visionPayload, syntheticPreview);
            }
            const screenshotDataUrl = visionPayload?.screenshotDataUrl || "";
            const activeWindowName = config.includeActiveWindow ? await MOD().getActiveWindowName() : "";
            const testText = canSendImage
                ? (visionPayload?.isVisionCollage
                    ? "这是一次桌宠视觉接口测试。图片是一张连续截图拼图，请确认你能理解拼图内容并只回复 OK。"
                    : "这是一次桌宠视觉接口测试，请结合截图回复 OK。")
                : "这是一次桌宠文字接口测试，请回复 OK。";
            const text = await MOD().callVisionApi(config, {
                systemPrompt: "你是桌宠接口测试助手。请只回复 OK。",
                text: testText,
                screenshotDataUrl,
                activeWindowName,
                visionPreset: visionPayload?.visionPreset,
                visionFrameCount: visionPayload?.visionFrameCount,
                visionSpanSeconds: visionPayload?.visionSpanSeconds,
                isVisionCollage: visionPayload?.isVisionCollage,
                visionCollageMaxDim: visionPayload?.visionCollageMaxDim,
                visionCollageJpegQuality: visionPayload?.visionCollageJpegQuality,
                captureMaxDim: visionPayload?.captureMaxDim,
                captureJpegQuality: visionPayload?.captureJpegQuality,
                timeoutMs: 45000,
                source: "settings_test",
                debugLog: (stage, data) => writeSettingsDebugLog(stage, data)
            });
            const imageNote = screenshotDataUrl ? " / 已显示本次发送图片" : "";
            setResult("测试成功：" + String(text || "OK").slice(0, 80) + imageNote + (compatibilityMessage ? " / " + compatibilityMessage : ""), "success");
        } catch (error) {
            if (isContentRejectedError(error)) {
                setResult("测试被内容安全拒绝：" + getContentRejectedTestMessage(error), "error");
            } else {
                setResult("测试失败：" + (error.message || error), "error");
            }
        } finally {
            if (btn) {
                btn.disabled = false;
            }
        }
    }

    function buildModal() {
        if (document.getElementById("pet-vision-settings-modal")) {
            return;
        }
        const modal = document.createElement("div");
        modal.id = "pet-vision-settings-modal";
        modal.className = "modal";
        modal.style.display = "none";
        modal.innerHTML = `
            <div class="modal-content mj-settings-panel ai-settings-content pet-vision-settings-content">
                <div class="modal-header">
                    <h2>桌宠设置</h2>
                    <button id="pet-vision-settings-close-btn" class="close-btn">x</button>
                </div>
                <div class="mj-panel-body">
                    <div class="mj-panel-sidebar">
                        <div class="mj-sidebar-group pet-vision-http-only">
                            <div class="mj-sidebar-label">接口方式</div>
                            <button class="mode-btn mj-sidebar-item active" data-pet-vision-mode="inherit">沿用当前自定义 API</button>
                            <button class="mode-btn mj-sidebar-item" data-pet-vision-mode="openai">单独配置 API</button>
                            <button class="mode-btn mj-sidebar-item" data-pet-vision-mode="custom">自定义端点</button>
                        </div>
                    </div>
                    <div class="mj-panel-content">
                        <div class="setting-group">
                            <label><input type="checkbox" id="pet-vision-enabled"> 启用桌宠 MOD 全模态</label>
                        </div>
                        <div class="setting-group">
                            <label for="pet-vision-engine">桌宠引擎:</label>
                            <select id="pet-vision-engine" class="setting-input">
                                <option value="http">HTTP 多模态</option>
                                <option value="qwenRealtime">Qwen Realtime</option>
                                <option value="doubaoRtc">豆包 RTC（实验）</option>
                            </select>
                            <div class="current-value">Realtime/RTC 模式会在桌宠会话期间发送麦克风和屏幕流，成本和隐私风险高于 HTTP 冷却截图模式。</div>
                        </div>
                        <div class="setting-group pet-vision-http-only">
                            <label for="pet-vision-auto-cooldown">自动回复统一冷却秒数:</label>
                            <input type="number" id="pet-vision-auto-cooldown" class="setting-input" min="5" max="600" step="1">
                        </div>
                        <div class="setting-group">
                            <label><input type="checkbox" id="pet-vision-include-window"> 同时发送当前前台程序名</label>
                        </div>
                        <div class="setting-group">
                            <label><input type="checkbox" id="pet-vision-enable-voice"> 启用桌宠语音播报</label>
                        </div>
                        <div class="setting-group pet-vision-http-only">
                            <label><input type="checkbox" id="pet-vision-http-stream-segmented"> HTTP 支持时分段显示和分段语音</label>
                            <div class="current-value">仅对支持流式输出的 OpenAI 兼容模型自动启用；不支持时会回退到完整回复。</div>
                        </div>
                        <div class="config-section pet-vision-realtime-only" style="display:none;">
                            <div class="setting-group">
                                <label for="pet-vision-realtime-model">Qwen Realtime 模型:</label>
                                <select id="pet-vision-realtime-model" class="setting-input">
                                    <option value="qwen3.5-omni-flash-realtime-2026-03-15">qwen3.5-omni-flash-realtime-2026-03-15</option>
                                    <option value="qwen3.5-omni-plus-realtime-2026-03-15">qwen3.5-omni-plus-realtime-2026-03-15</option>
                                    <option value="custom">自定义模型名</option>
                                </select>
                                <div class="current-value">如果 snapshot 模型返回不存在，可以改用无日期别名。</div>
                            </div>
                            <div class="setting-group" id="pet-vision-realtime-custom-model-wrap" style="display:none;">
                                <label for="pet-vision-realtime-custom-model">自定义模型名:</label>
                                <input type="text" id="pet-vision-realtime-custom-model" class="setting-input" placeholder="例如 qwen3.5-omni-flash-realtime">
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-realtime-key">DashScope API Key:</label>
                                <input type="password" id="pet-vision-realtime-key" class="setting-input" placeholder="留空则保留当前密钥">
                                <div class="current-value">当前值：<span id="pet-vision-realtime-key-current"></span></div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-realtime-audio-mode">Realtime 语音来源:</label>
                                <select id="pet-vision-realtime-audio-mode" class="setting-input">
                                    <option value="gameTts">游戏内置语音</option>
                                    <option value="qwenAudio">Qwen 模型语音</option>
                                </select>
                                <div id="pet-vision-realtime-audio-mode-hint" class="current-value">默认只让 Qwen 返回字幕文字，再调用游戏内置 Yuki 语音播报。</div>
                            </div>
                            <div class="setting-group" id="pet-vision-realtime-qwen-voice-wrap" style="display:none;">
                                <label for="pet-vision-realtime-voice">Qwen 音色:</label>
                                <input type="text" id="pet-vision-realtime-voice" class="setting-input" placeholder="Tina">
                                <div id="pet-vision-realtime-voice-hint" class="current-value">Qwen3.5 Realtime 推荐使用 Tina；Cherry 会被服务端拒绝。</div>
                            </div>
                            <div class="setting-group">
                                <label>说话方式:</label>
                                <div class="current-value">右 Alt 按住说话；热键失效时桌宠旁会显示兜底按住按钮。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-realtime-screen-mode">Realtime 屏幕帧:</label>
                                <select id="pet-vision-realtime-screen-mode" class="setting-input">
                                    <option value="always_1fps">全程 1fps</option>
                                    <option value="ptt_1fps">按住说话时 1fps</option>
                                    <option value="low_frequency">低频常驻</option>
                                    <option value="off">关闭屏幕帧</option>
                                </select>
                                <div class="current-value">Realtime 不使用大拼图，会发送连续小 JPEG 帧。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-realtime-image-preset">Realtime 图片质量档位:</label>
                                <select id="pet-vision-realtime-image-preset" class="setting-input">
                                    <option value="tiny">极省流量：最长边 640 / 45KB / 质量 62</option>
                                    <option value="low">低流量：最长边 800 / 65KB / 质量 68</option>
                                    <option value="economy">省流量：最长边 960 / 90KB / 质量 72</option>
                                    <option value="standard">标准：最长边 1080 / 130KB / 质量 78</option>
                                    <option value="clear">高清：最长边 1440 / 160KB / 质量 88</option>
                                    <option value="max">极限吃满：最长边 1920 / 185KB / 质量 92</option>
                                </select>
                                <div id="pet-vision-realtime-image-preset-hint" class="current-value">Qwen WebSocket 单帧限制约 256KB；图片会控制在 185KB 以内，避免一打开桌宠就断开。</div>
                            </div>
                            <div class="setting-group">
                                <label><input type="checkbox" id="pet-vision-realtime-auto-observe"> 无人说话时自动观察回复</label>
                                <div class="current-value">保留右 Alt 按住说话；开启后，桌宠空闲时也会隔一段时间自己看屏幕说一句。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-realtime-auto-interval">自动观察冷却秒数:</label>
                                <input type="number" id="pet-vision-realtime-auto-interval" class="setting-input" min="5" max="600" step="5">
                                <div class="current-value">桌宠回复/语音结束后，或用户松开右 Alt 说完话后，都会等待这段时间再自动观察。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-realtime-auto-style">自动回复风格:</label>
                                <select id="pet-vision-realtime-auto-style" class="setting-input">
                                    <option value="quiet">安静陪伴</option>
                                    <option value="game_assist">游戏辅助</option>
                                    <option value="active">活跃陪聊</option>
                                </select>
                            </div>
                        </div>
                        <div class="config-section pet-vision-doubao-only" style="display:none;">
                            <div class="setting-group">
                                <label for="pet-vision-doubao-ak">火山 OpenAPI Access Key ID:</label>
                                <input type="password" id="pet-vision-doubao-ak" class="setting-input" placeholder="留空则保留当前密钥">
                                <div class="current-value">当前值：<span id="pet-vision-doubao-ak-current"></span></div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-sk">火山 OpenAPI Secret Access Key:</label>
                                <input type="password" id="pet-vision-doubao-sk" class="setting-input" placeholder="留空则保留当前密钥">
                                <div class="current-value">当前值：<span id="pet-vision-doubao-sk-current"></span></div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-rtc-appid">RTC AppId:</label>
                                <input type="text" id="pet-vision-doubao-rtc-appid" class="setting-input" placeholder="RTC 控制台里的 AppId">
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-rtc-appkey">RTC AppKey:</label>
                                <input type="password" id="pet-vision-doubao-rtc-appkey" class="setting-input" placeholder="留空则保留当前 AppKey">
                                <div class="current-value">当前值：<span id="pet-vision-doubao-rtc-appkey-current"></span></div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-endpoint">火山方舟 Endpoint ID:</label>
                                <input type="text" id="pet-vision-doubao-endpoint" class="setting-input" placeholder="例如 ep-xxxxxxxx">
                                <div class="current-value">必须填写方舟里已部署、可用、能连接模型的 Endpoint ID；不要填模型名、API Key ID 或其它资源 ID。若测试只停在 thinking，优先检查这里。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-asr-appid">ASR AppId:</label>
                                <input type="text" id="pet-vision-doubao-asr-appid" class="setting-input" placeholder="语音识别控制台 AppId">
                                <div class="current-value">豆包语音模型通常共用同一套 AppId / Access Token；请在下面 TTS 区域也填写对应值。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-asr-token">ASR Access Token:</label>
                                <input type="password" id="pet-vision-doubao-asr-token" class="setting-input" placeholder="留空则保留当前 Token">
                                <div class="current-value">当前值：<span id="pet-vision-doubao-asr-token-current"></span></div>
                                <div class="current-value">ASR Secret Key 不需要填写；这里只填 Access Token。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-audio-mode">豆包 RTC 语音输出:</label>
                                <select id="pet-vision-doubao-audio-mode" class="setting-input">
                                    <option value="remoteTts">火山远端 TTS（低延迟，推荐）</option>
                                    <option value="localTts">游戏本地 Yuki TTS（旧方案）</option>
                                </select>
                                <div class="current-value">默认直接播放豆包 RTC 远端语音；如果远端语音不可用，可以切回本地 Yuki TTS。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-tts-appid">TTS AppId:</label>
                                <input type="text" id="pet-vision-doubao-tts-appid" class="setting-input" placeholder="语音合成控制台 AppId">
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-tts-token">TTS Access Token:</label>
                                <input type="password" id="pet-vision-doubao-tts-token" class="setting-input" placeholder="留空则保留当前 Token">
                                <div class="current-value">当前值：<span id="pet-vision-doubao-tts-token-current"></span></div>
                                <div class="current-value">TTS Secret Key 不需要填写；这里只填 Token / Access Token。</div>
                            </div>
                            <div class="setting-group" id="pet-vision-doubao-tts-voice-wrap">
                                <label for="pet-vision-doubao-tts-voice">TTS Voice Type:</label>
                                <input type="text" id="pet-vision-doubao-tts-voice" class="setting-input" placeholder="zh_female_meilinvyou_moon_bigtts">
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-screen-share-engine">屏幕流实现方式:</label>
                                <select id="pet-vision-doubao-screen-share-engine" class="setting-input">
                                    <option value="web">作者 Web SDK 方案（推荐）</option>
                                    <option value="native">原生 veRTC 方案（实验）</option>
                                </select>
                                <div class="current-value" id="pet-vision-doubao-screen-share-engine-status">默认使用作者 Web SDK 方案。</div>
                                <div class="current-value">Web SDK 方案仿照原版发布会话级屏幕流；如需完全关闭视觉，请把屏幕流模式改为“关闭屏幕流”。原生 veRTC 是之前的实现，主要用于对比和诊断。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-screen-mode">屏幕流模式:</label>
                                <select id="pet-vision-doubao-screen-mode" class="setting-input">
                                    <option value="always_1fps">全程 1fps</option>
                                    <option value="ptt_1fps">按住说话时 1fps</option>
                                    <option value="low_frequency">低频常驻</option>
                                    <option value="off">关闭屏幕流</option>
                                </select>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-video-preset">屏幕流清晰度:</label>
                                <select id="pet-vision-doubao-video-preset" class="setting-input">
                                    <option value="economy">省流量：960x540</option>
                                    <option value="standard">标准：1280x720</option>
                                    <option value="clear">高清：1600x900</option>
                                    <option value="max">最高：1920x1080</option>
                                </select>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-image-height">豆包视觉截图高度:</label>
                                <select id="pet-vision-doubao-image-height" class="setting-input">
                                    <option value="360">极省流量：360</option>
                                    <option value="480">低流量：480</option>
                                    <option value="540">轻量：540</option>
                                    <option value="720">标准：720</option>
                                    <option value="900">高清：900</option>
                                    <option value="1080">最高：1080</option>
                                </select>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-image-detail">豆包视觉细节:</label>
                                <select id="pet-vision-doubao-image-detail" class="setting-input">
                                    <option value="high">high</option>
                                    <option value="low">low</option>
                                </select>
                            </div>
                            <div class="setting-group">
                                <label><input type="checkbox" id="pet-vision-doubao-auto-observe"> 空闲时自动观察</label>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-auto-interval">自动观察冷却秒数:</label>
                                <input type="number" id="pet-vision-doubao-auto-interval" class="setting-input" min="5" max="600" step="5">
                                <div class="current-value">桌宠回复/语音结束后，或用户松开右 Alt 说完话后，都会等待这段时间再自动观察。</div>
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-doubao-auto-style">自动回复风格:</label>
                                <select id="pet-vision-doubao-auto-style" class="setting-input">
                                    <option value="quiet">安静陪伴</option>
                                    <option value="game_assist">游戏辅助</option>
                                    <option value="active">活跃陪聊</option>
                                </select>
                            </div>
                        </div>
                        <div class="setting-group pet-vision-http-only">
                            <label for="pet-vision-preset">画面理解预设:</label>
                            <select id="pet-vision-preset" class="setting-input">
                                <option value="single">省流量：只发当前截图</option>
                                <option value="lite">轻量动态：本次间隔内 / 3 帧</option>
                                <option value="balanced">平衡（推荐）：本次间隔内 / 4 帧高清</option>
                                <option value="dynamic">动态：本次间隔内 / 6 帧高清</option>
                                <option value="premium">高预算：本次间隔内 / 8 帧高清</option>
                                <option value="ultra">多帧：本次间隔内 / 10 帧高清</option>
                                <option value="extreme">超多帧：本次间隔内 / 12 帧高清</option>
                            </select>
                            <div class="current-value">除省流量外，档位决定每次观察间隔内取几张图；高帧档会生成更大的拼图，API 请求频率不变。</div>
                        </div>
                        <div class="setting-group">
                            <label>回复字数范围:</label>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                                <input type="number" id="pet-vision-reply-min-chars" class="setting-input" min="10" max="500" step="5" placeholder="最低字数">
                                <input type="number" id="pet-vision-reply-max-chars" class="setting-input" min="20" max="800" step="5" placeholder="最高字数">
                            </div>
                            <div class="current-value">按中文字符粗略计算。默认 20-40；想更详细可填 90-180。</div>
                        </div>
                        <div class="setting-group">
                            <label for="pet-vision-max-output-tokens">单次 token 上限（不懂勿动，0=自动）:</label>
                            <input type="number" id="pet-vision-max-output-tokens" class="setting-input" min="0" max="4096" step="64" placeholder="0">
                        </div>
                        <div class="setting-group">
                            <label for="pet-vision-extra-prompt">附加 Prompt（可选）:</label>
                            <textarea id="pet-vision-extra-prompt" class="setting-input" rows="4" maxlength="2000" placeholder="例如：回复更像妹妹一点，多吐槽当前页面，不要太像助手。"></textarea>
                            <div class="current-value">会追加到作者原本桌宠人设后面，留空则使用默认提示词。</div>
                        </div>
                        <div class="setting-group">
                            <label>MOD 调试日志:</label>
                            <div class="button-row" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:center;">
                                <button id="pet-vision-open-log-btn" class="action-btn" type="button" style="width:100%;white-space:nowrap;">打开日志文件夹</button>
                                <button id="pet-vision-copy-log-btn" class="action-btn" type="button" style="width:100%;white-space:nowrap;">复制最近日志</button>
                                <button id="pet-vision-clear-log-btn" class="action-btn secondary" type="button" style="width:100%;white-space:nowrap;">清空日志</button>
                            </div>
                            <div class="current-value">HTTP 和 Realtime 共用这份日志；只记录状态、事件、耗时、图片/音频大小、返回结构和错误，不保存 API Key、截图原图或音频内容。</div>
                        </div>

                        <div class="config-section pet-vision-api-section pet-vision-http-only" data-pet-vision-section="inherit">
                            <div class="setting-group">
                                <label>当前同步的普通对话自定义 API:</label>
                                <div class="current-value"><span id="pet-vision-inherited-current">未同步</span></div>
                            </div>
                            <button id="pet-vision-sync-inherited-btn" class="action-btn">同步当前自定义 API</button>
                        </div>

                        <div class="config-section pet-vision-api-section pet-vision-http-only" data-pet-vision-section="openai" style="display:none;">
                            <div class="setting-group">
                                <label for="pet-vision-openai-baseurl">API Base URL:</label>
                                <input type="text" id="pet-vision-openai-baseurl" class="setting-input" placeholder="例如 https://api.example.com/v1">
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-openai-model">模型名称:</label>
                                <input type="text" id="pet-vision-openai-model" class="setting-input" placeholder="填写支持图片的模型">
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-openai-key">API Key:</label>
                                <input type="password" id="pet-vision-openai-key" class="setting-input" placeholder="留空则保留当前密钥">
                                <div class="current-value">当前值：<span id="pet-vision-openai-key-current"></span></div>
                            </div>
                        </div>

                        <div class="config-section pet-vision-api-section pet-vision-http-only" data-pet-vision-section="custom" style="display:none;">
                            <div class="setting-group">
                                <label for="pet-vision-custom-endpoint">完整接口地址:</label>
                                <input type="text" id="pet-vision-custom-endpoint" class="setting-input" placeholder="例如 http://127.0.0.1:3000/vision">
                            </div>
                            <div class="setting-group">
                                <label for="pet-vision-custom-key">接口密钥（可选）:</label>
                                <input type="password" id="pet-vision-custom-key" class="setting-input" placeholder="留空则不发送 Authorization">
                                <div class="current-value">当前值：<span id="pet-vision-custom-key-current"></span></div>
                            </div>
                        </div>

                        <div class="mj-panel-actions">
                            <button id="pet-vision-save-btn" class="mj-btn-primary">保存设置</button>
                            <button id="pet-vision-test-btn" class="mj-btn-secondary">测试API</button>
                        </div>
                        <div id="pet-vision-test-result" class="test-result"></div>
                        <div id="pet-vision-test-preview" class="test-result" style="display:none;">
                            <div id="pet-vision-test-preview-meta" class="current-value" style="margin-bottom:8px;"></div>
                            <img id="pet-vision-test-preview-img" alt="本次测试发送给接口的图片" style="display:block;width:100%;max-height:520px;object-fit:contain;border:1px solid rgba(0,0,0,0.12);border-radius:6px;background:#111;cursor:zoom-in;">
                        </div>
                    </div>
                </div>
            </div>
        `;
        const anchor = document.getElementById("ai-settings-modal");
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(modal, anchor.nextSibling);
        } else {
            document.body.appendChild(modal);
        }
    }

    function buildButton() {
        if (document.getElementById("pet-vision-settings-btn")) {
            return;
        }
        const group = document.querySelector(".ai-settings-group");
        if (!group) {
            return;
        }
        const btn = document.createElement("button");
        btn.id = "pet-vision-settings-btn";
        btn.className = "ai-settings-btn";
        btn.textContent = "桌宠设置";
        group.appendChild(btn);
    }

    function bindEvents() {
        document.getElementById("pet-vision-settings-btn")?.addEventListener("click", showModal);
        document.getElementById("pet-vision-settings-close-btn")?.addEventListener("click", hideModal);
        document.getElementById("pet-vision-save-btn")?.addEventListener("click", saveSettings);
        document.getElementById("pet-vision-test-btn")?.addEventListener("click", testSettings);
        document.getElementById("pet-vision-open-log-btn")?.addEventListener("click", openRealtimeLogFolder);
        document.getElementById("pet-vision-copy-log-btn")?.addEventListener("click", copyRecentRealtimeLog);
        document.getElementById("pet-vision-clear-log-btn")?.addEventListener("click", clearRealtimeLogFile);
        document.getElementById("pet-vision-sync-inherited-btn")?.addEventListener("click", async () => {
            const synced = await syncInheritedApi(readFormConfig(), true);
            setResult(synced.message, synced.ok ? "success" : "error");
            if (synced.ok) {
                fillForm(synced.config);
            }
        });
        document.querySelectorAll("[data-pet-vision-mode]").forEach(btn => {
            btn.addEventListener("click", () => setMode(btn.dataset.petVisionMode));
        });
        document.getElementById("pet-vision-engine")?.addEventListener("change", event => {
            setEngine(event.target.value);
            clearResult();
        });
        document.getElementById("pet-vision-realtime-model")?.addEventListener("change", updateRealtimeModelInput);
        document.getElementById("pet-vision-realtime-custom-model")?.addEventListener("input", updateRealtimeModelInput);
        document.getElementById("pet-vision-realtime-audio-mode")?.addEventListener("change", updateRealtimeAudioMode);
        document.getElementById("pet-vision-realtime-image-preset")?.addEventListener("change", updateRealtimeImagePresetInput);
        document.getElementById("pet-vision-doubao-screen-share-engine")?.addEventListener("change", updateDoubaoScreenShareEngineInput);
        document.getElementById("pet-vision-doubao-audio-mode")?.addEventListener("change", updateDoubaoAudioModeInput);
        document.getElementById("pet-vision-doubao-video-preset")?.addEventListener("change", () => updateDoubaoImageHeightOptions());
        document.getElementById("pet-vision-settings-modal")?.addEventListener("click", event => {
            if (event.target && event.target.id === "pet-vision-settings-modal") {
                hideModal();
            }
        });
    }

    function patchApiStorageSync() {
        if (apiStoragePatched || !window.apiKeyStorage || !window.apiKeyStorage.saveConfig) {
            return;
        }
        apiStoragePatched = true;
        const originalSave = window.apiKeyStorage.saveConfig.bind(window.apiKeyStorage);
        window.apiKeyStorage.saveConfig = async function patchedSaveConfig(config) {
            const result = await originalSave(config);
            try {
                const modConfig = await MOD().loadConfig();
                if (modConfig.apiMode === "inherit") {
                    await syncInheritedApi(modConfig, false);
                }
            } catch (error) {
                console.warn("[YukiVisionMod] 同步普通 API 失败:", error);
            }
            return result;
        };
        MOD().loadConfig().then(config => {
            if (config.apiMode === "inherit") {
                return syncInheritedApi(config, false);
            }
            return null;
        }).then(synced => {
            if (synced && synced.ok) {
                currentConfig = synced.config;
                const modal = document.getElementById("pet-vision-settings-modal");
                if (modal) {
                    fillForm(currentConfig);
                }
            }
        }).catch(error => {
            console.warn("[YukiVisionMod] initial inherited API sync failed:", error);
        });
    }

    async function init() {
        const ready = await waitForReady();
        if (!ready) {
            console.warn("[YukiVisionMod] 未找到设置入口，桌宠设置未挂载");
            return;
        }
        installCloudGptsApiPreset();
        buildButton();
        buildModal();
        bindEvents();
        await loadConfigToForm();
        if (currentConfig && currentConfig.apiMode === "inherit") {
            const synced = await syncInheritedApi(currentConfig, false);
            if (synced.ok) {
                fillForm(synced.config);
            }
        } else if (currentConfig) {
            currentConfig = await MOD().saveConfig(currentConfig);
        }
        patchApiStorageSync();
        setInterval(patchApiStorageSync, 1000);
        setInterval(installCloudGptsApiPreset, 2000);
        console.log("[YukiVisionMod] 主窗口设置模块已加载");
    }

    patchGeminiChatFetch();
    init();
})();
