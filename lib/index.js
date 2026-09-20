// src/index.ts
import { createHash, randomBytes } from "node:crypto";
import { redactSecrets, settingsNamespace } from "@deepseek-ai/dsh-settings";

// src/config-schema.ts
import s from "@deepseek-ai/schemastery";
var DEFAULT_VOICE_MODE_SETTINGS = {
  // Default: mlx-qwen3-asr's own OpenAI-compatible serve command
  // (https://github.com/mlx-community/mlx-audio or the Qwen3-ASR model
  // card on Hugging Face for setup). apiKey blank - fill it in only if
  // your own local server requires a bearer token.
  sttLocal: {
    endpoint: "http://127.0.0.1:8102/v1/audio/transcriptions",
    model: "Qwen/Qwen3-ASR-0.6B",
    apiKey: ""
  },
  // apiKey blank on purpose: index.ts falls back to the OPENROUTER_API_KEY
  // environment variable when this field is empty, so a deployment that
  // already exports that variable for other purposes needs no extra
  // configuration here - fill it in to use a different key or vendor.
  sttCloud: {
    endpoint: "https://openrouter.ai/api/v1/audio/transcriptions",
    model: "qwen/qwen3-asr-flash-2026-02-10",
    apiKey: ""
  },
  ttsLocal: {
    endpoint: "http://127.0.0.1:8090/v1/audio/speech",
    model: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16",
    apiKey: "",
    langCode: "English"
  },
  // endpoint blank on purpose: index.ts falls back to the built-in free
  // Edge TTS synthesis (no key, no model concept - a fixed protocol, not
  // something a "model" field could describe) when this is empty. Fill in
  // endpoint/model to replace Edge TTS with your own OpenAI-compatible
  // speech server for the "cloud" TTS choice too.
  ttsCloud: { endpoint: "", model: "", apiKey: "" }
};
var STT_CONTRACT_NOTE = 'Contract: POST multipart/form-data with fields "file" (the recorded audio) and "model"; must respond 200 with JSON {"text": string}. Any OpenAI-compatible /audio/transcriptions server satisfies this, not just Qwen3-ASR.';
var TTS_CONTRACT_NOTE = 'Contract: POST JSON {model, input, voice, lang_code, response_format:"mp3"}; must respond 200 with raw audio bytes (mp3). Any OpenAI-compatible /audio/speech server satisfies this, not just Qwen3-TTS.';
function endpointConfigSchema(defaults, apiKeyDescription) {
  return s.object({
    endpoint: s.string().default(defaults.endpoint).description("Full URL to POST to"),
    model: s.string().default(defaults.model).description("Model id sent in the request"),
    apiKey: s.string().role("secret").default(defaults.apiKey).description(apiKeyDescription)
  });
}
var VoiceModeSettingsSchema = s.object({
  sttLocal: endpointConfigSchema(DEFAULT_VOICE_MODE_SETTINGS.sttLocal, "Bearer token, if the server requires one").description(`Local speech-recognition backend (default: local Qwen3-ASR). ${STT_CONTRACT_NOTE}`).collapse(),
  sttCloud: endpointConfigSchema(DEFAULT_VOICE_MODE_SETTINGS.sttCloud, "Bearer token; leave blank to use the OPENROUTER_API_KEY environment variable instead").description(`Cloud speech-recognition backend (default: OpenRouter-hosted Qwen3-ASR-Flash). ${STT_CONTRACT_NOTE}`).collapse(),
  ttsLocal: s.object({
    endpoint: s.string().default(DEFAULT_VOICE_MODE_SETTINGS.ttsLocal.endpoint).description("Full URL to POST to"),
    model: s.string().default(DEFAULT_VOICE_MODE_SETTINGS.ttsLocal.model).description("Model id sent in the request"),
    apiKey: s.string().role("secret").default(DEFAULT_VOICE_MODE_SETTINGS.ttsLocal.apiKey).description("Bearer token, if the server requires one"),
    langCode: s.string().default(DEFAULT_VOICE_MODE_SETTINGS.ttsLocal.langCode).description("lang_code field sent to the endpoint (a Qwen3-TTS-CustomVoice convention; other servers will just ignore it)")
  }).description(`Local speech-synthesis backend (default: local Qwen3-TTS). ${TTS_CONTRACT_NOTE}`).collapse(),
  ttsCloud: endpointConfigSchema(DEFAULT_VOICE_MODE_SETTINGS.ttsCloud, "Bearer token, if the server requires one").description(`Optional cloud speech-synthesis backend, same contract as ttsLocal. Leave "endpoint" blank to use the built-in free Edge TTS voice instead (no key needed - the default "cloud" TTS choice). ${TTS_CONTRACT_NOTE}`).collapse()
});

