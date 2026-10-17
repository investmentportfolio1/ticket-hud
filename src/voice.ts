// Speech-to-text for the G2 microphone, using Deepgram's live API.
// Mic audio from the glasses is PCM s16le, 16 kHz, mono, which Deepgram
// accepts directly (encoding=linear16).
// Docs: https://developers.deepgram.com/reference/speech-to-text-api/listen-streaming

export interface Heard {
  text: string // everything heard so far (final + interim)
  done: boolean // the speaker has finished
}

export interface VoiceSession {
  sendPcm(chunk: Uint8Array): void
  /** Stop listening and return the final transcript. */
  finish(): Promise<string>
}

export function startVoice(
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
