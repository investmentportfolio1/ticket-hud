// Turns a spoken question into a price lookup.
//
// Understands questions like:
//   "what's Apple's price"                       → live quote
//   "how is Nvidia doing today"                  → live quote + day change
//   "Tesla high today"                           → today's high
//   "price of AAPL on March 3rd at 2 PM"          → price at that minute
//   "Microsoft close yesterday"                   → that day's close
//   "Amazon at the open last Friday"              → that day's opening price
//   "A A P L on 3/10/2025 at 14:30"
//
// No AI involved: the parser picks out the stock, the date, the time and
// what you want (price / open / close / high / low), then asks Finnhub.

import { FinnhubError, fetchCandles, fetchQuote, searchSymbol } from './finnhub'
import {
  TOPIC_WORDS,
  companyEarnings,
  companyNews,
  detectTopic,
  earningsCalendar,
  fedNews,
  marketNews,
  marketOverview,
  type Answer,
} from './news'

export type { Answer }

export type Metric = 'price' | 'open' | 'close' | 'high' | 'low'

export interface ParsedQuestion {
  symbol: string | null
  searchPhrase: string | null // company words to look up if no ticker was recognised
  date: { y: number; m: number; d: number } | null // calendar date in `zone`
  time: { h: number; min: number } | null
  metric: Metric
}


// ------------------------------------------------------------------ names

// Common names people say out loud → ticker. Finnhub search covers the rest.
const NAMES: Record<string, string> = {
  apple: 'AAPL', microsoft: 'MSFT', nvidia: 'NVDA', 'n video': 'NVDA', amazon: 'AMZN',
  google: 'GOOGL', alphabet: 'GOOGL', meta: 'META', facebook: 'META', tesla: 'TSLA',
  netflix: 'NFLX', amd: 'AMD', 'advanced micro devices': 'AMD', intel: 'INTC',
  broadcom: 'AVGO', oracle: 'ORCL', salesforce: 'CRM', adobe: 'ADBE', ibm: 'IBM',
  qualcomm: 'QCOM', 'palantir': 'PLTR', uber: 'UBER', airbnb: 'ABNB', paypal: 'PYPL',
  shopify: 'SHOP', spotify: 'SPOT', coinbase: 'COIN', 'micro strategy': 'MSTR',
  microstrategy: 'MSTR', strategy: 'MSTR', berkshire: 'BRK.B', 'berkshire hathaway': 'BRK.B',
  'jp morgan': 'JPM', jpmorgan: 'JPM', 'goldman sachs': 'GS', 'bank of america': 'BAC',
  visa: 'V', mastercard: 'MA', walmart: 'WMT', costco: 'COST', disney: 'DIS',
  'coca cola': 'KO', coke: 'KO', pepsi: 'PEP', pepsico: 'PEP', mcdonalds: 'MCD',
  "mcdonald's": 'MCD', nike: 'NKE', starbucks: 'SBUX', boeing: 'BA', exxon: 'XOM',
  'exxon mobil': 'XOM', chevron: 'CVX', pfizer: 'PFE', 'johnson and johnson': 'JNJ',
  'eli lilly': 'LLY', lilly: 'LLY', 'novo nordisk': 'NVO', 'unitedhealth': 'UNH',
  'super micro': 'SMCI', supermicro: 'SMCI', arm: 'ARM', tsmc: 'TSM', 'taiwan semiconductor': 'TSM',
  'asml': 'ASML', 'snowflake': 'SNOW', 'crowdstrike': 'CRWD', 'rivian': 'RIVN', 'lucid': 'LCID',
  's and p': 'SPY', 's&p': 'SPY', 's&p 500': 'SPY', 's and p 500': 'SPY', spy: 'SPY',
  nasdaq: 'QQQ', qqq: 'QQQ', 'dow jones': 'DIA', dow: 'DIA',
}

