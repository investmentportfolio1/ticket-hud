// Ticker HUD: Finnhub watchlist → Even Realities G2.
//
// This page has two faces:
//   • on the phone (inside the Even app) it is the settings screen below;
//   • on the glasses it draws the watchlist through the Even Hub SDK.
// It also works in a normal desktop browser for testing: the settings and
// live preview run, and the glasses part is skipped.

import * as EvenSdk from '@evenrealities/even_hub_sdk'
import { OsEventTypeList, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  FinnhubError,
  fetchQuotes,
  fetchUsMarketOpen,
  parseSymbols,
  safeIntervalSeconds,
  type QuoteResult,
} from './finnhub'
import { GlassesView, pageCount } from './glasses'

// ---------------------------------------------------------------- settings

interface Settings {
  apiKey: string
  tickers: string
  interval: number
}

const STORAGE_KEY = 'tickerhud.settings'
const DEFAULTS: Settings = { apiKey: '', tickers: 'AAPL, NVDA, MSFT, TSLA, AMZN', interval: 15 }

function parseSettings(raw: string | null | undefined): Settings | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw)
    return {
      apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
      tickers: typeof s.tickers === 'string' ? s.tickers : DEFAULTS.tickers,
      interval: Number(s.interval) > 0 ? Number(s.interval) : DEFAULTS.interval,
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

let bridge: EvenAppBridge | null = null
let view: GlassesView | null = null
let settings: Settings = readBrowserStorage() ?? { ...DEFAULTS }

let results: QuoteResult[] = []
let page = 0
let marketOpen: boolean | null = null
let marketCheckedAt = 0
let timer: ReturnType<typeof setTimeout> | null = null
let backoff = 1
let halted = false // set after a rejected key, cleared on save
let inFlight = false

// Keep the page and last quotes when the phone app goes to the background.
// (Guarded so older SDK versions without these helpers still run.)
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const apiKeyInput = $<HTMLInputElement>('apiKey')
const tickersInput = $<HTMLTextAreaElement>('tickers')
const intervalSelect = $<HTMLSelectElement>('interval')
const saveButton = $<HTMLButtonElement>('save')
const toggleKey = $<HTMLButtonElement>('toggleKey')
const statusEl = $<HTMLParagraphElement>('status')
const previewEl = $<HTMLDivElement>('preview')

function fillForm(s: Settings) {
  apiKeyInput.value = s.apiKey
  tickersInput.value = s.tickers
  const opt = [...intervalSelect.options].find(o => Number(o.value) === s.interval)
  intervalSelect.value = opt ? opt.value : String(DEFAULTS.interval)
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

toggleKey.addEventListener('click', () => {
  const show = apiKeyInput.type === 'password'
  apiKeyInput.type = show ? 'text' : 'password'
  toggleKey.textContent = show ? 'Hide' : 'Show'
})

saveButton.addEventListener('click', async () => {
  const symbols = parseSymbols(tickersInput.value)
  const next: Settings = {
    apiKey: apiKeyInput.value.trim(),
    tickers: symbols.join(', '),
    interval: Number(intervalSelect.value) || DEFAULTS.interval,
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

// ---------------------------------------------------------------- refresh loop

function schedule() {
  if (timer) clearTimeout(timer)
  if (halted) return
  const symbols = parseSymbols(settings.tickers)
  const secs = safeIntervalSeconds(settings.interval, symbols.length) * backoff
  timer = setTimeout(() => void refresh(), secs * 1000)
}

async function refresh(): Promise<void> {
  if (inFlight) return
  const symbols = parseSymbols(settings.tickers)

  if (!settings.apiKey || !symbols.length) {
    setStatus('Add your Finnhub key and watchlist, then tap Save.')
    await view?.showMessage('Open Ticker HUD on your phone\nand add your Finnhub API key\nand watchlist.')
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
    await view?.showQuotes(results, page, marketOpen)
  } catch (err) {
    const e = err instanceof FinnhubError ? err : new FinnhubError('network', String(err))
    if (e.kind === 'bad_key') {
      halted = true
      setStatus('Finnhub rejected this API key. Check it and save again.', 'err')
      await view?.showMessage('Finnhub rejected the API key.\nFix it in Ticker HUD on your phone.')
    } else {
      if (e.kind === 'rate_limited') backoff = Math.min(backoff * 2, 8)
      const msg = e.kind === 'rate_limited' ? 'Finnhub rate limit hit, slowing down.' : `${e.message}. Retrying…`
      setStatus(msg, 'err')
      if (results.length) await view?.showQuotes(results, page, marketOpen, true)
      else await view?.showMessage(`${e.message}.\nRetrying shortly.`)
    }
  } finally {
    inFlight = false
    schedule()
  }
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
    const sys = eventTypeOf(event.sysEvent)
    const txt = eventTypeOf(event.textEvent)

    if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || txt === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void b.shutDownPageContainer(1) // system "exit?" dialog
      return
    }

    if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      if (timer) clearTimeout(timer)
      halted = true
      unsubscribe()
      return
    }

    if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      void refresh()
      return
    }

    if (txt === OsEventTypeList.SCROLL_BOTTOM_EVENT || txt === OsEventTypeList.SCROLL_TOP_EVENT) {
      const pages = pageCount(results.length)
      if (pages < 2) return
      const step = txt === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : -1
      page = (page + step + pages) % pages
      void view?.showQuotes(results, page, marketOpen)
      return
    }

    if (sys === OsEventTypeList.CLICK_EVENT || txt === OsEventTypeList.CLICK_EVENT) {
      if (halted) return
      void refresh()
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
