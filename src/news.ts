// Market news, Fed news, earnings and a quick market overview, from Finnhub.
// Endpoints: /news (general market news), /company-news, /stock/earnings
// (reported EPS vs estimate), /calendar/earnings (upcoming reports).

import { FinnhubError, fetchQuote, getJson } from './finnhub'

export interface Answer {
  header: string
  body: string // first screen
  more?: string[] // extra screens, reached by swiping
}

interface NewsItem {
  headline: string
  source: string
  datetime: number // unix seconds
  summary: string
}

const PAGE_CHARS = 300 // roughly what fits under the two-line header

// ------------------------------------------------------------------ intents

export type Topic = 'fed' | 'earnings' | 'news' | 'market' | null

export function detectTopic(text: string): Topic {
  const t = ' ' + text.toLowerCase() + ' '
  if (/\b(fed|feds|fomc|federal reserve|powell|interest rates?|rate (cut|hike|decision)s?|central bank)\b/.test(t)) return 'fed'
  if (/\b(earnings?|eps|quarterly (results|report)|reports? (today|tomorrow|this week)|reported)\b/.test(t)) return 'earnings'
  if (/\b(news|headlines?|happening|going on|latest on|update on)\b/.test(t)) return 'news'
  if (/\b(how('s| is| are)? (the )?(market|markets|stocks)|market (today|overview|summary)|the market)\b/.test(t)) return 'market'
  return null
}

/** Words that describe the topic, not the company (kept out of name searches). */
export const TOPIC_WORDS =
  'news headline headlines happening going latest update fed feds fomc federal reserve powell interest ' +
  'rate rates cut hike decision central bank earnings earning eps quarterly results report reports reported ' +
  'tomorrow overview summary markets about any'

// ------------------------------------------------------------------ helpers

function ago(unix: number, now: number): string {
  const mins = Math.max(0, Math.round((now / 1000 - unix) / 60))
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function clip(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : clean.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function newsPage(item: NewsItem, i: number, total: number, now: number): string {
  const head = clip(item.headline, 140)
  const meta = `${item.source || 'News'} · ${ago(item.datetime, now)}  (${i + 1}/${total})`
  const room = PAGE_CHARS - head.length - meta.length - 4
  const summary = room > 40 && item.summary ? '\n' + clip(item.summary, room) : ''
  return `${head}\n${meta}${summary}`
}

function toItems(raw: unknown): NewsItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((n: any) => n && typeof n.headline === 'string' && n.headline.trim())
    .map((n: any) => ({
      headline: n.headline,
      source: String(n.source ?? ''),
      datetime: Number(n.datetime) || 0,
      summary: String(n.summary ?? ''),
    }))
    .sort((a, b) => b.datetime - a.datetime)
}

function pagesFrom(items: NewsItem[], header: string, now: number, max = 8): Answer {
  const list = items.slice(0, max)
  const pages = list.map((n, i) => newsPage(n, i, list.length, now))
  return { header: pages.length > 1 ? `${header}  ·  swipe for more` : header, body: pages[0], more: pages.slice(1) }
}

const money = (v: number) =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ------------------------------------------------------------------ answers

export async function marketNews(apiKey: string, now = Date.now()): Promise<Answer> {
  const items = toItems(await getJson('/news', { category: 'general' }, apiKey))
  if (!items.length) return { header: 'MARKET NEWS', body: 'No headlines right now.' }
  return pagesFrom(items, 'MARKET NEWS', now)
}

export async function companyNews(symbol: string, apiKey: string, now = Date.now()): Promise<Answer> {
  const items = toItems(
    await getJson('/company-news', { symbol, from: ymd(now - 7 * 86_400_000), to: ymd(now) }, apiKey),
  )
  if (!items.length) return { header: `${symbol} NEWS`, body: `No news for ${symbol} in the last week.` }
  return pagesFrom(items, `${symbol} NEWS`, now)
}

const FED_WORDS = /\b(fed|fomc|federal reserve|powell|rate cut|rate hike|interest rate|rates? decision|basis points?|monetary policy|central bank)\b/i

export async function fedNews(apiKey: string, now = Date.now()): Promise<Answer> {
  const items = toItems(await getJson('/news', { category: 'general' }, apiKey)).filter(n =>
    FED_WORDS.test(n.headline + ' ' + n.summary),
  )
  if (!items.length) {
    return {
      header: 'FED / INTEREST RATES',
      body: 'No Fed headlines in the latest market news.\nAsk again after the next Fed announcement.',
    }
  }
  return pagesFrom(items, 'FED / INTEREST RATES', now, 6)
}

/** Latest reported quarter vs estimate, plus the next report date if known. */
export async function companyEarnings(symbol: string, apiKey: string, now = Date.now()): Promise<Answer> {
  const [hist, upcoming] = await Promise.all([
    getJson('/stock/earnings', { symbol }, apiKey).catch(e => {
      if (e instanceof FinnhubError && e.kind !== 'http') throw e
      return []
    }),
    getJson('/calendar/earnings', { symbol, from: ymd(now), to: ymd(now + 120 * 86_400_000) }, apiKey).catch(() => null),
  ])

  const reports: any[] = Array.isArray(hist) ? [...hist].sort((a, b) => String(b.period).localeCompare(String(a.period))) : []
  const next: any = (upcoming?.earningsCalendar ?? []).sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))[0]

  const lines: string[] = []
  const last = reports[0]
  if (last && typeof last.actual === 'number') {
    const q = last.quarter && last.year ? `Q${last.quarter} ${last.year}` : String(last.period ?? '')
    lines.push(`Last report (${q}):`)
    if (typeof last.estimate === 'number') {
      const beat = last.actual > last.estimate ? 'BEAT' : last.actual < last.estimate ? 'MISSED' : 'MET'
      const surprise = typeof last.surprisePercent === 'number' ? ` (${last.surprisePercent > 0 ? '+' : ''}${last.surprisePercent.toFixed(1)}%)` : ''
      lines.push(`EPS ${last.actual.toFixed(2)} vs est ${last.estimate.toFixed(2)}`)
      lines.push(`${beat} estimates${surprise}`)
    } else {
      lines.push(`EPS ${last.actual.toFixed(2)}`)
    }
  }
  if (next?.date) {
    const when = next.hour === 'bmo' ? 'before open' : next.hour === 'amc' ? 'after close' : ''
    lines.push(`Next report: ${next.date}${when ? ' ' + when : ''}`)
    if (typeof next.epsEstimate === 'number') lines.push(`EPS estimate ${next.epsEstimate.toFixed(2)}`)
  }
  if (!lines.length) return { header: `${symbol} EARNINGS`, body: `No earnings data found for ${symbol}.` }

  const more: string[] = []
  const older = reports.slice(1, 4).filter(r => typeof r.actual === 'number')
  if (older.length) {
    more.push(
      'Earlier quarters:\n' +
        older
          .map(r => {
            const q = r.quarter && r.year ? `Q${r.quarter} ${r.year}` : String(r.period ?? '')
            const est = typeof r.estimate === 'number' ? ` vs ${r.estimate.toFixed(2)}` : ''
            return `${q}: EPS ${r.actual.toFixed(2)}${est}`
          })
          .join('\n'),
    )
  }
  return { header: `${symbol} EARNINGS`, body: lines.join('\n'), more }
}

/** Who reports today / tomorrow / this week; watchlist names first. */
export async function earningsCalendar(text: string, watchlist: string[], apiKey: string, now = Date.now()): Promise<Answer> {
  const t = text.toLowerCase()
  const days = /\bweek\b/.test(t) ? 7 : /\btomorrow\b/.test(t) ? 1 : 0
  const start = /\btomorrow\b/.test(t) ? now + 86_400_000 : now
  const label = days === 7 ? 'THIS WEEK' : /\btomorrow\b/.test(t) ? 'TOMORROW' : 'TODAY'
  const d = await getJson('/calendar/earnings', { from: ymd(start), to: ymd(start + days * 86_400_000) }, apiKey)
  const list: any[] = Array.isArray(d?.earningsCalendar) ? d.earningsCalendar : []
  if (!list.length) return { header: `EARNINGS ${label}`, body: 'No earnings reports scheduled.' }

  const mine = list.filter(e => watchlist.includes(e.symbol))
  const when = (e: any) => (e.hour === 'bmo' ? 'pre' : e.hour === 'amc' ? 'post' : '')
  const fmt = (e: any) => `${e.symbol}${days ? ' ' + String(e.date).slice(5) : ''}${when(e) ? ' ' + when(e) : ''}`

  const pages: string[] = []
  if (mine.length) pages.push(`Your watchlist:\n${mine.map(fmt).join('\n')}`)
  const others = list.filter(e => !watchlist.includes(e.symbol)).slice(0, 60).map(fmt)
  for (let i = 0; i < others.length; i += 18) {
    pages.push((i === 0 ? `${list.length} companies report. Others:\n` : '') + others.slice(i, i + 18).join('   '))
  }
  return { header: `EARNINGS ${label}  ·  pre = before open, post = after close`.slice(0, 60), body: pages[0], more: pages.slice(1) }
}

/** S&P 500, Nasdaq 100 and Dow (via their ETFs) plus the top headlines. */
export async function marketOverview(apiKey: string, now = Date.now()): Promise<Answer> {
  const idx: [string, string][] = [['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['DIA', 'Dow']]
  const quotes = await Promise.all(idx.map(([s]) => fetchQuote(s, apiKey)))
  const lines = quotes.map((r, i) => {
    if (!r.ok) return `${idx[i][1]}: n/a`
    const p = r.quote.changePct
    return `${idx[i][1]}: ${p > 0 ? '▲ +' : p < 0 ? '▼ ' : ''}${p.toFixed(2)}%  (${idx[i][0]} ${money(r.quote.price)})`
  })
  let more: string[] = []
  try {
    const news = await marketNews(apiKey, now)
    more = [news.body, ...(news.more ?? [])].slice(0, 5)
  } catch {
    /* headlines are a bonus */
  }
  return {
    header: `MARKET TODAY${more.length ? '  ·  swipe for headlines' : ''}`,
    body: lines.join('\n'),
    more,
  }
}
