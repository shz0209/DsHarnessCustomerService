/**
 * The composed application this directory's tool suites drive: the shipped
 * tool registry, web server, storage hub, JSON backend, domain form, and
 * prompt registry, plus this directory's `store`, `auth`, and `tools` plugins,
 * behind a real listening web server.
 *
 * Only `connection`, `sessionController`, `workspaceRegistry`, and `agents` are
 * stood in for — Agent lifecycle is the harness's, and the minter below gives
 * the tools plugin the one thing it reads off an Agent (`session.id` and a
 * scoped `ctx`).
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
import * as authPlugin from '../plugins/auth/index.js'
import * as storePlugin from '../plugins/store/index.js'
import { DEMO_ACCOUNTS } from '../plugins/store/index.js'
import * as toolsPlugin from '../plugins/tools/index.js'
import { agentDouble, asAgent, bodyOf, call, cookieValue, registerCleanup, requireService } from './support.js'
import type { StoredOrder } from './support.js'

/** The Workspace the login Session must be created in. */
const WORKSPACE_PATH = '/tmp/customer-service-demo-workspace'

/** One candidate as the order card receives it. */
export interface CandidateOrder {
  readonly orderId: string
  readonly location: string
  readonly rentedAt: string
  readonly amountCents: number
  readonly status: string
  readonly statusLabel: string
  readonly returnedAt?: string
}

/** One pending question as the card's route serves it. */
export interface OrderQuestion {
  readonly query: Record<string, string>
  readonly candidates: readonly CandidateOrder[]
}

/** One booted composition, as the tool suites drive it. */
export interface Booted {
  readonly port: number
  readonly ctx: Context
  /** An Agent that was already live when the tools plugin loaded. */
  readonly liveAgent: Agent
  /** The backend root the composition was given. */
  readonly storageRoot: string
  /** Mint an Agent for one Session and announce it, as the agent loop does. */
  agent(sessionId: string): Promise<Agent>
  searchOrders(customerId: string, filter?: Record<string, string | undefined>): StoredOrder[]
  /** Read one stored Order row, as the store's own scoped lookup returns it. */
  order(customerId: string, orderId: string): StoredOrder | undefined
  /** Close one Order through the store, as the back office does. */
  markReturned(customerId: string, orderId: string, returnedAt: string): Promise<StoredOrder | undefined>
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

/** What one boot may vary. */
export interface BootOptions {
  /** The backend root; pass one to reuse an existing store. */
  readonly storageRoot?: string
  /** Presentation the deployment's tools row declares, as a profile would. */
  readonly deploymentMode?: 'native' | 'ptc'
  /** Presentation the already-live Agent's own scope declares for itself. */
  readonly livePresentation?: 'native' | 'ptc'
}

/**
 * One demo account's credentials, as the login route takes them.
 * @param accountName - the account name the demo seeds.
 * @returns the account's name and password.
 */
export function demoAccount(accountName: string): { accountName: string, password: string } {
  const account = DEMO_ACCOUNTS.find(candidate => candidate.accountName === accountName)
  if (account === undefined) throw new Error(`no demo account named "${accountName}"`)
  return account
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
export async function boot(options: BootOptions = {}): Promise<Booted> {
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
    order: (customerId, orderId) => customerStore.findOrder(customerId, orderId),
    markReturned: (customerId, orderId, returnedAt) => customerStore.markReturned(customerId, orderId, returnedAt),
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
export async function login(port: number, account: { accountName: string, password: string }): Promise<{ cookie: string, sessionId: string }> {
  const answer = await call(port, '/login', {
    method: 'POST',
    body: { accountName: account.accountName, password: account.password },
  })
  if (answer.status !== 200) throw new Error(`login for ${account.accountName} failed with ${answer.status}`)
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
export async function waitForQuestion(port: number, cookie: string): Promise<OrderQuestion> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const answer = await call(port, '/order-question?callId=call-1', { cookie })
    if (answer.status === 200) return bodyOf<OrderQuestion>(answer)
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
  throw new Error('the order card was never published')
}

/** The text of one settled tool call, as the model would read it. */
export function outcomeText(outcome: ToolExecutionResult): string {
  return outcome.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Read one JSON value as an object, when it is one.
 * @param value - the value to read.
 * @returns its entries, or `undefined` for anything else.
 */
export function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * Read a settled call's value as the fields its own output schema documents.
 *
 * The tool that published the value validated it against that schema before the
 * harness froze it, so this states the shape the caller already knows rather
 * than casting past a check — the same reading `support.ts` gives an HTTP body.
 * @param outcome - the settled tool call.
 * @returns the value, typed by the caller.
 */
export function outcomeValue<T>(outcome: ToolExecutionResult): T {
  return outcome.value as T
}

/**
 * The Order one settled `search_orders` call published, when it published one.
 * @param outcome - the settled tool call.
 * @returns the Order's fields as the model received them, or `undefined`.
 */
export function outcomeOrder(outcome: ToolExecutionResult): Record<string, JsonValue> | undefined {
  const value = jsonRecord(outcome.value)
  return value?.outcome === 'selected' ? jsonRecord(value.order) : undefined
}
