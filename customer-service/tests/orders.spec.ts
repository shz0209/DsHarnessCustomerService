/**
 * Issue #5 acceptance: the seeded Orders, `search_orders`, the blocking order
 * card, and the tool allowlist.
 *
 * The seam is the real thing: a Cordis composition with the shipped tool
 * registry, web server, storage hub, JSON backend, domain form, and prompt
 * registry, plus this directory's `store`, `auth`, and `tools` plugins, driven
 * over real HTTP. Only `connection`, `sessionController`, `workspaceRegistry`,
 * and `agents` are stood in for — Agent lifecycle is the harness's, and the
 * minter below gives the tools plugin the one thing it reads off an Agent
 * (`session.id` and a scoped `ctx`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
// The Loader hands a plugin module over whole, `inject` included; a bare `apply`
// would lose the injection gate and fail on the first service it reads.
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it } from 'vitest'
import * as authPlugin from '../plugins/auth/index.js'
import * as storePlugin from '../plugins/store/index.js'
import { DEMO_ACCOUNTS, DEMO_ORDERS } from '../plugins/store/index.js'
import * as toolsPlugin from '../plugins/tools/index.js'
import { agentDouble, asAgent, bodyOf, call, cookieValue, disposeAll, registerCleanup, requireService } from './support.js'
import type { Answer, StoredOrder } from './support.js'

/** The Workspace the login Session must be created in. */
const WORKSPACE_PATH = '/tmp/customer-service-demo-workspace'

/** One demo account's credentials, as the login route takes them. */
const silver = DEMO_ACCOUNTS.find(account => account.accountName === 'silver')!
const gold = DEMO_ACCOUNTS.find(account => account.accountName === 'gold')!

/** One candidate as the card receives it. */
interface CandidateOrder {
  readonly orderId: string
  readonly location: string
  readonly rentedAt: string
  readonly amountCents: number
  readonly status: string
  readonly statusLabel: string
}

/** One pending question as the card's route serves it. */
interface OrderQuestion {
  readonly query: Record<string, string>
  readonly candidates: readonly CandidateOrder[]
}

interface Booted {
  readonly port: number
  readonly ctx: Context
  /** An Agent that was already live when the tools plugin loaded. */
  readonly liveAgent: Agent
  /** The backend root the composition was given. */
  readonly storageRoot: string
  /** Mint an Agent for one Session and announce it, as the agent loop does. */
  agent(sessionId: string): Promise<Agent>
  searchOrders(customerId: string, filter?: Record<string, string | undefined>): StoredOrder[]
  /** Run one tool call as `caller`. */
  execute(name: string, args: unknown, caller: Agent, signal: AbortSignal): Promise<ToolExecutionResult>
  /** What one Agent's model would be offered: its tool names and section names. */
  offered(caller: Agent): Promise<{ readonly tools: readonly string[], readonly sections: readonly string[] }>
  /**
   * Contribute into one Agent's own scope what an agent preset contributes: a
   * tool, that tool's guidance section, and a section of its own.
   */
  contribute(caller: Agent, name: string): void
  dispose(): Promise<void>
}

afterEach(disposeAll)

interface BootOptions {
  /** The backend root; pass one to reuse an existing store. */
  readonly storageRoot?: string
  /** Presentation the deployment's tools row declares, as a profile would. */
  readonly deploymentMode?: 'native' | 'ptc'
  /** Presentation the already-live Agent's own scope declares for itself. */
  readonly livePresentation?: 'native' | 'ptc'
}

/**
 * One tool shaped like a harness one, for the allowlist to have something to
 * mask: it is registered into a scope, never called, and answers its own name.
 * @param name - the tool name to register.
 * @returns the definition.
 */
function contributedTool(name: string) {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] },
    execute: async () => name,
  }
}

/**
 * Compose the plugins under test behind a real listening web server.
 * @param options - the backend root, and the presentations to compose under.
 * @returns the bound port, Agent minting, and read-back accessors.
 */
