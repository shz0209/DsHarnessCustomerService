/**
 * Issue #9 acceptance: the panel — the routes a logged-in Customer drives it
 * with, and the Orders they create and close through it.
 *
 * The seam is the composed application (`composition.ts`) driven over real
 * HTTP, because the one thing this ticket is emphatic about is that the panel's
 * authority is the server's: the browser shows one Customer their own Orders,
 * and every route resolves that Customer from the login rather than from
 * anything the request carries (ADR-0004). Another Customer's Order number is
 * therefore unreachable from here, exactly as it is from the tools.
 *
 * Two clocks matter, so both are nailed down: the server's (faked, so the
 * return time and a defaulted 租借时间 are exact) and the seeded Orders' rental
 * times (frozen data, which is what the two-hour window is read against).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ALLOWED_TOOLS } from '../plugins/tools/index.js'
import { bodyOf, call, disposeAll } from './support.js'
import {
  boot, demoAccount, login, outcomeOrder, outcomeText, outcomeValue, waitForQuestion, writeStoredOrder,
} from './composition.js'
import type { Booted } from './composition.js'

/** The Customer the panel is exercised as, and whose Orders it writes. */
const silver = demoAccount('silver')

/** Another Customer, whose Orders silver's panel must never reach. */
const gold = demoAccount('gold')

/** Silver's in-progress Order, which the panel closes. */
const OPEN_ORDER = 'ord-silver-1'

/** Silver's other Order: already 已归还, so the panel may not close it again. */
const CLOSED_ORDER = 'ord-silver-2'

/** Gold's in-progress Order, which silver's panel must never reach. */
const OTHER_CUSTOMERS_ORDER = 'ord-gold-1'

/** Platinum's returned Order, the one a refund moves on to 已退款. */
const PLATINUM_RETURNED = 'ord-platinum-2'

/** The server instant every test starts from, after the seeded Orders. */
const NOW = Date.parse('2026-10-10T10:00:00+08:00')

/** {@link NOW} as the store writes it: this deployment's zone, to the second. */
const NOW_STAMP = '2026-10-10T10:00:00.000+08:00'

/** One Order as the panel's routes publish it. */
interface PanelOrder {
  readonly orderId: string
  readonly location: string
  readonly rentedAt: string
  readonly amountCents: number
  readonly status: string
  readonly statusLabel: string
  readonly returnedAt?: string
  readonly refundedAt?: string
}

/** One 校验 verdict the two-hour rule pins. */
interface Verdict {
  readonly verdict: 'allowed' | 'denied'
  readonly text: string
}

const ALLOWED_RETURN = { verdict: 'allowed', text: '允许人工还宝' }
const TOO_OLD = { verdict: 'denied', text: '不允许人工还宝，借出时间已超过两小时' }

/**
 * Create one Order through the panel's route.
 * @param app - the booted composition.
 * @param cookie - the Customer's login cookie.
 * @param body - the request body, as the panel sends it.
 * @returns the route's answer.
 */
function createOrder(app: Booted, cookie: string, body: Record<string, unknown>) {
  return call(app.port, '/orders/create', { method: 'POST', cookie, body })
}

/**
 * Close one Order through the panel's route.
 * @param app - the booted composition.
 * @param cookie - the Customer's login cookie.
 * @param orderId - the Order number the panel's button carries.
 * @returns the route's answer.
 */
function closeOrder(app: Booted, cookie: string, orderId: string) {
  return call(app.port, '/orders/return', { method: 'POST', cookie, body: { orderId } })
}

/**
 * Run one tool call as the model would.
 * @param app - the booted composition.
 * @param caller - the Agent the call runs as.
 * @param name - the tool to call.
 * @param args - its arguments.
 * @returns the settled tool call.
 */
function run(app: Booted, caller: Agent, name: string, args: unknown) {
  return app.execute(name, args, caller, new AbortController().signal)
}

/**
 * Put the newest Order of a Customer's query to them as a Card and confirm it,
 * as the opening does — the whole way from a tool call to the Order the model
 * is handed.
 * @param app - the booted composition.
 * @param cookie - the Customer's login cookie.
 * @param caller - the Customer's Agent.
 * @returns the Order the Customer confirmed.
 */
async function confirmNewest(app: Booted, cookie: string, caller: Agent): Promise<string> {
  const running = run(app, caller, 'search_orders', {})
  const question = await waitForQuestion(app.port, cookie)
  expect(question.candidates).toHaveLength(1)
  const orderId = question.candidates[0]!.orderId
  await call(app.port, '/order-question/answer', {
    method: 'POST',
    cookie,
    body: { callId: 'call-1', orderId },
  })
  expect(outcomeOrder(await running)?.orderId).toBe(orderId)
  return orderId
}

