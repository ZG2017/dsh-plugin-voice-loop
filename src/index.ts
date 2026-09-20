/**
 * Host half of @gz2016/dsh-plugin-voice-loop - fully self-contained: STT and
 * TTS synthesis both live directly in this file, with no runtime dependency
 * on any other plugin. Edge TTS is one WebSocket exchange (the Sec-MS-GEC
 * query-param protocol, mirroring node-edge-tts).
 *
 * Reply length for voice mode is controlled ENTIRELY by the system-prompt
 * section below (voiceModeSectionText's own length-hint sentence) - there
 * used to be a second pass here too, a `ctx.llm.stream()` rewrite of the
 * already-finalized reply into a shorter spoken version, keyed off a
 * `session/event` listener and served from a `shortVersions` cache. Measured
 * at ~30% of the whole silence-to-speaking latency (a second full LLM call,
 * AFTER the first one already finished) for a benefit prompting the first
 * call correctly should achieve directly - removed in favor of just asking
 * for the right length up front. The trade-off: this is a soft constraint
 * now, not a rewrite that guarantees a length cap - an unusually long reply
 * can still come back long and gets read in full (see README's Known
 * limitations).
 *
 * STT wraps one of two backends - by default, a local Qwen3-ASR server
 * (mlx-qwen3-asr serve on 127.0.0.1:8102) or OpenRouter's hosted
 * Qwen3-ASR-Flash transcription endpoint. Which one runs is chosen
 * PER-REQUEST by the client's own settings panel (see client.js), not
 * baked into the deployment - see resolveSttProvider()'s own comment. WHICH
 * endpoint/model each of those two choices actually calls is a separate,
 * user-configurable settings namespace instead of a hardcoded constant (see
 * config-schema.ts) - the "local"/"cloud" choice and the specific
 * model/endpoint it dispatches to are deliberately decoupled, so you can
 * point either one at your own server without forking this plugin. TTS
 * mirrors this: ttsCloud additionally supports plugging in any
 * OpenAI-compatible speech endpoint in place of the built-in Edge TTS
 * default. Plain webServer.register() routes throughout, no Typert RPC.
 *
 * Also owns the voice-mode system-prompt section: the client used to
 * prepend a bracketed instruction to every transcribed message's own text
 * instead, because there's no supported way to swap a session's AGENT
 * PRESET mid-session (packages/client/ui-agent-preset/src/client/
 * AgentPresetSeat.tsx locks preset selection after the first turn) - but
 * that's a narrower restriction than "no system-prompt injection at all".
 * ctx.systemPrompt.section() (packages/core/system-prompt/src/index.ts) is
 * a plain global registry any plugin can contribute to once, with a text
 * function re-evaluated every turn - dsh-plan-mode
 * (packages/plan/plan-mode/src/index.ts) is the precedent for exactly this
 * "only include this section while some per-session toggle is on" shape.
 * Plan mode's toggle is durably logged (a `plan/mode` session event,
 * fold-replayed so it survives resume/fork) with a live WeakMap<Session,
 * {active}> pending-intent layer on top; this one skips the durable layer
 * entirely - voice mode is a live browser-tab affordance with no resume
 * concept, so a plain in-memory Map<SessionId, boolean> (reset on host
 * restart, updated by the /toggle route below) is enough.
 * @module @gz2016/dsh-plugin-voice-loop
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { redactSecrets, type SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { VoiceModeSettingsSchema } from './config-schema.ts'
import type { VoiceModeEndpointConfig, VoiceModeSettings } from './config-schema.ts'

// Which STT backend to use - 'local' (a self-hosted server, see
// config-schema.ts's sttLocal) or 'cloud' (a hosted transcription API, see
// sttCloud). This env var is only a deployment-wide FALLBACK default - the
// client's own settings panel (client.js, persisted per-browser in
// localStorage) sends its choice on every request via the
// X-Voice-Mode-Stt-Provider header, read below in resolveSttProvider();
// this constant only applies when a request doesn't carry that header at
// all (an older client bundle, or a direct curl/test call). Defaults to
// 'cloud' - a deployment with no local server reachable selecting 'local'
// just gets a clear connection-refused error, not a special case.
const STT_PROVIDER_DEFAULT = String(process.env.VOICE_MODE_STT_PROVIDER || 'cloud').trim()

function resolveSttProvider(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === 'local' || trimmed === 'cloud' ? trimmed : STT_PROVIDER_DEFAULT
}

// The length hint is load-bearing, not decorative: this is now the ONLY
// mechanism keeping a voice-mode reply short enough to read aloud without
// turning into a monologue (see this file's own module comment for why the
// separate post-hoc rewrite pass was removed). Numeric guidance
// (characters/words, not just "brief") because plain "keep it short" alone
// under-constrained the model in practice - concrete numbers give it an
// actual target to write to.
const TASK_MODE_SPOKEN_LENGTH_HINT = 'a couple of short sentences - about 80-120 Chinese characters, or ~30-45 English words, whichever the language calls for'
const CHAT_MODE_SPOKEN_LENGTH_HINT = 'no more than 1-2 short sentences - about 40-60 Chinese characters, or ~15-20 English words, whichever the language calls for'

const VOICE_MODE_SECTION_BASE = 'You are currently in a live voice conversation with the user (voice mode: your reply will be read aloud, not displayed as text). '
  + 'Answer briefly and conversationally - no markdown lists, headings, tables, or code blocks; nothing that only makes sense written down. '
  + `Keep your reply to ${TASK_MODE_SPOKEN_LENGTH_HINT} - this is read aloud, not read on a screen, so length matters more than in text chat. `
  + 'Reply in the same language the user just spoke in.'

// Appended only in Chat preset mode (client.js's presetMode==='chat') - Task
// mode gets VOICE_MODE_SECTION_BASE alone, unchanged from before this preset
// split existed. Chat is meant for quick back-and-forth talk, not getting
// things done, so it steers away from the tool-heavy/thorough behavior the
// base agent defaults to - paired client-side with reasoningEffort 'off'
// (see client.js's presetMode handling).
const VOICE_MODE_CHAT_PRESET_ADDITION = ' You are in Chat preset mode: this is casual conversation, not task work. '
  + "Prioritize a fast, natural reply over thoroughness - answer from what you already know rather than reaching for tools, web search, file edits, or multi-step research unless the user's request genuinely can't be answered without one. "
  + `Keep replies especially short - ${CHAT_MODE_SPOKEN_LENGTH_HINT}, the length of a real spoken remark.`

function voiceModeSectionText(presetMode: 'chat' | 'task'): string {
  return presetMode === 'chat' ? VOICE_MODE_SECTION_BASE + VOICE_MODE_CHAT_PRESET_ADDITION : VOICE_MODE_SECTION_BASE
}

// SessionId -> whether voice mode is currently on, for this host process's
// lifetime only (see module comment above).
const activeSessions = new Map<string, boolean>()

// SessionId -> the client's last-reported preset mode (client.js's
// sharedVoiceModePrefs.presetMode - the same host-process-lifetime-only
// convention as activeSessions above, updated by the /toggle route below).
// Absent means 'task' (the default before any client has ever reported a
// mode - see the two lookups below, both `=== 'chat'` checks that treat
// anything else, including missing, as 'task').
const presetModeSessions = new Map<string, 'chat' | 'task'>()

export const name = 'voice-loop'
export const inject = ['webServer', 'systemPrompt', 'settings']

// Lets a deployment that already exports OPENROUTER_API_KEY for other
// purposes skip configuring sttCloud.apiKey separately. This is only a
// FALLBACK: settings.sttCloud.apiKey (config-schema.ts) takes priority when
// filled in, so pointing "cloud" STT at a different account or vendor
// entirely needs no env var changes.
function openrouterApiKeyFallback(): string {
  return String(process.env.OPENROUTER_API_KEY || '').trim()
}

/**
 * One STT call against a user-configurable OpenAI-compatible endpoint - see
 * config-schema.ts's STT_CONTRACT_NOTE for the exact request/response shape
 * required. `label` ('local'/'cloud') only decorates error messages.
 */
