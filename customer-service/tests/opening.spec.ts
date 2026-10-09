/**
 * Issue #6 acceptance: the opening — the trigger message the browser asks the
 * host for right after a login, and the protocol the model reads it by.
 *
 * The seam is the real thing for the HTTP route and the real prompt registry;
 * `sessionController` is stood in for, because admitting a prompt is the
 * harness's own path and what this directory decides is only *that* it is
 * admitted, once, with which content and which browser zone.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
// The Loader hands a plugin module over whole, `inject` included; a bare `apply`
// would lose the injection gate and fail on the first service it reads.
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import * as authPlugin from '../plugins/auth/index.js'
import * as storePlugin from '../plugins/store/index.js'
import { DEMO_ACCOUNTS } from '../plugins/store/index.js'
import { agentDouble, asAgent, bodyOf, call, cookieValue, disposeAll, registerCleanup, requireService } from './support.js'

/** The Workspace the login Session must be created in. */
const WORKSPACE_PATH = '/tmp/customer-service-demo-workspace'

/** The trigger message the host admits; the protocol below quotes it. */
const TRIGGER = '你好'

/** The opening line the ticket requires the Agent to say. */
const GREETING = '您好，请问您咨询的是这个订单吗？'

/** One demo account, as the login route takes it. */
const silver = DEMO_ACCOUNTS.find(account => account.accountName === 'silver')!
const gold = DEMO_ACCOUNTS.find(account => account.accountName === 'gold')!
const platinum = DEMO_ACCOUNTS.find(account => account.accountName === 'platinum')!

/** One delivered trigger message, as the stood-in Agent received it. */
interface DeliveredMessage {
  readonly role: string
  readonly id: string
  readonly content: readonly { readonly type: string, readonly text?: string }[]
  readonly source: { readonly kind: string }
}

interface Booted {
  readonly port: number
  /** The messages the composition delivered, in order. */
  readonly delivered: readonly DeliveredMessage[]
  /** Fail the next delivery with this message, as a harness failure would. */
  refuse(message: string): void
  /** Assemble the model-facing context snapshot for one harness Session. */
  assemble(sessionId: string): Promise<string>
  dispose(): Promise<void>
}

afterEach(disposeAll)

/**
 * Compose the plugins under test behind a real listening web server.
 * @returns the bound port, what was delivered, and read-back accessors.
 */
async function boot(): Promise<Booted> {
  const delivered: DeliveredMessage[] = []
  const created: string[] = []
  let refusal: string | undefined
  const ctx = new Context()
  // The request-trust fence admits a same-origin browser request; Session
  // creation, Agent resolution, and message delivery belong to the harness, so
  // all are stand-ins that record what this directory asked them for.
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('sessionController', {
    create: async () => {
      created.push(`session-${created.length + 1}`)
      return { sessionId: created[created.length - 1] }
    },
    resolveAgent: async (sessionId: string) => {
      if (refusal !== undefined) {
        const message = refusal
        refusal = undefined
        return { error: new Error(message) }
      }
      return {
        agent: {
          session: { id: sessionId },
          followup: (message: DeliveredMessage) => { delivered.push(message) },
        },
      }
    },
  })
  ctx.provide('workspaceRegistry', { create: async (path: string) => ({ id: `workspace-${path}`, path }) })
  const storageRoot = mkdtempSync(join(tmpdir(), 'customer-service-test-'))
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(storageRoot, 'kv') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(storePlugin)
  await ctx.plugin(authPlugin, { workspacePath: WORKSPACE_PATH })

  const webServer = requireService(ctx, 'webServer')
  const systemPrompt = requireService(ctx, 'systemPrompt')
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
  return {
    port: webServer.port,
    delivered,
    refuse: message => { refusal = message },
    assemble: async sessionId => renderContextSnapshot(await systemPrompt.assemble({
      agent: asAgent(agentDouble(sessionId)),
    })),
    dispose,
  }
}

/**
 * Log one demo account in and return the cookie that carries the login.
 * @param port - the listening port.
 * @param account - the demo account to log in.
 * @returns the request cookie and the Session the login opened.
 */