async function boot(options: BootOptions = {}): Promise<Booted> {
  const storageRoot = options.storageRoot ?? mkdtempSync(join(tmpdir(), 'customer-service-test-'))
  const agents: Agent[] = []
  let sessions = 0
  const ctx = new Context()
  // The request-trust fence admits a same-origin browser request; Session
  // creation, Workspace registration, and Agent lifecycle are the harness's own
  // paths, replaced here by stand-ins that record what they were asked for.
  // Each creation gets its own id, so two logins never share a Session.
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('sessionController', {
    create: async () => {
      sessions += 1
      return { sessionId: `session-${sessions}` }
    },
  })
  ctx.provide('workspaceRegistry', { create: async (path: string) => ({ id: `workspace-${path}`, path }) })
  ctx.provide('agents', { list: () => [...agents] })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(storageRoot, 'kv') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: options.deploymentMode ?? 'native' })
  // Two tools in the global layer, where the harness's own tool plugins put
  // theirs. Without them the allowlist assertions below would pass on a
  // composition that registered nothing to mask.
  for (const decoy of ['bash', 'read']) ctx.tools.register(contributedTool(decoy))
  await ctx.plugin(storePlugin)
  await ctx.plugin(authPlugin, { workspacePath: WORKSPACE_PATH })

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
  }
  registerCleanup(async () => {
    await dispose()
    rmSync(storageRoot, { recursive: true, force: true })
  })

  /**
   * Mint an Agent for one Session, as the agent loop does: the scope key IS the
   * Agent, and the loop's own injection list decides which services a scope
   * holder reaches (here, the tool registry the allowlist is installed on).
   *
   * The Agent's own contract is wider than these plugins read (they take an id
   * off it, a Session id, and its scoped context), so the double is asserted
   * into place here once rather than cast at every reader.
   * @param sessionId - the harness Session the Agent drives.
   * @returns the Agent-shaped object the plugins read.
   */
  const mint = async (sessionId: string): Promise<Agent> => {
    const double = agentDouble(sessionId)
    let scope!: { ctx: Context }
    await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, double)
    }, { inject: ['tools', 'systemPrompt'] }))
    double.ctx = scope.ctx
    const agent = asAgent(double)
    agents.push(agent)
    return agent
  }

  // One Agent exists before the plugin loads, so the allowlist's opening sweep
  // over the live registry is exercised beside the later announcements. It may
  // also have declared a presentation for itself, as an agent preset does.
  const liveAgent = await mint('session-live')
  if (options.livePresentation !== undefined) liveAgent.ctx!.tools.presentAs(options.livePresentation)
  await ctx.plugin(toolsPlugin)

  const webServer = requireService(ctx, 'webServer')
  const systemPrompt = requireService(ctx, 'systemPrompt')
  const runtime = requireService(ctx, 'tools')
  const customerStore = requireService(ctx, 'customerStore')

  return {
    port: webServer.port,
    ctx,
    liveAgent,
    storageRoot,
    agent: async (sessionId) => {
      const agent = await mint(sessionId)
      // The agent registry announces creation; the test stands in for it.
      ctx.emit('agent/created', { agent, source: 'startup' })
      return agent
    },
    searchOrders: (customerId, filter = {}) => customerStore.searchOrders(customerId, filter),
    execute: (name, args, caller, signal) => runtime.execute({
      callId: ToolCallId('call-1'), name, arguments: args, agent: caller, signal,
    }),
    offered: async caller => {
      const assembly = await systemPrompt.assemble({ agent: caller, scope: caller })
      return {
        tools: assembly.tools.map(tool => tool.name),
        sections: assembly.sections.map(section => section.name),
      }
    },
    contribute: (caller, name) => {
      const scoped = caller.ctx!
      scoped.tools.register(contributedTool(name))
      // `tool:<name>` is the harness-wide name for a tool's own guidance.
      scoped.systemPrompt.section({
        name: `tool:${name}`,
        order: 500,
        text: `Start independent delegations with \`${name}\`.`,
      })
      scoped.systemPrompt.section({
        name: `persona:${name}`,
        order: 600,
        text: 'You are a coding agent.',
      })
    },
    dispose,
  }
}

/**
 * Log one demo account in and return its cookie and its bound Session id.
 * @param port - the listening port.
 * @param account - the demo account to log in.
 * @returns the request cookie and the Session id the login opened.
 */
