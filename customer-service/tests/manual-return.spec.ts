/**
 * Issue #7 acceptance: 人工还宝 — the fixed rules that decide it, the one-time
 * grant a passing 校验 issues, and the action that grant authorises.
 *
 * The seam is the composed application (`composition.ts`): the real store, tool
 * registry, prompt registry and web server, driven through the tool executor —
 * the enforcement point the harness itself names. The server clock is the one
 * other input these rules read, so `vi.setSystemTime` moves it and the seeded
 * Order's rental time fixes where the two-hour window closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEMO_ORDERS } from '../plugins/store/index.js'
import { call, disposeAll } from './support.js'
import { boot, demoAccount, login, outcomeOrder, outcomeText, outcomeValue, waitForQuestion } from './composition.js'
import type { Booted } from './composition.js'

/** The Customer both silver Orders belong to. */
const CUSTOMER = 'cust-silver'

/** Silver's in-progress Order: the one 人工还宝 is exercised on. */
const ORDER = 'ord-silver-1'

/** Silver's other Order, already 已归还. */
const RETURNED_ORDER = 'ord-silver-2'

/** Gold's in-progress Order, which silver's Session must never reach. */
const OTHER_CUSTOMERS_ORDER = 'ord-gold-1'

/** The instant {@link ORDER} was rented, as the seeded row records it. */
const RENTED_AT = Date.parse(seededOrder(ORDER).rentedAt)

/** The moment the two-hour window closes — the boundary the ticket pins. */
const WINDOW_CLOSES = RENTED_AT + 2 * 60 * 60 * 1000

/** Ten minutes after a 校验, when its grant expires. */
const GRANT_TTL = 10 * 60 * 1000

/** The verdict text the ticket pins for a return inside the window. */
const ALLOWED = '允许人工还宝'

/** The verdict text it pins for a rental older than the window. */
const TOO_OLD = '不允许人工还宝，借出时间已超过两小时'

/** The verdict text it pins for an Order that is already closed. */
const ALREADY_RETURNED = '不允许人工还宝，该订单已归还'

/** The instant {@link WINDOW_CLOSES} reads as, in the zone the demo speaks. */
const CLOSES_AT = '2026-10-08T21:24:00.000+08:00'

/** One 校验 verdict, as `validate_manual_return` publishes it. */
interface Verdict {
  readonly verdict: 'allowed' | 'denied'
  readonly text: string
}

/** One settled `manual_return`, as it publishes the closed Order. */
interface ReturnedOrder {
  readonly order: Record<string, unknown>
}

const silver = demoAccount('silver')

/** Both tools this issue adds; each is driven against the same Order. */
const NEW_TOOLS = ['validate_manual_return', 'manual_return']

/**
 * One seeded Order row.
 * @param orderId - the Order to find.
 * @returns the seeded row.
 */
function seededOrder(orderId: string) {
  const order = DEMO_ORDERS.find(candidate => candidate.orderId === orderId)
  if (order === undefined) throw new Error(`the demo seeds no Order "${orderId}"`)
  return order
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

beforeEach(() => {
  // Only `Date` is faked: the Card's poll and the HTTP calls underneath need
  // real timers, and the rules are the only thing here that reads a clock.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await disposeAll()
})

describe('the fixed rules for 人工还宝', () => {
  it('allows a return at or inside two hours, and refuses one past it', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    const verdictAt = async (instant: number) => {
      vi.setSystemTime(instant)
      return run(app, caller, 'validate_manual_return', { orderId: ORDER })
    }

    // The same Order flips with the server clock alone: nothing the model sends
    // is part of the reading.
    expect(outcomeValue<Verdict>(await verdictAt(WINDOW_CLOSES - 1))).toEqual({ verdict: 'allowed', text: ALLOWED })
    // 恰好两小时判为允许, so the closed window is still inside it.
    expect(outcomeValue<Verdict>(await verdictAt(WINDOW_CLOSES))).toEqual({ verdict: 'allowed', text: ALLOWED })
    const past = await verdictAt(WINDOW_CLOSES + 1)
    expect(past.isError).toBe(false)
    expect(outcomeValue<Verdict>(past)).toEqual({ verdict: 'denied', text: TOO_OLD })
    expect(outcomeText(past)).toContain(TOO_OLD)
  })

  it('refuses an Order that is already 已归还, whatever the clock says', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    // Inside the window the time rule would allow this one, and well past it the
    // time rule would refuse it: either way the answer is the status, because a
    // returned rental is closed rather than late.
    for (const instant of [Date.parse(seededOrder(RETURNED_ORDER).rentedAt) + 1, WINDOW_CLOSES + 30 * 24 * 60 * 60 * 1000]) {
      vi.setSystemTime(instant)
      const verdict = await run(app, caller, 'validate_manual_return', { orderId: RETURNED_ORDER })
      expect(outcomeValue<Verdict>(verdict)).toEqual({ verdict: 'denied', text: ALREADY_RETURNED })
    }

    // A refused validation authorises nothing.
    const refused = await run(app, caller, 'manual_return', { orderId: RETURNED_ORDER })
    expect(refused.isError).toBe(true)
    expect(app.order(CUSTOMER, RETURNED_ORDER)?.returnedAt).toBeUndefined()
  })
})