// src/index.ts
var STT_PROVIDER_DEFAULT = String(process.env.VOICE_MODE_STT_PROVIDER || "cloud").trim();
function resolveSttProvider(headerValue) {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed === "local" || trimmed === "cloud" ? trimmed : STT_PROVIDER_DEFAULT;
}
var TASK_MODE_SPOKEN_LENGTH_HINT = "a couple of short sentences - about 80-120 Chinese characters, or ~30-45 English words, whichever the language calls for";
var CHAT_MODE_SPOKEN_LENGTH_HINT = "no more than 1-2 short sentences - about 40-60 Chinese characters, or ~15-20 English words, whichever the language calls for";
var VOICE_MODE_SECTION_BASE = `You are currently in a live voice conversation with the user (voice mode: your reply will be read aloud, not displayed as text). Answer briefly and conversationally - no markdown lists, headings, tables, or code blocks; nothing that only makes sense written down. Keep your reply to ${TASK_MODE_SPOKEN_LENGTH_HINT} - this is read aloud, not read on a screen, so length matters more than in text chat. Reply in the same language the user just spoke in.`;
var VOICE_MODE_CHAT_PRESET_ADDITION = ` You are in Chat preset mode: this is casual conversation, not task work. Prioritize a fast, natural reply over thoroughness - answer from what you already know rather than reaching for tools, web search, file edits, or multi-step research unless the user's request genuinely can't be answered without one. Keep replies especially short - ${CHAT_MODE_SPOKEN_LENGTH_HINT}, the length of a real spoken remark.`;
function voiceModeSectionText(presetMode) {
  return presetMode === "chat" ? VOICE_MODE_SECTION_BASE + VOICE_MODE_CHAT_PRESET_ADDITION : VOICE_MODE_SECTION_BASE;
}
var activeSessions = /* @__PURE__ */ new Map();
var presetModeSessions = /* @__PURE__ */ new Map();
var name = "voice-loop";
var inject = ["webServer", "systemPrompt", "settings"];
function openrouterApiKeyFallback() {
  return String(process.env.OPENROUTER_API_KEY || "").trim();
}
var AUTH_HINT = " - check the API key in Settings \u2192 Plugins \u2192 Voice Mode";
async function transcribeGeneric(audio, mime, cfg, label) {
  if (audio.byteLength === 0) throw new Error("voice-mode: recorded audio is empty");
  if (!cfg.endpoint) throw new Error(`voice-mode: ${label} STT endpoint is not configured - set one in Settings \u2192 Plugins \u2192 Voice Mode`);
  const form = new FormData();
  form.set("file", new Blob([audio], { type: mime || "audio/wav" }), "audio.wav");
  form.set("model", cfg.model);
  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let response;
  try {
    response = await fetch(cfg.endpoint, { method: "POST", headers, body: form });
  } catch (err) {
    throw new Error(`voice-mode: ${label} STT request failed: ` + (err instanceof Error ? err.message : String(err)));
  }
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`voice-mode: ${label} STT returned non-JSON response (HTTP ${String(response.status)})`);
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? AUTH_HINT : "";
    throw new Error(`voice-mode: ${label} STT request failed (HTTP ${String(response.status)}): ${body.slice(0, 300)}${hint}`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.text !== "string") {
    throw new Error(`voice-mode: ${label} STT returned no transcript`);
  }
  return parsed.text.trim();
}
async function transcribeLocal(audio, mime, settings) {
  return transcribeGeneric(audio, mime, settings.sttLocal, "local");
}
async function transcribeCloud(audio, mime, settings) {
  const apiKey = settings.sttCloud.apiKey || openrouterApiKeyFallback();
  return transcribeGeneric(audio, mime, { ...settings.sttCloud, apiKey }, "cloud");
}
var EDGE_TTS_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
var EDGE_TTS_CHROMIUM_VERSION = "143.0.3650.75";
var EDGE_TTS_WINDOWS_FILE_TIME_EPOCH = 11644473600n;
var EDGE_TTS_WSS_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
var EDGE_TTS_CRLF = String.fromCharCode(13, 10);
function edgeTtsSecMsGecToken() {
  const ticks = (BigInt(Math.floor(Date.now() / 1e3)) + EDGE_TTS_WINDOWS_FILE_TIME_EPOCH) * 10000000n;
  const roundedTicks = ticks - ticks % 3000000000n;
  const hash = createHash("sha256");
  hash.update(String(roundedTicks) + EDGE_TTS_TRUSTED_CLIENT_TOKEN, "ascii");
  return hash.digest("hex").toUpperCase();
}
function xmlEscape(s2) {
  return s2.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
var NodeWebSocket = WebSocket;
function synthesizeEdgeTtsOnce(voice, text, lang) {
  return new Promise((resolve, reject) => {
    const secMsGec = edgeTtsSecMsGecToken();
    const url = `${EDGE_TTS_WSS_BASE}?TrustedClientToken=${EDGE_TTS_TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-${EDGE_TTS_CHROMIUM_VERSION}`;
    const ws = new NodeWebSocket(url, {
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    ws.binaryType = "arraybuffer";
    const chunks = [];
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      try {
        ws.close();
      } catch {
      }
      if (buf.length < 100) {
        reject(new Error("edge-tts: audio too small: " + String(buf.length)));
        return;
      }
      resolve(buf);
    }
    function failOnce(err) {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
      }
      reject(err);
    }
    ws.addEventListener("error", () => {
      failOnce(new Error("edge-tts: websocket error"));
    });
    ws.addEventListener("close", (e) => {
      if (settled) return;
      const ev = e;
      failOnce(new Error(`edge-tts: closed early code=${String(ev.code)} reason=${String(ev.reason)}`));
    });
    ws.addEventListener("message", (event) => {
      if (settled) return;
      const data = event.data;
      if (typeof data === "string") {
        if (data.indexOf("Path:turn.end") >= 0) finish();
        return;
      }
      const raw = Buffer.from(data);
      const marker = Buffer.from("Path:audio" + EDGE_TTS_CRLF);
      const idx = raw.indexOf(marker);
      if (idx >= 0) {
        const body = raw.subarray(idx + marker.length);
        if (body.length > 0) chunks.push(body);
      } else if (raw.length > 0) {
        chunks.push(raw);
      }
    });
    ws.addEventListener("open", () => {
      const requestId = randomBytes(16).toString("hex");
      const speechConfig = { context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } };
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${xmlEscape(voice)}"><prosody rate="default" pitch="default" volume="default">${xmlEscape(text)}</prosody></voice></speak>`;
      ws.send("Content-Type:application/json; charset=utf-8" + EDGE_TTS_CRLF + "Path:speech.config" + EDGE_TTS_CRLF + EDGE_TTS_CRLF + JSON.stringify(speechConfig));
      ws.send("X-RequestId:" + requestId + EDGE_TTS_CRLF + "Content-Type:application/ssml+xml" + EDGE_TTS_CRLF + "Path:ssml" + EDGE_TTS_CRLF + EDGE_TTS_CRLF + ssml);
    });
    setTimeout(() => {
      failOnce(new Error("edge-tts: timeout"));
    }, 2e4);
  });
}
async function synthesizeEdgeTts(text, voice) {
  const parts = voice.split("-");
  const lang = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "en-US";
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await synthesizeEdgeTtsOnce(voice, text, lang);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof Error) || e.message.indexOf("1006") < 0) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
async function synthesizeOpenAiCompatibleTts(text, cfg, voice, label) {
  if (!cfg.endpoint) throw new Error(`voice-mode: ${label} TTS endpoint is not configured - set one in Settings \u2192 Plugins \u2192 Voice Mode`);
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let response;
  try {
    response = await fetch(cfg.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        input: text,
        voice,
        lang_code: cfg.langCode,
        response_format: "mp3"
      })
    });
  } catch (err) {
    throw new Error(`voice-mode: ${label} TTS request failed: ` + (err instanceof Error ? err.message : String(err)));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const hint = response.status === 401 || response.status === 403 ? AUTH_HINT : "";
    throw new Error(`voice-mode: ${label} TTS returned HTTP ${String(response.status)}: ${detail.slice(0, 300)}${hint}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
var LOCAL_TTS_FALLBACK_VOICE = "vivian";
function writeJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
function apply(ctx) {
  const webServer = ctx.get("webServer");
  if (!webServer) return;
  const settingsScope = ctx.settings.register(settingsNamespace("voice-mode"), VoiceModeSettingsSchema);
  const settingsDisposer = webServer.register({
    kind: "exact",
    path: "/dsh-voice-mode-api/settings",
    async handler(req, res) {
      try {
        if (req.method === "POST") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const patch = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          await settingsScope.update(patch);
          writeJson(res, 200, { ok: true });
          return;
        }
        writeJson(res, 200, redactSecrets(VoiceModeSettingsSchema, settingsScope.get()));
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  ctx.effect(() => settingsDisposer, "voice-mode: settings route");
  const disposer = webServer.register({
    kind: "exact",
    path: "/dsh-voice-mode-api/transcribe",
    async handler(req, res) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const contentType = req.headers["content-type"];
        const mime = typeof contentType === "string" ? contentType : "audio/wav";
        const sttProvider = resolveSttProvider(req.headers["x-voice-mode-stt-provider"]);
        const settings = settingsScope.get();
        const text = sttProvider === "cloud" ? await transcribeCloud(body, mime, settings) : await transcribeLocal(body, mime, settings);
        writeJson(res, 200, { text });
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  ctx.effect(() => disposer, "voice-mode: transcribe route");
  const toggleDisposer = webServer.register({
    kind: "exact",
    path: "/dsh-voice-mode-api/toggle",
    async handler(req, res) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
        if (!sessionId) {
          writeJson(res, 400, { error: "sessionId is required" });
          return;
        }
        if (parsed.active) activeSessions.set(sessionId, true);
        else activeSessions.delete(sessionId);
        if (parsed.presetMode === "chat" || parsed.presetMode === "task") presetModeSessions.set(sessionId, parsed.presetMode);
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  ctx.effect(() => toggleDisposer, "voice-mode: toggle route");
  const speakDisposer = webServer.register({
    kind: "exact",
    path: "/dsh-voice-mode-api/speak",
    async handler(req, res) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
        if (!text) {
          writeJson(res, 400, { error: "text is required" });
          return;
        }
        const voice = typeof parsed.voice === "string" && parsed.voice ? parsed.voice : "en-US-AvaNeural";
        const localVoice = typeof parsed.localVoice === "string" && parsed.localVoice ? parsed.localVoice : LOCAL_TTS_FALLBACK_VOICE;
        const useLocal = parsed.provider === "local";
        const settings = settingsScope.get();
        let audio;
        if (useLocal) {
          audio = await synthesizeOpenAiCompatibleTts(text, settings.ttsLocal, localVoice, "local");
        } else if (settings.ttsCloud.endpoint) {
          audio = await synthesizeOpenAiCompatibleTts(text, settings.ttsCloud, voice, "cloud");
        } else {
          audio = await synthesizeEdgeTts(text, voice);
        }
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(audio.length) });
        res.end(audio);
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  ctx.effect(() => speakDisposer, "voice-mode: speak route");
  const sectionDisposer = ctx.systemPrompt.section({
    name: "voice-mode:instructions",
    order: 150,
    text: (context) => {
      if (context.agent === void 0) return "";
      const sessionId = context.agent.session.id;
      if (!activeSessions.get(sessionId)) return "";
      return voiceModeSectionText(presetModeSessions.get(sessionId) === "chat" ? "chat" : "task");
    }
  });
  ctx.effect(() => sectionDisposer, "voice-mode: system-prompt section");
}
export {
  apply,
  inject,
  name
};
