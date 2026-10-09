/**
 * Shared seam for this directory's host-plugin suites: the service lookups both
 * compositions read back, and the HTTP/cookie plumbing both drive.
 *
 * The plugins under test are plain JavaScript, so nothing declares the services
 * they publish. The augmentation below is that declaration — it is what makes
 * `ctx.get('customerStore')` a typed read rather than a cast, and both suites
 * see it because both import this module.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One stored Order row, as `plugins/store` returns it. */
export interface StoredOrder {
  readonly orderId: string
  readonly customerId: string
  readonly location: string
  readonly amountCents: number
  readonly rentedAt: string
  readonly status: string
  /** The return time, present only once the Order has been closed. */
  readonly returnedAt?: string
  /** The refund time, present only once the Order's money has been returned. */
  readonly refundedAt?: string
}

/** The Customer and Order service published by `plugins/store`. */
export interface CustomerStore {
  /** Read one Customer row, or `undefined` when no such Customer exists. */
  findById(customerId: string): Record<string, unknown> | undefined
  /**
   * Read one Customer's own Orders, newest first.
   * @param customerId - the owning Customer, never a caller-supplied value.
   * @param filter - `location` as a substring, and inclusive ISO-8601 bounds;
   *   an absent field does not narrow the search.
   * @returns the matching Orders.
   */
  searchOrders(customerId: string, filter: Record<string, string | undefined>): StoredOrder[]
  /**
   * Read one of a Customer's own Orders by its number.
   * @param customerId - the owning Customer, never a caller-supplied value.
   * @param orderId - the Order number.
   * @returns the Order row, or `undefined` when this Customer owns no such Order.
   */
  findOrder(customerId: string, orderId: string): StoredOrder | undefined
  /**
   * Close one of a Customer's own Orders.
   * @param customerId - the owning Customer, never a caller-supplied value.
   * @param orderId - the Order number.
   * @param returnedAt - the return time, an offset-carrying ISO-8601 stamp.
   * @returns the stored Order as it now stands, or `undefined` when this
   *   Customer owns no such Order and nothing was written.
   */
  markReturned(customerId: string, orderId: string, returnedAt: string): Promise<StoredOrder | undefined>
  /**
   * Mark one of a Customer's own Orders refunded, leaving its status alone.
   * @param customerId - the owning Customer, never a caller-supplied value.
   * @param orderId - the Order number.
   * @param refundedAt - the refund time, an offset-carrying ISO-8601 stamp.
   * @returns the stored Order as it now stands, or `undefined` when this
   *   Customer owns no such Order and nothing was written.
   */
  markRefunded(customerId: string, orderId: string, refundedAt: string): Promise<StoredOrder | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    customerStore: CustomerStore
  }
}

/**
 * Read one service the composition must have published.
 * @param ctx - the composed application.
 * @param name - the service name its plugin registered.
 * @returns the published service.
 */
export function requireService<K extends string & keyof Context>(ctx: Context, name: K): Context[K] {
  const service = ctx.get(name)
  if (service === undefined) throw new Error(`the composition published no "${name}" service`)
  return service
}

/** One HTTP answer, as these suites read one. */
export interface Answer {
  readonly status: number
  readonly setCookie: string | undefined
  /** The parsed JSON body, or `undefined` for an empty one. */
  readonly body: unknown
}

/**
 * Call one customer-service route.
 * @param port - the listening port.
 * @param path - path below the plugin's route prefix.
 * @param init - the method, JSON body, and login cookie to send.
 * @returns the status, the `set-cookie` header, and the parsed JSON body.
 */
export async function call(
  port: number,
  path: string,
  init: { method?: string, body?: unknown, cookie?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.cookie !== undefined) headers.cookie = init.cookie
  const response = await fetch(`http://127.0.0.1:${port}/customer-service${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
  })
  const text = await response.text()
  return {
    status: response.status,
    setCookie: response.headers.get('set-cookie') ?? undefined,
    body: text === '' ? undefined : JSON.parse(text),
  }
}

/**
 * Read a response body as the fields its route documents.
 * @param answer - the response to read.
 * @returns the body, typed by the caller.
 */
export function bodyOf<T>(answer: Answer): T {
  return answer.body as T
}

/**
 * The `name=value` half of a `set-cookie` header, as a request would send it.
 * @param setCookie - the response header, when the response set one.
 * @returns the cookie pair, or `''`.
 */
export function cookieValue(setCookie: string | undefined): string {
  return (setCookie ?? '').split(';')[0] ?? ''
}

const cleanups: (() => Promise<void> | void)[] = []

/**
 * Register teardown for the composition a test booted.
 * @param dispose - the composition's own teardown.
 */
export function registerCleanup(dispose: () => Promise<void> | void): void {
  cleanups.push(dispose)
}

/** Run every registered teardown, most recent first. For `afterEach`. */
export async function disposeAll(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()!()
}

/** An Agent double: an id, a Session id, and the context slot its scope fills. */
export interface AgentDouble {
  readonly id: SessionId
  readonly session: { readonly id: SessionId }
  ctx?: Context
}

/**
 * Build the Agent double these suites drive. The harness's own Agent contract
 * is far wider than the plugins under test read (they take an id, a Session id,
 * and the Agent-scoped context), so a double stands in for it.
 * @param sessionId - the harness Session id the Agent is identified by.
 * @returns the double, whose `ctx` the caller sets once its scope is minted.
 */
export function agentDouble(sessionId: string): AgentDouble {
  return { id: sessionId as SessionId, session: { id: sessionId as SessionId } }
}

/**
 * Hand one double to a harness-typed seam as the Agent it stands in for. The
 * double IS the object the scope was minted against — this only states that
 * identity in the type the seam declares.
 * @param double - the double to hand over.
 * @returns the same object, as an Agent.
 */
export function asAgent(double: AgentDouble): Agent {
  return double as Agent
}