async function login(port: number, account: { accountName: string, password: string }): Promise<{ cookie: string, sessionId: string }> {
  const answer = await call(port, '/login', {
    method: 'POST',
    body: { accountName: account.accountName, password: account.password },
  })
  expect(answer.status).toBe(200)
  return {
    cookie: cookieValue(answer.setCookie),
    sessionId: bodyOf<{ sessionId: string }>(answer).sessionId,
  }
}

/**
 * Wait for a Card to become live, as the browser's polling does: the tool
 * dispatches asynchronously, so a first request may arrive before the question
 * is published.
 * @param port - the listening port.
 * @param cookie - the answering Customer's login cookie.
 * @returns the live question.
 */
async function waitForQuestion(port: number, cookie: string): Promise<OrderQuestion> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const answer = await call(port, '/order-question?callId=call-1', { cookie })
    if (answer.status === 200) return bodyOf<OrderQuestion>(answer)
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
  throw new Error('the order card was never published')
}

/** The text of one settled tool call, as the model would read it. */
function outcomeText(outcome: ToolExecutionResult): string {
  return outcome.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Read one JSON value as an object, when it is one.
 * @param value - the value to read.
 * @returns its entries, or `undefined` for anything else.
 */
function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * The Order one settled call published, when it published one.
 * @param outcome - the settled tool call.
 * @returns the Order's fields as the model received them, or `undefined`.
 */
function outcomeOrder(outcome: ToolExecutionResult): Record<string, JsonValue> | undefined {
  const value = jsonRecord(outcome.value)
  return value?.outcome === 'selected' ? jsonRecord(value.order) : undefined
}

describe('the seeded Orders', () => {
  it('gives every demo account one in-progress and one returned Order', async () => {
    const app = await boot()
    for (const account of DEMO_ACCOUNTS) {
      const orders = app.searchOrders(account.customerId)
      expect(orders).toHaveLength(2)
      expect(orders.map(order => order.status).sort()).toEqual(['in_progress', 'returned'])
      // The account's own seeded Orders, not a shared pair handed to everyone.
      expect(orders.map(order => order.orderId).sort())
        .toEqual(DEMO_ORDERS.filter(order => order.customerId === account.customerId).map(order => order.orderId).sort())
      for (const order of orders) {
        expect(order).toMatchObject({ customerId: account.customerId })
        expect(order.orderId).toMatch(/^ord-/)
        expect(order.location).not.toBe('')
        expect(order.amountCents).toBeGreaterThan(0)
        expect(Number.isFinite(Date.parse(order.rentedAt))).toBe(true)
      }
      // Two distinct places and two distinct times, or the Card cannot tell
      // them apart when it asks the Customer which one they mean.
      expect(new Set(orders.map(order => order.location)).size).toBe(2)
      expect(new Set(orders.map(order => order.rentedAt)).size).toBe(2)
    }
  })

  it('keeps the seeded Orders when the same store is opened again', async () => {
    const first = await boot()
    const before = first.searchOrders(silver.customerId)
    await first.dispose()

    const second = await boot({ storageRoot: first.storageRoot })
    expect(second.searchOrders(silver.customerId)).toEqual(before)
  })
})

describe('searchOrders', () => {
  it('returns the most recently rented Order when nothing is filtered', async () => {
    const app = await boot()
    for (const order of DEMO_ORDERS) {
      if (order.status !== 'in_progress') continue
      expect(app.searchOrders(order.customerId)[0]?.orderId).toBe(order.orderId)
    }
  })

  it('matches a location by containment, newest first', async () => {
    const app = await boot()
    expect(app.searchOrders(silver.customerId, { location: '万象城' }).map(order => order.orderId))
      .toEqual(['ord-silver-1'])
    expect(app.searchOrders(silver.customerId, { location: '站' }).map(order => order.orderId))
      .toEqual(['ord-silver-2'])
    // 购物中心 is one Customer's in-progress Order and another Customer's too,
    // but a query only ever sees its own.
    expect(app.searchOrders(silver.customerId, { location: '购物中心' }).map(order => order.orderId))
      .toEqual(['ord-silver-1'])
    expect(app.searchOrders(gold.customerId, { location: '购物中心' }).map(order => order.orderId))
      .toEqual(['ord-gold-1'])
    expect(app.searchOrders(silver.customerId, { location: '这地方不存在' })).toEqual([])
  })

  it('filters an inclusive time range', async () => {
    const app = await boot()
    const ids = (filter: Record<string, string>) =>
      app.searchOrders(silver.customerId, filter).map(order => order.orderId)

    // The bounds are inclusive: this range is exactly ord-silver-2's instant.
    expect(ids({ rentedFrom: '2026-09-21T08:05:00+08:00', rentedTo: '2026-09-21T08:05:00+08:00' }))
      .toEqual(['ord-silver-2'])
    expect(ids({ rentedFrom: '2026-09-21T08:04:59+08:00', rentedTo: '2026-09-21T08:05:01+08:00' }))
      .toEqual(['ord-silver-2'])
    expect(ids({ rentedFrom: '2026-09-21T08:05:01+08:00' })).toEqual(['ord-silver-1'])
    expect(ids({ rentedTo: '2026-09-21T08:04:59+08:00' })).toEqual([])
    // Both bounds together, newest first.
    expect(ids({ rentedFrom: '2026-01-01T00:00:00+08:00', rentedTo: '2026-12-31T00:00:00+08:00' }))
      .toEqual(['ord-silver-1', 'ord-silver-2'])
    expect(ids({ rentedFrom: '2026-01-01T00:00:00+08:00', rentedTo: '2026-01-31T00:00:00+08:00' })).toEqual([])
  })

  it('cannot reach another Customer’s Order, whatever the filter', async () => {
    const app = await boot()
    // The other Customer's exact location finds nothing.
    expect(app.searchOrders(silver.customerId, { location: '海岸城购物中心' })).toEqual([])
    // A range wide enough for every Order in the table still returns only this
    // Customer's two, and never another Customer's order id.
    const mine = app.searchOrders(silver.customerId, { rentedFrom: '2020-01-01T00:00:00Z' })
    expect(mine.map(order => order.orderId)).toEqual(['ord-silver-1', 'ord-silver-2'])
    expect(mine.every(order => order.customerId === silver.customerId)).toBe(true)
    // An account with no Orders owns none.
    expect(app.searchOrders('cust-nobody')).toEqual([])
  })
})

describe('the tool allowlist', () => {
  it('shows an Agent this one tool and nothing else', async () => {
    const app = await boot()
    const caller = await app.agent('session-1')
    expect(app.ctx.tools.schemas(caller).map(schema => schema.name)).toEqual(['search_orders'])
  })

  it('masks an Agent that was already live when the plugin loaded', async () => {
    const app = await boot()
    expect(app.ctx.tools.schemas(app.liveAgent).map(schema => schema.name)).toEqual(['search_orders'])
    expect((await app.execute('bash', {}, app.liveAgent, new AbortController().signal)).isError).toBe(true)
  })

  it('answers "unknown tool" for every name outside the allowlist', async () => {
    const app = await boot()
    const caller = await app.agent('session-1')
    const offered = await app.offered(caller)
    expect(offered.tools).toEqual(['search_orders'])
    // No tool guidance survives either: every `tool:<name>` section belongs to
    // a tool the allowlist excludes.
    expect(offered.sections.filter(name => name.startsWith('tool:'))).toEqual([])
    for (const name of ['bash', 'read', 'write', 'ask_user_question', 'run_code', 'search_order']) {
      const outcome = await app.execute(name, {}, caller, new AbortController().signal)
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain(`unknown tool "${name}"`)
    }
  })

  it('hides and denies a tool contributed into the Agent’s own scope, as a preset does', async () => {
    const app = await boot()
    const caller = await app.agent('session-1')
    // A preset (the web profile mounts its delegation tools this way) registers
    // into the Agent's OWN layer, and a scope's own registrations are exempt
    // from its own filter — `restrict` cannot see this name at all.
    app.contribute(caller, 'subagent')
    expect(app.ctx.tools.get('subagent', caller)).toBeDefined()

    // What the model reads, and what it may run, are still the allowlist: the
    // tool is gone from the list, and so is the guidance that would have told
    // the model to reach for it. The preset's own sections are left alone.
    const offered = await app.offered(caller)
    expect(offered.tools).toEqual(['search_orders'])
    expect(offered.sections).not.toContain('tool:subagent')
    expect(offered.sections).toContain('persona:subagent')
    const outcome = await app.execute('subagent', {}, caller, new AbortController().signal)
    expect(outcome.isError).toBe(true)
    // Indistinguishable from a name that exists nowhere: the answer a Customer
    // -facing agent gets must not reveal the shape of the registry behind the
    // mask.
    expect(outcomeText(outcome)).toContain('unknown tool "subagent"')
    expect(outcomeText(await app.execute('nope', {}, caller, new AbortController().signal)))
      .toContain('unknown tool "nope"')
  })

  it('holds when the deployment presents PTC, whose run_code a filter cannot remove', async () => {
    // Under PTC the model reaches every tool through the reserved `run_code`
    // transport, and `restrict()` refuses to name that name. The plugin must
    // therefore take the presentation away rather than trust the deployment's.
    const app = await boot({ deploymentMode: 'ptc' })
    const caller = await app.agent('session-1')
    expect(app.ctx.tools.schemas(caller).map(schema => schema.name)).toEqual(['search_orders'])
    expect((await app.execute('run_code', { code: 'bash()' }, caller, new AbortController().signal)).isError).toBe(true)
    // The deployment default is still whatever the profile asked for; only the
    // Customer-facing scopes are forced native.
    expect(app.ctx.tools.schemas(app.liveAgent).map(schema => schema.name)).toEqual(['search_orders'])
  })

  it('refuses to load when an Agent has already declared its own presentation', async () => {
    // The mask is a security invariant, not a default: a composition that
    // presents an Agent differently would widen what the model reaches, so it
    // fails loud at load rather than winning or losing silently.
    await expect(boot({ livePresentation: 'ptc' })).rejects.toThrow(/presentAs/)
  })
})

describe('search_orders', () => {
  it('blocks on the Card and returns the Order the Customer picked', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    // Nothing narrowed the query, so the Card asks about one Order — the
    // newest — and asks for a yes/no answer rather than a choice.
    const running = app.execute('search_orders', {}, caller, new AbortController().signal)
    const question = await waitForQuestion(app.port, cookie)
    expect(question.query).toEqual({})
    expect(question.candidates).toEqual([
      {
        orderId: 'ord-silver-1',
        location: '万象城购物中心 B1 层服务台',
        rentedAt: '2026-10-08T19:24:00+08:00',
        amountCents: 300,
        status: 'in_progress',
        statusLabel: '进行中',
      },
    ])

    const answered = await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-1' },
    })
    expect(answered.status).toBe(200)
    expect(answered.body).toEqual({ ok: true })

    const outcome = await running
    expect(outcome.isError).toBe(false)
    expect(outcome.value).toEqual({
      outcome: 'selected',
      order: {
        orderId: 'ord-silver-1',
        location: '万象城购物中心 B1 层服务台',
        rentedAt: '2026-10-08T19:24:00+08:00',
        amountCents: 300,
        status: 'in_progress',
      },
    })
    // The model reads the confirmed Order, and never the owner key it cannot use.
    expect(outcomeText(outcome)).toContain('客户确认的订单')
    expect(outcomeText(outcome)).not.toContain(silver.customerId)
    expect(outcomeText(outcome)).toContain('¥3.00')
  })

  it('offers every match for the Customer to choose from when the query is narrowed', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    // A bound was given, so the query is a search rather than "my latest".
    const running = app.execute('search_orders', { rentedFrom: '2026-01-01' }, caller, new AbortController().signal)
    const question = await waitForQuestion(app.port, cookie)
    expect(question.candidates.map(candidate => candidate.orderId))
      .toEqual(['ord-silver-1', 'ord-silver-2'])

    await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-2' },
    })
    // The Order the Customer picked, not the newest one the query ranked first.
    expect(outcomeOrder(await running)?.orderId).toBe('ord-silver-2')
  })

  it('narrows the candidates by location and by a whole-day time bound', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    // A date-only bound means that whole day in UTC, so it still covers an
    // Order rented at 08:05+08:00 on it.
    const running = app.execute('search_orders', { rentedFrom: '2026-09-21', rentedTo: '2026-09-21' }, caller, new AbortController().signal)
    const question = await waitForQuestion(app.port, cookie)
    expect(question.query).toEqual({
      rentedFrom: '2026-09-21T00:00:00.000Z',
      rentedTo: '2026-09-21T23:59:59.999Z',
    })
    expect(question.candidates.map(candidate => candidate.orderId)).toEqual(['ord-silver-2'])

    await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-2' },
    })
    expect(outcomeOrder(await running)?.orderId).toBe('ord-silver-2')
  })

  it('trims the location it matches on', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, gold)
    const caller = await app.agent(sessionId)

    const running = app.execute('search_orders', { location: '  地铁站  ' }, caller, new AbortController().signal)
    const question = await waitForQuestion(app.port, cookie)
    expect(question.query).toEqual({ location: '地铁站' })
    expect(question.candidates.map(candidate => candidate.orderId)).toEqual(['ord-gold-2'])

    await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: null },
    })
    expect((await running).value).toEqual({ outcome: 'declined' })
  })

  it('answers with no Order at all when the Customer says none of them', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, gold)
    const caller = await app.agent(sessionId)

    const running = app.execute('search_orders', {}, caller, new AbortController().signal)
    await waitForQuestion(app.port, cookie)
    await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: null },
    })

    const outcome = await running
    expect(outcome.isError).toBe(false)
    expect(outcome.value).toEqual({ outcome: 'declined' })
    expect(outcomeText(outcome)).toContain('都不是')
  })

  it('returns no result without blocking when nothing matches', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    const outcome = await app.execute('search_orders', { location: '机场' }, caller, new AbortController().signal)
    expect(outcome.isError).toBe(false)
    expect(outcome.value).toEqual({ outcome: 'none' })
    expect(outcomeText(outcome)).toContain('没有查到')
    // Nothing matched, so no Card may have been published.
    expect((await call(app.port, '/order-question?callId=call-1', { cookie })).status).toBe(404)
  })

  it('rejects arguments it cannot use, including a customer id', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    const signal = new AbortController().signal

    const rejected: readonly [unknown, string][] = [
      [[], '参数必须是一个对象'],
      [{ customerId: gold.customerId }, '未知参数：customerId'],
      [{ orderId: 'ord-gold-1' }, '未知参数：orderId'],
      [{ location: '' }, 'location 必须是非空字符串'],
      [{ location: 7 }, 'location 必须是非空字符串'],
      [{ rentedFrom: '昨天' }, 'ISO-8601'],
      [{ rentedTo: '' }, 'ISO-8601'],
      [{ rentedFrom: '2026-10-01', rentedTo: '2026-09-01' }, '晚于'],
    ]
    for (const [args, expected] of rejected) {
      const outcome = await app.execute('search_orders', args, caller, signal)
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain(expected)
    }
  })

  it('refuses to query in a Session with no Customer', async () => {
    const app = await boot()
    const caller = await app.agent('session-unbound')
    const outcome = await app.execute('search_orders', {}, caller, new AbortController().signal)
    expect(outcome.isError).toBe(true)
    expect(outcomeText(outcome)).toContain('没有绑定客户')
  })
})

