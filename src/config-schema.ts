/**
 * Host-only settings schema for @gz2016/dsh-plugin-voice-loop - registered
 * via `ctx.settings.register()` (the same `@deepseek-ai/dsh-settings`
 * mechanism other DSH plugins with configurable backends use), so it gets a
 * real entry in DSH's own Settings page for free, generically rendered from
 * this schema - no client-side settings code needed for that part.
 *
 * The point of this file: which backend runs ('local' vs 'cloud', chosen
 * live per-request by the client's own quick toggle - see
 * resolveSttProvider() in index.ts and sharedVoiceModePrefs in client.js) is
 * kept separate from WHICH endpoint/model that backend actually calls. Both
 * STT slots and both TTS slots are plain {endpoint, model, apiKey} blocks
 * you can repoint at your own self-hosted or third-party server - this
 * plugin does not require Qwen3-ASR/Qwen3-TTS/OpenRouter specifically, those
 * are just the shipped defaults. The response contract each slot must
 * satisfy is documented on its schema field below, not enforced beyond what
 * index.ts already needs to parse a reply.
 */
import s from '@deepseek-ai/schemastery'

/** One swappable STT or TTS endpoint: where to call, which model, and how to authenticate. */
export interface VoiceModeEndpointConfig {
  endpoint: string
  model: string
  apiKey: string
}

export interface VoiceModeSettings {
  sttLocal: VoiceModeEndpointConfig
  sttCloud: VoiceModeEndpointConfig
  ttsLocal: VoiceModeEndpointConfig & { langCode: string }
  ttsCloud: VoiceModeEndpointConfig
}

export const DEFAULT_VOICE_MODE_SETTINGS: VoiceModeSettings = {
  // Default: mlx-qwen3-asr's own OpenAI-compatible serve command
  // (https://github.com/mlx-community/mlx-audio or the Qwen3-ASR model
  // card on Hugging Face for setup). apiKey blank - fill it in only if
  // your own local server requires a bearer token.
  sttLocal: {
    endpoint: 'http://127.0.0.1:8102/v1/audio/transcriptions',
    model: 'Qwen/Qwen3-ASR-0.6B',
    apiKey: '',
  },
  // apiKey blank on purpose: index.ts falls back to the OPENROUTER_API_KEY
  // environment variable when this field is empty, so a deployment that
  // already exports that variable for other purposes needs no extra
  // configuration here - fill it in to use a different key or vendor.
  sttCloud: {
    endpoint: 'https://openrouter.ai/api/v1/audio/transcriptions',
    model: 'qwen/qwen3-asr-flash-2026-02-10',
    apiKey: '',
  },
  ttsLocal: {
    endpoint: 'http://127.0.0.1:8090/v1/audio/speech',
    model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16',
    apiKey: '',
    langCode: 'English',
  },
  // endpoint blank on purpose: index.ts falls back to the built-in free
  // Edge TTS synthesis (no key, no model concept - a fixed protocol, not
  // something a "model" field could describe) when this is empty. Fill in
  // endpoint/model to replace Edge TTS with your own OpenAI-compatible
  // speech server for the "cloud" TTS choice too.
  ttsCloud: { endpoint: '', model: '', apiKey: '' },
}

const STT_CONTRACT_NOTE = 'Contract: POST multipart/form-data with fields "file" (the recorded audio) and "model"; must respond 200 with JSON {"text": string}. '
  + 'Any OpenAI-compatible /audio/transcriptions server satisfies this, not just Qwen3-ASR.'

const TTS_CONTRACT_NOTE = 'Contract: POST JSON {model, input, voice, lang_code, response_format:"mp3"}; must respond 200 with raw audio bytes (mp3). '
  + 'Any OpenAI-compatible /audio/speech server satisfies this, not just Qwen3-TTS.'

function endpointConfigSchema(defaults: VoiceModeEndpointConfig, apiKeyDescription: string) {
  return s.object({
    endpoint: s.string().default(defaults.endpoint).description('Full URL to POST to'),
    model: s.string().default(defaults.model).description('Model id sent in the request'),
    apiKey: s.string().role('secret').default(defaults.apiKey).description(apiKeyDescription),
  })
}

export const VoiceModeSettingsSchema: s<VoiceModeSettings> = s.object({
  sttLocal: endpointConfigSchema(DEFAULT_VOICE_MODE_SETTINGS.sttLocal, 'Bearer token, if the server requires one')
    .description(`Local speech-recognition backend (default: local Qwen3-ASR). ${STT_CONTRACT_NOTE}`)
    .collapse(),
  sttCloud: endpointConfigSchema(DEFAULT_VOICE_MODE_SETTINGS.sttCloud, 'Bearer token; leave blank to use the OPENROUTER_API_KEY environment variable instead')
    .description(`Cloud speech-recognition backend (default: OpenRouter-hosted Qwen3-ASR-Flash). ${STT_CONTRACT_NOTE}`)
    .collapse(),
  ttsLocal: s.object({
    endpoint: s.string().default(DEFAULT_VOICE_MODE_SETTINGS.ttsLocal.endpoint).description('Full URL to POST to'),
    model: s.string().default(DEFAULT_VOICE_MODE_SETTINGS.ttsLocal.model).description('Model id sent in the request'),
    apiKey: s.string().role('secret').default(DEFAULT_VOICE_MODE_SETTINGS.ttsLocal.apiKey).description('Bearer token, if the server requires one'),
    langCode: s.string().default(DEFAULT_VOICE_MODE_SETTINGS.ttsLocal.langCode)
      .description('lang_code field sent to the endpoint (a Qwen3-TTS-CustomVoice convention; other servers will just ignore it)'),
  })
    .description(`Local speech-synthesis backend (default: local Qwen3-TTS). ${TTS_CONTRACT_NOTE}`)
    .collapse(),
  ttsCloud: endpointConfigSchema(DEFAULT_VOICE_MODE_SETTINGS.ttsCloud, 'Bearer token, if the server requires one')
    .description(`Optional cloud speech-synthesis backend, same contract as ttsLocal. Leave "endpoint" blank to use the built-in free Edge TTS voice instead (no key needed - the default "cloud" TTS choice). ${TTS_CONTRACT_NOTE}`)
    .collapse(),
})