// Appended to a 401/403 STT/TTS response so the client (which surfaces
// thrown Error messages directly to the user, in the voice-mode overlay -
// see client.js's showError()) doesn't just show a bare HTTP status with no
// next step. Genuinely the most common failure mode for this plugin: the
// default sttLocal/ttsLocal/ttsCloud endpoints all ship with a BLANK apiKey
// (see config-schema.ts), and sttCloud's default (OpenRouter) always
// requires one - a fresh install with no key filled in anywhere reaches
// this exact branch on its very first real request.
const AUTH_HINT = ' - check the API key in Settings → Plugins → Voice Mode'

async function transcribeGeneric(audio: Uint8Array, mime: string, cfg: VoiceModeEndpointConfig, label: string): Promise<string> {
  if (audio.byteLength === 0) throw new Error('voice-mode: recorded audio is empty')
  if (!cfg.endpoint) throw new Error(`voice-mode: ${label} STT endpoint is not configured - set one in Settings → Plugins → Voice Mode`)
  const form = new FormData()
  form.set('file', new Blob([audio], { type: mime || 'audio/wav' }), 'audio.wav')
  form.set('model', cfg.model)
  const headers: Record<string, string> = {}
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  let response: Response
  try {
    response = await fetch(cfg.endpoint, { method: 'POST', headers, body: form })
  } catch (err) {
    throw new Error(`voice-mode: ${label} STT request failed: ` + (err instanceof Error ? err.message : String(err)))
  }
  const body = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(`voice-mode: ${label} STT returned non-JSON response (HTTP ${String(response.status)})`)
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? AUTH_HINT : ''
    throw new Error(`voice-mode: ${label} STT request failed (HTTP ${String(response.status)}): ${body.slice(0, 300)}${hint}`)
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { text?: unknown }).text !== 'string') {
    throw new Error(`voice-mode: ${label} STT returned no transcript`)
  }
  return (parsed as { text: string }).text.trim()
}

