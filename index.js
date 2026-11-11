/**
 * Prompt Inspector — Host half.
 *
 * Exposes a tiny same-origin HTTP surface that reports the *effective* prompt
 * assembly of one live agent (sections, context blocks, tool schemas, token
 * estimates) and applies per-session overrides following this harness's
 * documented practices:
 *
 *   - text changes  -> shadow `systemPrompt.section()` registrations on the
 *                      agent's own context (never rewrite the assembly
 *                      waterfall, never mutate global sections)
 *   - tool removal  -> `tools.restrict({ deny })` scoped to the same context
 *
 * Every registration is owned by one context effect, so unloading the plugin
 * (or disposing the agent) restores the untouched prompt.
 */

const ROUTE = '/prompt-inspector'
const MAX_BODY = 8 * 1024 * 1024

/** agentId -> { edits: Map<name, {text, order}>, hidden: Set<name>, toolMeta: Map, disposers: [] } */
const stores = new Map()

function storeOf(id) {
  let st = stores.get(id)
  if (!st) {
    st = { edits: new Map(), hidden: new Set(), toolMeta: new Map(), unrestrictable: new Set(), disposers: [] }
    stores.set(id, st)
  }
  return st
}

function disposeAll(st) {
  for (const dispose of st.disposers.splice(0)) {
    try {
      dispose()
    } catch {
      /* a stale registration is already gone */
    }
  }
}

function approxTokens(text) {
  return typeof text === 'string' && text.length > 0 ? Math.ceil(text.length / 4) : 0
}

function interpolate(text, variables) {
  if (!variables) return text
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name) => {
    const value = variables[name]
    return value === undefined ? whole : String(value)
  })
}

function readSectionOrders(ctx, agent) {
  const out = new Map()
  let merged
  try {
    const layers = ctx.systemPrompt && ctx.systemPrompt.layers
    if (!layers || typeof layers.merge !== 'function') return out
    merged = layers.merge(agent, (layer) => layer.sections)
  } catch {
    return out
  }
  if (!merged) return out
  const absorb = (value, key) => {
    if (value && typeof value === 'object' && typeof value.order === 'number') out.set(key, value.order)
  }
  try {
    if (typeof merged.forEach === 'function') {
      merged.forEach((value, key) => absorb(value, key))
    } else if (typeof merged === 'object') {
      for (const key of Object.keys(merged)) absorb(merged[key], key)
    }
  } catch {
    /* shape changed; fall back to getSectionOrder below */
  }
  return out
}