describe('the order Card routes', () => {
  it('answers "expired" for a Card nobody is waiting on', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    expect((await call(app.port, '/order-question?callId=call-1', { cookie })).status).toBe(404)
    const answer = await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: null },
    })
    expect(answer.status).toBe(404)
    expect(answer.body).toEqual({ error: '这张订单卡片已经失效' })
  })

  it('keeps two Customers’ Cards apart when their calls share a call id', async () => {
    const app = await boot()
    const silverLogin = await login(app.port, silver)
    const goldLogin = await login(app.port, gold)
    const silverAgent = await app.agent(silverLogin.sessionId)
    const goldAgent = await app.agent(goldLogin.sessionId)

    // A tool call id is unique within its Session, not across the process:
    // both models emitting `call-1` must leave both Cards answerable, and each
    // Customer must read their own.
    const silverCall = app.execute('search_orders', { location: '万象城' }, silverAgent, new AbortController().signal)
    const goldCall = app.execute('search_orders', { location: '地铁站' }, goldAgent, new AbortController().signal)
    await waitForQuestion(app.port, silverLogin.cookie)
    await waitForQuestion(app.port, goldLogin.cookie)

    expect(bodyOf<OrderQuestion>(await call(app.port, '/order-question?callId=call-1', { cookie: silverLogin.cookie }))
      .candidates.map(candidate => candidate.orderId)).toEqual(['ord-silver-1'])
    expect(bodyOf<OrderQuestion>(await call(app.port, '/order-question?callId=call-1', { cookie: goldLogin.cookie }))
      .candidates.map(candidate => candidate.orderId)).toEqual(['ord-gold-2'])

    for (const [login_, orderId] of [[silverLogin, 'ord-silver-1'], [goldLogin, 'ord-gold-2']] as const) {
      expect((await call(app.port, '/order-question/answer', {
        method: 'POST',
        cookie: login_.cookie,
        body: { callId: 'call-1', orderId },
      })).status).toBe(200)
    }
    expect(outcomeOrder(await silverCall)?.orderId).toBe('ord-silver-1')
    expect(outcomeOrder(await goldCall)?.orderId).toBe('ord-gold-2')
  })

  it('refuses the Card to nobody, and to another Customer', async () => {
    const app = await boot()
    const silverLogin = await login(app.port, silver)
    const goldLogin = await login(app.port, gold)
    const caller = await app.agent(silverLogin.sessionId)

    const running = app.execute('search_orders', {}, caller, new AbortController().signal)
    await waitForQuestion(app.port, silverLogin.cookie)

    expect((await call(app.port, '/order-question?callId=call-1')).status).toBe(401)
    expect((await call(app.port, '/order-question/answer', { method: 'POST', body: { callId: 'call-1', orderId: null } })).status).toBe(401)
    // Another Customer's Session is told the Card does not exist, not that it
    // is forbidden: who else is being served is not theirs to learn.
    expect((await call(app.port, '/order-question?callId=call-1', { cookie: goldLogin.cookie })).status).toBe(404)
    expect((await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie: goldLogin.cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-1' },
    })).status).toBe(404)

    // The owner answers, proving the refused attempts left the question live.
    const answered = await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie: silverLogin.cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-1' },
    })
    expect(answered.status).toBe(200)
    expect(outcomeOrder(await running)?.orderId).toBe('ord-silver-1')
  })

  it('refuses an Order the query did not return, a malformed body, and a second answer', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    const running = app.execute('search_orders', { location: '深圳北站' }, caller, new AbortController().signal)
    await waitForQuestion(app.port, cookie)

    const foreign = await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-1' },
    })
    expect(foreign.status).toBe(400)
    expect(foreign.body).toEqual({ error: '这个订单不在本次查询结果中' })
    for (const body of [{ callId: 'call-1' }, { callId: 'call-1', orderId: 7 }, { orderId: null }]) {
      expect((await call(app.port, '/order-question/answer', { method: 'POST', cookie, body })).status).toBe(400)
    }

    expect((await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-2' },
    })).status).toBe(200)
    await running

    const again = await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-2' },
    })
    expect(again.status).toBe(404)
  })

  it('refuses the wrong method', async () => {
    const app = await boot()
    expect((await call(app.port, '/order-question', { method: 'POST' })).status).toBe(405)
    expect((await call(app.port, '/order-question/answer')).status).toBe(405)
  })

  it('settles the tool call when the turn is cancelled before the Customer answers', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    const controller = new AbortController()

    const running = app.execute('search_orders', {}, caller, controller.signal)
    // Wait for the Card, or the registry aborts the call before the tool body
    // ever runs and the cancellation this test is about never happens.
    await waitForQuestion(app.port, cookie)
    controller.abort()

    const outcome = await running
    expect(outcome.isError).toBe(true)
    expect(outcomeText(outcome)).toContain('订单确认已取消')
    // The Card is gone, so a Customer cannot answer a question nobody awaits.
    expect((await call(app.port, '/order-question?callId=call-1', { cookie })).status).toBe(404)
  })
})