async function transcribeLocal(audio: Uint8Array, mime: string, settings: VoiceModeSettings): Promise<string> {
  return transcribeGeneric(audio, mime, settings.sttLocal, 'local')
}

async function transcribeCloud(audio: Uint8Array, mime: string, settings: VoiceModeSettings): Promise<string> {
  const apiKey = settings.sttCloud.apiKey || openrouterApiKeyFallback()
  return transcribeGeneric(audio, mime, { ...settings.sttCloud, apiKey }, 'cloud')
}

// ---------------------------------------------------------------------------
// Edge TTS (Microsoft's unofficial "Read Aloud" endpoint - free, real-time,
// no key needed, works the same regardless of where this is deployed since
// it's a real network call). The Sec-MS-GEC query-param protocol, mirroring
// node-edge-tts@1.2.10 - runs in-process (this file already runs as
// TypeScript via tsx) and returns the audio bytes directly.
// ---------------------------------------------------------------------------
const EDGE_TTS_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_TTS_CHROMIUM_VERSION = '143.0.3650.75'
const EDGE_TTS_WINDOWS_FILE_TIME_EPOCH = 11644473600n
const EDGE_TTS_WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const EDGE_TTS_CRLF = String.fromCharCode(13, 10)

function edgeTtsSecMsGecToken(): string {
  const ticks = (BigInt(Math.floor(Date.now() / 1000)) + EDGE_TTS_WINDOWS_FILE_TIME_EPOCH) * 10000000n
  const roundedTicks = ticks - (ticks % 3000000000n)
  const hash = createHash('sha256')
  hash.update(String(roundedTicks) + EDGE_TTS_TRUSTED_CLIENT_TOKEN, 'ascii')
  return hash.digest('hex').toUpperCase()
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Node's global WebSocket (undici) accepts a Node-specific `headers` option
// as its second constructor argument for setting handshake headers - a real
// extension beyond the browser-standard `protocols` string/string[] second
// parameter the DOM lib types describe. The cast here only tells TypeScript
// about a capability that's really there.
type NodeWebSocketCtor = new (url: string, options: { headers: Record<string, string> }) => WebSocket
const NodeWebSocket = WebSocket as unknown as NodeWebSocketCtor

function synthesizeEdgeTtsOnce(voice: string, text: string, lang: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const secMsGec = edgeTtsSecMsGecToken()
    const url = `${EDGE_TTS_WSS_BASE}?TrustedClientToken=${EDGE_TTS_TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-${EDGE_TTS_CHROMIUM_VERSION}`
    const ws = new NodeWebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    ws.binaryType = 'arraybuffer'
    const chunks: Buffer[] = []
    let settled = false
    function finish(): void {
      if (settled) return
      settled = true
      const buf = Buffer.concat(chunks)
      try { ws.close() } catch { /* already closed/closing */ }
      if (buf.length < 100) { reject(new Error('edge-tts: audio too small: ' + String(buf.length))); return }
      resolve(buf)
    }
    function failOnce(err: Error): void {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* already closed/closing */ }
      reject(err)
    }
    ws.addEventListener('error', () => { failOnce(new Error('edge-tts: websocket error')) })
    ws.addEventListener('close', (e: unknown) => {
      if (settled) return
      const ev = e as { code?: number, reason?: string }
      failOnce(new Error(`edge-tts: closed early code=${String(ev.code)} reason=${String(ev.reason)}`))
    })
    ws.addEventListener('message', (event: unknown) => {
      if (settled) return
      const data = (event as { data: unknown }).data
      if (typeof data === 'string') {
        if (data.indexOf('Path:turn.end') >= 0) finish()
        return
      }
      const raw = Buffer.from(data as ArrayBuffer)
      const marker = Buffer.from('Path:audio' + EDGE_TTS_CRLF)
      const idx = raw.indexOf(marker)
      if (idx >= 0) {
        const body = raw.subarray(idx + marker.length)
        if (body.length > 0) chunks.push(body)
      } else if (raw.length > 0) {
        chunks.push(raw)
      }
    })
    ws.addEventListener('open', () => {
      const requestId = randomBytes(16).toString('hex')
      const speechConfig = { context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${xmlEscape(voice)}"><prosody rate="default" pitch="default" volume="default">${xmlEscape(text)}</prosody></voice></speak>`
      ws.send('Content-Type:application/json; charset=utf-8' + EDGE_TTS_CRLF + 'Path:speech.config' + EDGE_TTS_CRLF + EDGE_TTS_CRLF + JSON.stringify(speechConfig))
      ws.send('X-RequestId:' + requestId + EDGE_TTS_CRLF + 'Content-Type:application/ssml+xml' + EDGE_TTS_CRLF + 'Path:ssml' + EDGE_TTS_CRLF + EDGE_TTS_CRLF + ssml)
    })
    setTimeout(() => { failOnce(new Error('edge-tts: timeout')) }, 20000)
  })
}

