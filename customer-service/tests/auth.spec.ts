/**
 * Issue #3 acceptance: login, logout, the Session binding, and the identity the
 * model is told about.
 *
 * The seam is the real thing: a Cordis composition with the shipped web server,
 * storage hub, JSON backend, domain form, and prompt registry, plus this
 * directory's `store` and `auth` plugins, driven over real HTTP. Only
 * `connection` and `sessionController` are stood in for — the request-trust
 * fence and Session creation belong to the harness, and are covered there.
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

/** Rejected credentials answer with this one message, naming neither field. */
const CREDENTIALS_ERROR = '账号或密码错误'

/** The Workspace the login Session must be created in. */
const WORKSPACE_PATH = '/tmp/customer-service-demo-workspace'

/** The services this file reads back out of the composition. */
interface Services {
  readonly webServer: { readonly port: number }
  readonly systemPrompt: {
    assemble(context?: unknown): Promise<{ readonly contexts: readonly { readonly text: string }[] }>
  }
  readonly customerStore: { findById(customerId: string): Record<string, unknown> | undefined }
}

interface Booted {
  readonly port: number
  /** Session ids the stood-in controller was asked to create, in order. */
  readonly created: string[]
  /** The `workspaceId` each creation carried, in the same order. */
  readonly createdIn: (string | undefined)[]
  /** Workspace directories the stood-in registry was asked for, in order. */
  readonly ensured: string[]
  /** Assemble the model-facing context snapshot for one harness Session. */
  assemble(sessionId: string | undefined): Promise<string>
  /** Read a stored Customer row through the plugin's own service. */
  findById(customerId: string): Record<string, unknown> | undefined
  dispose(): Promise<void>
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * Compose the plugins under test behind a real listening web server.
 * @param storageRoot - the backend root; pass one to reuse an existing store.
 * @returns the bound port, the Session-creation log, and read-back accessors.
 */
async function boot(storageRoot = mkdtempSync(join(tmpdir(), 'customer-service-test-'))): Promise<Booted> {
  const created: string[] = []
  const createdIn: (string | undefined)[] = []
  const ensured: string[] = []
  const ctx = new Context()
  // The request-trust fence admits a same-origin browser request; Session
  // creation and Workspace registration are the harness's own paths, replaced
  // here by countable stand-ins that record what they were asked for.
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('sessionController', {
    create: async (request: { workspaceId?: string }) => {
      const sessionId = `session-${created.length + 1}`
      created.push(sessionId)
      createdIn.push(request.workspaceId)
      return { sessionId }
    },
  })
  ctx.provide('workspaceRegistry', {
    create: async (path: string) => {
      ensured.push(path)
      return { id: `workspace-${path}`, path }
    },
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(storageRoot, 'kv') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(storePlugin)
  await ctx.plugin(authPlugin, { workspacePath: WORKSPACE_PATH })

  const services = ctx as unknown as Services
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
  }
  cleanups.push(async () => {
    await dispose()
    rmSync(storageRoot, { recursive: true, force: true })
  })
  return {
    port: services.webServer.port,
    created,
    createdIn,
    ensured,
    assemble: async (sessionId) => renderContextSnapshot(await services.systemPrompt.assemble(
      sessionId === undefined ? undefined : { agent: { session: { id: sessionId } } },
    )),
    findById: customerId => services.customerStore.findById(customerId),
    dispose,
  }
}

interface Answer {
  readonly status: number
  readonly setCookie: string | undefined
  readonly body: Record<string, unknown> | undefined
}

/**
 * Call one customer-service route.
 * @param port - the listening port.
 * @param path - path below the plugin's route prefix.
 * @param init - the method, JSON body, and login cookie to send.
 * @returns the status, the `set-cookie` header, and the parsed JSON body.
 */
async function call(
  port: number,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.cookie !== undefined) headers.cookie = init.cookie
  const response = await fetch(`http://127.0.0.1:${port}/customer-service${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  return {
    status: response.status,
    setCookie: response.headers.get('set-cookie') ?? undefined,
    body: text === '' ? undefined : JSON.parse(text),
  }
}

/**
 * The `name=value` half of a `set-cookie` header, as a request would send it.
 * @param setCookie - the response header, when the response set one.
 * @returns the cookie pair, or `''`.
 */
function cookieValue(setCookie: string | undefined): string {
  return (setCookie ?? '').split(';')[0] ?? ''
}

describe('customer login routes', () => {
  it('answers anonymous without creating a Session', async () => {
    const app = await boot()
    const answer = await call(app.port, '/session')
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ loggedIn: false })
    expect(app.created).toEqual([])
  })

  it('rejects a wrong password and a wrong account with the same message', async () => {
    const app = await boot()
    const wrongPassword = await call(app.port, '/login', {
      method: 'POST',
      body: { accountName: 'silver', password: 'not-the-password' },
    })
    const wrongAccount = await call(app.port, '/login', {
      method: 'POST',
      body: { accountName: 'nobody', password: 'silver123' },
    })
    expect(wrongPassword.status).toBe(401)
    expect(wrongAccount.status).toBe(401)
    expect(wrongPassword.body).toEqual({ error: CREDENTIALS_ERROR })
    expect(wrongAccount.body).toEqual({ error: CREDENTIALS_ERROR })
    // 未登录不创建会话: neither rejection may reach Session creation.
    expect(app.created).toEqual([])
  })

  it('creates exactly one Session on a successful login and binds it to the cookie', async () => {
    const app = await boot()
    const login = await call(app.port, '/login', {
      method: 'POST',
      body: { accountName: 'gold', password: 'gold123' },
    })
    expect(login.status).toBe(200)
    expect(app.created).toEqual(['session-1'])
    // The Session must sit in the demo Workspace, or the browser renders the
    // "choose a workspace" landing and the Customer chats elsewhere.
    expect(app.ensured).toEqual([WORKSPACE_PATH])
    expect(app.createdIn).toEqual([`workspace-${WORKSPACE_PATH}`])
    expect(login.body).toEqual({
      accountName: 'gold',
      tier: 'gold',
      tierLabel: '黄金',
      isAdmin: false,
      sessionId: 'session-1',
    })
    expect(login.setCookie).toContain('HttpOnly')
    expect(login.setCookie).toContain('SameSite=Strict')
    // A session cookie: closing the browser must log the Customer out, so
    // there is no "remember me" (issue #1, 登录 story 3).
    expect(login.setCookie).not.toContain('Max-Age')

    const cookie = cookieValue(login.setCookie)
    const session = await call(app.port, '/session', { cookie })
    expect(session.body).toEqual({
      loggedIn: true,
      accountName: 'gold',
      tier: 'gold',
      tierLabel: '黄金',
      isAdmin: false,
      sessionId: 'session-1',
    })
    expect(app.created).toEqual(['session-1'])
  })

  it('drops the binding and the cookie on logout', async () => {
    const app = await boot()
    const login = await call(app.port, '/login', {
      method: 'POST',
      body: { accountName: 'platinum', password: 'platinum123' },
    })
    const cookie = cookieValue(login.setCookie)
    const logout = await call(app.port, '/logout', { method: 'POST', cookie })
    expect(logout.status).toBe(200)
    expect(logout.setCookie).toContain('Max-Age=0')
    // A browser drops the cookie; the token must be dead server-side too.
    expect((await call(app.port, '/session', { cookie })).body).toEqual({ loggedIn: false })
  })

  it('opens a separate Session for each login', async () => {
    const app = await boot()
    const first = await call(app.port, '/login', { method: 'POST', body: { accountName: 'silver', password: 'silver123' } })
    const second = await call(app.port, '/login', { method: 'POST', body: { accountName: 'blackgold', password: 'blackgold123' } })
    expect(app.created).toEqual(['session-1', 'session-2'])
    expect(first.body?.sessionId).toBe('session-1')
    expect(second.body?.sessionId).toBe('session-2')
    // Each cookie resolves to its own Session and its own Customer.
    expect((await call(app.port, '/session', { cookie: cookieValue(first.setCookie) })).body).toMatchObject({ accountName: 'silver' })
    expect((await call(app.port, '/session', { cookie: cookieValue(second.setCookie) })).body).toMatchObject({ accountName: 'blackgold' })
  })

  it('refuses to load without an absolute Workspace path', async () => {
    const ctx = new Context()
    ctx.provide('connection', { requestRejection: () => undefined })
    ctx.provide('sessionController', { create: async () => ({ sessionId: 'session-1' }) })
    ctx.provide('workspaceRegistry', { create: async () => ({ id: 'workspace-1', path: '' }) })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root: join(mkdtempSync(join(tmpdir(), 'customer-service-test-')), 'kv') })
    await ctx.plugin(storageDomain, { backend: 'json' })
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(storePlugin)
    cleanups.push(() => ctx.fiber.dispose())
    await expect(ctx.plugin(authPlugin, {})).rejects.toThrow(/workspacePath/)
    await expect(ctx.plugin(authPlugin, { workspacePath: 'relative/dir' })).rejects.toThrow(/workspacePath/)
  })

  it('refuses the wrong method and a malformed body', async () => {
    const app = await boot()
    expect((await call(app.port, '/login')).status).toBe(405)
    expect((await call(app.port, '/session', { method: 'POST' })).status).toBe(405)
    expect((await call(app.port, '/login', { method: 'POST', body: { accountName: 'silver' } })).status).toBe(400)
  })

  it('lists the demo accounts with their tier labels and never a hash', async () => {
    const app = await boot()
    const answer = await call(app.port, '/demo-accounts')
    expect(answer.status).toBe(200)
    expect(answer.body?.accounts).toEqual([
      { accountName: 'silver', password: 'silver123', tier: 'silver', tierLabel: '白银', isAdmin: false },
      { accountName: 'gold', password: 'gold123', tier: 'gold', tierLabel: '黄金', isAdmin: false },
      { accountName: 'platinum', password: 'platinum123', tier: 'platinum', tierLabel: '铂金', isAdmin: false },
      { accountName: 'blackgold', password: 'blackgold123', tier: 'black_gold', tierLabel: '黑金', isAdmin: true },
    ])
    expect(JSON.stringify(answer.body)).not.toContain('passwordHash')
  })
})

describe('customer identity in the model context', () => {
  it('tells the model who it is talking to, and only for a bound Session', async () => {
    const app = await boot()
    const login = await call(app.port, '/login', { method: 'POST', body: { accountName: 'blackgold', password: 'blackgold123' } })
    const sessionId = login.body?.sessionId as string

    expect(await app.assemble(sessionId)).toContain('当前客户：blackgold（VIP 等级：黑金，管理员）。')
    // An unbound Session, and an assembly with no Session at all, contribute
    // nothing — never a blank or a placeholder identity.
    expect(await app.assemble('session-unbound')).not.toContain('当前客户')
    expect(await app.assemble(undefined)).not.toContain('当前客户')

    await call(app.port, '/logout', { method: 'POST', cookie: cookieValue(login.setCookie) })
    expect(await app.assemble(sessionId)).not.toContain('当前客户')
  })

  it('names the tier of every demo account', async () => {
    const app = await boot()
    const expected: Record<string, string> = {
      silver: '当前客户：silver（VIP 等级：白银）。',
      gold: '当前客户：gold（VIP 等级：黄金）。',
      platinum: '当前客户：platinum（VIP 等级：铂金）。',
      blackgold: '当前客户：blackgold（VIP 等级：黑金，管理员）。',
    }
    for (const account of DEMO_ACCOUNTS) {
      const login = await call(app.port, '/login', { method: 'POST', body: { accountName: account.accountName, password: account.password } })
      expect(await app.assemble(login.body?.sessionId as string)).toContain(expected[account.accountName])
    }
  })
})

describe('the Customer table', () => {
  it('stores salted hashes, never the demo passwords', async () => {
    const app = await boot()
    const account = DEMO_ACCOUNTS[0]!
    const row = app.findById(account.customerId)
    expect(row).toMatchObject({
      customerId: account.customerId,
      accountName: account.accountName,
      tier: account.tier,
      isAdmin: account.isAdmin,
    })
    const hash = row?.passwordHash as string
    expect(hash).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(hash).not.toContain(account.password)
    // One salt per row, so no two stored hashes are equal.
    const stored = DEMO_ACCOUNTS.map(entry => app.findById(entry.customerId)?.passwordHash as string)
    expect(new Set(stored).size).toBe(DEMO_ACCOUNTS.length)
  })

  it('keeps the seeded rows when the same store is opened again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'customer-service-test-'))
    const first = await boot(root)
    const before = DEMO_ACCOUNTS.map(entry => first.findById(entry.customerId)?.passwordHash)
    await first.dispose()

    const second = await boot(root)
    expect(DEMO_ACCOUNTS.map(entry => second.findById(entry.customerId)?.passwordHash)).toEqual(before)
    // The re-opened store still authenticates: the rows were reused, not blanked.
    const login = await call(second.port, '/login', { method: 'POST', body: { accountName: 'gold', password: 'gold123' } })
    expect(login.status).toBe(200)
  })
})