beforeEach(() => {
  // Only `Date` is faked: the Card's poll and the HTTP calls underneath need
  // real timers, and the server clock is the only thing these routes read.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(async () => {
  vi.useRealTimers()
  await disposeAll()
})

describe('the panel and the login behind it', () => {
  it('refuses a request that carries no login at all', async () => {
    const app = await boot()
    expect((await call(app.port, '/orders')).status).toBe(401)
    expect((await createOrder(app, '', { location: '万象城', amountCents: 300 })).status).toBe(401)
    expect((await call(app.port, '/orders/return', { method: 'POST', body: { orderId: OPEN_ORDER } })).status).toBe(401)
  })

  it('shows a Customer their own Orders, whatever their status, newest first', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const answer = await call(app.port, '/orders', { cookie })
    expect(answer.status).toBe(200)
    const { orders } = bodyOf<{ orders: PanelOrder[] }>(answer)
    expect(orders.map(order => order.orderId)).toEqual(['ord-silver-1', 'ord-silver-2'])
    expect(orders.map(order => order.statusLabel)).toEqual(['进行中', '已归还'])
    // The panel shows the same fields the Cards do, and no owner key: every
    // Order here is the caller's own.
    expect(orders[0]).toEqual({
      orderId: 'ord-silver-1',
      location: '万象城购物中心 B1 层服务台',
      rentedAt: '2026-10-08T19:24:00+08:00',
      amountCents: 300,
      status: 'in_progress',
      statusLabel: '进行中',
    })
    expect(JSON.stringify(answer.body)).not.toContain(silver.customerId)
  })

  it('never shows one Customer another Customer’s Orders', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const { orders } = bodyOf<{ orders: PanelOrder[] }>(await call(app.port, '/orders', { cookie }))
    expect(orders.map(order => order.orderId)).not.toContain(OTHER_CUSTOMERS_ORDER)
    expect(orders.every(order => order.orderId.startsWith('ord-silver-'))).toBe(true)
  })
})