function orderOf(ctx, agent, name, orders) {
  if (orders.has(name)) return orders.get(name)
  try {
    const order = ctx.systemPrompt.getSectionOrder(name)
    if (typeof order === 'number' && Number.isFinite(order)) return order
  } catch {
    /* unknown name */
  }
  return 0
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const GUARD_HEADER = 'x-prompt-inspector'

function forbidden(message) {
  const err = new Error(message)
  err.status = 403
  return err
}

function parseHostHeader(value) {
  try {
    const url = new URL(`http://${value}`)
    return url.username === '' && url.password === '' ? url : undefined
  } catch {
    return undefined
  }
}

function isLoopbackName(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Confused-deputy fence for the whole `/prompt-inspector` surface.
 *
 * This route is mounted straight on the webserver, so it does not sit behind the
 * harness's own `/api` Host/Origin fence. Two browser paths stay open without one:
 *
 *   - DNS rebinding: a page on the attacker's domain is re-pointed at 127.0.0.1,
 *     so the browser treats this listener as same-origin and reads `/ping` (the
 *     live agent ids) and `/snapshot` (the whole prompt). `Host` is the one header
 *     rebinding cannot forge, so pinning it to the loopback listener is the fence.
 *   - Cross-site CSRF: a page POSTs here with `mode: 'no-cors'` and a `text/plain`
 *     body. No preflight is sent, the handler ignores Content-Type, and the edits
 *     land. `Origin`/`Sec-Fetch-Site` plus a required custom header (which forces a
 *     preflight the server never approves) close that path.
 *
 * Non-browser clients (curl, smoke tests) pass by naming the loopback Host and
 * sending the header; no identity is established here.
 */
function assertTrusted(ctx, req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') throw forbidden('missing host header')
  const hostUrl = parseHostHeader(host)
  if (hostUrl === undefined) throw forbidden('untrusted host')
  if (!isLoopbackName(hostUrl.hostname)) throw forbidden('untrusted host')

  let own
  try {
    own = new URL(ctx.webServer.getOrigin())
  } catch {
    own = undefined // not listening yet; the loopback check above still holds
  }
  if (own !== undefined && hostUrl.port !== own.port) throw forbidden('untrusted host')

  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    throw forbidden('cross-site request refused')
  }

  const origin = req.headers.origin
  if (typeof origin === 'string') {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      throw forbidden('invalid origin')
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') throw forbidden('invalid origin')
    if (originUrl.host !== hostUrl.host) throw forbidden('cross-origin request refused')
  }

  if (req.headers[GUARD_HEADER] !== '1') throw forbidden(`missing ${GUARD_HEADER} header`)
}

function missingAgent(ctx, sessionId) {
  const err = new Error(`no live agent named ${JSON.stringify(sessionId)}`)
  err.status = 404
  try {
    err.known = ctx.agents.list().map((agent) => agent.id)
  } catch {
    err.known = []
  }
  return err
}

async function snapshot(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId)
  if (!agent) throw missingAgent(ctx, sessionId)

  const st = storeOf(sessionId)
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const orders = readSectionOrders(ctx, agent)
  const hiddenNames = new Set(st.hidden)
  const editedNames = new Set(st.edits.keys())

  const sections = []
  for (const section of assembly.sections) {
    const edit = st.edits.get(section.name)
    const text = typeof section.text === 'string' ? section.text : String(section.text ?? '')
    sections.push({
      name: section.name,
      order: orderOf(ctx, agent, section.name, orders),
      text,
      chars: text.length,
      tokens: approxTokens(text),
      edited: editedNames.has(section.name),
      muted: Boolean(edit) && edit.text.trim() === '',
    })
  }
  // A muted shadow may be dropped from the assembly entirely; surface it again so
  // the row stays reachable (and revertible) in the UI.
  for (const [name, edit] of st.edits) {
    if (sections.some((row) => row.name === name)) continue
    sections.push({
      name,
      order: edit.order,
      text: '',
      chars: 0,
      tokens: 0,
      edited: true,
      muted: edit.text.trim() === '',
      detached: true,
    })
  }
  sections.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

  const contexts = assembly.contexts.map((entry) => {
    const text = typeof entry.text === 'string' ? entry.text : String(entry.text ?? '')
    return { name: entry.name, text, chars: text.length, tokens: approxTokens(text) }
  })

  const tools = []
  for (const tool of assembly.tools) {
    if (!st.toolMeta.has(tool.name)) {
      st.toolMeta.set(tool.name, { description: tool.description, parameters: tool.parameters })
    }
    tools.push({
      name: tool.name,
      tokens: approxTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      description: tool.description,
      parameters: tool.parameters,
      hidden: hiddenNames.has(tool.name),
      restrictable: !st.unrestrictable.has(tool.name),
    })
  }
  // Hidden tools are removed from the assembly; keep them listed from the captured metadata.
  for (const name of hiddenNames) {
    if (tools.some((row) => row.name === name)) continue
    const meta = st.toolMeta.get(name)
    tools.push({
      name,
      tokens: meta ? approxTokens(JSON.stringify({ name, description: meta.description, parameters: meta.parameters })) : 0,
      description: meta ? meta.description : '',
      parameters: meta ? meta.parameters : {},
      hidden: true,
      restrictable: !st.unrestrictable.has(name),
      detached: true,
    })
  }

  const rendered = assembly.sections
    .filter((section) => typeof section.text === 'string' && section.text.trim() !== '')
    .map((section) => (section.interpolate === false ? section.text : interpolate(section.text, assembly.variables)))
    .join('\n\n')

  const totals = {
    sections: sections.reduce((sum, row) => sum + row.tokens, 0),
    contexts: contexts.reduce((sum, row) => sum + row.tokens, 0),
    tools: tools.filter((row) => !row.hidden).reduce((sum, row) => sum + row.tokens, 0),
    toolsHidden: tools.filter((row) => row.hidden).reduce((sum, row) => sum + row.tokens, 0),
  }
  totals.rendered = approxTokens(rendered) + (rendered ? 4 : 0)
  totals.all = totals.sections + totals.contexts + totals.tools

  return {
    sessionId,
    title: readTitle(agent),
    sections,
    contexts,
    tools,
    totals,
    rendered,
    hidden: [...hiddenNames],
    edited: [...editedNames],
    note: null,
  }
}

