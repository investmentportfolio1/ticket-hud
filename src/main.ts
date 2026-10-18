// Ticker HUD: Finnhub watchlist + voice questions → Even Realities G2.
//
// This page has two faces:
//   • on the phone (inside the Even app) it is the settings screen;
//   • on the glasses it draws the watchlist and answers spoken questions.
// It also works in a normal browser for testing: settings, live preview and
// typed questions run; the glasses part is skipped.

import * as EvenSdk from '@evenrealities/even_hub_sdk'
import { OsEventTypeList, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { MARKET_ZONE, answerQuestion, detectCommand, parseQuestion, resolveSymbol, zoneLabel, type Answer } from './ask'
import {
  FinnhubError,
  fetchQuotes,
  fetchUsMarketOpen,
  parseSymbols,
  safeIntervalSeconds,
  type QuoteResult,
} from './finnhub'
import { GlassesView, pageCount } from './glasses'
import { mountUi } from './ui'
import { startVoice, type VoiceSession } from './voice'

// ---------------------------------------------------------------- settings

interface Settings {
  apiKey: string
  tickers: string
  interval: number
  speechKey: string
  zone: string // time zone that spoken times are in
}

const STORAGE_KEY = 'tickerhud.settings'
const PHONE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || MARKET_ZONE
const DEFAULTS: Settings = {
  apiKey: '',
  tickers: 'AAPL, NVDA, MSFT, TSLA, AMZN',
  interval: 15,
  speechKey: '',
  zone: MARKET_ZONE,
}

function parseSettings(raw: string | null | undefined): Settings | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw)
    return {
      apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
      tickers: typeof s.tickers === 'string' ? s.tickers : DEFAULTS.tickers,
      interval: Number(s.interval) > 0 ? Number(s.interval) : DEFAULTS.interval,
      speechKey: typeof s.speechKey === 'string' ? s.speechKey : '',
      zone: typeof s.zone === 'string' && s.zone ? s.zone : DEFAULTS.zone,
    }
  } catch {
    return null
  }
}