async function login(
  port: number,
  account: { accountName: string, password: string },
): Promise<{ cookie: string, sessionId: string }> {
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

describe('the opening route', () => {
  it('delivers the trigger message once, for the Session the login bound', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)

    const first = await call(app.port, '/opening', {
      method: 'POST',
      cookie,
      body: { clientTimeZone: 'Asia/Shanghai' },
    })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ opened: true })
    expect(app.delivered).toEqual([
      {
        role: 'user',
        id: expect.any(String),
        content: [{ type: 'text', text: TRIGGER }],
        // Not `user`: the conversation renders this as a system trigger row, so
        // the Customer never reads words they did not say.
        source: { kind: 'customer-service' },
      },
    ])
    // The agent loop keys its per-message accounting on identity, which the
    // harness's own constructor guarantees by freezing what it builds.
    expect(Object.isFrozen(app.delivered[0])).toBe(true)
  })

  it('delivers nothing more when the browser asks again', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    await call(app.port, '/opening', { method: 'POST', cookie, body: { clientTimeZone: 'Asia/Shanghai' } })

    // A reload asks again, and the answer is a no-op rather than a second
    // greeting: the opening happens once per login, not once per page load.
    const again = await call(app.port, '/opening', { method: 'POST', cookie, body: { clientTimeZone: 'Asia/Shanghai' } })
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ opened: false })
    expect(app.delivered).toHaveLength(1)
  })

  it('opens its own conversation for each login', async () => {
    const app = await boot()
    const firstLogin = await login(app.port, silver)
    const secondLogin = await login(app.port, gold)
    for (const login_ of [firstLogin, secondLogin]) {
      const answer = await call(app.port, '/opening', {
        method: 'POST',
        cookie: login_.cookie,
        body: { clientTimeZone: 'Asia/Shanghai' },
      })
      expect(answer.body).toEqual({ opened: true })
    }
    // Two greetings, each its own message: a fresh identity per opening, so one
    // Customer's trigger cannot stand in for another's.
    expect(app.delivered).toHaveLength(2)
    expect(new Set(app.delivered.map(message => message.id)).size).toBe(2)
  })

  it('refuses a browser that is not logged in', async () => {
    const app = await boot()
    const answer = await call(app.port, '/opening', { method: 'POST' })
    expect(answer.status).toBe(401)
    expect(app.delivered).toEqual([])
  })

  it('releases the Session when the harness refuses the delivery', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    app.refuse('session is held elsewhere')

    const refused = await call(app.port, '/opening', { method: 'POST', cookie })
    expect(refused.status).toBe(503)
    // The refusal is reported, not swallowed: a conversation that never opened
    // is a failure of this route, not an empty greeting.
    expect(refused.body).toEqual({ error: expect.stringContaining('失败') })

    // Nobody was greeted, so the next page load must be able to try again.
    const retried = await call(app.port, '/opening', { method: 'POST', cookie })
    expect(retried.status).toBe(200)
    expect(retried.body).toEqual({ opened: true })
    expect(app.delivered).toHaveLength(1)
  })

  it('opens without a zone when the browser named none, or named one the harness refuses', async () => {
    const app = await boot()
    for (const [account, sent] of [[silver, undefined], [gold, ''], [platinum, 'Mars/Phobos']] as const) {
      const { cookie } = await login(app.port, account)
      const answer = await call(app.port, '/opening', {
        method: 'POST',
        cookie,
        body: sent === undefined ? {} : { clientTimeZone: sent },
      })
      // The greeting is what the Customer is waiting for; a zone that cannot be
      // used must not cost them the opening.
      expect(answer.status).toBe(200)
      expect(answer.body).toEqual({ opened: true })
    }
    expect(app.delivered).toHaveLength(3)
  })

  it('refuses a malformed body and the wrong method', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const malformed = await call(app.port, '/opening', {
      method: 'POST',
      cookie,
      body: { clientTimeZone: 8 },
    })
    expect(malformed.status).toBe(400)
    expect(app.delivered).toEqual([])
    expect((await call(app.port, '/opening', { cookie })).status).toBe(405)
  })
})

describe('the opening protocol in the model context', () => {
  it('tells the model how to open a bound Session, and in which zone', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    await call(app.port, '/opening', {
      method: 'POST',
      cookie,
      body: { clientTimeZone: 'Asia/Shanghai' },
    })
    const assembled = await app.assemble(sessionId)

    // The trigger the browser asks for, and the line the Agent must answer it
    // with (issue #6): both stated where the model reads them.
    expect(assembled).toContain(TRIGGER)
    expect(assembled).toContain(GREETING)
    // The opening is a card, not a question about order numbers.
    expect(assembled).toContain('search_orders')
    // And a vague time is converted with the injected clock before the query.
    expect(assembled).toContain('上周三')
    // The harness reads the browser zone from messages the browser sent, and
    // this trigger is not one: without the zone stated here, the model is told
    // to ask the Customer which zone their times are in.
    expect(assembled).toContain('客户浏览器的时区是 Asia/Shanghai')
  })

  it('states no zone for a Session whose browser named none', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    await call(app.port, '/opening', { method: 'POST', cookie, body: {} })
    expect(await app.assemble(sessionId)).not.toContain('客户浏览器的时区是')
  })

  it('contributes nothing to a Session with no Customer', async () => {
    const app = await boot()
    await login(app.port, silver)
    expect(await app.assemble('session-unbound')).not.toContain('开场')
  })
})
