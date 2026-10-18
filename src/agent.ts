// The AI brain: Claude answers any question in plain words, using live
// Finnhub data through tools and the web for everything else (Fed decisions,
// macro news, explanations). Runs straight from the app with the user's own
// Claude API key; nothing goes through a server of ours.
//
// Docs: https://docs.claude.com/en/api/messages
//       https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool

import { answerQuestion, partsInZone, zoneLabel, MARKET_ZONE } from './ask'
import { fetchQuote, getJson } from './finnhub'
import { companyEarnings, earningsCalendar, type Answer } from './news'

const MODEL = 'claude-haiku-5-5' // fast enough to feel instant on the glasses
const API = 'https://api.anthropic.com/v1/messages'
const PAGE_CHARS = 300

export interface AgentContext {
  claudeKey: string
  finnhubKey: string
  zone: string
  watchlist: () => string[]
  showWatchlist: () => void
  addToWatchlist: (symbols: string[]) => Promise<string[]>
  removeFromWatchlist: (symbols: string[]) => Promise<string[]>
}

export class AgentError extends Error {
  constructor(public kind: 'bad_key' | 'busy' | 'network' | 'other', message: string) {
    super(message)
  }
}

// ------------------------------------------------------------------ tools

const TOOLS = [
  {
    name: 'get_quotes',
    description: 'Live price, day change %, day high/low/open and previous close for one or more US stock or ETF tickers.',
    input_schema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers, e.g. ["AAPL","SPY"]' } },
      required: ['symbols'],
    },
  },
  {
    name: 'get_price_history',
    description:
      'Price of a stock on a past date, optionally at a specific time (1-minute bar). Without time returns that day\'s open/high/low/close. Needs a paid Finnhub plan; the result says so if not available.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: '24h HH:MM, optional' },
      },
      required: ['symbol', 'date'],
    },
  },
  {
    name: 'find_ticker',
    description: 'Look up the ticker symbol for a company name.',
    input_schema: { type: 'object', properties: { company: { type: 'string' } }, required: ['company'] },
  },
  {
    name: 'market_news',
    description: 'Latest general market headlines with summaries (Finnhub).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'company_news',
    description: 'Headlines about one company from the past week (Finnhub).',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'company_earnings',
    description: 'Latest reported EPS vs estimate (beat/miss), earlier quarters, and next report date for a company.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'earnings_calendar',
    description: 'Which companies report earnings today, tomorrow or this week.',
    input_schema: {
      type: 'object',
      properties: { when: { type: 'string', enum: ['today', 'tomorrow', 'this week'] } },
      required: ['when'],
    },
  },
  {
    name: 'show_watchlist',
    description: "Switch the glasses to the user's live watchlist screen. Use when they ask to see their watchlist/stocks.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_to_watchlist',
    description: "Add tickers to the user's watchlist.",
    input_schema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
  },
  {
    name: 'remove_from_watchlist',
    description: "Remove tickers from the user's watchlist.",
    input_schema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
  },
]

const WEB_SEARCH = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 }

function answerText(a: Answer): string {
  return [a.header, a.body, ...(a.more ?? [])].join('\n')
}

async function runTool(name: string, input: any, ctx: AgentContext, flags: { showWatchlist: boolean }): Promise<string> {
  const key = ctx.finnhubKey
  const up = (s: unknown) => String(s ?? '').toUpperCase().trim()
  switch (name) {
    case 'get_quotes': {
      const syms: string[] = (Array.isArray(input.symbols) ? input.symbols : []).map(up).filter(Boolean).slice(0, 10)
      const out = await Promise.all(syms.map(s => fetchQuote(s, key)))
      return JSON.stringify(out.map(r => (r.ok ? r.quote : { symbol: r.symbol, error: 'not found' })))
    }
    case 'get_price_history': {
      const [y, m, d] = String(input.date ?? '').split('-').map(Number)
      if (!y || !m || !d) return 'Invalid date.'
      const q = `${up(input.symbol)} on ${m}/${d}/${y}${input.time ? ' at ' + String(input.time) : ''}`
      return answerText(await answerQuestion(q, { apiKey: key, watchlist: [], zone: ctx.zone }))
    }
    case 'find_ticker': {
      const d = await getJson('/search', { q: String(input.company ?? '') }, key)
      const list = (Array.isArray(d?.result) ? d.result : []).slice(0, 5)
      return JSON.stringify(list.map((r: any) => ({ symbol: r.symbol, name: r.description, type: r.type })))
    }
    case 'market_news': {
      const d = await getJson('/news', { category: 'general' }, key)
      return JSON.stringify(
        (Array.isArray(d) ? d : []).slice(0, 12).map((n: any) => ({
          headline: n.headline,
          source: n.source,
          time: new Date(Number(n.datetime) * 1000).toISOString(),
          summary: String(n.summary ?? '').slice(0, 300),
        })),
      )
    }
    case 'company_news': {
      const now = Date.now()
      const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
      const d = await getJson('/company-news', { symbol: up(input.symbol), from: ymd(now - 7 * 864e5), to: ymd(now) }, key)
      return JSON.stringify(
        (Array.isArray(d) ? d : []).slice(0, 10).map((n: any) => ({
          headline: n.headline,
          source: n.source,
          time: new Date(Number(n.datetime) * 1000).toISOString(),
          summary: String(n.summary ?? '').slice(0, 300),
        })),
      )
    }
    case 'company_earnings':
      return answerText(await companyEarnings(up(input.symbol), key))
    case 'earnings_calendar':
      return answerText(await earningsCalendar(String(input.when ?? 'today'), ctx.watchlist(), key))
    case 'show_watchlist':
      flags.showWatchlist = true
      return `Showing the live watchlist: ${ctx.watchlist().join(', ')}`
    case 'add_to_watchlist': {
      const list = await ctx.addToWatchlist((input.symbols ?? []).map(up))
      return `Watchlist now: ${list.join(', ')}`
    }
    case 'remove_from_watchlist': {
      const list = await ctx.removeFromWatchlist((input.symbols ?? []).map(up))
      return `Watchlist now: ${list.join(', ')}`
    }
    default:
      return `Unknown tool ${name}`
  }
}