// Words that are never the company name.
const STOP = new Set(
  (
    'what whats what\'s is was were the a an of for on at in to me tell show give price prices ' +
    'stock stocks share shares cost costs trading trade traded worth value how hows how\'s doing ' +
    'did does do today yesterday now current currently right please and with from it its ' +
    'open opening opened close closing closed high highest low lowest am pm a.m. p.m. ' +
    'last this ago days day week noon midnight morning afternoon evening time date ' +
    'january february march april may june july august september october november december ' +
    'jan feb mar apr jun jul aug sep sept oct nov dec ' +
    'monday tuesday wednesday thursday friday saturday sunday hey okay ok um uh so like ' +
    'i my me you good best buy sell should would could can market up down weeks ' +
    TOPIC_WORDS
  ).split(/\s+/),
)

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, 'twenty first': 21, 'twenty second': 22, 'twenty third': 23,
  'twenty fourth': 24, 'twenty fifth': 25, 'twenty sixth': 26, 'twenty seventh': 27,
  'twenty eighth': 28, 'twenty ninth': 29, thirtieth: 30, 'thirty first': 31,
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12,
}

// ------------------------------------------------------------------ time zones

export const MARKET_ZONE = 'America/New_York'

/** Calendar parts of `epochMs` as seen in `zone`. */
export function partsInZone(epochMs: number, zone: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', weekday: 'short',
  })
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(new Date(epochMs))) p[part.type] = part.value
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    h: Number(p.hour), min: Number(p.minute), s: Number(p.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  }
}

/** Epoch ms for a wall-clock time in `zone` (handles daylight saving). */
export function zonedToEpoch(y: number, m: number, d: number, h: number, min: number, zone: string): number {
  const asUtc = Date.UTC(y, m - 1, d, h, min)
  let guess = asUtc
  for (let i = 0; i < 2; i++) {
    const p = partsInZone(guess, zone)
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s)
    guess += asUtc - seen
  }
  return guess
}

function addDays(date: { y: number; m: number; d: number }, n: number) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d) + n * 86_400_000)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

function weekdayOf(date: { y: number; m: number; d: number }): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()
}

// ------------------------------------------------------------------ parser

function normalize(text: string): string {
  let t = ' ' + text.toLowerCase().replace(/[“”"!?,]/g, ' ').replace(/\s+/g, ' ') + ' '
  t = t.replace(/\ba\.m\./g, 'am').replace(/\bp\.m\./g, 'pm')
  // multi-word ordinals first ("twenty third" before "third")
  for (const [w, n] of Object.entries(ORDINAL_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n))
  }
  t = t.replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, '$1')
  return t
}

function findSpelledTicker(original: string): string | null {
  // "A A P L", "A.A.P.L.", "a-a-p-l"
  const m = original.match(/\b([A-Za-z])(?:[\s.\-]+([A-Za-z])){1,4}\b\.?/g)
  if (!m) return null
  for (const chunk of m) {
    const letters = chunk.replace(/[^A-Za-z]/g, '')
    const spaced = chunk.trim().split(/[\s.\-]+/).filter(Boolean)
    if (letters.length >= 3 && letters.length <= 5 && spaced.every(s => s.length === 1)) {
      return letters.toUpperCase()
    }
  }
  return null
}

