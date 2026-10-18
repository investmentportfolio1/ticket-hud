// Speech-to-text for the G2 microphone. Works with either service:
//   • ElevenLabs Scribe (keys start with "sk_")
//     https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
//   • Deepgram live streaming
//     https://developers.deepgram.com/reference/speech-to-text-api/listen-streaming
// Mic audio from the glasses is PCM s16le, 16 kHz, mono; both accept it directly.

export interface Heard {
  text: string // everything heard so far (final + interim)
  done: boolean // the speaker has finished
}

export interface VoiceSession {
  sendPcm(chunk: Uint8Array): void
  /** Stop listening and return the final transcript. */
  finish(): Promise<string>
}

/** Which speech service a key belongs to. */
export function speechProvider(key: string): 'elevenlabs' | 'deepgram' {
  return key.trim().startsWith('sk_') ? 'elevenlabs' : 'deepgram'
}

export function startVoice(
  apiKey: string,
  hints: string[],
  onHeard: (h: Heard) => void,
  onError: (msg: string) => void,
): Promise<VoiceSession> {
  return speechProvider(apiKey) === 'elevenlabs'
    ? startElevenLabs(apiKey, hints, onHeard, onError)
    : startDeepgram(apiKey, hints, onHeard, onError)
}

function startDeepgram(
  apiKey: string,
  hints: string[],
  onHeard: (h: Heard) => void,
  onError: (msg: string) => void,
): Promise<VoiceSession> {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '400',
    utterance_end_ms: '1200',
    vad_events: 'true',
  })
  // Help recognition of tickers and company names in the watchlist.
  for (const h of hints.slice(0, 20)) params.append('keyterm', h)

  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try {
      // Browsers can't set headers on WebSockets; Deepgram accepts the key as a subprotocol.
      ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', apiKey])
    } catch {
      reject(new Error("Couldn't start speech recognition"))
      return
    }
    ws.binaryType = 'arraybuffer'

    let finalText = ''
    let interim = ''
    let opened = false
    let closed = false
    let finishResolve: ((t: string) => void) | null = null

    const current = () => (finalText + ' ' + interim).replace(/\s+/g, ' ').trim()

    const settle = () => {
      if (finishResolve) {
        const r = finishResolve
        finishResolve = null
        r(current())
      }
    }

    ws.onopen = () => {
      opened = true
      resolve(session)
    }

    ws.onerror = () => {
      if (!opened) reject(new Error('Speech service rejected the connection (check the Deepgram key)'))
      else onError('Speech connection lost')
    }

    ws.onclose = () => {
      closed = true
      if (!opened) reject(new Error('Speech service rejected the connection (check the Deepgram key)'))
      settle()
    }

    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return
      let msg: any
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'Results') {
        const text: string = msg.channel?.alternatives?.[0]?.transcript ?? ''
        if (msg.is_final) {
          if (text) finalText += ' ' + text
          interim = ''
        } else {
          interim = text
        }
        const done = Boolean(msg.speech_final) && current().length > 0
        onHeard({ text: current(), done })
      } else if (msg.type === 'UtteranceEnd') {
        if (current()) onHeard({ text: current(), done: true })
      }
    }

    const session: VoiceSession = {
      sendPcm(chunk) {
        if (!closed && ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(chunk))
      },
      finish() {
        return new Promise<string>(res => {
          if (closed) return res(current())
          finishResolve = res
          try {
            ws.send(JSON.stringify({ type: 'CloseStream' }))
          } catch {
            /* already closing */
          }
          // Don't wait forever for the last words.
          setTimeout(() => {
            settle()
            try {
              ws.close()
            } catch {
              /* ignore */
            }
          }, 1500)
        })
      },
    }
  })
}

// ------------------------------------------------------------------ ElevenLabs

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

async function startElevenLabs(
  apiKey: string,
  hints: string[],
  onHeard: (h: Heard) => void,
  onError: (msg: string) => void,
): Promise<VoiceSession> {
  // A browser can't send the API key on a WebSocket, so first trade it for a
  // single-use token (valid 15 minutes, consumed on connect).
  let token: string
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey.trim() },
    })
    if (res.status === 401 || res.status === 403) throw new Error('ElevenLabs rejected the speech key')
    if (!res.ok) throw new Error(`ElevenLabs error ${res.status}`)
    token = String((await res.json()).token ?? '')
    if (!token) throw new Error('ElevenLabs gave no token')
  } catch (err) {
    throw err instanceof Error && err.message.startsWith('ElevenLabs')
      ? err
      : new Error("Can't reach ElevenLabs")
  }

  const params = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    token,
    audio_format: 'pcm_16000',
    language_code: 'en',
    commit_strategy: 'vad', // ElevenLabs decides when you've stopped talking
    vad_silence_threshold_secs: '1.0',
  })
  for (const h of hints.slice(0, 20)) params.append('keyterms', h)

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`)
    let committed = ''
    let partial = ''
    let opened = false
    let closed = false
    let finishResolve: ((t: string) => void) | null = null
    const current = () => (committed + ' ' + partial).replace(/\s+/g, ' ').trim()
    const settle = () => {
      if (finishResolve) {
        const r = finishResolve
        finishResolve = null
        r(current())
      }
    }

    ws.onopen = () => {
      opened = true
      resolve(session)
    }
    ws.onerror = () => {
      if (!opened) reject(new Error('ElevenLabs rejected the connection (check the speech key)'))
      else onError('Speech connection lost')
    }
    ws.onclose = () => {
      closed = true
      if (!opened) reject(new Error('ElevenLabs rejected the connection (check the speech key)'))
      settle()
    }
    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return
      let msg: any
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      const type = String(msg.message_type ?? '')
      if (type === 'partial_transcript') {
        partial = String(msg.text ?? '')
        onHeard({ text: current(), done: false })
      } else if (type === 'committed_transcript') {
        const text = String(msg.text ?? '').trim()
        if (text) committed += ' ' + text
        partial = ''
        if (current()) onHeard({ text: current(), done: true })
      } else if (/error/i.test(type) || type === 'rate_limited') {
        onError(String(msg.error ?? msg.message ?? 'Speech service error'))
      }
    }

    const session: VoiceSession = {
      sendPcm(chunk) {
        if (closed || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: toBase64(chunk) }))
      },
      finish() {
        return new Promise<string>(res => {
          if (closed) return res(current())
          finishResolve = res
          try {
            // Flush whatever was said so far.
            ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true }))
          } catch {
            /* already closing */
          }
          setTimeout(() => {
            settle()
            try {
              ws.close()
            } catch {
              /* ignore */
            }
          }, 1500)
        })
      },
    }
  })
}