// ------------------------------------------------------------------ conversation

type Msg = { role: 'user' | 'assistant'; content: any }
let history: Msg[] = []
let lastTurnAt = 0

function systemPrompt(ctx: AgentContext): string {
  const now = Date.now()
  const p = partsInZone(now, ctx.zone)
  const ny = partsInZone(now, MARKET_ZONE)
  const two = (n: number) => String(n).padStart(2, '0')
  return [
    "You are the voice assistant inside Ticker HUD, a stock app on the user's Even Realities G2 smart glasses.",
    'The user speaks; speech-to-text may garble tickers or company names, so infer the most likely meaning.',
    `Now: ${p.y}-${two(p.m)}-${two(p.d)} ${two(p.h)}:${two(p.min)} in the user's time zone (${zoneLabel(ctx.zone)}); ${two(ny.h)}:${two(ny.min)} in New York.`,
    `When the user says a time like "2 PM" they mean ${zoneLabel(ctx.zone)} time unless they say otherwise.`,
    `Their watchlist: ${ctx.watchlist().join(', ') || '(empty)'}.`,
    'Use the tools for prices, history, news and earnings. Use web_search for anything else current: Fed/FOMC decisions, economic data (CPI, jobs), market-moving events, explanations of why something moved.',
    'Your reply is shown on a tiny monochrome display:',
    '- Plain text only. No markdown, no asterisks, no headings, no tables, no links.',
    '- Lead with the direct answer (numbers first). Keep it under about 400 characters unless the user asks for detail.',
    '- Use short lines. Prices like $227.48, changes like +1.2%.',
    '- If you used the web, name the source in a few words, e.g. (Reuters).',
    "- If data isn't available (e.g. history needs a paid Finnhub plan), say so in one line.",
    'You are an information tool, not a financial advisor: give facts and context, not buy/sell recommendations.',
  ].join('\n')
}

async function callClaude(ctx: AgentContext, messages: Msg[], withWeb: boolean): Promise<any> {
  let res: Response
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ctx.claudeKey,
        'anthropic-version': '2023-06-01',
        // Required for calling the API directly from a web page.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: systemPrompt(ctx),
        tools: withWeb ? [...TOOLS, WEB_SEARCH] : TOOLS,
        messages,
      }),
    })
  } catch {
    throw new AgentError('network', "Can't reach Claude")
  }
  if (res.status === 401 || res.status === 403) throw new AgentError('bad_key', 'Claude rejected the API key')
  if (res.status === 429 || res.status === 529) throw new AgentError('busy', 'Claude is busy, try again in a moment')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = String(body?.error?.message ?? `Claude error ${res.status}`)
    if (withWeb && res.status === 400 && /web.?search/i.test(msg)) return callClaude(ctx, messages, false)
    throw new AgentError('other', msg)
  }
  return body
}

function paginate(text: string): string[] {
  const clean = text.replace(/\*\*|__|`|^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  const pages: string[] = []
  let cur = ''
  // Split on lines first, then sentences, so pages break at natural points.
  const pieces = clean.split(/(?<=\n)|(?<=[.!?])[ \t]+/)
  for (const piece of pieces) {
    if ((cur + ' ' + piece).trim().length > PAGE_CHARS && cur.trim()) {
      pages.push(cur.trim())
      cur = ''
    }
    cur += (cur && !cur.endsWith('\n') ? ' ' : '') + piece
  }
  if (cur.trim()) pages.push(cur.trim())
  return pages.length ? pages : ['(no answer)']
}

export interface AgentResult {
  answer: Answer
  showWatchlist: boolean
}

export async function askAgent(question: string, ctx: AgentContext): Promise<AgentResult> {
  // Follow-ups ("what about Nvidia?") work for 10 minutes after the last question.
  if (Date.now() - lastTurnAt > 10 * 60_000) history = []
  const messages: Msg[] = [...history, { role: 'user', content: question }]
  const flags = { showWatchlist: false }

  let final: any = null
  for (let step = 0; step < 8; step++) {
    const res = await callClaude(ctx, messages, true)
    messages.push({ role: 'assistant', content: res.content })
    if (res.stop_reason === 'tool_use') {
      const results = []
      for (const block of res.content ?? []) {
        if (block.type !== 'tool_use') continue
        let out: string
        try {
          out = await runTool(block.name, block.input ?? {}, ctx, flags)
        } catch (err) {
          out = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out.slice(0, 8000) })
      }
      messages.push({ role: 'user', content: results })
      continue
    }
    if (res.stop_reason === 'pause_turn') continue // server-side web search still running
    final = res
    break
  }

  const text = (final?.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('')
    .trim()

  // Remember only the plain question and answer, to keep follow-ups cheap.
  history = [...history, { role: 'user' as const, content: question }, { role: 'assistant' as const, content: text || '(no answer)' }].slice(-8)
  lastTurnAt = Date.now()

  const pages = paginate(text || "Sorry, I couldn't find an answer to that.")
  const header = `"${question.length > 50 ? question.slice(0, 49) + '…' : question}"`
  return { answer: { header, body: pages[0], more: pages.slice(1) }, showWatchlist: flags.showWatchlist }
}

export function resetConversation() {
  history = []
}