export function parseQuestion(
  text: string,
  opts: { watchlist: string[]; zone: string; now?: number },
): ParsedQuestion {
  const now = opts.now ?? Date.now()
  const t = normalize(text)
  const today = partsInZone(now, opts.zone)
  const todayDate = { y: today.y, m: today.m, d: today.d }

  // ---- metric
  let metric: Metric = 'price'
  if (/\b(high|highest|peak)\b/.test(t)) metric = 'high'
  else if (/\b(low|lowest|bottom)\b/.test(t)) metric = 'low'
  else if (/\b(close|closing|closed|close price|end of (the )?day)\b/.test(t)) metric = 'close'
  else if (/\b(open|opening|opened)\b/.test(t)) metric = 'open'

  // ---- time
  let time: ParsedQuestion['time'] = null
  let tm: RegExpMatchArray | null
  if ((tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/))) {
    let h = Number(tm[1]) % 12
    if (tm[3] === 'pm') h += 12
    time = { h, min: Number(tm[2] ?? 0) }
  } else if ((tm = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/))) {
    time = { h: Number(tm[1]), min: Number(tm[2]) }
  } else if ((tm = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(am|pm|o'?clock)\b/))) {
    let h = NUMBER_WORDS[tm[1]] % 12
    if (tm[2] === 'pm' || (tm[2].startsWith('o') && h < 8)) h += 12
    time = { h, min: 0 }
  } else if (/\bnoon\b/.test(t)) {
    time = { h: 12, min: 0 }
  } else if (/\bat (the )?(open|opening|market open)\b/.test(t)) {
    metric = 'open'
  } else if (/\bat (the )?(close|closing|market close)\b/.test(t)) {
    metric = 'close'
  }

  // ---- date
  let date: ParsedQuestion['date'] = null
  let dm: RegExpMatchArray | null
  const monthNames = Object.keys(MONTHS).join('|')
  if (/\byesterday\b/.test(t)) date = addDays(todayDate, -1)
  else if (/\btoday\b/.test(t)) date = todayDate
  else if ((dm = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a) (days?|weeks?) ago\b/))) {
    const n = dm[1] === 'a' ? 1 : (NUMBER_WORDS[dm[1]] ?? Number(dm[1]))
    date = addDays(todayDate, -n * (dm[2].startsWith('week') ? 7 : 1))
  }
  else if ((dm = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) date = { y: +dm[1], m: +dm[2], d: +dm[3] }
  else if ((dm = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    // US style month/day[/year]
    const y = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : today.y
    date = { y, m: +dm[1], d: +dm[2] }
    if (!dm[3] && Date.UTC(y, date.m - 1, date.d) > Date.UTC(today.y, today.m - 1, today.d)) date.y -= 1
  } else if (
    (dm = t.match(new RegExp(`\\b(${monthNames})\\.? (\\d{1,2})(?: (\\d{4}))?\\b`))) ||
    (dm = t.match(new RegExp(`\\b(\\d{1,2}) (?:of )?(${monthNames})\\.?(?: (\\d{4}))?\\b`)))
  ) {
    const monthFirst = isNaN(Number(dm[1]))
    const m = MONTHS[monthFirst ? dm[1] : dm[2]]
    const d = Number(monthFirst ? dm[2] : dm[1])
    let y = dm[3] ? Number(dm[3]) : today.y
    if (!dm[3] && Date.UTC(y, m - 1, d) > Date.UTC(today.y, today.m - 1, today.d)) y -= 1
    date = { y, m, d }
  } else if ((dm = t.match(new RegExp(`\\b(last |on |this )?(${WEEKDAYS.join('|')})\\b`)))) {
    const target = WEEKDAYS.indexOf(dm[2])
    let back = (weekdayOf(todayDate) - target + 7) % 7
    if (back === 0 && dm[1]?.trim() === 'last') back = 7
    date = addDays(todayDate, -back)
  } else if (/\blast week\b/.test(t)) {
    date = addDays(todayDate, -7)
  }
  if (time && !date) date = todayDate

  // ---- symbol
  let symbol: string | null = findSpelledTicker(text)
  if (!symbol) {
    // ticker said as a word that is in the watchlist ("show me nvda")
    for (const s of opts.watchlist.filter(w => w.length >= 2)) {
      if (new RegExp(`\\b${s.toLowerCase().replace('.', '\\.')}\\b`).test(t)) {
        symbol = s
        break
      }
    }
  }
  if (!symbol) {
    for (const [name, sym] of Object.entries(NAMES).sort((a, b) => b[0].length - a[0].length)) {
      const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\b${n}(?:'s|s)?\\b`).test(t)) {
        symbol = sym
        break
      }
    }
  }
  if (!symbol) {
    // An all-caps word in the raw transcript is probably a ticker ("is TSLA up").
    const caps = text.match(/\b[A-Z]{2,5}\b/g)?.filter(w => !['AM', 'PM', 'ET', 'OK', 'US'].includes(w))
    if (caps?.length) symbol = caps[0]
  }

  // Leftover non-stop-words become a company-name search ("Rocket Lab").
  let searchPhrase: string | null = null
  if (!symbol) {
    const words = t
      .replace(/[^a-z0-9&' ]/g, ' ')
      .split(/\s+/)
      .filter(w => w && !STOP.has(w) && !/^\d+$/.test(w))
      .map(w => w.replace(/'s$/, ''))
    if (words.length) searchPhrase = words.slice(0, 3).join(' ')
  }

  return { symbol, searchPhrase, date, time, metric }
}

// ------------------------------------------------------------------ answering

function money(p: number): string {
  const digits = p < 1 ? 4 : 2
  return '$' + p.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function pct(v: number): string {
  const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '–'
  return `${arrow} ${v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dateLabel(date: { y: number; m: number; d: number }): string {
  return `${DAY_ABBR[weekdayOf(date)]} ${MONTH_ABBR[date.m - 1]} ${date.d}, ${date.y}`
}

function timeLabel(h: number, min: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(min).padStart(2, '0')} ${ampm}`
}

export function zoneLabel(zone: string): string {
  if (zone === MARKET_ZONE) return 'New York'
  return zone.split('/').pop()!.replace(/_/g, ' ')
}

const HELP =
  'Try: "Apple price", "Nvidia on March 3 at 2 PM",\n"market news", "Tesla earnings", "what did the Fed do",\n"how is the market", "earnings this week"'

export async function answerQuestion(
  text: string,
  opts: { apiKey: string; watchlist: string[]; zone: string; now?: number },
): Promise<Answer> {
  const now = opts.now ?? Date.now()
  const q = parseQuestion(text, opts)
  const topic = detectTopic(text)

  // Questions that don't need a specific stock.
  if (topic === 'fed') return fedNews(opts.apiKey, now)
  if (topic === 'market' && !q.symbol) return marketOverview(opts.apiKey, now)

  let symbol = q.symbol
  let name = ''
  if (!symbol && q.searchPhrase) {
    const hit = await searchSymbol(q.searchPhrase, opts.apiKey).catch(() => null)
    // Only trust the search if the company name actually matches what was said.
    const words = q.searchPhrase.split(' ').filter(w => w.length > 2)
    const plausible =
      hit &&
      (hit.symbol.toLowerCase() === q.searchPhrase.replace(/\s/g, '') ||
        words.some(w => hit.name.toLowerCase().includes(w)))
    if (hit && plausible) {
      symbol = hit.symbol
      name = hit.name
    }
  }
  if (topic === 'news') return symbol ? companyNews(symbol, opts.apiKey, now) : marketNews(opts.apiKey, now)
  if (topic === 'earnings') {
    return symbol
      ? companyEarnings(symbol, opts.apiKey, now)
      : earningsCalendar(text, opts.watchlist, opts.apiKey, now)
  }

  if (!symbol) {
    return { header: 'NOT SURE WHAT TO LOOK UP', body: `I heard: "${text}"\n\n${HELP}` }
  }

  // ---- live quote (no date, or today without a time and not asking for a close)
  const isToday = q.date && (() => {
    const p = partsInZone(now, opts.zone)
    return q.date!.y === p.y && q.date!.m === p.m && q.date!.d === p.d
  })()
  if (!q.date || (isToday && !q.time)) {
    const r = await fetchQuote(symbol, opts.apiKey)
    if (!r.ok) return { header: symbol, body: `Couldn't find a price for ${symbol}.\n\n${HELP}` }
    const x = r.quote
    const title = name ? `${symbol} · ${name}`.slice(0, 40) : symbol
    const pick: Record<Metric, [string, number]> = {
      price: ['Now', x.price],
      open: ['Opened today at', x.open],
      close: ['Previous close', x.prevClose],
      high: ["Today's high", x.high],
      low: ["Today's low", x.low],
    }
    const [label, value] = pick[q.metric]
    return {
      header: `${title}  ·  LIVE`,
      body:
        `${label}: ${money(value)}\n` +
        `Day change: ${pct(x.changePct)}\n` +
        `High ${money(x.high)}   Low ${money(x.low)}`,
    }
  }

  const date = q.date!
  try {
    // ---- a specific minute
    if (q.time) {
      const zone = opts.zone
      const target = zonedToEpoch(date.y, date.m, date.d, q.time.h, q.time.min, zone) / 1000
      if (target * 1000 > now) return { header: symbol, body: "That time hasn't happened yet." }
      const bars = await fetchCandles(symbol, '1', target - 30 * 60, target + 60, opts.apiKey)
      const label = `${dateLabel(date)}, ${timeLabel(q.time.h, q.time.min)} ${zoneLabel(zone)}`
      // Bar timestamps are the start of each minute; take the last one at or before the target.
      let idx = -1
      if (bars) for (let i = 0; i < bars.t.length; i++) if (bars.t[i] <= target) idx = i
      if (!bars || idx < 0) {
        return {
          header: `${symbol}  ·  ${label}`,
          body: 'No trades at that time.\nUS market hours are 9:30 AM–4:00 PM New York time, Mon–Fri.',
        }
      }
      const gapMin = Math.round((target - bars.t[idx]) / 60)
      return {
        header: `${symbol}  ·  ${label}`,
        body:
          `Price: ${money(bars.c[idx])}\n` +
          (gapMin > 1 ? `(last trade ${gapMin} min earlier)\n` : '') +
          `That minute: high ${money(bars.h[idx])}, low ${money(bars.l[idx])}`,
      }
    }

    // ---- a whole day
    const dayStart = zonedToEpoch(date.y, date.m, date.d, 0, 0, MARKET_ZONE)
    if (dayStart > now) return { header: symbol, body: "That day hasn't happened yet." }
    // Daily bars may be stamped at midnight UTC or at the New York open, so
    // ask for a wide window and keep the bar nearest that calendar date.
    const anchor = Date.UTC(date.y, date.m - 1, date.d) / 1000
    const bars = await fetchCandles(symbol, 'D', anchor - 2 * 86_400, anchor + 2 * 86_400, opts.apiKey)
    let i = -1
    if (bars) {
      let best = Infinity
      for (let k = 0; k < bars.t.length; k++) {
        const diff = Math.abs(bars.t[k] - anchor)
        if (diff < best && diff <= 16 * 3600) {
          best = diff
          i = k
        }
      }
    }
    if (!bars || i < 0) {
      return { header: `${symbol}  ·  ${dateLabel(date)}`, body: 'The market was closed that day.' }
    }
    const values: Record<Metric, number> = { price: bars.c[i], close: bars.c[i], open: bars.o[i], high: bars.h[i], low: bars.l[i] }
    const lead = q.metric === 'price' || q.metric === 'close' ? 'Close' : q.metric[0].toUpperCase() + q.metric.slice(1)
    return {
      header: `${symbol}  ·  ${dateLabel(date)}`,
      body:
        `${lead}: ${money(values[q.metric])}\n` +
        `Open ${money(bars.o[i])}   Close ${money(bars.c[i])}\n` +
        `High ${money(bars.h[i])}   Low ${money(bars.l[i])}`,
    }
  } catch (err) {
    if (err instanceof FinnhubError && err.kind === 'no_access') {
      return {
        header: `${symbol}  ·  HISTORY`,
        body: 'Past prices need a paid Finnhub plan.\nUpgrade at finnhub.io, then ask again.',
      }
    }
    throw err
  }
}