describe('the grant a passing 校验 issues', () => {
  it('authorises the Order it was issued for, and no other', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)

    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_manual_return', { orderId: ORDER }))).toEqual({
      verdict: 'allowed',
      text: ALLOWED,
    })

    const other = await run(app, caller, 'manual_return', { orderId: RETURNED_ORDER })
    expect(other.isError).toBe(true)
    expect(outcomeText(other)).toContain(RETURNED_ORDER)
    expect(outcomeText(other)).toContain('凭证')
    expect(app.order(CUSTOMER, RETURNED_ORDER)?.returnedAt).toBeUndefined()

    // The refused attempt did not spend the grant: its own Order still closes.
    expect((await run(app, caller, 'manual_return', { orderId: ORDER })).isError).toBe(false)
    expect(app.order(CUSTOMER, ORDER)?.status).toBe('returned')
  })

  it('authorises the Session it was issued in, and no other', async () => {
    const app = await boot()
    // Two logins for one Customer: the second Session is a different Session,
    // which is the binding under test.
    const first = await login(app.port, silver)
    const second = await login(app.port, silver)
    const firstAgent = await app.agent(first.sessionId)
    const secondAgent = await app.agent(second.sessionId)
    vi.setSystemTime(WINDOW_CLOSES)

    await run(app, firstAgent, 'validate_manual_return', { orderId: ORDER })
    const elsewhere = await run(app, secondAgent, 'manual_return', { orderId: ORDER })
    expect(elsewhere.isError).toBe(true)
    expect(outcomeText(elsewhere)).toContain('凭证')
    expect(app.order(CUSTOMER, ORDER)?.status).toBe('in_progress')

    expect((await run(app, firstAgent, 'manual_return', { orderId: ORDER })).isError).toBe(false)
    expect(app.order(CUSTOMER, ORDER)?.status).toBe('returned')
  })

  it('is spent by the action it authorises', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)
    await run(app, caller, 'validate_manual_return', { orderId: ORDER })

    expect((await run(app, caller, 'manual_return', { orderId: ORDER })).isError).toBe(false)
    expect(app.order(CUSTOMER, ORDER)?.returnedAt).toBe(CLOSES_AT)

    // A minute later the same grant is asked for the same Order again: it was
    // used, so nothing happens — and the recorded return time proves the write
    // did not run a second time.
    vi.setSystemTime(WINDOW_CLOSES + 60 * 1000)
    const again = await run(app, caller, 'manual_return', { orderId: ORDER })
    expect(again.isError).toBe(true)
    expect(outcomeText(again)).toContain('凭证')
    expect(app.order(CUSTOMER, ORDER)?.returnedAt).toBe(CLOSES_AT)
  })

  it('is still good at exactly ten minutes, and expired a millisecond later', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)
    await run(app, caller, 'validate_manual_return', { orderId: ORDER })

    vi.setSystemTime(WINDOW_CLOSES + GRANT_TTL)
    expect((await run(app, caller, 'manual_return', { orderId: ORDER })).isError).toBe(false)
    expect(app.order(CUSTOMER, ORDER)?.status).toBe('returned')
  })

  it('is refused a millisecond past ten minutes, and changes nothing', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)
    await run(app, caller, 'validate_manual_return', { orderId: ORDER })

    vi.setSystemTime(WINDOW_CLOSES + GRANT_TTL + 1)
    const late = await run(app, caller, 'manual_return', { orderId: ORDER })
    expect(late.isError).toBe(true)
    expect(outcomeText(late)).toContain('过期')
    expect(app.order(CUSTOMER, ORDER)).toMatchObject({ status: 'in_progress' })
    expect(app.order(CUSTOMER, ORDER)?.returnedAt).toBeUndefined()
  })

  it('is taken back by a later 校验 that refuses', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)
    await run(app, caller, 'validate_manual_return', { orderId: ORDER })

    // The window shuts between the two validations. What the agent holds must
    // follow the newest verdict, or it would close an Order it has just been
    // told it may not close.
    vi.setSystemTime(WINDOW_CLOSES + 1)
    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_manual_return', { orderId: ORDER })).verdict).toBe('denied')

    const afterRefusal = await run(app, caller, 'manual_return', { orderId: ORDER })
    expect(afterRefusal.isError).toBe(true)
    expect(outcomeText(afterRefusal)).toContain('凭证')
    expect(app.order(CUSTOMER, ORDER)).toMatchObject({ status: 'in_progress' })
    expect(app.order(CUSTOMER, ORDER)?.returnedAt).toBeUndefined()
  })

  it('closes an Order validated inside the window, even once the window has shut', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)
    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_manual_return', { orderId: ORDER })))
      .toEqual({ verdict: 'allowed', text: ALLOWED })

    // Five minutes on, the rental is past two hours — and the verdict stands:
    // the rules are read once, at 校验, and the grant's ten minutes are how long
    // that reading holds (ADR-0009). Asking again in the meantime is what takes
    // it back, and only that.
    vi.setSystemTime(WINDOW_CLOSES + 5 * 60 * 1000)
    expect((await run(app, caller, 'manual_return', { orderId: ORDER })).isError).toBe(false)
    expect(app.order(CUSTOMER, ORDER)?.returnedAt).toBe('2026-10-08T21:29:00.000+08:00')
  })

  it('dies when the Order changes under it', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)
    await run(app, caller, 'validate_manual_return', { orderId: ORDER })

    // The Order is closed by someone else in the meantime — the back office
    // (issue #9) closes Orders through this same write.
    const byTheBackOffice = '2026-10-08T20:00:00.000+08:00'
    await app.markReturned(CUSTOMER, ORDER, byTheBackOffice)

    const stale = await run(app, caller, 'manual_return', { orderId: ORDER })
    expect(stale.isError).toBe(true)
    expect(outcomeText(stale)).toContain('变更')
    // The stale grant wrote nothing, so the back office's record stands.
    expect(app.order(CUSTOMER, ORDER)?.returnedAt).toBe(byTheBackOffice)
  })
})