function readTitle(agent) {
  try {
    if (agent.options && typeof agent.options.title === 'string') return agent.options.title
  } catch {
    /* ignore */
  }
  try {
    if (agent.session && typeof agent.session.title === 'string') return agent.session.title
  } catch {
    /* ignore */
  }
  return ''
}

async function applyEdits(ctx, body) {
  const sessionId = body && body.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    const err = new Error('missing sessionId')
    err.status = 400
    throw err
  }
  const agent = ctx.agents.get(sessionId)
  if (!agent) throw missingAgent(ctx, sessionId)

  const st = storeOf(sessionId)
  disposeAll(st)

  const orders = readSectionOrders(ctx, agent)
  const errors = []
  const nextEdits = new Map()

  for (const entry of Array.isArray(body.edits) ? body.edits : []) {
    if (!entry || typeof entry.name !== 'string' || entry.name === '') continue
    const text = typeof entry.text === 'string' ? entry.text : ''
    const order = orderOf(ctx, agent, entry.name, orders)
    try {
      const dispose = agent.ctx.systemPrompt.section({
        name: entry.name,
        order,
        text: () => text,
      })
      st.disposers.push(dispose)
      nextEdits.set(entry.name, { text, order })
    } catch (err) {
      errors.push(`${entry.name}: ${String((err && err.message) || err)}`)
    }
  }
  st.edits = nextEdits

  const requested = Array.isArray(body.hidden) ? body.hidden : []
  const deny = [...new Set(requested.filter((name) => typeof name === 'string'))]
  const skipped = []
  const hiddenSet = new Set()
  st.unrestrictable = new Set()
  for (const name of deny) {
    try {
      st.disposers.push(agent.ctx.tools.restrict({ deny: [name] }))
      hiddenSet.add(name)
    } catch (err) {
      st.unrestrictable.add(name)
      skipped.push(name)
      errors.push(`${name}: ${String((err && err.message) || err)}`)
    }
  }
  st.hidden = hiddenSet

  const result = await snapshot(ctx, sessionId)
  result.errors = errors
  result.skippedTools = skipped
  return result
}

async function reset(ctx, body) {
  const sessionId = body && body.sessionId
  const st = stores.get(sessionId)
  if (st) disposeAll(st)
  stores.delete(sessionId)
  return snapshot(ctx, sessionId)
}

async function handle(ctx, req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname.slice(ROUTE.length) || '/'
  try {
    assertTrusted(ctx, req)
    if (req.method === 'GET' && (path === '/' || path === '/snapshot')) {
      const sessionId = url.searchParams.get('session')
      if (!sessionId) {
        json(res, 400, { error: 'missing ?session=' })
        return
      }
      json(res, 200, await snapshot(ctx, sessionId))
      return
    }
    if (req.method === 'GET' && path === '/ping') {
      const agents = ctx.agents.list().map((agent) => agent.id)
      json(res, 200, { ok: true, agents, tracked: [...stores.keys()] })
      return
    }
    if (req.method === 'POST' && path === '/apply') {
      const body = JSON.parse((await readBody(req)) || '{}')
      json(res, 200, await applyEdits(ctx, body))
      return
    }
    if (req.method === 'POST' && path === '/reset') {
      const body = JSON.parse((await readBody(req)) || '{}')
      json(res, 200, await reset(ctx, body))
      return
    }
    json(res, 404, { error: `unknown endpoint ${req.method} ${path}` })
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : 500
    json(res, status, {
      error: String((err && err.message) || err),
      known: err && err.known ? err.known : undefined,
    })
  }
}

export const name = 'prompt-inspector'
export const inject = ['systemPrompt', 'tools', 'agents', 'webServer']

export function apply(ctx) {
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => handle(ctx, req, res),
    })
    return () => {
      disposeRoute()
      for (const st of stores.values()) disposeAll(st)
      stores.clear()
    }
  })
}
