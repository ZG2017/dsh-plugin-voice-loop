// Client half of @gz2016/dsh-plugin-voice-loop. Hand-written, no build step.
// Fully self-contained: every route this file calls
// (/dsh-voice-mode-api/transcribe, /speak, /toggle) is this plugin's OWN
// host half - no dependency on any other plugin.
//
// Full-screen hands-free voice loop: mic capture -> silence-based VAD
// auto-stop -> POST to /dsh-voice-mode-api/transcribe (local Qwen3-ASR or
// cloud Qwen3-ASR-Flash, per the settings panel) -> conversation.input.for(actx)
// .setDraft/submit (the per-session-scoped pattern) -> wait for the reply to
// finalize -> POST the WHOLE reply text in one request to
// /dsh-voice-mode-api/speak (Edge TTS or local Qwen3-TTS, per the settings
// panel) -> play it -> listen again. No sentence-by-sentence chunking:
// cloud TTS synthesizes even a long reply in a couple of seconds (measured
// ~2.3s at 300 characters), which doesn't justify the complexity of
// streaming synthesis out ahead of the finalized text.
//
// Renders as a `position: fixed` view from a normal
// conversation.input.left registrant, NOT a shadow of the 'conversation'
// slot - shadowing was tried first and worked visually, but it unmounts the
// default ConversationRoot underneath, which is what keeps props.session
// flowing to this component at all (see the composer-registrant section
// further down for the confirmed mechanism). This way ConversationRoot
// stays mounted the whole time; `position: fixed` covers the viewport
// regardless of DOM nesting depth.
//
// v1 scope, deliberately: energy-threshold VAD (no silero-grade model), one
// hardcoded Edge voice default. Barge-in (talking over a reply to cut it
// short, or over the 'thinking' wait to abandon it) IS in: the mic keeps
// running a lightweight RMS monitor - no chunk buffering, so no
// transcription cost - through the whole 'thinking'/'speaking' stretch
// (see armBargeIn/startMonitoring/BARGEIN_RMS below), separate from the
// full VAD-gated recording used while actually 'listening'.
window.__ModuleLoader__.load({
  id: '@gz2016/dsh-plugin-voice-loop',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    // ---------------------------------------------------------------------
    // Audio capture (AudioWorklet -> raw PCM -> 16kHz mono WAV). No
    // MediaRecorder: it only yields compressed container chunks, which
    // can't be cheaply decoded back into a growing raw-sample buffer.
    // ---------------------------------------------------------------------
    var WORKLET_SOURCE = [
      'class VoiceModeCaptureProcessor extends AudioWorkletProcessor {',
      '  process(inputs) {',
      '    var input = inputs[0];',
      '    if (input && input[0] && input[0].length > 0) this.port.postMessage(input[0].slice());',
      '    return true;',
      '  }',
      '}',
      'registerProcessor("dsh-voice-mode-capture", VoiceModeCaptureProcessor);',
    ].join('\n')

    function workletModuleUrl() {
      var blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
      return URL.createObjectURL(blob)
    }

    function computeRms(float32) {
      var sum = 0
      for (var i = 0; i < float32.length; i++) sum += float32[i] * float32[i]
      return Math.sqrt(sum / float32.length)
    }

    function resampleLinear(float32, fromRate, toRate) {
      if (fromRate === toRate || float32.length === 0) return float32
      var ratio = fromRate / toRate
      var newLen = Math.max(1, Math.round(float32.length / ratio))
      var out = new Float32Array(newLen)
      for (var i = 0; i < newLen; i++) {
        var srcIdx = i * ratio
        var i0 = Math.floor(srcIdx)
        var i1 = Math.min(i0 + 1, float32.length - 1)
        var frac = srcIdx - i0
        out[i] = float32[i0] * (1 - frac) + float32[i1] * frac
      }
      return out
    }

    function floatToInt16(float32) {
      var out = new Int16Array(float32.length)
      for (var i = 0; i < float32.length; i++) {
        var s = Math.max(-1, Math.min(1, float32[i]))
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      return out
    }

    function encodeWav16Mono(int16Samples, sampleRate) {
      var numSamples = int16Samples.length
      var buffer = new ArrayBuffer(44 + numSamples * 2)
      var view = new DataView(buffer)
      function writeStr(offset, str) {
        for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
      }
      writeStr(0, 'RIFF')
      view.setUint32(4, 36 + numSamples * 2, true)
      writeStr(8, 'WAVE')
      writeStr(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeStr(36, 'data')
      view.setUint32(40, numSamples * 2, true)
      for (var i = 0; i < numSamples; i++) view.setInt16(44 + i * 2, int16Samples[i], true)
      return new Uint8Array(buffer)
    }

    // Mic capture graph - created ONCE per voice-mode session (see
    // VoiceModeView's mount effect), not once per listen/stop cycle. It
    // used to be the latter (getUserMedia + `new AudioContext()` +
    // audioWorklet.addModule() all re-run from scratch on every single
    // turn), which cost a real, measurable ~0.5s of dead air between "TTS
    // finishes" and "mic is actually capturing again" - reported as the
    // start of the user's next sentence getting clipped/missed entirely,
    // not just a UI delay. getUserMedia/AudioContext creation/worklet
    // module compilation are all genuinely async browser-side work; doing
    // them once at voice-mode entry and reusing the same stream/context/
    // worklet node for every subsequent turn removes that whole chain from
    // the hot path - starting/stopping a "turn" becomes a synchronous flag
    // flip (see startRecording/stopRecording below), not a fresh async
    // hardware handshake. (Same principle ComposerVoiceMode's audioGraphRef
    // already applies on the OUTPUT/playback side, for a different reason -
    // mobile autoplay-unlock - reused here for the input side too.)
    function createPersistentMicCapture() {
      var stream = null
      var audioCtx = null
      var workletNode = null
      var sourceNode = null
      var recording = false
      var chunks = []
      var totalSamples = 0
      var onFrame = null // (rms) => void, wired fresh per recording/monitoring via startRecording()/startMonitoring()
      // Barge-in support: while 'thinking' or 'speaking' (see startMonitoring below),
      // frames still flow through here for RMS but are NOT pushed into
      // chunks/totalSamples - monitoring costs nothing extra (no growing
      // buffer, no transcription-bound memory) for however long a reply
      // takes to read aloud. Instead they're kept in a small ROLLING ring
      // (monitorRing/monitorRingSamples, capped to MONITOR_RING_MS) that
      // startRecording() below splices in as pre-roll the moment a barge-in
      // actually fires - without it, the ~300ms a real interruption needs to
      // cross BARGEIN_MIN_MS before triggering would otherwise just be
      // clipped off the front of what gets transcribed (reported, before
      // this ring existed, as the first word or two of an interruption
      // going missing).
      var monitoring = false
      var monitorRing = []
      var monitorRingSamples = 0
      var MONITOR_RING_MS = 600

      async function init() {
        // Explicitly forcing echoCancellation/noiseSuppression/
        // autoGainControl on was tried here (for barge-in - see
        // createBargeInDetector) and reverted: it broke the PLAIN listening
        // VAD outright (reported as "paused 3+ seconds, never moved to
        // thinking") - autoGainControl in particular is known to keep
        // boosting a quiet room's noise floor toward a target loudness,
        // which is exactly the failure mode that produces: background
        // noise reads as continuously above the speech threshold and the
        // SILENCE_MS timeout never gets a clean below-threshold stretch to
        // count from - it would also defeat createNoiseFloorTracker below
        // by constantly renormalizing the very ambient level it's trying
        // to measure. Both the (now-adaptive) VAD threshold and the
        // barge-in one were tuned against whatever a bare, unconstrained
        // getUserMedia call already does by default - leave that default
        // alone rather than overriding it again without a way to test real
        // mic/speaker hardware from here.
        // Barge-in is still wired up (see startMonitoring/BARGEIN_RMS
        // below) but now relies entirely on the browser's own DEFAULT
        // processing for that stream, whatever it is per-platform - no
        // explicit override in either direction.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
        audioCtx = new (window.AudioContext || window.webkitAudioContext)()
        await audioCtx.audioWorklet.addModule(workletModuleUrl())
        sourceNode = audioCtx.createMediaStreamSource(stream)
        workletNode = new AudioWorkletNode(audioCtx, 'dsh-voice-mode-capture')
        workletNode.port.onmessage = function (event) {
          if (recording) {
            chunks.push(event.data)
            totalSamples += event.data.length
          } else if (monitoring) {
            monitorRing.push(event.data)
            monitorRingSamples += event.data.length
            var maxRingSamples = audioCtx.sampleRate * MONITOR_RING_MS / 1000
            while (monitorRingSamples > maxRingSamples && monitorRing.length > 1) {
              monitorRingSamples -= monitorRing[0].length
              monitorRing.shift()
            }
          }
          if ((recording || monitoring) && onFrame) onFrame(computeRms(event.data))
        }
        sourceNode.connect(workletNode)
      }

      /** Start (or restart) accumulating a fresh recording; frameCb gets each frame's RMS while recording. Seeds from whatever the barge-in monitor's ring already buffered (empty unless this follows a triggered interrupt). */
      function startRecording(frameCb) {
        chunks = monitorRing
        totalSamples = monitorRingSamples
        monitoring = false
        monitorRing = []
        monitorRingSamples = 0
        onFrame = frameCb
        recording = true
      }
      /** Stop accumulating - the graph itself (stream/context/worklet) stays alive and connected. */
      function stopRecording() {
        recording = false
        onFrame = null
      }
      /** Lightweight RMS-only monitor for barge-in while 'thinking' or 'speaking' - see the field comments above for why this never touches chunks/totalSamples directly. */
      function startMonitoring(frameCb) {
        monitorRing = []
        monitorRingSamples = 0
        onFrame = frameCb
        monitoring = true
      }
      /** Stop monitoring and drop its pre-roll ring - used when leaving 'speaking' WITHOUT a barge-in (normal reply end, or a plan-review/question interrupt where the pre-roll would be stale and shouldn't seed the next real recording). */
      function stopMonitoring() {
        monitoring = false
        onFrame = null
        monitorRing = []
        monitorRingSamples = 0
      }

      function snapshotWavBytes() {
        var merged = new Float32Array(totalSamples)
        var offset = 0
        for (var i = 0; i < chunks.length; i++) {
          merged.set(chunks[i], offset)
          offset += chunks[i].length
        }
        var resampled = resampleLinear(merged, audioCtx.sampleRate, 16000)
        return encodeWav16Mono(floatToInt16(resampled), 16000)
      }

      /** Full teardown - only called when voice mode itself is exited (VoiceModeView unmount), not between turns. */
      function teardown() {
        recording = false
        onFrame = null
        if (workletNode) { try { workletNode.disconnect() } catch (e) {} }
        if (sourceNode) { try { sourceNode.disconnect() } catch (e) {} }
        if (stream) stream.getTracks().forEach(function (track) { track.stop() })
        if (audioCtx) { try { audioCtx.close() } catch (e) {} }
      }

      return {
        init: init,
        startRecording: startRecording,
        stopRecording: stopRecording,
        startMonitoring: startMonitoring,
        stopMonitoring: stopMonitoring,
        snapshotWavBytes: snapshotWavBytes,
        hasSamples: function () { return totalSamples > 0 },
        teardown: teardown,
      }
    }

    // ---------------------------------------------------------------------
    // Energy-threshold VAD. No user-facing sensitivity control (a "Mic
    // sensitivity" slider used to live in both settings surfaces - removed:
    // asking someone to manually re-tune a knob every time their room gets
    // louder or quieter is exactly the wrong shape of fix) - instead the
    // speech-detection threshold continuously tracks the mic's own recent
    // AMBIENT noise floor (createNoiseFloorTracker below) and sits a fixed
    // margin above whatever that floor currently is, so a noisy room
    // doesn't stop "silence" from ever being detected and a quiet room
    // doesn't require shouting to register as "speech."
    // ---------------------------------------------------------------------
    var MIN_SPEECH_MS = 250
    var SILENCE_MS = 1200
    var MAX_RECORD_MS = 30000
    // Absolute safety clamps on the ADAPTIVE threshold below, regardless of
    // what the noise floor estimate says - the same two values this plugin
    // used as its slider's own min/max before the slider existed, kept as
    // hard bounds so a pathological floor reading (e.g. right after mic
    // permission is granted, before any real samples have arrived) can
    // never make the VAD unusably hair-trigger or require shouting.
    var VAD_MIN_RMS = 0.008
    var VAD_MAX_RMS = 0.05
    // Speech threshold = floor * MULTIPLIER + MARGIN, then clamped to the
    // bounds above. The additive MARGIN matters most near-silence (a floor
    // reading of ~0 would otherwise produce an ~0 threshold, which is
    // exactly the hair-trigger failure mode a fixed minimum is meant to
    // avoid); the MULTIPLIER matters once the room has real ambient noise
    // to clear. Tuned so a typical quiet-room floor (~0.003-0.006) lands
    // close to 0.02 - this plugin's original hardcoded SPEECH_RMS - so
    // nothing changes behaviorally for the common case, only the noisy/
    // quiet extremes this was never able to adapt to before.
    var VAD_THRESHOLD_MULTIPLIER = 3.5
    var VAD_THRESHOLD_MARGIN = 0.004
    // Ambient noise floor tracker: a "slow-attack, instant-decay" follower,
    // not a plain moving average - real speech is always LOUDER than
    // ambient noise, never quieter, so instantly following any READING
    // that's BELOW the current floor is always safe (it's more silent than
    // previously observed, i.e. definitely not speech), while a louder
    // reading - which could be speech, or could be the room genuinely
    // getting noisier - is only allowed to raise the floor slowly, bounded
    // to NOISE_FLOOR_RISE_RMS_PER_SEC. This means a burst of speech can
    // never snap the floor upward and self-sabotage the very threshold
    // meant to detect it, while a room that's actually gotten louder (AC
    // turned on, moved to a cafe) still gets tracked correctly, just over
    // several seconds instead of instantly.
    var NOISE_FLOOR_RISE_RMS_PER_SEC = 0.004
    // Seeded at this plugin's old default sensitivity's own implied floor
    // (0.02 threshold => ~0.0046 floor by the formula above) rather than 0,
    // so the very first listening turn - before the tracker has had any
    // real mic samples to learn from - already resolves to close to the
    // old, known-working default instead of an untested extreme.
    var NOISE_FLOOR_INITIAL_RMS = 0.0046
    function createNoiseFloorTracker() {
      var floor = NOISE_FLOOR_INITIAL_RMS
      var lastFeedAt = 0
      return {
        feed: function (rms) {
          var now = performance.now()
          var dt = lastFeedAt ? (now - lastFeedAt) / 1000 : 0
          lastFeedAt = now
          if (rms < floor) {
            floor = rms
          } else if (dt > 0) {
            floor = Math.min(rms, floor + NOISE_FLOOR_RISE_RMS_PER_SEC * dt)
          }
        },
        get: function () { return floor },
      }
    }
    // One tracker for the whole page lifetime (not per voice-mode session) -
    // ambient noise doesn't reset just because voice mode was toggled off
    // and back on, so there's no reason to throw away what it's already
    // learned about the room.
    var sharedNoiseFloorTracker = createNoiseFloorTracker()
    function currentAdaptiveSpeechRms() {
      var raw = sharedNoiseFloorTracker.get() * VAD_THRESHOLD_MULTIPLIER + VAD_THRESHOLD_MARGIN
      return Math.max(VAD_MIN_RMS, Math.min(VAD_MAX_RMS, raw))
    }

    // Barge-in detector, active during 'thinking' and 'speaking' (see
    // startMonitoring above / armBargeIn below). First tuned to 0.045/300ms
    // - well above plain listening's SPEECH_RMS=0.02, on the theory that
    // echo cancellation is unreliable without headphones (see
    // getUserMedia's own comment) and a higher bar keeps a reply's own
    // audio leaking into the mic from self-triggering an interrupt.
    // Reported back as "needs shouting to interrupt" - that margin was
    // simply too wide for normal speaking volume. Dropped to just above
    // SPEECH_RMS instead, matching plain listening's own calibration
    // (which already works, per that same report): a little headroom over
    // SPEECH_RMS rather than 2x+ it. This trades toward more sensitive at
    // the cost of being more exposed to any real echo leakage - if it
    // starts self-triggering on the reply's own audio (most likely without
    // headphones), raise BARGEIN_RMS back up rather than BARGEIN_MIN_MS;
    // duration isn't what was reported wrong here.
    var BARGEIN_RMS = 0.028
    var BARGEIN_MIN_MS = 220

    // Voice-mode's response-shaping instruction (brief/conversational, no
    // markdown, mirror the user's language) now lives in the session's
    // system prompt (dsh-plugin-voice-loop's host half registers it via
    // ctx.systemPrompt.section(), gated on the toggleVoiceModeActive() calls
    // below) instead of being prepended to every transcript. It used to be
    // prepended here because there's no supported way to swap a session's
    // AGENT PRESET mid-session - but a system-prompt section is a
    // different, unrestricted mechanism (see the host file's comment), and
    // prepending made the instruction show up as if the USER had typed it,
    // in the wrong language, in every message bubble.
    // `presetMode` ('chat'/'task') is optional and, when given, is ALSO
    // stored host-side (index.ts's presetModeSessions Map) - the host
    // needs to know which preset is active per-session to pick the right
    // system-prompt wording (voice-mode:instructions) and spoken-summary
    // length limit (summarizeForSpeech), neither of which the client can
    // decide on its own. Always sent when entering voice mode or when the
    // in-call dropdown changes mode; omitted (left at whatever the host
    // already has) on plain active:false/exit calls, since it stops
    // mattering the moment voice mode is off.
    function toggleVoiceModeActive(sessionId, active, presetMode) {
      if (!sessionId) return
      var body = { sessionId: sessionId, active: active }
      if (presetMode === 'chat' || presetMode === 'task') body.presetMode = presetMode
      fetch('/dsh-voice-mode-api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(function (e) { console.error('[voice-mode] toggleVoiceModeActive failed:', e) })
    }

    // Sets the session's reasoning effort - 'high' for Task mode (this
    // plugin's own long-standing default, chosen for voice mode generally:
    // enough reasoning to actually get work done properly), 'off' for Chat
    // mode (pure conversation, prioritizing fast turnaround over depth). The
    // real service for this is connection.api.sessions.models({sessionId})
    // to read the current provider/model/effort, then .selectModel({...,
    // reasoningEffort}) to change it
    // (packages/client/ui-model-selection/src/client/service.ts's
    // ModelDirectoryResolver.directoryFor() is what actually calls this on
    // the model-picker UI, confirmed by reading it directly).
    // ctx.get('sessions') (used elsewhere in this file for .scope()) has no
    // such API - this is a different service, hence the extra
    // @deepseek-ai/dsh-client-connection inject.
    function setReasoningEffort(connection, sessionId, effort) {
      if (!connection || !connection.api || !connection.api.sessions || !sessionId) return
      connection.api.sessions.models({ sessionId }).then(function (response) {
        var result = response && response.result
        if (!result || !result.ok) return
        var current = result.value && result.value.current
        if (!current || current.reasoningEffort === effort) return
        return connection.api.sessions.selectModel({
          sessionId: sessionId,
          provider: current.provider,
          model: current.model,
          reasoningEffort: effort,
        })
      }).catch(function (e) {
        console.error('[voice-mode] setReasoningEffort(' + effort + ') failed:', e)
      })
    }

    function createVad(onSilenceStop) {
      var startedAt = 0
      var aboveMs = 0
      var speechDetected = false
      var lastAboveAt = 0
      var lastFrameAt = 0
      var stopped = false
      var maxRmsSeen = 0
      var frameCount = 0
      // Read once per listening turn (reset() is called fresh every time
      // beginListening() arms a new one) rather than on every single frame -
      // cheap either way, but this makes it unambiguous that the adaptive
      // threshold is a snapshot taken at the START of each turn, not
      // something that can shift mid-recording out from under an
      // in-progress utterance.
      var speechRms = VAD_MIN_RMS
      return {
        reset: function () {
          startedAt = performance.now()
          aboveMs = 0
          speechDetected = false
          lastAboveAt = startedAt
          lastFrameAt = startedAt
          stopped = false
          maxRmsSeen = 0
          frameCount = 0
          speechRms = currentAdaptiveSpeechRms()
        },
        feed: function (rms) {
          if (stopped) return
          frameCount++
          if (rms > maxRmsSeen) maxRmsSeen = rms
          var now = performance.now()
          var dt = now - lastFrameAt
          lastFrameAt = now
          if (rms > speechRms) {
            aboveMs += dt
            lastAboveAt = now
            if (aboveMs > MIN_SPEECH_MS && !speechDetected) {
              speechDetected = true
              console.log('[voice-mode] vad: speech detected (maxRmsSeen=' + maxRmsSeen.toFixed(4) + ')')
            }
          } else {
            aboveMs = 0
          }
          if (speechDetected && (now - lastAboveAt) > SILENCE_MS) {
            stopped = true
            console.log('[voice-mode] vad: silence timeout, stopping (maxRmsSeen=' + maxRmsSeen.toFixed(4) + ')')
            onSilenceStop()
            return
          }
          if (now - startedAt > MAX_RECORD_MS) {
            stopped = true
            console.log('[voice-mode] vad: MAX_RECORD_MS safety cap hit')
            onSilenceStop()
          }
        },
      }
    }

    /**
     * Barge-in detector - simpler than createVad on purpose: it only needs
     * to fire ONCE, the moment sustained speech crosses BARGEIN_MIN_MS,
     * with no silence-timeout half (there's no "recording" to close out
     * here, just a single edge that hands off to the real VAD/recording
     * path via interruptPlayback()). `stopped` makes feed() a no-op
     * forever after that one trigger, since the caller tears this detector
     * down and starts a fresh one for the next 'speaking' turn anyway.
     */
    function createBargeInDetector(onTrigger) {
      var aboveMs = 0
      var lastFrameAt = 0
      var stopped = false
      // Diagnostic only - a periodic (not per-frame) line showing the
      // loudest RMS seen recently, so the console can distinguish "mic
      // isn't picking up speech at all" from "picking it up but never
      // crossing BARGEIN_RMS" from "crossing it but never sustaining
      // BARGEIN_MIN_MS" without 375-lines/sec of per-frame spam.
      var maxRmsSeen = 0
      var lastDiagAt = 0
      return {
        reset: function () {
          aboveMs = 0
          lastFrameAt = performance.now()
          stopped = false
          maxRmsSeen = 0
          lastDiagAt = performance.now()
        },
        feed: function (rms) {
          if (stopped) return
          var now = performance.now()
          var dt = now - lastFrameAt
          lastFrameAt = now
          if (rms > maxRmsSeen) maxRmsSeen = rms
          if (now - lastDiagAt > 1000) {
            lastDiagAt = now
            console.log('[voice-mode] barge-in: monitoring (maxRmsSeen=' + maxRmsSeen.toFixed(4) + ', threshold=' + BARGEIN_RMS + ', aboveMs=' + Math.round(aboveMs) + '/' + BARGEIN_MIN_MS + ')')
            maxRmsSeen = 0
          }
          if (rms > BARGEIN_RMS) {
            aboveMs += dt
            if (aboveMs > BARGEIN_MIN_MS) {
              stopped = true
              console.log('[voice-mode] barge-in: triggered')
              onTrigger()
            }
          } else {
            // Decay rather than hard-reset to 0: reported as taking
            // noticeably longer to trigger specifically while a reply is
            // playing (vs. during the silent 'thinking' wait, where this
            // was fast) - without echoCancellation forced on (see
            // getUserMedia's own comment on why not), the reply's own
            // audio leaking into the mic makes the RMS reading noisier
            // while it plays, dipping below BARGEIN_RMS for a frame or two
            // even while the user is genuinely still talking. A hard reset
            // threw away all accumulated progress on every such dip,
            // forcing a fresh 220ms of PERFECTLY continuous speech each
            // time - decaying at the same rate progress accumulates means
            // a brief dip costs roughly what it lasted, not everything
            // banked before it.
            aboveMs = Math.max(0, aboveMs - dt)
          }
        },
      }
    }

    // ---------------------------------------------------------------------
    // Orb (ring) view
    // ---------------------------------------------------------------------
    // idle/listening: plain white. speaking: light blue (matching the
    // reference photo). thinking: a hue that shifts continuously over time
    // (see Orb's own targetRgbForState) rather than a fixed entry here.
    var COLORS = {
      idle: '#ffffff',
      listening: '#ffffff',
      speaking: '#4aa8ff',
    }
    // How long (roughly) the displayed ring color takes to catch up to
    // wherever it's currently headed - see Orb's own color-chase comment.
    // An exponential time constant, not a fixed duration: expressed as "T
    // to feel done," T ≈ 3x this value (1 - e^-3 ≈ 95%).
    var COLOR_CHASE_TAU_MS = 180
    // No status label under the ring MOST of the time (a prior version had
    // one always present, with playful rotating text - its length
    // changing between states shifted the flex layout and made the ring
    // itself visibly hop up and down). The one exception is a long
    // 'thinking' wait (see LONG_WAIT_MESSAGES/showLongWait below) - reserved
    // in a fixed-height slot that's always present (just empty otherwise),
    // so THAT text's own appearance/disappearance can't reintroduce the
    // same layout hop.
    var LONG_WAIT_MESSAGES = [
      'Still noodling on this one…',
      'Brewing up something good…',
      "Hang tight, plotting my next move…",
      "Give me a sec, I'm on a roll…",
      'Cooking up a proper answer…',
      "This is a good one - bear with me…",
      'Deep in thought over here…',
      'Working some magic behind the scenes…',
      'Chasing down a few more details…',
      "Nearly there, I promise…",
    ]

    function hexToRgb(hex) {
      var h = hex.replace('#', '')
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      var num = parseInt(h, 16)
      return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
    }

    function hslToRgb(h, s, l) {
      h = h / 360; s = s / 100; l = l / 100
      if (s === 0) { var v = Math.round(l * 255); return [v, v, v] }
      var hue2rgb = function (p, q, t) {
        if (t < 0) t += 1
        if (t > 1) t -= 1
        if (t < 1 / 6) return p + (q - p) * 6 * t
        if (t < 1 / 2) return q
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
        return p
      }
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s
      var p = 2 * l - q
      return [
        Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        Math.round(hue2rgb(p, q, h) * 255),
        Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
      ]
    }

    // Accepts an already-resolved [r,g,b] array (Orb's own color chase
    // passes one of these directly - no reason to round-trip it through a
    // string just to re-parse it here), or - for any other caller - a
    // '#rrggbb'/'#rgb' hex string or an 'hsl(H S% L%)' string. Returns
    // [r,g,b] either way.
    function colorToRgb(c) {
      if (Array.isArray(c)) return c
      if (c.charAt(0) === '#') return hexToRgb(c)
      var m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/.exec(c)
      if (m) return hslToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]))
      return [255, 255, 255]
    }

    // Trapezoid ring, but the ramp from full color (at radius r0+-aFlat) to
    // background (at r0+-bEdge) follows a hyperbola B(t) = (1-t)/(1+k*t),
    // t = (|x|-aFlat)/(bEdge-aFlat) in [0,1], instead of a straight line -
    // steep near the flat top (t=0, slope -(1+k)) and shallow near the
    // background edge (t=1, slope -1/(1+k)). CSS gradients only interpolate
    // LINEARLY between stops, so tracing a curve (rather than a straight
    // ramp, which needs only its two endpoints) means sampling several
    // points along it - color blending happens here in JS for the same
    // reason gaussianRingGradient needed to (mixing a literal bg hex
    // against either a hex or hsl() ring color isn't one CSS interpolation
    // both shapes go through equally).
    function hyperbolaRingGradient(r0, aFlat, bEdge, k, ref, bgHex, colorStr, samplesOverride) {
      var bgRgb = hexToRgb(bgHex)
      var colorRgb = colorToRgb(colorStr)
      var mix = function (frac) {
        return [0, 1, 2].map(function (i) { return Math.round(bgRgb[i] + (colorRgb[i] - bgRgb[i]) * frac) })
      }
      var toStop = function (x, frac) { return 'rgb(' + mix(frac).join(',') + ') ' + ((r0 + x) / ref * 100).toFixed(2) + '%' }
      // More samples than before (was 8): the ramp now spans up to ~38px
      // (bEdge=40 vs the original 14.2), over 3x longer, so the same
      // sample count would space stops far enough apart to visibly kink
      // the curve into straight segments again. Overridable down for
      // 'thinking': that state recomputes this whole gradient every animation
      // frame (the hue keeps shifting), so fewer stops meaningfully cuts the
      // per-frame repaint cost on mobile - the other states set their color
      // once per STATE CHANGE, not continuously, so they keep full fidelity.
      var samples = samplesOverride || 16
      var stops = ['rgb(' + bgRgb.join(',') + ') 0%']
      var i, t, b
      for (i = samples; i >= 0; i--) {
        t = i / samples
        b = (1 - t) / (1 + k * t)
        stops.push(toStop(-(aFlat + t * (bEdge - aFlat)), b))
      }
      for (i = 0; i <= samples; i++) {
        t = i / samples
        b = (1 - t) / (1 + k * t)
        stops.push(toStop(aFlat + t * (bEdge - aFlat), b))
      }
      stops.push('rgb(' + bgRgb.join(',') + ') 100%')
      return 'radial-gradient(circle closest-side, ' + stops.join(', ') + ')'
    }

    // Where the ring's color is currently HEADED for a given state - not
    // what's actually displayed this frame, see Orb's own color-chase
    // comment for the difference. thinking's target is a hue that shifts
    // continuously over time (props.hue, driven by VoiceModeView's tick),
    // so it's a moving target the displayed color continuously trails
    // slightly behind - the other two states are fixed points.
    function targetRgbForState(state, hue) {
      if (state === 'thinking') return hslToRgb(hue || 0, 85, 65)
      if (state === 'speaking') return hexToRgb(COLORS.speaking)
      return hexToRgb(COLORS.idle) // idle & listening
    }

    function Orb(props) {
      var React = require('react')
      // `level` for 'thinking' is a synthesized sine wave fed through the
      // exact same setLevel() this component's caller uses for mic RMS
      // (listening) and TTS-analyser output (speaking) - see
      // VoiceModeView's thinkRafRef effect. Driving every state through one
      // shared number, read through one continuous `transition`, is what
      // keeps state-to-state handoffs (thinking -> speaking especially)
      // smooth.
      var level = Math.min(props.level, 1)
      var scale = 1 + level * 0.14
      var thinking = props.state === 'thinking'
      // ONE rendering path for every state (a rotating conic-gradient +
      // hole-cover was tried for 'thinking' specifically, and it worked,
      // but as a completely different DOM shape from the other states'
      // single gradient div - crossfading smoothly INTO and OUT OF that
      // structure on a state change is a much harder problem than
      // crossfading a color). Every state differs only in `color`.
      //
      // The displayed color is a continuous CHASE toward targetRgbForState
      // above, eased in plain JS (exponential per-frame lerp, computed
      // fresh on every render - same shape as pushLevel's own damping
      // filter) rather than a CSS `transition` on `background`. A CSS
      // transition was tried first and looked right in isolation, but
      // silently stopped crossfading at every listening/thinking and
      // thinking/speaking boundary: hyperbolaRingGradient emits FEWER
      // stops while 'thinking' (samplesOverride=6, for its own per-frame
      // repaint cost - see below) than every other state (16), and a CSS
      // gradient transition can only interpolate between two gradients
      // with the same stop count/positions - a mismatched pair just snaps
      // instead of blending, which is exactly the "跳变" reported. Doing
      // the interpolation here in JS instead sidesteps that entirely: each
      // render paints ONE fully-resolved gradient (already-eased color, at
      // whatever sample count fits ITS OWN state), so there's never a
      // browser-side blend between two differently-shaped gradients to
      // begin with. Every state already re-renders Orb at ~25-60fps on its
      // own (mic/analyser/hue ticks, or idle's own tick) - see those
      // effects' own comments - so this chase always has frames to
      // progress on, with no separate rAF loop of its own needed.
      var targetRgb = targetRgbForState(props.state, props.hue)
      var displayedRgbRef = React.useRef(targetRgb.slice())
      var lastColorFrameAtRef = React.useRef(0)
      var nowMs = performance.now()
      var dt = lastColorFrameAtRef.current ? nowMs - lastColorFrameAtRef.current : 0
      lastColorFrameAtRef.current = nowMs
      var alpha = dt > 0 ? 1 - Math.exp(-dt / COLOR_CHASE_TAU_MS) : 0
      var displayed = displayedRgbRef.current
      var nextRgb = [
        displayed[0] + (targetRgb[0] - displayed[0]) * alpha,
        displayed[1] + (targetRgb[1] - displayed[1]) * alpha,
        displayed[2] + (targetRgb[2] - displayed[2]) * alpha,
      ]
      displayedRgbRef.current = nextRgb
      var color = nextRgb // hyperbolaRingGradient's own colorToRgb accepts this [r,g,b] array as-is
      // One plain `background` radial-gradient (background-color -> ring
      // color -> background-color) instead of a `mask-image` (unreliable on
      // mobile Safari - see git history) or a separate cover-up circle
      // (which needs to track a second element's size/position in lockstep
      // and is what drifted above). A plain gradient is just paint, so
      // there is nothing to keep in sync, and BOTH edges - the inner one
      // against the hole and the outer one against the page - get to fade
      // through the same mechanism instead of only the outer edge having a
      // soft transition.
      //
      // `radial-gradient(circle, ...)` with NO explicit size keyword
      // defaults to `farthest-corner`: for a square box, 100% is the
      // distance to a CORNER, not to the middle of an edge - `closest-side`
      // anchors percentages to the distance actually intended (half the
      // box's own width).
      //
      // The reference image is a THIN bright line with a continuous falloff
      // on both sides, not a wide solid band with feathered edges - a
      // previous version had a wide (20%) flat color plateau, which reads
      // as a "ring" with soft edges but not as a glow. Shrinking the flat
      // portion down to a thin sliver (this same feather-in/feather-out
      // structure, just with almost no gap between them) and widening the
      // feather zones on both sides is what actually produces that
      // thin-core, glowing look.
      // Flat top (r0 +/- 2.4px, same as the plain trapezoid) but the ramp
      // out to the background (now 2.4px to 40px from center, pulled out
      // from 14.2px) follows a hyperbola instead of a straight line -
      // steep right after the flat top, shallow by the time it reaches
      // background. r0=120px, ref (closest-side) = 240px, for the 480px
      // box below - 40px still comfortably inside that. bgHex is the
      // literal fallback (not the `var(--dsw-alias-bg-primary)` reference
      // used elsewhere in this file) because the curve needs real RGB
      // numbers to blend, and there's no way to read a CSS custom
      // property's current computed value from plain JS.
      var bgHex = '#0b0b0f'
      // k back to 4 (was reduced to 1.5, then 0.5): slope ratio
      // steep:shallow is (1+k)^2 = 25x. Fewer samples while 'thinking' - see
      // hyperbolaRingGradient's comment on samplesOverride. Safe to vary
      // per-state freely now (unlike when a CSS transition needed matching
      // stop counts on both sides of a change) - each render paints one
      // complete, already-eased gradient, nothing blends between two of
      // them at the browser level.
      var gradient = hyperbolaRingGradient(120, 2.4, 40, 4, 240, bgHex, color, thinking ? 6 : 16)
      return React.createElement('div', {
        style: {
          width: '480px', height: '480px',
          borderRadius: '50%',
          background: gradient,
          transform: 'scale(' + scale + ')',
          // Level-reactivity (scale) and the ring geometry are deliberately
          // separate concerns now: `scale` grows/shrinks the WHOLE gradient
          // uniformly, so the ring-to-feather ratio the percentages above
          // define stays constant at any level instead of the feather zones
          // stretching unevenly relative to the ring the way they did when
          // the percentages themselves shifted with level.
          // Only `transform` needs a CSS transition - `background` is
          // already a fully-eased value by the time it gets here (the
          // color chase above), so transitioning it too would just add a
          // second, redundant layer of lag on top of the first.
          transition: 'transform 220ms cubic-bezier(.22,1,.36,1)',
        },
      })
    }

    // Per-language voice switching (not the multilingual voice tried
    // earlier) per explicit preference: Chinese replies get a real Mandarin
    // voice, English replies get a real English voice. A rough CJK-density
    // check is enough to tell them apart for this purpose.
    function pickVoiceForText(text) {
      var cjk = 0
      for (var i = 0; i < text.length; i++) {
        var cp = text.codePointAt(i)
        if (cp >= 0x4e00 && cp <= 0x9fff) cjk++
      }
      return text.length > 0 && cjk / text.length > 0.15 ? 'zh-CN-XiaoxuanNeural' : 'en-US-AriaNeural'
    }

    // ---------------------------------------------------------------------
    // STT/TTS provider preference - which backend to actually call. 'cloud'
    // (a hosted STT/TTS API) is the default for everyone - it needs no
    // setup and works identically regardless of where this is deployed.
    // Both 'local' options (a self-hosted Qwen3-ASR/Qwen3-TTS server, see
    // config-schema.ts) are an opt-in escape hatch for whoever actually has
    // that local model running - selecting 'local' with nothing running
    // just surfaces this plugin's own "can't reach it" connection error.
    //
    // A plain MODULE-LEVEL object + pub-sub (not per-component React state)
    // on purpose. Two separate UI surfaces read/write this now: the
    // in-overlay gear panel (VoiceModeView, for switching mid-conversation
    // without exiting) and the Settings -> Plugins tab
    // further down (VoiceModeSettingsPanel, for configuring before ever
    // entering voice mode) - a per-component useState each would let them
    // drift out of sync the moment one changed a setting while the other
    // was also mounted. Reading `sharedVoiceModePrefs` directly (rather
    // than a React-state copy) also means synthesizeSpeech/stopAndSend - captured
    // ONCE by VoiceModeView's empty-deps mount effect - always see the
    // LATEST prefs with no extra ref-mirroring needed (unlike level/state
    // elsewhere in this file, which really do need a ref because they're
    // real React state).
    var VOICE_MODE_PREFS_KEY = 'dsh-voice-mode-prefs'
    // Suggestions only, NOT a validated list. The real, complete speaker
    // roster for the shipped DEFAULT local TTS model (mlx-community/
    // Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16, config-schema.ts's ttsLocal) -
    // read directly out of that checkpoint's own talker_config.spk_id in
    // its downloaded config.json, not guessed: {serena, vivian, uncle_fu,
    // ryan, aiden, ono_anna, sohee, eric, dylan} (eric/dylan additionally
    // speak Sichuan/Beijing dialects per that same config's
    // spk_is_dialect). "Chelsie"/"Ethan" (this list's previous, WRONG
    // contents) are NOT in this checkpoint's roster at all - apparently
    // carried over from generic Qwen3-TTS docs/examples rather than this
    // specific CustomVoice model. Which names actually work now depends
    // entirely on whatever model a user has pointed ttsLocal at from DSH's
    // own Settings page (backend/model choice is decoupled from local/cloud
    // choice - see config-schema.ts), so localVoiceSelectRow renders a
    // free-text input with these as <datalist> suggestions, not a closed
    // dropdown - the model itself lowercases whatever name it receives
    // before lookup, so casing here doesn't matter functionally, only for
    // readability. No speed/rate control is exposed anywhere in this
    // plugin's settings: tested directly against the local mlx_audio.server
    // (same `speed` request field OpenAI's real /v1/audio/speech API
    // defines) and it had no measurable effect on output duration even at
    // extreme values - confirmed in mlx_audio's own Qwen3-TTS source
    // (tts/models/qwen3_tts/qwen3_tts.py's generate() docstring: "speed:
    // Speech speed factor (not directly supported yet)"). A slider that
    // silently does nothing is worse than no slider.
    // 'vivian' listed first on purpose: it's the pre-existing default this
    // plugin already shipped (index.ts's own LOCAL_TTS_FALLBACK_VOICE), and
    // loadVoiceModePrefs()/its catch fallback below both take [0] as the
    // default when nothing is stored yet - reordering this list must not
    // silently change that default for existing/new users.
    var QWEN3_TTS_VOICE_SUGGESTIONS = ['vivian', 'serena', 'uncle_fu', 'ryan', 'aiden', 'ono_anna', 'sohee', 'eric', 'dylan']

    function loadVoiceModePrefs() {
      try {
        var raw = globalThis.localStorage ? localStorage.getItem(VOICE_MODE_PREFS_KEY) : null
        var parsed = raw ? JSON.parse(raw) : null
        return {
          stt: parsed && parsed.stt === 'local' ? 'local' : 'cloud',
          tts: parsed && parsed.tts === 'local' ? 'local' : 'cloud',
          localVoice: parsed && typeof parsed.localVoice === 'string' && parsed.localVoice ? parsed.localVoice : QWEN3_TTS_VOICE_SUGGESTIONS[0],
          // Chat (this plugin's current default preset: casual-conversation,
          // reasoningEffort 'off', system prompt steers away from tool use,
          // spoken summaries held to 1-2 sentences) vs Task (full agent
          // behavior, reasoningEffort 'high', tools/research all allowed,
          // spoken summaries up to 2-3 sentences - see index.ts's
          // voiceModeSectionText()/summarizeForSpeech()). Defaults to Chat
          // for anyone who hasn't picked one yet; an explicit stored 'task'
          // is still honored.
          presetMode: parsed && parsed.presetMode === 'task' ? 'task' : 'chat',
        }
      } catch (e) {
        return { stt: 'cloud', tts: 'cloud', localVoice: QWEN3_TTS_VOICE_SUGGESTIONS[0], presetMode: 'chat' }
      }
    }
    function saveVoiceModePrefs(prefs) {
      try {
        if (globalThis.localStorage) localStorage.setItem(VOICE_MODE_PREFS_KEY, JSON.stringify(prefs))
      } catch (e) { /* non-fatal */ }
    }

    var sharedVoiceModePrefs = loadVoiceModePrefs()
    var voiceModePrefsListeners = new Set()
    function notifyVoiceModePrefsChange() {
      for (var fn of voiceModePrefsListeners) { try { fn() } catch (e) {} }
    }
    function updateVoiceModePref(key, value) {
      var next = Object.assign({}, sharedVoiceModePrefs)
      next[key] = value
      sharedVoiceModePrefs = next
      saveVoiceModePrefs(next)
      notifyVoiceModePrefsChange()
    }
    /** Force a re-render whenever any voice-mode setting changes elsewhere. */
    function useVoiceModePrefsForce() {
      var React = require('react')
      var s = React.useState(0)
      var setN = s[1]
      React.useEffect(function () {
        var fn = function () { setN(function (n) { return n + 1 }) }
        voiceModePrefsListeners.add(fn)
        return function () { voiceModePrefsListeners.delete(fn) }
      }, [])
    }

    var SETTINGS_LABEL_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #9ca3af)' }
    // Deliberately hardcoded white/near-black, not the --dsw-alias-bg/label
    // tokens this used to use - real testing showed those resolving to a
    // dark background with dark-ish gray text in BOTH places this renders
    // (the in-call gear panel and the desktop Settings tab), i.e. a
    // low-contrast dark-on-dark combination, not (as first guessed) WebKit
    // ignoring the text color. A fixed white box reads correctly everywhere
    // regardless of the surrounding page/panel theme.
    var SETTINGS_SELECT_STYLE = {
      background: '#ffffff',
      color: '#111827',
      border: '1px solid #d1d5db', borderRadius: '6px',
      padding: '6px 8px', fontSize: '13px',
    }
    // <select> only (never plain <input>s, which stay on the plain style
    // above): `appearance: none` hands full rendering control to our own
    // CSS instead of the platform's native menulist chrome, at the cost of
    // the native dropdown arrow, which the backgroundImage caret below
    // replaces.
    var SETTINGS_DROPDOWN_CARET = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23374151' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"
    var SETTINGS_DROPDOWN_STYLE = Object.assign({}, SETTINGS_SELECT_STYLE, {
      WebkitAppearance: 'none',
      MozAppearance: 'none',
      appearance: 'none',
      paddingRight: '26px',
      backgroundImage: SETTINGS_DROPDOWN_CARET,
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'right 10px center',
      backgroundSize: '10px 6px',
    })

    // One labeled two-option <select> row, shared by BOTH settings surfaces
    // (the in-overlay gear panel and the Settings -> Plugins tab) -
    // module-level, not a component-local closure, since it reads/writes
    // sharedVoiceModePrefs directly rather than props passed down.
    // `optionValues` defaults to ['cloud','local'] (every call site before
    // reasoning-mode used exactly that pair) - existing 4-arg calls are
    // unchanged. `onAfterChange(value)` is an optional extra side effect
    // beyond just persisting the pref - reasoning-mode's own in-overlay row
    // uses it to apply the change to the LIVE session immediately (the
    // Settings tab has no live session to apply to, so it omits this and
    // the choice just takes effect next time voice mode starts).
    function prefSelectRow(labelText, prefKey, firstLabel, secondLabel, optionValues, onAfterChange) {
      var React = require('react')
      var values = optionValues || ['cloud', 'local']
      return React.createElement(
        'label',
        { style: SETTINGS_LABEL_STYLE },
        labelText,
        React.createElement(
          'select',
          {
            value: sharedVoiceModePrefs[prefKey],
            onChange: function (e) {
              updateVoiceModePref(prefKey, e.target.value)
              if (onAfterChange) onAfterChange(e.target.value)
            },
            style: SETTINGS_DROPDOWN_STYLE,
          },
          React.createElement('option', { value: values[0] }, firstLabel),
          React.createElement('option', { value: values[1] }, secondLabel),
        ),
      )
    }

    // Sentinel select value meaning "not one of the known suggestions, type
    // your own" - only reachable by explicitly picking "Custom..." or by
    // already having a non-suggestion value stored (e.g. from a swapped
    // model). Not a real voice name, never sent to the server as one.
    var QWEN3_TTS_CUSTOM_VOICE_VALUE = '__custom__'

    /**
     * Local TTS voice name - only meaningful while tts==='local', so callers
     * render it conditionally. A real <select> of the known roster (a plain
     * free-text input with a <datalist> was tried first, but every browser
     * tested filters datalist suggestions against whatever the input
     * already contains - with a real voice name pre-filled, that hid all
     * the OTHER suggestions instead of listing them, which is the opposite
     * of useful here) plus a "Custom..." option that reveals a text input,
     * for a swapped model whose valid names this plugin can't know - see
     * QWEN3_TTS_VOICE_SUGGESTIONS's own comment for where the known roster
     * comes from.
     */
    function localVoiceSelectRow() {
      var React = require('react')
      var current = sharedVoiceModePrefs.localVoice
      var isKnown = QWEN3_TTS_VOICE_SUGGESTIONS.indexOf(current) >= 0
      var selectValue = isKnown ? current : QWEN3_TTS_CUSTOM_VOICE_VALUE
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        React.createElement(
          'label',
          { style: SETTINGS_LABEL_STYLE },
          'Local voice',
          React.createElement(
            'select',
            {
              value: selectValue,
              onChange: function (e) {
                var v = e.target.value
                updateVoiceModePref('localVoice', v === QWEN3_TTS_CUSTOM_VOICE_VALUE ? '' : v)
              },
              style: SETTINGS_DROPDOWN_STYLE,
            },
            QWEN3_TTS_VOICE_SUGGESTIONS.map(function (v) { return React.createElement('option', { key: v, value: v }, v) }),
            React.createElement('option', { value: QWEN3_TTS_CUSTOM_VOICE_VALUE }, 'Custom…'),
          ),
        ),
        !isKnown ? React.createElement('input', {
          type: 'text',
          value: current,
          placeholder: 'custom speaker name (for a swapped model)',
          onChange: function (e) { updateVoiceModePref('localVoice', e.target.value) },
          style: SETTINGS_SELECT_STYLE,
        }) : null,
      )
    }

    // Client-side chat-node blocks (session tree, `node.blocks`) use `kind`
    // as their discriminant, NOT `type` - do not confuse this with the
    // HOST-side extractPlainTextFromContent() in index.ts, which reads a
    // different shape (AssistantMessage.content, the LLM-level ContentBlock
    // from packages/llm/llm/src/types.ts) that really does use `type`.
    function extractPlainText(blocks) {
      if (!Array.isArray(blocks)) return ''
      var out = ''
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i]
        if (b && b.kind === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
      }
      return out
    }

    // How much near-silence padding to seek past at the start/end of the
    // synthesized reply's own audio - both shipped TTS backends (Edge TTS,
    // Qwen3-TTS) pad a bit of near-silence onto the start and end of a
    // clip; trimming it makes playback feel like it starts/stops more
    // crisply. Done by SEEKING past the duration already decoded (see
    // playSpeechBlob's own comment) rather than re-encoding the blob.
    var TRIM_START_MS = 150
    var TRIM_END_MS = 250

    function findNewestAssistant(session) {
      if (!session || !session.nodes) return null
      var maxSeq = -1
      var newest = null
      for (var i = 0; i < session.nodes.length; i++) {
        var n = session.nodes[i]
        if (n && n.kind === 'assistant' && typeof n.messageId === 'string' && n.seq > maxSeq) {
          maxSeq = n.seq
          newest = n
        }
      }
      return newest
    }

    function VoiceModeView(props) {
      var React = require('react')
      var state = React.useState('idle')
      var voiceState = state[0]
      var setVoiceState = state[1]
      var levelState = React.useState(0)
      var level = levelState[0]
      var setLevel = levelState[1]
      var hueState = React.useState(0)
      var hue = hueState[0]
      var setHue = hueState[1]
      // Settings-panel state now lives in the shared module-level store
      // (sharedVoiceModePrefs/updateVoiceModePref, see that block's own
      // comment) - useVoiceModePrefsForce() just re-renders this component
      // when it changes, including from the OTHER surface that can change
      // it (the Settings -> Plugins tab, VoiceModeSettingsPanel further
      // down). beginListening/stopAndSend/synthesizeSpeech read
      // sharedVoiceModePrefs directly (a plain module binding, not React
      // state captured by the mount effect's empty deps), so they always
      // see the latest value with no ref-mirroring needed.
      useVoiceModePrefsForce()
      var settingsOpenState = React.useState(false)
      var settingsOpen = settingsOpenState[0]
      var setSettingsOpen = settingsOpenState[1]
      // After 7s of uninterrupted 'thinking' (a long agent turn - tool
      // calls, research, several steps), show a reassuring line so the
      // wait doesn't look stalled. Cleared the instant 'thinking' ends, for
      // whatever reason - moving to 'speaking' (the reply arrived) or back
      // to 'listening' (the user exited or something failed outright).
      var longWaitState = React.useState('')
      var longWaitMessage = longWaitState[0]
      var setLongWaitMessage = longWaitState[1]
      React.useEffect(function () {
        if (voiceState !== 'thinking') { setLongWaitMessage(''); return }
        var timer = null
        var lastIndex = -1
        // Never repeats the same line twice in a row (including across a
        // single wait's own successive lines, not just call to call), and
        // for a wait that runs long keeps cycling to a fresh random line
        // every 5-8s rather than freezing on whichever one happened to show
        // first.
        var showNext = function () {
          var idx
          do { idx = Math.floor(Math.random() * LONG_WAIT_MESSAGES.length) } while (idx === lastIndex && LONG_WAIT_MESSAGES.length > 1)
          lastIndex = idx
          setLongWaitMessage(LONG_WAIT_MESSAGES[idx])
          timer = setTimeout(showNext, 5000 + Math.random() * 3000)
        }
        timer = setTimeout(showNext, 7000)
        return function () { clearTimeout(timer) }
      }, [voiceState])
      // Surfaces a failed transcribe/speak request in the SAME text slot
      // longWaitMessage renders in (below), so a misconfigured backend (the
      // most common failure - a fresh install's STT/TTS endpoints ship with
      // no API key filled in) is actually visible instead of the loop just
      // silently going back to 'listening' with nothing on screen and only
      // a console.error nobody but a developer would ever open. Deliberately
      // NOT tied to voiceState the way longWaitMessage is (that effect
      // clears on every state change, which would wipe an error the instant
      // this same call flips state back to 'listening') - a plain timeout
      // clears it instead, long enough to actually read.
      var errorMessageState = React.useState('')
      var errorMessage = errorMessageState[0]
      var setErrorMessage = errorMessageState[1]
      var errorMessageTimerRef = React.useRef(null)
      function showError(text) {
        console.error('[voice-mode] ' + text)
        if (errorMessageTimerRef.current) clearTimeout(errorMessageTimerRef.current)
        // The full text always reaches the console above - this cap is only
        // for the on-screen version, which has a fixed-width, few-lines-tall
        // spot below the ring (a raw upstream error body, e.g. a JSON
        // payload from the configured STT/TTS server, can run to hundreds
        // of characters and would otherwise overflow well past the ring).
        var display = text.length > 160 ? text.slice(0, 157) + '…' : text
        setErrorMessage(display)
        errorMessageTimerRef.current = setTimeout(function () { setErrorMessage('') }, 6000)
      }
      // Damped level: raw RMS/analyser samples arrive noisy at ~60fps: fed
      // straight into setLevel(), the ring's per-frame `transform` target
      // keeps getting yanked to a new value before the CSS transition
      // settles, which reads as stiff/jittery motion no matter how the
      // transition itself is tuned. This is a simple exponential low-pass
      // filter (the same shape as a critically-damped one-pole follower) -
      // each call moves the displayed level only partway toward the new raw
      // sample, so it visibly "catches up" instead of jumping.
      var dampedLevelRef = React.useRef(0)
      function pushLevel(raw) {
        var next = dampedLevelRef.current + (raw - dampedLevelRef.current) * 0.22
        dampedLevelRef.current = next
        setLevel(next)
      }
      function resetLevel() {
        dampedLevelRef.current = 0
        setLevel(0)
      }
      // 'thinking' has no real mic/playback signal to drive the ring off
      // of, but feeding it through this SAME setLevel() (a synthesized sine
      // wave) rather than a separate CSS animation is what makes the
      // handoff into 'speaking' continuous instead of a jump-cut - see
      // Orb's comment.
      React.useEffect(function () {
        if (voiceState !== 'thinking') return
        var raf = null
        var start = performance.now()
        // Throttled to ~25fps (was every rAF, ~60fps) - React state
        // updates here each force a full gradient recompute + repaint (see
        // hyperbolaRingGradient), and on mobile hardware that can't keep up
        // at 60fps, the dropped frames make each update jump further than
        // intended once it finally lands - reported as stuttering size
        // changes and color jumps rather than a smooth drift. Still
        // scheduling rAF every frame (cheap - just a clock check), only the
        // expensive state update is rate-limited.
        var lastTick = 0
        var tick = function (now) {
          if (now - lastTick >= 40) {
            lastTick = now
            pushLevel(0.32 + 0.28 * Math.sin((now - start) / 420))
            setHue(((now - start) / 18) % 360)
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return function () { if (raf) cancelAnimationFrame(raf) }
      }, [voiceState])
      // 'idle' (mic permission failure) has no other per-frame callback to
      // piggyback a breathing floor on the way 'listening' does via its mic
      // callback, so it gets its own small tick here - same idea, just
      // driven by rAF instead of real audio frames.
      React.useEffect(function () {
        if (voiceState !== 'idle') return
        var raf = null
        var start = performance.now()
        var tick = function (now) {
          // Amplitude doubled (was 0.3 +/- 0.22, peak 0.52) - reported too
          // faint to notice on a phone screen. base===amplitude keeps the
          // trough at 0 instead of going negative; Orb's own
          // Math.min(level, 1) clamps the peak, so the top of each cycle
          // just holds briefly at full scale rather than overshooting.
          pushLevel(0.52 + 0.52 * Math.sin((now - start) / 450))
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return function () { if (raf) cancelAnimationFrame(raf) }
      }, [voiceState])
      // Created once, in the mount effect below, and reused for every
      // listen/stop cycle within this one voice-mode session (see
      // createPersistentMicCapture's own comment for why this used to be
      // per-turn and what that cost).
      var micRef = React.useRef(null)
      var vadRef = React.useRef(null)
      // props.audioGraph ({el, ctx, analyser}) is built ONCE by
      // ComposerVoiceMode, synchronously inside the toggle-on click (see its
      // comment), and reused for every reply across this element's whole
      // lifetime (including re-entering voice mode later) - never replaced
      // with `new Audio()`/`new AudioContext()` here, which would be
      // unlocked-less and silently fail/stay suspended on a phone. Owned by
      // the parent, not torn down when this view unmounts (exiting voice
      // mode), so re-entering doesn't need a fresh unlock gesture either.
      var meterRafRef = React.useRef(null)
      var stoppedRef = React.useRef(false)
      var lastSpokenSeqRef = React.useRef(-1)
      // Turn-number floor: any finalized node or streaming partial whose
      // OWN turn is <= this is never something to speak, no matter how
      // high its seq is. Needed because abandoning a turn (barge-in)
      // doesn't stop the agent's turn running server-side - it keeps
      // generating and WILL eventually finalize a real node with a real,
      // HIGHER-than-lastSpokenSeqRef seq, which would otherwise look
      // exactly like a fresh reply. Monotonic (only ever raised, via
      // snapshotSpokenFloor below, called from both startTurn() and
      // abandonCurrentTurn()) - see that function's own comment for why.
      var lastSpokenTurnRef = React.useRef(-1)

      /**
       * One object encapsulates EVERY piece of state for one "round" - from
       * the moment the user's utterance is submitted (or a pending item
       * resolves) through waiting for the agent's reply, streaming it in,
       * synthesizing it, and playing it back. Exactly ONE such object is
       * ever "current" (currentTurnRef.current) - starting a new one
       * (startTurn()) or abandoning the current one (abandonCurrentTurn(),
       * a barge-in) simply stops pointing at the old object; nothing new
       * ever mutates an orphaned one or acts on its results, since every
       * async continuation captures its OWN `turn` reference once and
       * checks isCurrentTurn(turn) - object identity, not a separate
       * id/generation number that has to be kept in sync by hand at every
       * call site - before doing anything observable.
       *
       * This replaces what used to be five separate refs
       * (streamCursorRef/speechQueueRef/queueBusyRef/prefetchRef/
       * bargeInRef) plus a numeric speakGenRef staleness counter, each of
       * which had to be individually remembered at every interrupt call
       * site - missing even one of them at one of those sites was exactly
       * the shape of several bugs chased through this file already (a
       * stale chunk playing after a barge-in, a stale pending-item
       * interrupting a fresh listening turn, a stale reply getting matched
       * to a question the user had already moved past). One object,
       * cleared by simply no longer being current, removes the whole
       * class at once instead of patching each new instance of it.
       *
       * Shape: `{ id, awaitingReply, claimedSessionTurn, finalizedSeq,
       * bargeIn }` - see startTurn() for field meanings.
       */
      var currentTurnRef = React.useRef(null)
      var turnIdCounterRef = React.useRef(0)

      /** The one check every turn-scoped async continuation makes before doing anything observable - see currentTurnRef's own comment. */
      function isCurrentTurn(turn) {
        return !stoppedRef.current && currentTurnRef.current === turn
      }

      // An outstanding cancelSession() confirmation from a just-abandoned
      // turn, if any - see abandonCurrentTurn's own comment. tryClaimAndFlush
      // defers ALL claiming while this is set - closing a race no amount of
      // bookkeeping about already-OBSERVED content can, since it covers
      // the case where a barge-in happens so early that the abandoned turn
      // hasn't produced any observable partial/finalized trace at all yet:
      // snapshotSpokenFloor() has nothing to floor against in that case -
      // only an actual confirmation that the old turn is dead removes the
      // ambiguity for whatever shows up next.
      var pendingCancelRef = React.useRef(null)
      // Always fresh (updated every render) so the cancel-confirmation
      // callback below - which fires from a promise .then(), not from a
      // props update - can read CURRENT session state instead of whatever
      // was captured by the render that scheduled it.
      var latestSessionRef = React.useRef(props.session)
      latestSessionRef.current = props.session

      // Latency breakdown for one voice-triggered turn: silence detected ->
      // audio encoded -> STT response -> submitted -> agent's reply lands
      // -> TTS response -> playback actually starts. (A 'summarize' stage
      // used to sit between "agent's reply lands" and "TTS response" - a
      // separate host round-trip to shorten the reply for speech, measured
      // at ~30% of the total via this exact instrumentation and removed in
      // favor of prompting the model for the right length directly - see
      // index.ts's own comment.) beginTiming() is called ONLY from
      // stopAndSend() (this is
      // specifically about the voice-initiated path, not a reply triggered
      // by answering a plan-review/question panel by hand) - every other
      // stage just appends a mark if a cycle is already running, so a
      // helper called from a non-voice-triggered path is already a safe
      // no-op. A turn with an intermediate empty assistant node (tool
      // calls/reasoning steps before the real text reply - see the
      // finalized-node watcher effect's own comment on this) shows up as
      // extra rows rather than being hidden, which is the more honest read
      // of "what actually took the time."
      var cycleTimingRef = React.useRef(null)
      function beginTiming() {
        cycleTimingRef.current = { marks: [{ label: 'silence-detected', at: performance.now() }] }
      }
      function markTiming(label) {
        var timing = cycleTimingRef.current
        if (!timing) return
        timing.marks.push({ label: label, at: performance.now() })
      }
      function finishTiming() {
        var timing = cycleTimingRef.current
        cycleTimingRef.current = null
        if (!timing || timing.marks.length < 2) return
        var marks = timing.marks
        var total = marks[marks.length - 1].at - marks[0].at
        var rows = []
        for (var i = 1; i < marks.length; i++) {
          var duration = marks[i].at - marks[i - 1].at
          rows.push({ stage: marks[i].label, ms: Math.round(duration), pct: total > 0 ? (duration / total * 100).toFixed(1) + '%' : '0%' })
        }
        console.log('[voice-mode] timing: silence -> speaking took ' + Math.round(total) + 'ms')
        console.table(rows)
      }

      function stopMeter() {
        if (meterRafRef.current) cancelAnimationFrame(meterRafRef.current)
        meterRafRef.current = null
      }

      function cleanupAudio() {
        stopMeter()
        if (micRef.current) { try { micRef.current.stopMonitoring() } catch (e) {} }
        if (props.audioGraph && props.audioGraph.el) { try { props.audioGraph.el.pause() } catch (e) {} }
      }

      function stopAll() {
        stoppedRef.current = true
        if (micRef.current) { try { micRef.current.stopRecording() } catch (e) {} }
        currentTurnRef.current = null
        cleanupAudio()
      }

      async function beginListening() {
        if (stoppedRef.current) return
        var mic = micRef.current
        if (!mic) return // not initialized yet - the init effect's own .then() calls this once it is
        // Diagnostic only - every call site that reaches here is a
        // legitimate "go back to plain listening" (VAD arm/re-arm, an
        // interrupt, a too-short/failed/empty transcript, the reply
        // finishing normally), so this should read as ONE line per real
        // listening turn. Two of these in a row with no VAD
        // speech-detected/silence-timeout log in between, or a
        // stopAndSend()/interruptThinking() log sandwiched right after one
        // without a matching "vad: silence timeout" first, would point at
        // a double-call - logged to help pin down the intermittent
        // "interrupt finished but got stuck in listening" report, which
        // this file can't currently explain from code reading alone.
        console.log('[voice-mode] beginListening()')
        // Plain listening has no active turn by definition - defensive
        // (every call site already arranges this itself before getting
        // here), but cheap, and consistent with the whole point of the
        // Turn design: "no longer current" should be trivially true
        // whenever we're back to just listening.
        currentTurnRef.current = null
        setVoiceState('listening')
        // "Waiting" (silence, nothing above the mic's own noise floor)
        // should still visibly breathe rather than sit frozen - a gentle
        // sine floor mixed in via max() so real speech (a much bigger
        // rms*6) always dominates it, but true silence still gets a small
        // periodic size change instead of nothing.
        var listenStart = performance.now()
        var lastLevelUpdate = 0
        mic.startRecording(function (rms) {
          // The AudioWorklet posts a message per 128-sample render quantum -
          // at 48kHz that's ~375 calls/sec. VAD needs that full rate (its
          // timing precision depends on it, and feed() is cheap pure-JS
          // math), but pushLevel() triggers a React state update + a full
          // gradient recompute + repaint (see hyperbolaRingGradient) -
          // doing that ~375x/sec is far more than even 'thinking's 60fps
          // version was, and is what made the ring visibly stutter while
          // actually speaking into the mic. Throttled to the same ~25fps
          // budget as 'thinking's tick.
          var now = performance.now()
          if (now - lastLevelUpdate >= 40) {
            lastLevelUpdate = now
            // A max() blend of breathing + rms*6 doesn't actually work:
            // any amplitude big enough to read as visible breathing during
            // silence (the original 0.3 +/- 0.22) also outweighs rms*6 for
            // a normal speaking voice, so the ring reads as "just
            // breathing, ignoring the mic" - and shrinking the amplitude
            // enough to stop that (tried: 0.06 +/- 0.04) makes the
            // breathing itself nearly invisible (scale barely moves off
            // 1 + 0.1*0.14). A hard switch on rms - full-amplitude
            // breathing while genuinely silent, pure mic signal the moment
            // there's real sound - avoids needing one amplitude to serve
            // both jobs at once; RING_SIGNAL_RMS sits well below the VAD's
            // own adaptive speech threshold (a fixed 40% of it, so it
            // stays proportionate as that threshold moves with the ambient
            // noise floor) so even a quiet "um" already counts as real
            // signal, not just room noise. pushLevel's own smoothing turns
            // the switch into a quick ramp rather than a visible snap.
            var RING_SIGNAL_RMS = currentAdaptiveSpeechRms() * 0.4
            // Amplitude doubled (was 0.3 +/- 0.22, peak 0.52) to match the
            // 'idle' tick's own bump - same "too faint on a phone" report.
            var breathFloor = 0.52 + 0.52 * Math.sin((now - listenStart) / 450)
            pushLevel(rms > RING_SIGNAL_RMS ? rms * 6 : breathFloor)
          }
          // Every frame (not just the throttled visual tick above) feeds
          // the ambient noise floor tracker too - see its own comment for
          // why sampling during actual speech doesn't corrupt the
          // estimate, so this doesn't need to gate on speechDetected.
          sharedNoiseFloorTracker.feed(rms)
          if (vadRef.current) vadRef.current.feed(rms)
        })
        if (stoppedRef.current) { mic.stopRecording(); return }
        var vad = createVad(function () { void stopAndSend() })
        vad.reset()
        vadRef.current = vad
      }

      /**
       * Records "everything up to and including this turn is already
       * accounted for, NOT something to speak" - called from BOTH
       * startTurn() (a fresh submission) and abandonCurrentTurn() (a
       * barge-in), the only two places that change which turn is current.
       * Looks at both the newest FINALIZED node and any still-STREAMING
       * partial, not just the former: a turn that's mid-flight (still
       * generating, not finalized yet) at the exact moment this runs - the
       * abandoned-via-interrupt case - has no finalized node yet for
       * findNewestAssistant() to see, so skipping the partial check would
       * let that turn's belated finalization slip through the floor
       * undetected.
       *
       * Monotonic on purpose (never LOWERS lastSpokenTurnRef/
       * lastSpokenSeqRef, only raises them): abandonCurrentTurn() calls
       * this at the moment of interrupt, while the about-to-be-abandoned
       * turn is normally still visibly streaming - correctly capturing it
       * as the floor right then, before cancelSession()'s own RPC round
       * trip has any chance to land. startTurn()'s LATER call, once the
       * user's next question is actually submitted, must not undo that by
       * computing a lower floor from state that - if the abandoned turn
       * had, by then, already been fully aborted and cleared from
       * `partial` - would look like it never happened at all.
       */
      function snapshotSpokenFloor() {
        var priorNewest = findNewestAssistant(props.session)
        var seq = priorNewest ? priorNewest.seq : -1
        if (seq > lastSpokenSeqRef.current) lastSpokenSeqRef.current = seq
        var floorTurn = priorNewest ? priorNewest.turn : -1
        var priorPartial = props.session && props.session.partial
        if (priorPartial && priorPartial.turn > floorTurn) floorTurn = priorPartial.turn
        if (floorTurn > lastSpokenTurnRef.current) lastSpokenTurnRef.current = floorTurn
      }

      /** Starts a brand-new turn and makes it current - see currentTurnRef's own comment for the whole design. */
      function startTurn() {
        snapshotSpokenFloor()
        turnIdCounterRef.current++
        var turn = {
          id: turnIdCounterRef.current,
          awaitingReply: true,
          claimedSessionTurn: -1, // the DSH session's own `turn` number this Turn is locked onto, once observed
          finalizedSeq: -1, // highest finalized-node seq already examined for claimedSessionTurn
          bargeIn: null, // { detector, trigger }
        }
        currentTurnRef.current = turn
        return turn
      }

      /**
       * Abandons whatever turn is current (a barge-in): orphans the object
       * (isCurrentTurn() is false for it from this point on - nothing new
       * ever acts on it again, regardless of what it's still waiting on),
       * raises the floor from LIVE state (snapshotSpokenFloor, see its own
       * comment), and kicks off - without waiting for - the server-side
       * cancellation. Also records the cancellation's own promise in
       * pendingCancelRef so the NEXT turn's claim attempts defer until it's
       * confirmed (see that ref's own comment); the resolution handler
       * re-attempts claiming for whichever turn is current BY THEN, using
       * latestSessionRef since effects only re-run on a props.session
       * change, not a promise settling on its own.
       */
      function abandonCurrentTurn() {
        snapshotSpokenFloor()
        currentTurnRef.current = null
        if (!props.cancelSession) return
        var cancelPromise = props.cancelSession().catch(function () {})
        pendingCancelRef.current = cancelPromise
        cancelPromise.then(function () {
          if (pendingCancelRef.current === cancelPromise) pendingCancelRef.current = null
          var turn = currentTurnRef.current
          if (turn) tryClaimAndFlush(turn, latestSessionRef.current)
        })
      }

      /**
       * Wires a barge-in detector into the mic's RMS monitor and fires
       * onTrigger(turn) the moment it decides the user has started
       * talking. Shared by 'speaking' (interruptPlayback, armed once in
       * playSpeechBlob) and 'thinking' (interruptThinking, armed once per
       * wait). Reuses the EXISTING detector - not a fresh one - when both
       * the turn and the trigger (a stable function reference either way,
       * so `===` is meaningful here) already match what's armed, so a
       * redundant re-arm for the same phase never discards accumulated
       * aboveMs progress; a genuine phase change (thinking -> speaking, or
       * a new turn entirely) always gets a fresh detector.
       */
      function armBargeIn(turn, onTrigger) {
        if (!micRef.current || !isCurrentTurn(turn)) return
        var existing = turn.bargeIn
        if (existing && existing.trigger === onTrigger) {
          return // already armed for this exact turn+phase - keep whatever progress the user has already made
        }
        console.log('[voice-mode] barge-in: armed fresh (turn=' + turn.id + ', trigger=' + (onTrigger === interruptThinking ? 'thinking' : 'playback') + ')')
        var detector = createBargeInDetector(function () {
          if (!isCurrentTurn(turn)) return
          onTrigger(turn)
        })
        detector.reset()
        turn.bargeIn = { detector: detector, trigger: onTrigger }
        // Only feeds the ambient noise floor tracker during 'thinking'
        // (onTrigger === interruptThinking), never 'speaking' - the mic
        // during 'speaking' can pick up the reply's OWN audio (see
        // getUserMedia's own comment on why echo cancellation isn't
        // forced), and that's the AI's voice, not room noise; letting it
        // feed the tracker would slowly pull the "ambient" floor up toward
        // however loud playback itself is.
        var sampleForNoiseFloor = onTrigger === interruptThinking
        micRef.current.startMonitoring(function (rms) {
          if (turn.bargeIn) turn.bargeIn.detector.feed(rms)
          if (sampleForNoiseFloor) sharedNoiseFloorTracker.feed(rms)
        })
      }

      /**
       * Fires once when barge-in triggers during playSpeechBlob's
       * 'speaking' state - NOT during announcePendingSwitch's brief
       * handoff notice, which the user should just let finish. Cuts the
       * reply short and drops straight into listening -
       * beginListening()'s own mic.startRecording() picks up the
       * monitor's pre-roll ring automatically (see
       * createPersistentMicCapture), so whatever the user said in the
       * ~BARGEIN_MIN_MS before this fired isn't lost.
       *
       * abandonCurrentTurn() (see its own comment) both orphans the turn
       * object and cancels it server-side - a multi-step turn (Task mode:
       * tool calls, more text) may still be RUNNING even once its first
       * text step has already finalized and started playing, so 'speaking'
       * doesn't imply "nothing left server-side to cancel."
       *
       * Nulls onended/onerror before pause(): pausing the shared <audio>
       * element can still invoke a stale handler afterward otherwise,
       * which would resolve the interrupted reply's own playSpeechBlob()
       * promise and let speakReply's post-await continuation run for a
       * turn that's already been orphaned - isCurrentTurn(turn) right
       * after that await is what actually guards against that, but nulling
       * the handlers here keeps it from firing at all in the first place.
       */
      function interruptPlayback(turn) {
        if (stoppedRef.current || !isCurrentTurn(turn)) return
        abandonCurrentTurn()
        if (props.audioGraph && props.audioGraph.el) {
          try {
            props.audioGraph.el.onended = null
            props.audioGraph.el.onerror = null
            props.audioGraph.el.pause()
          } catch (e) { /* best-effort */ }
        }
        stopMeter()
        resetLevel()
        void beginListening()
      }

      /**
       * Fires once when barge-in triggers during the 'thinking' wait -
       * armed both right after the user's own utterance is submitted
       * (stopAndSend) and after answering a plan-review/question by hand
       * (the pendingCount effect's "resolved" branch below). There's
       * nothing playing to pause here, unlike interruptPlayback - the only
       * thing to undo is the WAIT itself, which abandonCurrentTurn() does
       * by orphaning the turn object (nothing new ever acts on it again,
       * whatever it was still waiting on) and cancelling it server-side.
       */
      function interruptThinking(turn) {
        if (stoppedRef.current || !isCurrentTurn(turn)) return
        abandonCurrentTurn()
        cycleTimingRef.current = null // abandoning this voice-triggered cycle - its timing no longer means anything
        void beginListening()
      }

      // Three DISTINCT announcements, not one generic "there's a choice" -
      // reported as wrong specifically for plan-review, which is a
      // materially different situation from a plain question (a whole plan
      // to look over, not a short pick-one). `kind` here matches
      // props.session.pending's own three real shapes: a question payload
      // tagged intent.kind==='plan-review' (exit_plan_mode), a plain
      // question payload with no such intent (ask_user_question), or a
      // `kind: 'approval'` wait entirely (a tool-call permission prompt,
      // e.g. "run this shell command?" - a different payload shape with no
      // `questions` array at all).
      var ANNOUNCE_TEXT = {
        plan: 'I have a plan ready for your review. Switching to text mode - I will continue once you are done.',
        question: 'There is a question for you to answer on screen. Switching to text mode - I will pick back up once you are done.',
        approval: 'There is a permission request for you to confirm on screen. Switching to text mode - I will pick back up once you are done.',
      }

      /** Which of the three announcement variants applies to whatever's currently pending. */
      function currentPendingKind() {
        var pending = props.session && props.session.pending
        if (!Array.isArray(pending) || pending.length === 0) return 'question'
        var item = pending[0]
        if (item && item.kind === 'approval') return 'approval'
        if (item && item.kind === 'question' && item.payload && Array.isArray(item.payload.questions)) {
          var isPlanReview = item.payload.questions.some(function (q) { return q && q.intent && q.intent.kind === 'plan-review' })
          if (isPlanReview) return 'plan'
        }
        return 'question'
      }

      /**
       * Speaks a short, FIXED (not LLM-generated - this is a generic
       * template, not content that needs summarizing) heads-up that voice
       * mode is handing off to the real on-screen panel, and WAITS for it
       * to actually finish playing before resolving - the caller uses that
       * to keep the overlay up for the announcement's whole duration and
       * only reveal the real panel afterward, instead of the panel popping
       * up first and the announcement narrating something already on
       * screen (reported exactly backwards from this).
       *
       * The caller sets 'thinking' before calling this - matching
       * playSpeechBlob's own approach, this function doesn't flip to 'speaking'
       * (and start the analyser tick that makes the ring pulse with the
       * audio) until the TTS synthesis fetch has actually returned a
       * playable blob. Doing that flip eagerly, before the network round
       * trip, was reported as two symptoms of the same bug: several
       * seconds of a static (non-pulsing) blue ring before any sound
       * played - the ring had already claimed "speaking" while synthesis
       * was still in flight, and had no tick loop wired up yet regardless.
       *
       * Best-effort throughout: any failure just means no announcement
       * plays, never blocks the handoff (the caller proceeds regardless of
       * how this settles).
       */
      async function announcePendingSwitch() {
        try {
          if (!props.audioGraph || !props.audioGraph.el) return
          var announceText = ANNOUNCE_TEXT[currentPendingKind()]
          var useLocalTts = sharedVoiceModePrefs.tts === 'local'
          var speakResp = await fetch('/dsh-voice-mode-api/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: announceText,
              provider: useLocalTts ? 'local' : 'cloud',
              voice: useLocalTts ? undefined : pickVoiceForText(announceText),
              localVoice: useLocalTts ? sharedVoiceModePrefs.localVoice : undefined,
            }),
          })
          if (!speakResp.ok) {
            var announceErrBody = await speakResp.json().catch(function () { return null })
            showError((announceErrBody && announceErrBody.error) || ('Speech synthesis failed (HTTP ' + speakResp.status + ')'))
            return
          }
          var blob = await speakResp.blob()
          var url = URL.createObjectURL(blob)
          var audio = props.audioGraph.el
          if (props.audioGraph.ctx && props.audioGraph.ctx.state === 'suspended') {
            try { var r = props.audioGraph.ctx.resume(); if (r && r.catch) r.catch(function () {}) } catch (e) {}
          }
          setVoiceState('speaking')
          if (props.audioGraph.analyser) {
            var analyserNode = props.audioGraph.analyser
            var buf = new Uint8Array(analyserNode.frequencyBinCount)
            var lastSpeakLevelUpdate = 0
            var tick = function (now) {
              if (now - lastSpeakLevelUpdate >= 40) {
                lastSpeakLevelUpdate = now
                analyserNode.getByteTimeDomainData(buf)
                var sum = 0
                for (var i = 0; i < buf.length; i++) {
                  var v = (buf[i] - 128) / 128
                  sum += v * v
                }
                pushLevel(Math.sqrt(sum / buf.length) * 6)
              }
              meterRafRef.current = requestAnimationFrame(tick)
            }
            meterRafRef.current = requestAnimationFrame(tick)
          }
          await new Promise(function (resolve) {
            audio.src = url
            audio.onended = function () { URL.revokeObjectURL(url); resolve() }
            audio.onerror = function () { URL.revokeObjectURL(url); resolve() }
            var p = audio.play()
            if (p && p.catch) p.catch(function () { resolve() })
          })
          stopMeter()
          resetLevel()
        } catch (e) {
          console.error('[voice-mode] announcePendingSwitch failed:', e)
          stopMeter()
        }
      }

      async function stopAndSend() {
        if (stoppedRef.current) return
        var mic = micRef.current
        if (!mic) return
        beginTiming() // t0 - VAD's silence timeout just fired, this is "the user stopped talking"
        setVoiceState('thinking')
        // Deliberately NOT resetLevel() here (unlike the other
        // state-exit sites) - by the time VAD's silence timeout fires,
        // `level` has already been sitting in 'listening's own gentle
        // breathFloor range (rms was below threshold for the whole
        // preceding SILENCE_MS stretch) for over a second, so there's no
        // stale loud value to clear. Hard-resetting to exactly 0 here
        // instead of letting the damped filter carry its current value
        // into 'thinking's own sine tick made the ring visibly deflate to
        // baseline and then reinflate into 'thinking's (smaller) breathing
        // range - a real size "跳变" on top of the color one, since
        // resetLevel() bypasses pushLevel's damping rather than easing
        // through it. Leaving the damped value where it is lets the very
        // next 'thinking' tick ease smoothly FROM wherever listening left
        // off, same continuous-chase idea as Orb's own color transition.
        mic.stopRecording()
        // Created here, covering the ENTIRE 'thinking' stretch including
        // the STT round trip just below - a user who barges in while their
        // own just-finished utterance is still being transcribed gets the
        // same abandon-and-relisten treatment as one who barges in later,
        // during the actual wait for the agent. isCurrentTurn(turn) checks
        // after each await below are what let a mid-STT interrupt take
        // effect immediately: interruptThinking() (via the barge-in
        // armed right after this) already calls beginListening() on its
        // own, so every checkpoint here just needs to notice it's no
        // longer current and quietly stop - not repeat that work or fight
        // over which state wins.
        var turn = startTurn()
        armBargeIn(turn, interruptThinking)
        var hadSamples = mic.hasSamples()
        var wavBytes = hadSamples ? mic.snapshotWavBytes() : null
        markTiming('encode-audio')
        console.log('[voice-mode] stopAndSend: hadSamples=' + hadSamples + ' wavBytes=' + (wavBytes ? wavBytes.length : 0))
        if (!hadSamples || !wavBytes || wavBytes.length < 4000) {
          console.log('[voice-mode] recording too short, resuming listening without transcribing')
          if (currentTurnRef.current === turn) currentTurnRef.current = null // never going to submit anything - nothing to wait for
          void beginListening() // too short to be real speech - just keep listening
          return
        }
        var text = ''
        var failure = ''
        try {
          var resp = await fetch('/dsh-voice-mode-api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav', 'X-Voice-Mode-Stt-Provider': sharedVoiceModePrefs.stt },
            body: wavBytes,
          })
          var data = await resp.json()
          markTiming('speech-to-text')
          console.log('[voice-mode] transcribe response:', resp.status, data)
          if (resp.ok) {
            text = (data && data.text) || ''
          } else {
            failure = (data && data.error) || ('Speech recognition failed (HTTP ' + resp.status + ')')
          }
        } catch (e) {
          failure = 'Speech recognition request failed: ' + (e && e.message ? e.message : String(e))
        }
        // A barge-in during the STT round trip just above already called
        // interruptThinking(turn) -> abandonCurrentTurn() ->
        // beginListening() on its own - this transcript (successful or
        // not) is simply moot now, and acting on it further would fight
        // over the state that call already settled.
        if (!isCurrentTurn(turn)) return
        if (failure) {
          showError(failure)
          currentTurnRef.current = null
          void beginListening()
          return
        }
        if (!text.trim()) {
          console.log('[voice-mode] empty transcript, resuming listening without submitting')
          currentTurnRef.current = null
          void beginListening()
          return
        }
        console.log('[voice-mode] transcribed text: "' + text + '"')
        try {
          var inputActions = props.inputActions
          if (!inputActions) throw new Error('no inputActions face (standard-kit prop unavailable)')
          inputActions.setDraft(text)
          inputActions.submit()
          markTiming('submit')
        } catch (e) {
          console.error('[voice-mode] submit failed:', e)
          currentTurnRef.current = null
          void beginListening()
          return
        }
      }

      /**
       * Attempts to claim/flush a new FINALIZED assistant node. Cloud TTS
       * (edge-tts) synthesizes a whole reply in a couple of seconds even
       * at full length (measured: ~2.3s for a 300-character reply, vs
       * local Qwen3-TTS's ~47s for the same text) - not worth the
       * complexity of chunking/streaming a reply out sentence by sentence
       * just to hide synthesis latency that's already small. So this
       * simply waits for the reply to finish generating and speaks the
       * WHOLE thing in one request.
       *
       * `turn.claimedSessionTurn` locks onto whichever DSH turn number is
       * first observed (PartialAccumulator is constructed fresh per STEP -
       * deepseek-harness packages/client/runtime/src/client/sessions/
       * partial.ts - but the DSH `turn` number itself is stable across
       * steps of the same turn); once locked, a finalized node from a
       * DIFFERENT dsh-turn is ignored outright. Deferred entirely while
       * pendingCancelRef is set (see its own comment) - re-attempted from
       * abandonCurrentTurn()'s own confirmation handler once it clears,
       * since nothing else would otherwise re-trigger this for a
       * props.session that hasn't changed since.
       */
      function tryClaimAndFlush(turn, session) {
        if (!isCurrentTurn(turn) || !turn.awaitingReply || pendingCancelRef.current) return
        var newest = findNewestAssistant(session)
        if (!newest || newest.seq <= turn.finalizedSeq) return
        if (turn.claimedSessionTurn === -1) {
          if (newest.seq <= lastSpokenSeqRef.current || newest.turn <= lastSpokenTurnRef.current) return // still old news, not yet superseded
        } else if (newest.turn !== turn.claimedSessionTurn) {
          return // some OTHER dsh-turn's node - not what this Turn is waiting on
        }
        turn.finalizedSeq = newest.seq
        if (newest.seq > lastSpokenSeqRef.current) lastSpokenSeqRef.current = newest.seq
        if (turn.claimedSessionTurn === -1) turn.claimedSessionTurn = newest.turn
        // Never narrate while a plan-review/question wait is pending - see
        // the pendingCount effect's own "isPending" branch comment. That
        // effect starts a fresh turn once the pending item clears, so the
        // real next reply still gets picked up - nothing to redo here.
        if (session && session.pending && session.pending.length > 0) {
          turn.awaitingReply = false
          return
        }
        var fullText = extractPlainText(newest.blocks).trim()
        if (!fullText) {
          // Intermediate node (reasoning/tool-call step before the actual
          // text reply) - keep waiting for the next one; claimedSessionTurn
          // stays locked (it's still the SAME dsh-turn, just an earlier
          // step of it) and finalizedSeq is already past this one so it
          // won't be re-examined.
          turn.awaitingReply = true
          return
        }
        markTiming('agent-reply')
        turn.awaitingReply = false
        speakReply(turn, fullText)
      }

      React.useEffect(function () {
        var turn = currentTurnRef.current
        if (turn) tryClaimAndFlush(turn, props.session)
      }, [props.session])

      /**
       * Synthesizes and plays the WHOLE reply as one request, then returns
       * to listening. isCurrentTurn(turn) is checked before speaking (a
       * barge-in mid-synthesis simply leaves the resolved blob unused).
       */
      async function speakReply(turn, text) {
        if (!isCurrentTurn(turn) || !text) return
        var blob = await synthesizeSpeech(turn, text)
        await playSpeechBlob(turn, blob)
        if (!isCurrentTurn(turn)) return
        if (currentTurnRef.current === turn) currentTurnRef.current = null
        cleanupAudio()
        resetLevel()
        void beginListening()
      }

      /**
       * POSTs the reply text to /speak and resolves with the audio blob
       * (or null on any failure/staleness) - synthesis only, no playback.
       */
      async function synthesizeSpeech(turn, text) {
        if (!isCurrentTurn(turn) || !text) return null
        try {
          // provider is sent as-is ('cloud'/'local') - the /speak route
          // picks Edge TTS or the local Qwen3-TTS server itself, no
          // separate provider-name translation needed. 'local' omits
          // `voice` since Edge's voice ids (en-US-AriaNeural etc.) don't
          // mean anything to Qwen3-TTS -
          // `localVoice` (free text, set from either settings surface)
          // carries the chosen local-TTS speaker name instead.
          var useLocalTts = sharedVoiceModePrefs.tts === 'local'
          var speakResp = await fetch('/dsh-voice-mode-api/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: text,
              provider: useLocalTts ? 'local' : 'cloud',
              voice: useLocalTts ? undefined : pickVoiceForText(text),
              localVoice: useLocalTts ? sharedVoiceModePrefs.localVoice : undefined,
            }),
          })
          if (!isCurrentTurn(turn)) return null
          if (!speakResp.ok) {
            var errBody = await speakResp.json().catch(function () { return null })
            showError((errBody && errBody.error) || ('Speech synthesis failed (HTTP ' + speakResp.status + ')'))
            return null
          }
          var blob = await speakResp.blob()
          markTiming('tts-synthesis')
          if (!isCurrentTurn(turn)) return null
          return blob
        } catch (e) {
          console.error('[voice-mode] synthesizeSpeech failed:', e)
          return null
        }
      }

      /** Plays the reply's audio blob, checking isCurrentTurn(turn) rather than a separate generation counter (see currentTurnRef's own comment for the whole design). */
      async function playSpeechBlob(turn, audioBlob) {
        try {
          if (!isCurrentTurn(turn) || !audioBlob) return
          if (!props.audioGraph || !props.audioGraph.el) throw new Error('no unlocked audio element (voice mode was not entered via the toggle click)')
          // The shared AudioContext is only ever explicitly resumed ONCE,
          // at the moment voice mode is first toggled on (see
          // ComposerVoiceMode) - the one unlock a user gesture allows.
          // Browsers (mobile Safari especially) can silently re-suspend an
          // AudioContext of its own accord after a period of inactivity,
          // which mutes anything routed through it - the element's own
          // audio.play() still resolves normally, and this tick still
          // runs, but analyserNode reads a suspended/frozen graph and the
          // destination never actually outputs anything. Reported as "the
          // ring turned blue/speaking but nothing played" on a SECOND
          // reply in the same session. Resuming (a no-op if already
          // running) right before every playback, not just the first, is
          // the standard fix - it needs no user gesture since the context
          // was already unlocked once this session.
          if (props.audioGraph.ctx && props.audioGraph.ctx.state === 'suspended') {
            try {
              var resumeResult = props.audioGraph.ctx.resume()
              if (resumeResult && resumeResult.catch) resumeResult.catch(function () {})
            } catch (e) { /* best-effort */ }
          }
          setVoiceState('speaking')
          markTiming('playback-start')
          finishTiming()
          // NOT wired into announcePendingSwitch's own
          // 'speaking' phase - that announcement is a mandatory
          // one-sentence handoff notice the user needs to hear, not
          // something worth interrupting.
          armBargeIn(turn, interruptPlayback)
          var audio = props.audioGraph.el
          if (props.audioGraph.analyser) {
            var analyserNode = props.audioGraph.analyser
            var buf = new Uint8Array(analyserNode.frequencyBinCount)
            // Throttled to the same ~25fps budget 'listening'/'thinking'
            // use (see their own comments) - this tick used to call
            // pushLevel() on every rAF (~60fps), which doesn't just cost
            // more repaints: pushLevel's exponential filter converges
            // toward each new sample at a FIXED fraction per CALL, so
            // calling it twice as often makes it visibly follow twice as
            // fast in wall-clock time - reported as "jitters too fast, no
            // damping feel" even though the filter math never changed.
            var lastSpeakLevelUpdate = 0
            var tick = function (now) {
              if (now - lastSpeakLevelUpdate >= 40) {
                lastSpeakLevelUpdate = now
                analyserNode.getByteTimeDomainData(buf)
                var sum = 0
                for (var i = 0; i < buf.length; i++) {
                  var v = (buf[i] - 128) / 128
                  sum += v * v
                }
                pushLevel(Math.sqrt(sum / buf.length) * 6)
              }
              meterRafRef.current = requestAnimationFrame(tick)
            }
            meterRafRef.current = requestAnimationFrame(tick)
          }
          var audioUrl = URL.createObjectURL(audioBlob)
          await new Promise(function (resolve) {
            var endTimer = null
            function finish() {
              if (endTimer) { clearTimeout(endTimer); endTimer = null }
              URL.revokeObjectURL(audioUrl)
              stopMeter()
              resolve()
            }
            audio.src = audioUrl
            audio.onended = finish
            audio.onerror = finish
            // Both shipped TTS backends (Edge TTS, Qwen3-TTS) pad a bit of
            // near-silence onto the start/end of a clip - trimmed by
            // SEEKING past the duration already decoded rather than
            // re-encoding the blob (no MP3 encoder available in-browser
            // anyway). Capped at 35% of the clip's own duration per end so
            // a very short reply never gets trimmed down to nothing.
            audio.onloadedmetadata = function () {
              var dur = audio.duration
              if (!isFinite(dur) || dur <= 0) return
              var cap = dur * 0.35
              var startSec = Math.min(TRIM_START_MS / 1000, cap)
              var endSec = Math.min(TRIM_END_MS / 1000, cap)
              if (startSec > 0) { try { audio.currentTime = startSec } catch (e) { /* not seekable yet - play from 0, acceptable */ } }
              var playMs = Math.max(0, (dur - startSec - endSec) * 1000)
              endTimer = setTimeout(finish, playMs)
            }
            var p = audio.play()
            if (p && p.catch) p.catch(function () { finish() })
          })
        } catch (e) {
          console.error('[voice-mode] playSpeechBlob failed:', e)
        }
      }

      React.useEffect(function () {
        stoppedRef.current = false
        // Mic graph created ONCE here (see createPersistentMicCapture's own
        // comment) - beginListening() only starts firing once init()
        // resolves; every later listen/stop cycle within this same mount
        // reuses micRef.current without repeating any of this async setup.
        var mic = createPersistentMicCapture()
        micRef.current = mic
        mic.init().then(function () {
          if (stoppedRef.current) { mic.teardown(); return }
          void beginListening()
        }).catch(function (err) {
          showError('Microphone unavailable: ' + (err && err.message ? err.message : String(err)))
          setVoiceState('idle')
        })
        return function () {
          stopAll()
          mic.teardown()
          micRef.current = null
          if (errorMessageTimerRef.current) clearTimeout(errorMessageTimerRef.current)
          if (pendingGraceTimerRef.current) clearTimeout(pendingGraceTimerRef.current)
        }
      }, [])

      // Plan-review approval and ask_user_question (including plain
      // clarifying questions, not just plan mode) both pause the agent on
      // a `ConversationSnapshot.pending` entry - a live push
      // (question/requested|resolved, approval/requested|resolved), not a
      // durable session/event a plugin can otherwise observe. This
      // fullscreen overlay is a `position:fixed` portal to document.body at
      // the maximum z-index, so while one is pending it was unconditionally
      // covering ConversationRoot's own sticky composer seat - the ACTUAL
      // panel with the Approve/Reject buttons or question options was still
      // rendering underneath the whole time, just invisible and untappable.
      // Reported as voice mode "getting stuck" at approval/question time
      // with no way to proceed at all. `props.session` is the same
      // ConversationSnapshot findNewestAssistant already reads elsewhere in
      // this file, so `.pending` needs no new plumbing - it's already
      // there, forwarded to every conversation.input.* registrant by the
      // standard kit.
      //
      // A voice-driven answering flow (brief the question aloud, listen,
      // match a spoken reply to an option, submit via item.respond()) was
      // tried and explicitly abandoned by the user ("since this doesn't
      // work") in favor of this simpler shape instead: announce the
      // handoff aloud, then just hand off to the real on-screen panel -
      // the user answers by tapping/typing there like normal, and voice
      // mode picks the loop back up on its own once they're done.
      var pendingCount = (props.session && props.session.pending && props.session.pending.length) || 0
      // Always fresh (updated every render, read from the grace-timer
      // callback below - see PENDING_GRACE_MS's own comment) - a plain
      // ref assignment during render is safe here since nothing renders
      // FROM it, it's purely a cache for that later async read.
      var pendingCountRef = React.useRef(0)
      pendingCountRef.current = pendingCount
      var pendingGraceTimerRef = React.useRef(null)
      var wasPendingRef = React.useRef(false)
      // Gates the handoff itself, separate from pendingCount: the panel
      // must not appear (overlay must not hide) until the announcement has
      // actually finished playing - reported exactly backwards before this
      // (panel popped up first, narration followed describing something
      // already on screen). Starts true so a session with no pending item
      // at all never shows a stray blocked overlay.
      var handoffReadyState = React.useState(true)
      var handoffReady = handoffReadyState[0]
      var setHandoffReady = handoffReadyState[1]
      // useLayoutEffect, not useEffect: a plain effect runs AFTER the
      // browser paints, so the very first render after pendingCount goes
      // positive still commits with the OLD handoffReady (true) - the
      // overlay hides, the real panel paints, THEN this effect fires and
      // flips handoffReady false, hiding the panel again and repainting
      // the overlay. That whole hide-paint-flip-repaint round trip is
      // exactly the ~0.1s flash into "text mode" and back that was
      // reported. A layout effect runs synchronously after render but
      // BEFORE paint, so handoffReady is already false by the time the
      // browser draws anything - the overlay never has a frame in which to
      // disappear.
      // How long to wait, once pending first goes 0->positive, before
      // treating it as real - see the effect's own comment on the race
      // this guards against. Long enough to comfortably cover one
      // round trip to the host and back (the correction is a plain RPC,
      // not an LLM call); short enough that a GENUINE pending item's
      // announcement isn't noticeably delayed.
      var PENDING_GRACE_MS = 500
      React.useLayoutEffect(function () {
        var isPending = pendingCount > 0
        if (isPending && !wasPendingRef.current) {
          // Don't act on this edge immediately - see interruptPlayback's
          // own cancelSession() comment: cancelling a barged-into turn
          // aborts it server-side, but if that turn had ALREADY sent a
          // pending approval/question request to the client microseconds
          // earlier, the client can legitimately see pending.length go
          // 0->1 for one brief round trip BEFORE the host's own correction
          // (settling that request as 'cancelled') arrives and clears it
          // back to 0. Reacting to that transient edge immediately paused
          // the user's OWN fresh listening turn (mid-utterance, having
          // just barged in) to narrate a stale announcement about a
          // question that no longer exists - reported as voice mode
          // "randomly switching from listening to speaking" while the user
          // was still actively talking, which should never happen for any
          // reason other than the VAD itself deciding they'd stopped.
          // Waiting a short beat and rechecking pendingCountRef (always
          // fresh, unlike pendingCount which is only as current as this
          // render) tells a genuine pending item (still there after the
          // grace window) apart from this race (resolved back to 0 well
          // within it) without delaying a real one noticeably.
          if (pendingGraceTimerRef.current) return // already waiting on this same edge
          pendingGraceTimerRef.current = setTimeout(function () {
            pendingGraceTimerRef.current = null
            if (pendingCountRef.current === 0) return // resolved itself within the grace window - the cancel race, not a real pending item; wasPendingRef stays false so a genuine one later still edges cleanly
            wasPendingRef.current = true
            // Pause the loop rather than let VAD silently submit a spoken
            // sentence as if it were an answer to the pending panel - the
            // user is expected to tap Approve/Reject/an option (or type a
            // comment) directly. stopRecording() (not stopAndSend()) since
            // there's nothing to transcribe/submit here, just a listening
            // session to suspend.
            vadRef.current = null
            if (micRef.current) { try { micRef.current.stopRecording() } catch (e) {} }
            // Abandon whatever turn is current, not just stop recording -
            // a reply's barge-in monitor may still be running at exactly
            // this moment (this effect can fire mid-'speaking', not just
            // mid-'listening'), and leaving it current would let
            // interruptPlayback() -> beginListening() fire UNDER the
            // pending panel, starting a real recording (and eventually a
            // VAD auto-submit) at the exact moment the comment above says
            // to suspend listening entirely. abandonCurrentTurn() is a
            // no-op if nothing is current.
            if (currentTurnRef.current) abandonCurrentTurn()
            cycleTimingRef.current = null // whatever voice-triggered cycle was in flight is moot now
            resetLevel()
            // The finalized-node claim function's own pending-check (see
            // its comment) only catches a reply that hasn't started
            // playing yet - the pending wait and the assistant text
            // finalizing are two independent delivery channels with no
            // ordering guarantee, so the reply can already be mid-playback
            // by the time pending becomes visible here.
            // abandonCurrentTurn() above already orphaned the turn (so
            // isCurrentTurn(turn) is false for whatever reply was in
            // flight - its own check right after its next await is what
            // actually stops a stale continuation from reaching
            // beginListening()), and clearing the shared <audio> element's
            // onended/onerror BEFORE pausing it (below) stops that reply's
            // own playSpeechBlob() finish() from EVER firing at all -
            // originally added (back when a stale finish() DID reach all
            // the way to beginListening() itself) because pausing could
            // still let the old handler fire later, or a moment later when
            // announcePendingSwitch reassigns the same element's src for
            // its own playback - reported as an extra reading right as the
            // plan-review card appeared, and separately as the ring
            // flipping blue->white mid-read.
            if (props.audioGraph && props.audioGraph.el) {
              try {
                props.audioGraph.el.onended = null
                props.audioGraph.el.onerror = null
                props.audioGraph.el.pause()
              } catch (e) { /* best-effort */ }
            }
            stopMeter()
            setHandoffReady(false)
            // 'thinking' while announcePendingSwitch does its own network
            // round trip (TTS synthesis) - it flips to 'speaking' itself,
            // with the ring's analyser tick wired up, only once audio is
            // actually about to play (see its own comment on why).
            setVoiceState('thinking')
            announcePendingSwitch().then(function () { setHandoffReady(true) })
          }, PENDING_GRACE_MS)
          return
        }
        if (pendingGraceTimerRef.current && !isPending) {
          // pendingCount dropped back to 0 before the grace window elapsed
          // - this WAS the cancel race (see above): cancel the pending
          // confirmation outright. wasPendingRef is still false (never
          // confirmed), so nothing here was ever paused/announced and
          // there's nothing to resolve either.
          clearTimeout(pendingGraceTimerRef.current)
          pendingGraceTimerRef.current = null
          return
        }
        if (!isPending && wasPendingRef.current) {
          // Resolved (by a tap on the real panel, since voice mode can't
          // answer it directly) - answering a pending question/approval
          // resumes the agent's own turn immediately (that's what a tool
          // result does), so it's about to say/do something else on its
          // own almost every time, not waiting on the user to speak next.
          // Dropping straight into 'listening' (white ring) read as "your
          // turn to talk" at exactly the moment the agent was already
          // continuing - go to 'thinking' (colored ring) instead and start
          // a fresh turn the same way stopAndSend() does after submitting a
          // transcribed message, so whatever the agent says next gets
          // picked up and read aloud normally.
          setVoiceState('thinking')
          var turn = startTurn()
          armBargeIn(turn, interruptThinking)
        }
        wasPendingRef.current = isPending
      }, [pendingCount])

      if (pendingCount > 0 && handoffReady) return null // let ConversationRoot's own composer seat (and its pending panel) show through, once the announcement has actually finished (while it's still playing, handoffReady is false and the overlay stays up instead)

      var overlay = React.createElement(
        'div',
        {
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483647,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '28px',
            background: 'var(--dsw-alias-bg-primary, #0b0b0f)',
          },
        },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-voice-mode-icon-btn',
            'aria-label': 'Voice mode settings',
            onClick: function () { setSettingsOpen(!settingsOpen) },
            style: {
              position: 'fixed', top: '20px', right: '20px',
              width: '36px', height: '36px', borderRadius: '50%', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            },
          },
          React.createElement(
            // A circle + 8 rays reads as a sun/brightness toggle, not
            // settings - reported as genuinely confusable with a dark/light
            // mode switch. This is a real gear/cog outline instead (Feather
            // icons' "settings" glyph, same public 24x24 stroke-path shape
            // used everywhere for this exact meaning), hand-copied as plain
            // path geometry the same way every other icon in this file is.
            'svg',
            { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
            React.createElement('circle', { cx: '12', cy: '12', r: '3' }),
            React.createElement('path', {
              d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
            }),
          ),
        ),
        settingsOpen ? React.createElement(
          'div',
          {
            style: {
              position: 'fixed', top: '64px', right: '20px', zIndex: 2147483647,
              display: 'flex', flexDirection: 'column', gap: '14px',
              minWidth: '220px', padding: '16px', borderRadius: '12px',
              background: 'var(--dsw-alias-bg-secondary, #16171d)',
              border: '1px solid rgba(255,255,255,0.12)',
            },
          },
          prefSelectRow('Speech recognition (STT)', 'stt', 'Cloud', 'Local'),
          prefSelectRow('Speech synthesis (TTS)', 'tts', 'Cloud', 'Local'),
          // Local voice moved to the Settings tab (VoiceModeEndpointSettings,
          // inside the ttsLocal group) - it follows the model, same place
          // endpoint/model live, not this quick in-call panel.
          // Applies immediately to THIS live session (unlike the Settings
          // tab's copy of this same row, which only sets the preference for
          // next time - no live session exists there).
          prefSelectRow('Preset mode', 'presetMode', 'Task', 'Chat (default)', ['task', 'chat'], function (mode) {
            if (props.applyReasoningEffort) props.applyReasoningEffort(mode === 'chat' ? 'off' : 'high')
            // Live-updates the host's per-session record too (not just
            // reasoning effort) - Chat's shorter system-prompt wording and
            // tighter spoken-summary length limit both key off this, and
            // should take effect immediately if switched mid-call, not only
            // the next time voice mode starts.
            toggleVoiceModeActive(props.sessionId, true, mode)
          }),
          React.createElement('p', { style: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #6b7280)', lineHeight: 1.4 } },
            'Open Settings → Plugins → Voice Mode to set backend models.'),
        ) : null,
        React.createElement(Orb, { state: voiceState, level: level, hue: hue }),
        React.createElement(
          'div',
          {
            style: {
              minHeight: '20px', maxWidth: '420px', padding: '0 20px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
              color: errorMessage ? 'var(--dsw-alias-state-danger-primary, #f87171)' : 'var(--dsw-alias-label-secondary, #9ca3af)',
              fontSize: '14px', lineHeight: 1.4,
            },
          },
          errorMessage || longWaitMessage,
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-voice-mode-icon-btn',
            'aria-label': 'Close voice mode',
            onClick: props.onExit,
            style: {
              marginTop: '48px',
              width: '40px', height: '40px', borderRadius: '50%', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            },
          },
          React.createElement(
            'svg',
            { width: '18', height: '18', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            React.createElement('path', { d: 'M2 2l12 12M14 2L2 14', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }),
          ),
        ),
      )
      // Rendered from a composer-area registrant (see the section below for
      // why), so it sits somewhere deep in ConversationRoot's DOM subtree -
      // an ancestor there uses a CSS transform for its own layout/animation,
      // which (per spec) makes that ancestor the containing block for any
      // `position: fixed` descendant instead of the viewport. That clipped
      // this overlay to that ancestor's box, leaving the app's own top bar
      // visible above it. A portal to document.body escapes that entirely,
      // the same way this app's own modals/toasts must.
      try {
        var ReactDOM = require('react-dom')
        if (ReactDOM && typeof ReactDOM.createPortal === 'function') return ReactDOM.createPortal(overlay, document.body)
      } catch (e) { /* fall through to inline rendering below */ }
      return overlay
    }

    // ---------------------------------------------------------------------
    // Composer toggle + fullscreen view, ONE registrant on
    // conversation.input.left - NOT a conversation-slot shadow. Shadowing
    // 'conversation' was the first attempt, and it worked visually, but it
    // unmounts the entire default ConversationRoot underneath - which is
    // what actually supplies props.session/props.sessionId to any
    // conversation.input.* registrant via ui-conversation's own standard-kit
    // prop injection (confirmed live: a plain composer registrant gets both
    // with no explicit `inject` at all - that's ConversationRoot's own
    // mechanism, available to any composer-area registrant). Rendering the
    // fullscreen view as a `position: fixed` sibling from a composer-area
    // registrant instead keeps ConversationRoot alive, while still
    // covering the viewport visually.
    // ---------------------------------------------------------------------
    // A silent, minimal WAV - just long enough to be a real playable source
    // (mobile Safari/Chrome refuse to "unlock" audio on a src-less element).
    var SILENT_WAV_DATA_URL = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

    function ComposerVoiceMode(props) {
      var React = require('react')
      var state = React.useState(false)
      var active = state[0]
      var setActive = state[1]
      // One <audio> element PLUS its AudioContext/analyser graph, both
      // created and "unlocked" synchronously inside the click that turns
      // voice mode on (still inside the user-gesture window mobile
      // Safari/Chrome require for both APIs), then reused for every reply
      // afterwards. Either one created later, from an async callback after
      // a fetch/await chain (which is what playSpeechBlob necessarily is), is
      // NOT inside a user gesture on mobile and silently fails/stays
      // suspended - no error reaches either side (a rejected play() promise
      // here was already being caught and logged, but that log is invisible
      // on a phone with no devtools attached). This sidesteps the
      // restriction entirely by never creating fresh, locked ones.
      var audioGraphRef = React.useRef(null)
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-voice-mode-toggle',
            'aria-label': active ? 'Exit voice mode' : 'Enter voice mode',
            'data-active': active ? 'true' : 'false',
            onClick: function () {
              var next = !active
              if (next && !audioGraphRef.current) {
                var el = new Audio()
                el.src = SILENT_WAV_DATA_URL
                var unlockPlay = el.play()
                if (unlockPlay && typeof unlockPlay.catch === 'function') unlockPlay.catch(function () {})
                try {
                  var AudioCtxCtor = window.AudioContext || window.webkitAudioContext
                  var audioCtx = new AudioCtxCtor()
                  if (audioCtx.state === 'suspended') { var r = audioCtx.resume(); if (r && r.catch) r.catch(function () {}) }
                  var analyser = audioCtx.createAnalyser()
                  analyser.fftSize = 256
                  var srcNode = audioCtx.createMediaElementSource(el)
                  srcNode.connect(analyser)
                  analyser.connect(audioCtx.destination)
                  audioGraphRef.current = { el: el, ctx: audioCtx, analyser: analyser }
                } catch (e) {
                  // Metering is a nice-to-have; keep the (already unlocked)
                  // plain element so playback still works without a level
                  // meter rather than losing voice output entirely.
                  audioGraphRef.current = { el: el, ctx: null, analyser: null }
                }
              }
              setActive(next)
              // Applies whichever preset mode the user last picked
              // (Task/'high' by default, Chat/'off' if they switched) - read
              // fresh from the shared pref, not hardcoded, so a change made
              // last session (in either settings surface) carries over to
              // the next time voice mode starts. presetMode is sent to the
              // host here too (only meaningful while next===true - it stops
              // mattering the moment voice mode goes inactive).
              toggleVoiceModeActive(props.sessionId, next, next ? sharedVoiceModePrefs.presetMode : undefined)
              if (next && props.applyReasoningEffort) props.applyReasoningEffort(sharedVoiceModePrefs.presetMode === 'chat' ? 'off' : 'high')
            },
          },
          React.createElement(
            'svg',
            { 'aria-hidden': 'true', width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none' },
            React.createElement('circle', { cx: '8', cy: '8', r: '6', stroke: 'currentColor', strokeWidth: '1.4' }),
            React.createElement('circle', { cx: '8', cy: '8', r: '2.2', fill: 'currentColor' }),
          ),
        ),
        active
          ? React.createElement(VoiceModeView, {
            session: props.session,
            sessionId: props.sessionId,
            inputActions: props.inputActions,
            audioGraph: audioGraphRef.current,
            applyReasoningEffort: props.applyReasoningEffort,
            cancelSession: props.cancelSession,
            onExit: function () {
              setActive(false)
              toggleVoiceModeActive(props.sessionId, false)
            },
          })
          : null,
      )
    }

    // Which of the 4 independent {endpoint, model, apiKey} slots
    // (config-schema.ts, host side) this form edits, and their on-screen
    // grouping/order. `hasLangCode` is the one field that isn't shared
    // across all 4 (Qwen3-TTS-CustomVoice's own lang_code convention).
    // `pref`/`mode` say which sharedVoiceModePrefs choice ('stt'/'tts' ===
    // 'local'/'cloud') makes this group relevant - VoiceModeEndpointSettings
    // only renders the one group per pref that's actually in use, not all 4
    // at once, so this stays in sync with the dropdowns right above it.
    var VOICE_MODE_ENDPOINT_GROUPS = [
      { key: 'sttLocal', pref: 'stt', mode: 'local', title: 'Speech recognition — local' },
      { key: 'sttCloud', pref: 'stt', mode: 'cloud', title: 'Speech recognition — cloud' },
      { key: 'ttsLocal', pref: 'tts', mode: 'local', title: 'Speech synthesis — local', hasLangCode: true },
      { key: 'ttsCloud', pref: 'tts', mode: 'cloud', title: 'Speech synthesis — cloud (blank endpoint = built-in Edge TTS)' },
    ]

    /**
     * Loads/edits/saves the 4 endpoint groups against the host's
     * /dsh-voice-mode-api/settings route (GET redacted current value +
     * `secrets` sidecar, POST a partial patch - see index.ts's own comment
     * on that route for the exact contract). Deliberately NOT wired through
     * sharedVoiceModePrefs/localStorage: this is per-DEPLOYMENT config (DSH
     * settings, server-side), not a per-browser quick preference.
     */
    function useVoiceModeEndpointSettings() {
      var React = require('react')
      var draftState = React.useState({})
      var draft = draftState[0]
      var setDraft = draftState[1]
      // Only fields the user actually typed THIS visit - never
      // pre-populated from the (redacted) fetch, and only sent to the
      // server if non-empty, per the settings redaction contract (never
      // resend a placeholder for a secret you never received).
      var apiKeyDraftState = React.useState({})
      var apiKeyDraft = apiKeyDraftState[0]
      var setApiKeyDraft = apiKeyDraftState[1]
      var statusState = React.useState('loading')
      var status = statusState[0]
      var setStatus = statusState[1]

      React.useEffect(function () {
        var cancelled = false
        fetch('/dsh-voice-mode-api/settings')
          .then(function (r) { return r.json() })
          .then(function (data) {
            if (cancelled) return
            var nextDraft = {}
            VOICE_MODE_ENDPOINT_GROUPS.forEach(function (g) {
              var v = (data.value && data.value[g.key]) || {}
              nextDraft[g.key] = { endpoint: v.endpoint || '', model: v.model || '', langCode: v.langCode || '' }
            })
            setDraft(nextDraft)
            setStatus('')
          })
          .catch(function (err) { if (!cancelled) setStatus('Failed to load: ' + (err && err.message ? err.message : String(err))) })
        return function () { cancelled = true }
      }, [])

      function updateField(group, field, value) {
        setDraft(function (prev) {
          var next = Object.assign({}, prev)
          next[group] = Object.assign({}, next[group])
          next[group][field] = value
          return next
        })
      }
      function updateApiKeyDraft(group, value) {
        setApiKeyDraft(function (prev) {
          var next = Object.assign({}, prev)
          next[group] = value
          return next
        })
      }
      function save() {
        setStatus('saving')
        var patch = {}
        VOICE_MODE_ENDPOINT_GROUPS.forEach(function (g) {
          var d = draft[g.key] || {}
          var entry = { endpoint: d.endpoint || '', model: d.model || '' }
          if (g.hasLangCode) entry.langCode = d.langCode || ''
          if (apiKeyDraft[g.key]) entry.apiKey = apiKeyDraft[g.key]
          patch[g.key] = entry
        })
        fetch('/dsh-voice-mode-api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(function (r) {
            if (!r.ok) return r.json().then(function (b) { throw new Error((b && b.error) || ('HTTP ' + r.status)) })
            return r.json()
          })
          .then(function () {
            setStatus('Saved.')
            setApiKeyDraft({})
          })
          .catch(function (err) { setStatus('Failed to save: ' + (err && err.message ? err.message : String(err))) })
      }

      return {
        draft: draft, apiKeyDraft: apiKeyDraft, status: status,
        updateField: updateField, updateApiKeyDraft: updateApiKeyDraft, save: save,
      }
    }

    function VoiceModeEndpointSettings() {
      var React = require('react')
      var ctl = useVoiceModeEndpointSettings()
      // Re-render when the STT/TTS dropdowns above change, so the visible
      // group here always tracks the current local/cloud choice instead of
      // showing all 4 (loaded/saved state for the other 2 is untouched -
      // useVoiceModeEndpointSettings still fetches/patches the full set).
      useVoiceModePrefsForce()
      var visibleGroups = VOICE_MODE_ENDPOINT_GROUPS.filter(function (g) {
        return sharedVoiceModePrefs[g.pref] === g.mode
      })
      var GROUP_STYLE = {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px',
        borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)',
      }
      function textRow(labelText, value, onChange, placeholder) {
        return React.createElement(
          'label',
          { style: SETTINGS_LABEL_STYLE },
          labelText,
          React.createElement('input', {
            type: 'text', value: value, placeholder: placeholder || '', onChange: onChange, style: SETTINGS_SELECT_STYLE,
          }),
        )
      }
      var groupRows = visibleGroups.map(function (g) {
        var d = ctl.draft[g.key] || { endpoint: '', model: '', langCode: '' }
        return React.createElement(
          'div',
          { key: g.key, style: GROUP_STYLE },
          React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #9ca3af)' } }, g.title),
          textRow('Endpoint', d.endpoint, function (e) { ctl.updateField(g.key, 'endpoint', e.target.value) }, 'https://...'),
          textRow('Model', d.model, function (e) { ctl.updateField(g.key, 'model', e.target.value) }),
          g.hasLangCode ? textRow('lang_code', d.langCode, function (e) { ctl.updateField(g.key, 'langCode', e.target.value) }) : null,
          // Local voice lives here, not the quick in-call panel - it
          // follows the model, so it belongs next to endpoint/model
          // (localVoiceSelectRow reads/writes sharedVoiceModePrefs.localVoice
          // directly, a per-browser client preference - distinct from this
          // card's own per-deployment endpoint/model/key fields, but shown
          // together since they're conceptually coupled).
          g.key === 'ttsLocal' ? localVoiceSelectRow() : null,
          React.createElement(
            'label',
            { style: SETTINGS_LABEL_STYLE },
            'API key',
            React.createElement('input', {
              type: 'password',
              value: ctl.apiKeyDraft[g.key] || '',
              placeholder: '(leave blank to keep the current key)',
              onChange: function (e) { ctl.updateApiKeyDraft(g.key, e.target.value) },
              style: SETTINGS_SELECT_STYLE,
            }),
          ),
        )
      })
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #6b7280)', lineHeight: 1.5 } },
          "Point local/cloud STT or TTS at your own server instead of the shipped default. Any OpenAI-compatible endpoint works - see this plugin's README for the exact request/response contract."),
        groupRows,
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: ctl.save,
              disabled: ctl.status === 'loading' || ctl.status === 'saving',
              style: {
                padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.2)',
                background: 'var(--dsw-alias-button-info-fill, #2563eb)', color: 'white', cursor: 'pointer', fontSize: '13px',
              },
            },
            'Save',
          ),
          ctl.status ? React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #9ca3af)' } }, ctl.status) : null,
        ),
      )
    }

    // Settings -> Plugins tab (settings.plugins.tab slot) - lets STT/TTS
    // (and, when TTS is 'local', the Qwen3-TTS speaker) be configured
    // BEFORE ever entering voice mode, not just from the in-call gear
    // panel. Same shared store as that panel (useVoiceModePrefsForce keeps
    // this in sync if the other is changed instead), so there's exactly
    // one source of truth regardless of which surface last touched it.
    // The endpoint/model/key editor further down is unrelated per-
    // DEPLOYMENT config (see VoiceModeEndpointSettings's own comment).
    function VoiceModeSettingsPanel() {
      var React = require('react')
      useVoiceModePrefsForce()
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '20px', padding: '4px', maxWidth: '420px' } },
        React.createElement('p', { style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #9ca3af)', lineHeight: 1.5 } },
          'Which backend hands-free voice mode uses for recognition/synthesis. Cloud options work out of the box; local options require the matching local server to already be running, or voice mode will error when used.'),
        prefSelectRow('Speech recognition (STT)', 'stt', 'Cloud', 'Local'),
        prefSelectRow('Speech synthesis (TTS)', 'tts', 'Cloud', 'Local'),
        // Local voice lives inside the ttsLocal card below now (it follows
        // the model, not this STT/TTS/reasoning quick-pref block).
        // No live session here (this is the global Settings page, not a
        // conversation view) - this just sets the preference for the NEXT
        // time voice mode starts; the in-overlay copy of this same row
        // additionally applies to the CURRENT session immediately.
        prefSelectRow('Preset mode', 'presetMode', 'Task', 'Chat (default)', ['task', 'chat']),
        React.createElement('hr', { style: { border: 'none', borderTop: '1px solid rgba(255,255,255,0.12)', margin: 0, width: '100%' } }),
        React.createElement(VoiceModeEndpointSettings, null),
      )
    }

    function apply(ctx) {
      var style = document.createElement('style')
      style.dataset.plugin = 'dsh-voice-mode'
      style.textContent = [
        '.dsh-voice-mode-toggle {',
        '  display: inline-flex; align-items: center; justify-content: center;',
        '  width: 28px; height: 28px; border-radius: 50%; border: none;',
        '  background: transparent; cursor: pointer; padding: 0;',
        '  color: var(--dsw-alias-label-secondary, rgb(97, 102, 107));',
        '  transition: background-color .15s, color .15s;',
        '}',
        '.dsh-voice-mode-toggle:hover { background: var(--dsw-alias-fill-hover, rgba(0,0,0,0.06)); }',
        '.dsh-voice-mode-toggle[data-active="true"] {',
        '  background: var(--dsw-alias-button-info-fill, #2563eb); color: white;',
        '}',
        // Fullscreen view's gear/close buttons - bright/visible at rest
        // (reported: the old always-dim style was hard to spot against the
        // ring's own dark background), dimming to the ORIGINAL subdued
        // style only for the brief :active (pressed) moment as click
        // feedback, same direction dsh's other icon buttons use elsewhere.
        '.dsh-voice-mode-icon-btn {',
        '  background: rgba(255,255,255,0.24); color: var(--dsw-alias-label-primary, #f5f5f7);',
        '  transition: background-color .12s, color .12s;',
        '}',
        '.dsh-voice-mode-icon-btn:active {',
        '  background: var(--dsw-alias-fill-hover, rgba(255,255,255,0.1)); color: var(--dsw-alias-label-secondary, #9ca3af);',
        '}',
      ].join('\n')
      document.head.append(style)

      var attempts = 0
      var timer = setInterval(function () {
        attempts += 1
        var slots
        try { slots = ctx.get ? ctx.get('slots') : undefined } catch (e) { slots = undefined }
        if (!slots) {
          if (attempts >= 100) clearInterval(timer)
          return
        }
        clearInterval(timer)

        slots.inject('conversation.input.left', function* () {
          yield slots.register({
            name: 'conversation.input.left',
            id: 'dsh-voice-mode-toggle',
            order: 25,
            // No custom `input` key here on purpose: every session-scoped
            // 'conversation.input.*' registrant already gets `inputActions`
            // (setDraft/submit/addImages/removeImage/pruneImages) for free
            // via ui-conversation's own sessions.provide({props:
            // ['inputActions']}) standard kit (apply.ts's "input
            // standard-kit provider"). An earlier version of this file built
            // its own via sessions.scope(sessionId)+conversation.input.for(actx)
            // and returned it under a key ALSO named `input` - that
            // silently collided with the standard kit's own reserved
            // `input` prop (bound from its 'input' HOOK - a read-only state
            // snapshot, not the mutation face) and lost the merge, so
            // setDraft/submit ended up undefined at call time despite this
            // plugin's own construction being correct (confirmed by logging
            // it in isolation). applyReasoningEffort and cancelSession both
            // need a custom inject, since 'connection' has no standard-kit
            // entry.
            inject: function (sessionId) {
              var connection = ctx.get('connection')
              return {
                applyReasoningEffort: connection
                  ? function (effort) { setReasoningEffort(connection, sessionId, effort) }
                  : null,
                // Genuinely aborts the session's in-progress turn server-side
                // (connection.api.sessions.cancel -> Agent.cancel() ->
                // AbortController.abort() on the running phase, per
                // deepseek-harness's own agent-loop) - the same RPC the core
                // composer's own stop button calls, just not exposed through
                // inputActions (see VoiceModeView's interruptThinking/
                // interruptPlayback for why voice mode needs this: barging in
                // used to only stop LISTENING for a reply client-side while
                // the abandoned turn kept generating and could finalize late,
                // getting misread as the answer to whatever the user said
                // next).
                cancelSession: connection
                  ? function () {
                    return connection.api.sessions.cancel({ sessionId: sessionId }).catch(function (e) {
                      console.error('[voice-mode] cancelSession failed:', e)
                    })
                  }
                  : null,
              }
            },
          }, ComposerVoiceMode)
        })

        // A `settings.plugins.tab` registrant, given its own id/key/order
        // so it coexists with any other plugin's tab on the same slot.
        slots.inject('settings.plugins.tab', function* () {
          yield slots.register({
            name: 'settings.plugins.tab',
            key: 'voice-mode',
            id: 'voice-mode',
            order: 21,
            label: function () { return 'Voice Mode' },
          }, VoiceModeSettingsPanel)
        })
      }, 100)

      ctx.effect(function () {
        return function () {
          clearInterval(timer)
          style.remove()
        }
      })
    }

    exports.apply = apply
    return module.exports
  },
})