describe('manual_return', () => {
  it('closes the Order, records the return time, and shows both afterwards', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)
    await run(app, caller, 'validate_manual_return', { orderId: ORDER })

    const outcome = await run(app, caller, 'manual_return', { orderId: ORDER })
    expect(outcome.isError).toBe(false)
    expect(outcomeValue<ReturnedOrder>(outcome)).toEqual({
      order: {
        orderId: ORDER,
        location: seededOrder(ORDER).location,
        rentedAt: seededOrder(ORDER).rentedAt,
        amountCents: seededOrder(ORDER).amountCents,
        status: 'returned',
        returnedAt: CLOSES_AT,
      },
    })
    const said = outcomeText(outcome)
    expect(said).toContain('已归还')
    expect(said).toContain('归还时间 2026-10-08 21:24')
    // The model is told what happened, never the owner key it cannot use.
    expect(said).not.toContain(CUSTOMER)

    expect(app.order(CUSTOMER, ORDER)).toMatchObject({ status: 'returned', returnedAt: CLOSES_AT })

    // And the next conversation about this Order says so: the same query that
    // used to card it as 进行中 now cards it as 已归还, with the return time.
    const running = run(app, caller, 'search_orders', { location: '万象城' })
    const question = await waitForQuestion(app.port, cookie)
    expect(question.candidates).toEqual([{
      orderId: ORDER,
      location: seededOrder(ORDER).location,
      rentedAt: seededOrder(ORDER).rentedAt,
      amountCents: seededOrder(ORDER).amountCents,
      status: 'returned',
      statusLabel: '已归还',
      returnedAt: CLOSES_AT,
    }])
    await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: ORDER },
    })
    expect(outcomeOrder(await running)).toMatchObject({ status: 'returned', returnedAt: CLOSES_AT })
  })

  it('refuses with no validation behind it, and changes nothing', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    // Inside the window, so only the missing grant can be what refuses this.
    vi.setSystemTime(WINDOW_CLOSES)
    const bare = await run(app, caller, 'manual_return', { orderId: ORDER })
    expect(bare.isError).toBe(true)
    expect(outcomeText(bare)).toContain('校验')
    expect(app.order(CUSTOMER, ORDER)).toMatchObject({ status: 'in_progress' })
    expect(app.order(CUSTOMER, ORDER)?.returnedAt).toBeUndefined()

    // A validation that said no issues nothing, so the action is refused too —
    // however the Customer asks for it, there is no way round the rule.
    vi.setSystemTime(WINDOW_CLOSES + 1)
    const denied = await run(app, caller, 'validate_manual_return', { orderId: ORDER })
    expect(outcomeValue<Verdict>(denied).verdict).toBe('denied')
    const afterDenial = await run(app, caller, 'manual_return', { orderId: ORDER })
    expect(afterDenial.isError).toBe(true)
    expect(outcomeText(afterDenial)).toContain('校验')
    expect(app.order(CUSTOMER, ORDER)).toMatchObject({ status: 'in_progress' })
    expect(app.order(CUSTOMER, ORDER)?.returnedAt).toBeUndefined()
  })

  it('refuses an Order that belongs to another Customer', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)

    for (const name of NEW_TOOLS) {
      const outcome = await run(app, caller, name, { orderId: OTHER_CUSTOMERS_ORDER })
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain(OTHER_CUSTOMERS_ORDER)
    }
    expect(app.order('cust-gold', OTHER_CUSTOMERS_ORDER)).toMatchObject({ status: 'in_progress' })
    expect(app.order('cust-gold', OTHER_CUSTOMERS_ORDER)?.returnedAt).toBeUndefined()
  })

  it('refuses an Order that does not exist', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)

    for (const name of NEW_TOOLS) {
      const outcome = await run(app, caller, name, { orderId: 'ord-nobody' })
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain('ord-nobody')
      expect(outcomeText(outcome)).toContain('不存在')
    }
  })

  it('refuses in a Session with no Customer', async () => {
    const app = await boot()
    const caller = await app.agent('session-unbound')
    vi.setSystemTime(WINDOW_CLOSES)

    for (const name of NEW_TOOLS) {
      const outcome = await run(app, caller, name, { orderId: ORDER })
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain('没有绑定客户')
    }
  })

  it('rejects arguments it cannot use, including a customer id', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(WINDOW_CLOSES)

    const rejected: readonly [unknown, string][] = [
      [[], '参数必须是一个对象'],
      [{ orderId: 7 }, 'orderId'],
      [{ orderId: '' }, 'orderId'],
      [{ customerId: 'cust-gold', orderId: ORDER }, '未知参数：customerId'],
      // The shape a model reaches for when it wants the rule out of the way.
      [{ orderId: ORDER, force: true }, '未知参数：force'],
    ]
    for (const name of NEW_TOOLS) {
      for (const [args, expected] of rejected) {
        const outcome = await run(app, caller, name, args)
        expect(outcome.isError).toBe(true)
        expect(outcomeText(outcome)).toContain(expected)
      }
    }
    expect(app.order(CUSTOMER, ORDER)).toMatchObject({ status: 'in_progress' })
  })
})

describe('the tools this issue adds to the allowlist', () => {
  it('offers both of them, and keeps every other tool out of reach', async () => {
    const app = await boot()
    const caller = await app.agent('session-1')

    const offered = await app.offered(caller)
    expect(offered.tools).toContain('validate_manual_return')
    expect(offered.tools).toContain('manual_return')
    for (const name of ['refund', 'run_code', 'bash', 'subagent']) {
      expect(offered.tools).not.toContain(name)
      const outcome = await run(app, caller, name, { orderId: ORDER })
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain(`unknown tool "${name}"`)
    }
  })
})