/** One retry on the flaky-but-harmless 1006 (abnormal close) code, same as the original worker. */
async function synthesizeEdgeTts(text: string, voice: string): Promise<Buffer> {
  const parts = voice.split('-')
  const lang = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US'
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await synthesizeEdgeTtsOnce(voice, text, lang)
    } catch (e) {
      lastErr = e
      if (!(e instanceof Error) || e.message.indexOf('1006') < 0) break
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// ---------------------------------------------------------------------------
// User-configurable OpenAI-compatible TTS (default: local Qwen3-TTS via
// mlx_audio.server's generic /v1/audio/speech endpoint). A deployment with
// no local server running just gets this fetch's own connection error, same
// convention as every other local-only default in this plugin. No
// speed/rate parameter is exposed anywhere in this plugin's settings on
// purpose - tested against the default local server, `speed` has no effect
// (mlx_audio's own Qwen3-TTS generate() docstring: "speed: Speech speed
// factor (not directly supported yet)"). `voice` is NOT validated against a
// fixed list here - which voice names are valid is entirely up to whatever
// model config.model points at.
// ---------------------------------------------------------------------------
async function synthesizeOpenAiCompatibleTts(text: string, cfg: VoiceModeEndpointConfig & { langCode?: string }, voice: string, label: string): Promise<Buffer> {
  if (!cfg.endpoint) throw new Error(`voice-mode: ${label} TTS endpoint is not configured - set one in Settings → Plugins → Voice Mode`)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  let response: Response
  try {
    response = await fetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        input: text,
        voice,
        lang_code: cfg.langCode,
        response_format: 'mp3',
      }),
    })
  } catch (err) {
    throw new Error(`voice-mode: ${label} TTS request failed: ` + (err instanceof Error ? err.message : String(err)))
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const hint = response.status === 401 || response.status === 403 ? AUTH_HINT : ''
    throw new Error(`voice-mode: ${label} TTS returned HTTP ${String(response.status)}: ${detail.slice(0, 300)}${hint}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

// Last-resort voice name when the client sends none - not a validated list
// (see synthesizeOpenAiCompatibleTts's own comment), just a real speaker
// confirmed present in the shipped default local TTS model's own roster
// (mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16's downloaded
// config.json: talker_config.spk_id = {serena, vivian, uncle_fu, ryan,
// aiden, ono_anna, sohee, eric, dylan} - client.js's own
// QWEN3_TTS_VOICE_SUGGESTIONS mirrors this same roster). The model
// lowercases whatever name it receives before lookup, so casing here is
// cosmetic only.
const LOCAL_TTS_FALLBACK_VOICE = 'vivian'

function writeJson(res: { writeHead: (code: number, headers: Record<string, string>) => void, end: (body: string) => void }, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as { register: (route: unknown) => () => void } | undefined
  if (!webServer) return

  const settingsScope: SettingsScope<VoiceModeSettings> = ctx.settings.register('voice-mode', VoiceModeSettingsSchema)

  // Plain HTTP settings read/write for the client's own Settings > Plugins >
  // Voice Mode tab (client.js's VoiceModeEndpointSettings) - same
  // webServer.register() convention as every other route in this file, no
  // Typert (see this file's own module comment for why). GET returns the
  // current settings with role('secret') fields (apiKey) redacted, plus a
  // `secrets` sidecar recording which ones are currently set, so the form
  // can render a write-only placeholder without ever receiving the key
  // itself. POST accepts a partial patch merged into the stored settings
  // (deep-merged per key - see @deepseek-ai/dsh-settings's mergeLayers) -
  // callers must omit an apiKey field entirely to leave it unchanged, never
  // resend the redacted placeholder.
  const settingsDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-voice-mode-api/settings',
    async handler(req: AsyncIterable<Buffer> & { method?: string }, res: Parameters<typeof writeJson>[0]) {
      try {
        if (req.method === 'POST') {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk)
          const patch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<VoiceModeSettings>
          await settingsScope.update(patch)
          writeJson(res, 200, { ok: true })
          return
        }
        writeJson(res, 200, redactSecrets(VoiceModeSettingsSchema, settingsScope.get()))
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  ctx.effect(() => settingsDisposer, 'voice-mode: settings route')

  const disposer = webServer.register({
    kind: 'exact',
    path: '/dsh-voice-mode-api/transcribe',
    async handler(req: AsyncIterable<Buffer> & { headers: Record<string, string | string[] | undefined> }, res: Parameters<typeof writeJson>[0]) {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks)
        const contentType = req.headers['content-type']
        const mime = typeof contentType === 'string' ? contentType : 'audio/wav'
        const sttProvider = resolveSttProvider(req.headers['x-voice-mode-stt-provider'])
        const settings = settingsScope.get()
        const text = sttProvider === 'cloud' ? await transcribeCloud(body, mime, settings) : await transcribeLocal(body, mime, settings)
        writeJson(res, 200, { text })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  ctx.effect(() => disposer, 'voice-mode: transcribe route')

  const toggleDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-voice-mode-api/toggle',
    async handler(req: AsyncIterable<Buffer>, res: Parameters<typeof writeJson>[0]) {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sessionId?: unknown, active?: unknown, presetMode?: unknown }
        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        if (!sessionId) { writeJson(res, 400, { error: 'sessionId is required' }); return }
        if (parsed.active) activeSessions.set(sessionId, true)
        else activeSessions.delete(sessionId)
        if (parsed.presetMode === 'chat' || parsed.presetMode === 'task') presetModeSessions.set(sessionId, parsed.presetMode)
        writeJson(res, 200, { ok: true })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  ctx.effect(() => toggleDisposer, 'voice-mode: toggle route')

  const speakDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-voice-mode-api/speak',
    async handler(req: AsyncIterable<Buffer>, res: Parameters<typeof writeJson>[0] & { end: (body: Buffer | string) => void }) {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: unknown, voice?: unknown, provider?: unknown, localVoice?: unknown }
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
        if (!text) { writeJson(res, 400, { error: 'text is required' }); return }
        const voice = typeof parsed.voice === 'string' && parsed.voice ? parsed.voice : 'en-US-AvaNeural'
        const localVoice = typeof parsed.localVoice === 'string' && parsed.localVoice ? parsed.localVoice : LOCAL_TTS_FALLBACK_VOICE
        const useLocal = parsed.provider === 'local'
        const settings = settingsScope.get()
        let audio: Buffer
        if (useLocal) {
          audio = await synthesizeOpenAiCompatibleTts(text, settings.ttsLocal, localVoice, 'local')
        } else if (settings.ttsCloud.endpoint) {
          audio = await synthesizeOpenAiCompatibleTts(text, settings.ttsCloud, voice, 'cloud')
        } else {
          audio = await synthesizeEdgeTts(text, voice)
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length) })
        res.end(audio)
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  ctx.effect(() => speakDisposer, 'voice-mode: speak route')

  const sectionDisposer = ctx.systemPrompt.section({
    name: 'voice-mode:instructions',
    order: 150,
    text: (context) => {
      if (context.agent === undefined) return ''
      const sessionId = context.agent.session.id
      if (!activeSessions.get(sessionId)) return ''
      return voiceModeSectionText(presetModeSessions.get(sessionId) === 'chat' ? 'chat' : 'task')
    },
  })
  ctx.effect(() => sectionDisposer, 'voice-mode: system-prompt section')
}