describe('creating an Order from the panel', () => {
  it('mints the Order number, fixes the status at 进行中 and the owner at the login', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const first = await createOrder(app, cookie, {
      location: '会展中心地铁站 D 出口',
      amountCents: 450,
    })
    expect(first.status).toBe(201)
    const order = bodyOf<{ order: PanelOrder }>(first).order
    expect(order).toMatchObject({
      location: '会展中心地铁站 D 出口',
      amountCents: 450,
      status: 'in_progress',
      statusLabel: '进行中',
      rentedAt: NOW_STAMP,
    })
    expect(order.orderId).toMatch(/^ord-[0-9a-f]{8}$/)
    expect(order.returnedAt).toBeUndefined()

    // It belongs to the login, not to anything the request said: silver's own
    // query is where it turns up, and gold's is not.
    expect(app.order(silver.customerId, order.orderId)?.location).toBe('会展中心地铁站 D 出口')
    expect(app.order(gold.customerId, order.orderId)).toBeUndefined()

    // Two Orders, two numbers.
    const second = bodyOf<{ order: PanelOrder }>(await createOrder(app, cookie, {
      location: '深圳湾万象城 3 号门',
      amountCents: 200,
    })).order
    expect(second.orderId).not.toBe(order.orderId)

    // The number, the owner and the status are the server's to decide; asking
    // for any of them is a malformed request rather than an override, and
    // nothing is written.
    const before = app.searchOrders(silver.customerId).length
    for (const body of [
      { orderId: 'ord-mine', location: '万象城', amountCents: 300 },
      { customerId: gold.customerId, location: '万象城', amountCents: 300 },
      { status: 'returned', location: '万象城', amountCents: 300 },
    ]) {
      expect((await createOrder(app, cookie, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(app.searchOrders(silver.customerId)).toHaveLength(before)
  })

  it('reads a given 租借时间 as Beijing time, and defaults it to the server clock', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const given = bodyOf<{ order: PanelOrder }>(await createOrder(app, cookie, {
      location: '华强北电子市场 2 号门',
      amountCents: 200,
      rentedAt: '2026-10-09T18:40',
    })).order
    // The panel's `datetime-local` value names no zone; the demo speaks one.
    expect(given.rentedAt).toBe('2026-10-09T18:40:00.000+08:00')

    const defaulted = bodyOf<{ order: PanelOrder }>(await createOrder(app, cookie, {
      location: '宝安国际机场 T3 到达厅',
      amountCents: 500,
    })).order
    expect(defaulted.rentedAt).toBe(NOW_STAMP)

    // An empty field is the panel's "leave it to the server", not a bad value.
    const empty = bodyOf<{ order: PanelOrder }>(await createOrder(app, cookie, {
      location: '深圳湾公园欢乐海岸入口',
      amountCents: 900,
      rentedAt: '',
    })).order
    expect(empty.rentedAt).toBe(NOW_STAMP)
  })

  it('refuses a body it cannot act on, writing nothing', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const before = app.searchOrders(silver.customerId)
    const rejected: Record<string, unknown>[] = [
      { location: '', amountCents: 300 },
      { location: '   ', amountCents: 300 },
      { location: '万象城', amountCents: -1 },
      { location: '万象城', amountCents: 3.5 },
      { location: '万象城', amountCents: '300' },
      { location: '万象城' },
      { location: '万象城', amountCents: 300, rentedAt: '昨天下午' },
      { location: '万象城', amountCents: 300, rentedAt: '2026-02-31T10:00' },
      { location: '万象城', amountCents: 300, rentedAt: 20261009 },
    ]
    for (const body of rejected) {
      expect((await createOrder(app, cookie, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(app.searchOrders(silver.customerId)).toEqual(before)
  })

  it('shows the new Order in the panel straight away', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const created = bodyOf<{ order: PanelOrder }>(await createOrder(app, cookie, {
      location: '深圳北站候车厅 3 号点位',
      amountCents: 600,
    })).order
    const { orders } = bodyOf<{ orders: PanelOrder[] }>(await call(app.port, '/orders', { cookie }))
    // Newest first, which is what makes the freshly created Order the one the
    // Agent's next unfiltered query offers.
    expect(orders.map(order => order.orderId)).toEqual([created.orderId, 'ord-silver-1', 'ord-silver-2'])
  })
})

describe('returning an Order from the panel', () => {
  it('sets a 进行中 Order to 已归还 and records the return time', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const answer = await closeOrder(app, cookie, OPEN_ORDER)
    expect(answer.status).toBe(200)
    const { order } = bodyOf<{ order: PanelOrder }>(answer)
    expect(order).toMatchObject({ orderId: OPEN_ORDER, status: 'returned', statusLabel: '已归还', returnedAt: NOW_STAMP })
    // The write is the store's, and the Customer's own later query reads it.
    expect(app.order(silver.customerId, OPEN_ORDER)).toMatchObject({ status: 'returned', returnedAt: NOW_STAMP })
    const { orders } = bodyOf<{ orders: PanelOrder[] }>(await call(app.port, '/orders', { cookie }))
    expect(orders.find(candidate => candidate.orderId === OPEN_ORDER)?.statusLabel).toBe('已归还')
  })

  it('refuses an Order that is already 已归还, leaving its row alone', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    const before = app.order(silver.customerId, CLOSED_ORDER)
    expect((await closeOrder(app, cookie, CLOSED_ORDER)).status).toBe(409)
    expect(app.order(silver.customerId, CLOSED_ORDER)).toEqual(before)
  })

  it('refuses one that has been refunded, and says which status it is in', async () => {
    const app = await boot()
    const platinum = demoAccount('platinum')
    const { cookie, sessionId } = await login(app.port, platinum)
    const caller = await app.agent(sessionId)
    // The Agent refunds it, which is the only way an Order reaches 已退款.
    await run(app, caller, 'validate_refund', { orderId: PLATINUM_RETURNED })
    await run(app, caller, 'refund', { orderId: PLATINUM_RETURNED })

    const answer = await closeOrder(app, cookie, PLATINUM_RETURNED)
    expect(answer.status).toBe(409)
    // The refusal names the status the Order is really in, not 已归还.
    expect(bodyOf<{ error: string }>(answer).error).toContain('已退款')
    expect(app.order(platinum.customerId, PLATINUM_RETURNED)?.returnedAt).toBeUndefined()
  })

  it('cannot reach another Customer’s Order, and refuses a body it cannot read', async () => {
    const app = await boot()
    const { cookie } = await login(app.port, silver)
    // Another Customer's Order is not found, not forbidden: the panel is no
    // place to learn which Order numbers exist.
    expect((await closeOrder(app, cookie, OTHER_CUSTOMERS_ORDER)).status).toBe(404)
    expect(app.order(gold.customerId, OTHER_CUSTOMERS_ORDER)?.status).toBe('in_progress')
    expect((await closeOrder(app, cookie, 'ord-nope')).status).toBe(404)
    for (const body of [{}, { orderId: '' }, { orderId: 42 }, { orderId: OPEN_ORDER, force: true }]) {
      expect((await call(app.port, '/orders/return', { method: 'POST', cookie, body })).status, JSON.stringify(body))
        .toBe(400)
    }
    expect(app.order(silver.customerId, OPEN_ORDER)?.status).toBe('in_progress')
  })
})

describe('an Order refunded under the old model', () => {
  it('is carried forward to 已退款 when the store is opened again', async () => {
    const first = await boot()
    const storageRoot = first.storageRoot
    await first.dispose()
    // What a refund wrote before 已退款 was a status: the mark, with the status
    // left at 已归还. Nothing in the plugins can produce that pair any more, so
    // the row is written straight into the table.
    await writeStoredOrder(storageRoot, {
      orderId: 'ord-legacy',
      customerId: silver.customerId,
      location: '万象城购物中心 B1 层服务台',
      amountCents: 300,
      rentedAt: '2026-10-01T10:00:00+08:00',
      status: 'returned',
      refundedAt: '2026-10-09T10:00:00.000+08:00',
    })

    const second = await boot({ storageRoot })
    expect(second.order(silver.customerId, 'ord-legacy')).toMatchObject({
      status: 'refunded',
      refundedAt: '2026-10-09T10:00:00.000+08:00',
    })
    // And the Customer's panel shows it as 已退款, not as a 已归还 Order that
    // happens to carry a refund time.
    const { cookie } = await login(second.port, silver)
    const { orders } = bodyOf<{ orders: PanelOrder[] }>(await call(second.port, '/orders', { cookie }))
    expect(orders.find(order => order.orderId === 'ord-legacy')).toMatchObject({ statusLabel: '已退款' })
  })
})

describe('the demo the panel exists for', () => {
  it('makes the Order the two-hour rule refuses, and one it allows', async () => {
    const app = await boot()
    const { cookie: panelCookie } = await login(app.port, silver)
    // The Order the panel exists for: rented three hours ago, which is past the
    // window the seeded data can never demonstrate.
    const old = bodyOf<{ order: PanelOrder }>(await createOrder(app, panelCookie, {
      location: '会展中心地铁站 D 出口',
      amountCents: 300,
      rentedAt: '2026-10-10T07:00',
    })).order

    // The Customer's own conversation reaches it with no help beyond the row
    // the panel wrote: it is now the newest rental they have.
    const first = await login(app.port, silver)
    const firstAgent = await app.agent(first.sessionId)
    const refusedId = await confirmNewest(app, first.cookie, firstAgent)
    expect(refusedId).toBe(old.orderId)
    expect(outcomeValue<Verdict>(await run(app, firstAgent, 'validate_manual_return', { orderId: refusedId })))
      .toEqual(TOO_OLD)

    // Now one that is still inside the window, which the rule allows and the
    // Agent can actually close.
    const fresh = bodyOf<{ order: PanelOrder }>(await createOrder(app, panelCookie, {
      location: '万象城购物中心 B1 层服务台',
      amountCents: 300,
    })).order
    const second = await login(app.port, silver)
    const secondAgent = await app.agent(second.sessionId)
    const allowedId = await confirmNewest(app, second.cookie, secondAgent)
    expect(allowedId).toBe(fresh.orderId)
    expect(outcomeValue<Verdict>(await run(app, secondAgent, 'validate_manual_return', { orderId: allowedId })))
      .toEqual(ALLOWED_RETURN)
    const closed = await run(app, secondAgent, 'manual_return', { orderId: allowedId })
    expect(closed.isError).toBe(false)
    expect(app.order(silver.customerId, allowedId)?.status).toBe('returned')
    expect(outcomeText(closed)).toContain('已还宝')

    // The panel shows the Order the Agent just closed, 归还时间 included.
    const { orders } = bodyOf<{ orders: PanelOrder[] }>(await call(app.port, '/orders', { cookie: panelCookie }))
    expect(orders.find(order => order.orderId === allowedId))
      .toMatchObject({ status: 'returned', statusLabel: '已归还', returnedAt: NOW_STAMP })
  })

  it('leaves the Administrator’s own conversation on the five-tool allowlist', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, demoAccount('blackgold'))
    const caller = await app.agent(sessionId)
    // The panel is a surface beside the conversation, not a way into it: the
    // Administrator's Agent is masked like every other one.
    expect(app.ctx.tools.schemas(caller).map(schema => schema.name)).toEqual(ALLOWED_TOOLS)
    const bash = await run(app, caller, 'bash', { command: 'ls' })
    expect(bash.isError).toBe(true)
    expect(outcomeText(bash)).toContain('unknown tool "bash"')
  })
})