function readBrowserStorage(): Settings | null {
  try {
    return parseSettings(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

async function saveSettings(s: Settings): Promise<void> {
  const raw = JSON.stringify(s)
  try {
    window.localStorage.setItem(STORAGE_KEY, raw)
  } catch {
    /* storage unavailable; the Even app store below is the one that matters */
  }
  if (bridge) await bridge.setLocalStorage(STORAGE_KEY, raw)
}

// ---------------------------------------------------------------- state

type Mode = 'watchlist' | 'listening' | 'thinking' | 'answer'

let bridge: EvenAppBridge | null = null
let view: GlassesView | null = null
let settings: Settings = readBrowserStorage() ?? { ...DEFAULTS }

let mode: Mode = 'watchlist'
let results: QuoteResult[] = []
let page = 0
let marketOpen: boolean | null = null
let marketCheckedAt = 0
let timer: ReturnType<typeof setTimeout> | null = null
let backoff = 1
let halted = false // set after a rejected key, cleared on save
let inFlight = false

// Keep the page and last quotes when the phone app goes to the background.
// (Guarded so SDK versions without these helpers still run.)
const sdk = EvenSdk as unknown as Record<string, unknown>
if (typeof sdk.setBackgroundState === 'function' && typeof sdk.onBackgroundRestore === 'function') {
  const setBg = sdk.setBackgroundState as (k: string, fn: () => object) => void
  const onRestore = sdk.onBackgroundRestore as (k: string, fn: (s: Record<string, unknown>) => void) => void
  setBg('tickerhud', () => ({ page, results, marketOpen }))
  onRestore('tickerhud', saved => {
    if (typeof saved.page === 'number') page = saved.page
    if (Array.isArray(saved.results)) results = saved.results as QuoteResult[]
    if (typeof saved.marketOpen === 'boolean') marketOpen = saved.marketOpen
  })
}

// ---------------------------------------------------------------- phone UI

// Tell the installed shell that the live code loaded.
;(window as unknown as { __tickerhudLoaded?: boolean }).__tickerhudLoaded = true
mountUi()

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const apiKeyInput = $<HTMLInputElement>('apiKey')
const speechKeyInput = $<HTMLInputElement>('speechKey')
const tickersInput = $<HTMLTextAreaElement>('tickers')
const intervalSelect = $<HTMLSelectElement>('interval')
const zoneSelect = $<HTMLSelectElement>('zone')
const saveButton = $<HTMLButtonElement>('save')
const statusEl = $<HTMLParagraphElement>('status')
const previewEl = $<HTMLDivElement>('preview')
const askInput = $<HTMLInputElement>('askInput')
const askButton = $<HTMLButtonElement>('askButton')
const askOut = $<HTMLDivElement>('askOut')

// Time-zone choices: New York (market time) and the phone's own zone.
zoneSelect.innerHTML =
  `<option value="${MARKET_ZONE}">New York (US market time)</option>` +
  (PHONE_ZONE !== MARKET_ZONE ? `<option value="${PHONE_ZONE}">My time (${zoneLabel(PHONE_ZONE)})</option>` : '')

function fillForm(s: Settings) {
  apiKeyInput.value = s.apiKey
  speechKeyInput.value = s.speechKey
  tickersInput.value = s.tickers
  const opt = [...intervalSelect.options].find(o => Number(o.value) === s.interval)
  intervalSelect.value = opt ? opt.value : String(DEFAULTS.interval)
  zoneSelect.value = [...zoneSelect.options].some(o => o.value === s.zone) ? s.zone : MARKET_ZONE
}

function setStatus(msg: string, tone: '' | 'ok' | 'err' = '') {
  statusEl.textContent = msg
  statusEl.className = tone
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function renderPreview() {
  if (!results.length) {
    previewEl.innerHTML = '<p class="empty">Add your key and watchlist to see prices.</p>'
    return
  }
  const rows = results
    .map(r => {
      if (!r.ok) {
        const why = r.reason === 'not_found' ? 'Not found' : 'Error'
        return `<tr><td>${escapeHtml(r.symbol)}</td><td class="num">${why}</td><td class="num"></td></tr>`
      }
      const q = r.quote
      const tone = q.changePct > 0 ? 'up' : q.changePct < 0 ? 'down' : ''
      const sign = q.changePct > 0 ? '+' : ''
      return `<tr><td>${escapeHtml(q.symbol)}</td><td class="num">${q.price.toFixed(q.price < 1 ? 4 : 2)}</td><td class="num ${tone}">${sign}${q.changePct.toFixed(2)}%</td></tr>`
    })
    .join('')
  previewEl.innerHTML = `<table><thead><tr><th>Symbol</th><th class="num">Price</th><th class="num">Day</th></tr></thead><tbody>${rows}</tbody></table>`
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-toggle]')) {
  btn.addEventListener('click', () => {
    const input = $<HTMLInputElement>(btn.dataset.toggle!)
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    btn.textContent = show ? 'Hide' : 'Show'
  })
}

saveButton.addEventListener('click', async () => {
  const symbols = parseSymbols(tickersInput.value)
  const next: Settings = {
    apiKey: apiKeyInput.value.trim(),
    speechKey: speechKeyInput.value.trim(),
    tickers: symbols.join(', '),
    interval: Number(intervalSelect.value) || DEFAULTS.interval,
    zone: zoneSelect.value || MARKET_ZONE,
  }
  if (!next.apiKey) return setStatus('Paste your Finnhub API key first.', 'err')
  if (!symbols.length) return setStatus('Add at least one ticker.', 'err')

  saveButton.disabled = true
  setStatus('Saving…')
  try {
    settings = next
    tickersInput.value = next.tickers
    await saveSettings(next)
    halted = false
    backoff = 1
    results = []
    page = 0
    marketCheckedAt = 0
    await refresh()
  } finally {
    saveButton.disabled = false
  }
})

// Spoken/typed commands: "show my watchlist", "add AMD to my watchlist", "remove Tesla from my watchlist".
// Returns 'watchlist' to switch to the live list, an Answer to show, or null if it isn't a command.
async function runCommand(text: string): Promise<'watchlist' | Answer | null> {
  const cmd = detectCommand(text)
  if (!cmd) return null
  if (cmd.kind === 'show_watchlist') return 'watchlist'

  const watch = parseSymbols(settings.tickers)
  const q = parseQuestion(cmd.phrase, { watchlist: watch, zone: settings.zone })
  const found = await resolveSymbol(q, settings.apiKey)
  if (!found) return { header: 'WATCHLIST', body: `Couldn't tell which stock "${cmd.phrase}" is.` }
  const sym = found.symbol

  let next = watch
  let msg: string
  if (cmd.kind === 'add') {
    if (watch.includes(sym)) msg = `${sym} is already on your watchlist.`
    else if (watch.length >= 30) msg = 'Your watchlist is full (30 stocks).'
    else {
      next = [...watch, sym]
      msg = `Added ${sym}${found.name ? ' (' + found.name + ')' : ''}.`
    }
  } else {
    if (!watch.includes(sym)) msg = `${sym} isn't on your watchlist.`
    else {
      next = watch.filter(s => s !== sym)
      msg = `Removed ${sym}.`
    }
  }
  if (next !== watch) {
    settings = { ...settings, tickers: next.join(', ') }
    fillForm(settings)
    await saveSettings(settings)
    marketCheckedAt = 0
    void refresh()
  }
  return { header: 'WATCHLIST', body: `${msg}\nNow watching: ${next.join(', ') || 'nothing'}` }
}

// Typed questions: same brain as the voice feature, handy for testing.
async function askTyped() {
  const q = askInput.value.trim()
  if (!q) return
  if (!settings.apiKey) {
    askOut.innerHTML = '<p class="err-text">Save your Finnhub key first.</p>'
    return
  }
  askButton.disabled = true
  askOut.innerHTML = '<p class="empty">Looking up…</p>'
  try {
    const cmd = await runCommand(q)
    if (cmd === 'watchlist') {
      askOut.innerHTML = '<p class="empty">On the glasses this shows your live watchlist (see the preview above).</p>'
      return
    }
    const a = cmd ?? (await answerQuestion(q, { apiKey: settings.apiKey, watchlist: parseSymbols(settings.tickers), zone: settings.zone }))
    const pages = [a.body, ...(a.more ?? [])]
    askOut.innerHTML =
      `<p class="answer-head">${escapeHtml(a.header.replace(/ {2}· swipe for (more|headlines)/, ''))}</p>` +
      pages.map(p => `<p class="answer-body">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('<hr>')
  } catch (err) {
    askOut.innerHTML = `<p class="err-text">${escapeHtml(errorText(err))}</p>`
  } finally {
    askButton.disabled = false
  }
}
askButton.addEventListener('click', () => void askTyped())
askInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') void askTyped()
})

function errorText(err: unknown): string {
  if (err instanceof FinnhubError) {
    if (err.kind === 'bad_key') return 'Finnhub rejected the API key.'
    if (err.kind === 'rate_limited') return 'Finnhub rate limit hit. Try again in a minute.'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------- watchlist loop

function schedule() {
  if (timer) clearTimeout(timer)
  if (halted) return
  const symbols = parseSymbols(settings.tickers)
  const secs = safeIntervalSeconds(settings.interval, symbols.length) * backoff
  timer = setTimeout(() => void refresh(), secs * 1000)
}

function drawWatchlist(stale = false) {
  if (mode !== 'watchlist' || !view) return
  if (results.length) void view.showQuotes(results, page, marketOpen, stale)
}

async function refresh(): Promise<void> {
  if (inFlight) return
  const symbols = parseSymbols(settings.tickers)

  if (!settings.apiKey || !symbols.length) {
    setStatus('Add your Finnhub key and watchlist, then tap Save.')
    if (mode === 'watchlist') await view?.showMessage('Open Ticker HUD on your phone\nand add your Finnhub API key\nand watchlist.')
    return
  }

  inFlight = true
  try {
    if (Date.now() - marketCheckedAt > 5 * 60_000) {
      marketOpen = await fetchUsMarketOpen(settings.apiKey)
      marketCheckedAt = Date.now()
    }
    results = await fetchQuotes(symbols, settings.apiKey)
    backoff = 1
    page = Math.min(page, pageCount(results.length) - 1)
    const found = results.filter(r => r.ok).length
    const missing = results.length - found
    setStatus(
      `Updated ${new Date().toLocaleTimeString()} · ${found} quote${found === 1 ? '' : 's'}` +
        (missing ? ` · ${missing} not found` : ''),
      'ok',
    )
    renderPreview()
    drawWatchlist()
  } catch (err) {
    const e = err instanceof FinnhubError ? err : new FinnhubError('network', String(err))
    if (e.kind === 'bad_key') {
      halted = true
      setStatus('Finnhub rejected this API key. Check it and save again.', 'err')
      if (mode === 'watchlist') await view?.showMessage('Finnhub rejected the API key.\nFix it in Ticker HUD on your phone.')
    } else {
      if (e.kind === 'rate_limited') backoff = Math.min(backoff * 2, 8)
      const msg = e.kind === 'rate_limited' ? 'Finnhub rate limit hit, slowing down.' : `${e.message}. Retrying…`
      setStatus(msg, 'err')
      if (results.length) drawWatchlist(true)
      else if (mode === 'watchlist') await view?.showMessage(`${e.message}.\nRetrying shortly.`)
    }
  } finally {
    inFlight = false
    schedule()
  }
}

// ---------------------------------------------------------------- voice questions

const EXAMPLES = 'e.g. "show my watchlist"  "Apple price"\n"Nvidia on March 3 at 2 PM"\n"market news"  "Tesla earnings"\n"what did the Fed do"  "how is the market"'
const MAX_LISTEN_MS = 15_000

let voice: VoiceSession | null = null
let answerHeader = ''
let answerPages: string[] = []
let answerPage = 0

function showAnswerPage() {
  const total = answerPages.length
  const hint = total > 1
    ? `\n\n${answerPage + 1}/${total} · swipe for more · tap to ask`
    : '\n\nTap: ask again · Swipe: watchlist'
  void view?.showMessage(answerPages[answerPage] + hint, answerHeader)
}

/** Swipe on an answer: move between its screens, and past either end back to the watchlist. */
function swipeAnswer(step: 1 | -1) {
  const next = answerPage + step
  if (next < 0 || next >= answerPages.length) {
    backToWatchlist()
    return
  }
  answerPage = next
  showAnswerPage()
}
let listenTimer: ReturnType<typeof setTimeout> | null = null
let lastHeard = ''
let heardDrawTimer: ReturnType<typeof setTimeout> | null = null

async function startListening() {
  if (!bridge || !view) return
  if (!settings.apiKey) {
    mode = 'answer'
    await view.showMessage('Add your Finnhub key in Ticker HUD\non your phone first.', 'ASK A QUESTION')
    return
  }
  if (!settings.speechKey) {
    mode = 'answer'
    await view.showMessage(
      'To ask by voice, add an ElevenLabs or Deepgram\nspeech key in Ticker HUD settings on your phone.',
      'ASK A QUESTION',
    )
    return
  }

  mode = 'listening'
  lastHeard = ''
  await view.showMessage(`Listening…\n\n${EXAMPLES}`, 'ASK A QUESTION  ·  tap when done')

  const hints = parseSymbols(settings.tickers)
  try {
    voice = await startVoice(
      settings.speechKey,
      hints,
      heard => {
        if (mode !== 'listening') return
        lastHeard = heard.text
        if (heard.done) {
          void stopListeningAndAnswer()
          return
        }
        // Throttle display writes; the Bluetooth link is slow.
        if (!heardDrawTimer) {
          heardDrawTimer = setTimeout(() => {
            heardDrawTimer = null
            if (mode === 'listening') void view?.showMessage(`"${lastHeard}"`, 'LISTENING  ·  tap when done')
          }, 200)
        }
      },
      msg => {
        if (mode === 'listening') void stopListeningAndAnswer(msg)
      },
    )
  } catch (err) {
    mode = 'answer'
    await view.showMessage(errorText(err), "COULDN'T LISTEN")
    return
  }

  if (mode !== 'listening') {
    // user tapped/cancelled while connecting
    void voice.finish()
    voice = null
    return
  }
  await bridge.audioControl(true)
  listenTimer = setTimeout(() => void stopListeningAndAnswer(), MAX_LISTEN_MS)
}

async function stopListeningAndAnswer(problem?: string) {
  if (mode !== 'listening') return
  mode = 'thinking'
  if (listenTimer) clearTimeout(listenTimer)
  listenTimer = null
  if (heardDrawTimer) clearTimeout(heardDrawTimer)
  heardDrawTimer = null
  await bridge?.audioControl(false)

  const session = voice
  voice = null
  const text = ((session ? await session.finish() : '') || lastHeard).trim()

  if (!text) {
    mode = 'answer'
    await view?.showMessage(
      `${problem ? problem + '\n' : ''}I didn't catch that. Tap to try again.\n\n${EXAMPLES}`,
      'ASK A QUESTION',
    )
    return
  }

  try {
    const cmd = await runCommand(text)
    if (cmd === 'watchlist') {
      backToWatchlist()
      return
    }
    if (!cmd) await view?.showMessage(`"${text}"\n\nLooking up…`, 'ASK A QUESTION')
    const a = cmd ?? await answerQuestion(text, {
      apiKey: settings.apiKey,
      watchlist: parseSymbols(settings.tickers),
      zone: settings.zone,
    })
    mode = 'answer'
    answerHeader = a.header
    answerPages = [a.body, ...(a.more ?? [])]
    answerPage = 0
    showAnswerPage()
  } catch (err) {
    mode = 'answer'
    await view?.showMessage(`${errorText(err)}\n\nTap to try again.`, 'ASK A QUESTION')
  }
}

function backToWatchlist() {
  mode = 'watchlist'
  if (results.length) drawWatchlist()
  else void refresh()
}

// ---------------------------------------------------------------- glasses input

// CLICK_EVENT is 0 and protobuf drops zero values, so a tap arrives with
// eventType undefined. Resolve the default only when the envelope exists.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function attachInput(b: EvenAppBridge) {
  const unsubscribe = b.onEvenHubEvent(event => {
    // Microphone audio arrives on its own envelope.
    const pcm = event.audioEvent?.audioPcm
    if (pcm) {
      voice?.sendPcm(pcm)
      return
    }

    const sys = eventTypeOf(event.sysEvent)
    const txt = eventTypeOf(event.textEvent)

    if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || txt === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void b.shutDownPageContainer(1) // system "exit?" dialog
      return
    }

    if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      if (timer) clearTimeout(timer)
      halted = true
      if (voice) void voice.finish()
      void b.audioControl(false)
      unsubscribe()
      return
    }

    if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      void refresh()
      return
    }

    if (txt === OsEventTypeList.SCROLL_BOTTOM_EVENT || txt === OsEventTypeList.SCROLL_TOP_EVENT) {
      if (mode === 'answer') {
        swipeAnswer(txt === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : -1)
        return
      }
      if (mode !== 'watchlist') return
      const pages = pageCount(results.length)
      if (pages < 2) return
      const step = txt === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : -1
      page = (page + step + pages) % pages
      drawWatchlist()
      return
    }

    if (sys === OsEventTypeList.CLICK_EVENT || txt === OsEventTypeList.CLICK_EVENT) {
      if (mode === 'listening') void stopListeningAndAnswer()
      else if (mode === 'watchlist' || mode === 'answer') void startListening()
    }
  })
}

// ---------------------------------------------------------------- boot

async function connectBridge(timeoutMs: number): Promise<EvenAppBridge | null> {
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs))
  try {
    return await Promise.race([waitForEvenAppBridge(), timeout])
  } catch {
    return null
  }
}

async function boot() {
  fillForm(settings)
  renderPreview()

  bridge = await connectBridge(5000)
  if (bridge) {
    const glasses = new GlassesView(bridge)
    if (await glasses.start()) view = glasses
    else setStatus('Could not open the glasses display. Try reopening the app.', 'err')

    // Settings saved in the Even app win over the browser copy.
    const stored = parseSettings(await bridge.getLocalStorage(STORAGE_KEY))
    if (stored) {
      settings = stored
      fillForm(settings)
    }
    attachInput(bridge)
  } else {
    setStatus('Glasses not connected. Preview only (open this inside the Even app for the HUD).')
  }

  await refresh()
}

void boot()
