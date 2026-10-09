/**
 * Issue #8 acceptance: 退款 — the fixed rules that decide it, the one-time 凭证
 * 人工还宝 introduced (ADR-0002), and the action that marks the Order.
 *
 * The seam is the composed application (`composition.ts`): the real store, tool
 * registry, prompt registry and web server, driven through the tool executor.
 * The refund rules read no clock — the tier and the status decide — so the
 * clock is fixed only where a recorded 退款时间 has to be compared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEMO_ORDERS } from '../plugins/store/index.js'
import { call, disposeAll } from './support.js'
import { boot, demoAccount, login, outcomeOrder, outcomeText, outcomeValue, waitForQuestion } from './composition.js'
import type { Booted } from './composition.js'

/** 铂金: a tier a refund is open to, with one Order of each status. */
const PLATINUM = 'cust-platinum'
const PLATINUM_RETURNED = 'ord-platinum-2'
const PLATINUM_IN_PROGRESS = 'ord-platinum-1'

/** 黑金: the other tier a refund is open to. */
const BLACK_GOLD = 'cust-black-gold'
const BLACK_GOLD_RETURNED = 'ord-black-gold-2'

/** Tiers a refund is not open to, each with an Order that is already 已归还. */
const SILVER = 'cust-silver'
const SILVER_RETURNED = 'ord-silver-2'
const GOLD = 'cust-gold'
const GOLD_RETURNED = 'ord-gold-2'

/** The instant a 人工还宝 validation reads {@link PLATINUM_IN_PROGRESS} inside its
 * window, so only the action the grant binds can be what refuses a refund. */
const INSIDE_RETURN_WINDOW = Date.parse(seededOrder(PLATINUM_IN_PROGRESS).rentedAt) + 1000

/** The server instant the refund tests run at, so a recorded time is exact. */
const NOW = Date.parse('2026-10-10T09:30:00+08:00')

/** {@link NOW} as the Order carries it once refunded. */
const REFUNDED_AT = '2026-10-10T09:30:00.000+08:00'

/** The verdict text issue #8 pins for a Customer whose tier qualifies. */
const ALLOWED_PLATINUM = '用户为铂金会员，允许退款'
const ALLOWED_BLACK_GOLD = '用户为黑金会员，允许退款'

/** The refusal a power bank that is still out gets, whatever the tier. */
const STILL_OUT = '不允许退款，该订单仍在进行中'

/** The refusal a tier below 铂金 gets, once the Order is back. */
const NOT_QUALIFIED = '非铂金/黑金会员，不允许退款'

/** Ten minutes after a 校验, when its grant expires. */
const GRANT_TTL = 10 * 60 * 1000

/** One 校验 verdict, as `validate_refund` publishes it. */
interface Verdict {
  readonly verdict: 'allowed' | 'denied'
  readonly text: string
}

/** One settled `refund`, as it publishes the marked Order. */
interface RefundedOrder {
  readonly order: Record<string, unknown>
}

const platinum = demoAccount('platinum')

/** Both tools this issue adds; each is driven against the same Orders. */
const NEW_TOOLS = ['validate_refund', 'refund']

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

/**
 * Log one demo account in and mint the Agent its Session drives.
 * @param app - the booted composition.
 * @param accountName - the demo account to log in.
 * @returns the caller and the Customer id the login bound.
 */
async function callerFor(app: Booted, accountName: string) {
  const { sessionId } = await login(app.port, demoAccount(accountName))
  return app.agent(sessionId)
}

beforeEach(() => {
  // Only `Date` is faked: the Card's poll and the HTTP calls underneath need
  // real timers, and the recorded 退款时间 is the only thing here that reads one.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await disposeAll()
})

describe('the fixed rules for 退款', () => {
  it('allows 铂金 and 黑金 on a returned Order, naming the Customer’s own tier', async () => {
    const app = await boot()
    const cases = [
      ['platinum', PLATINUM_RETURNED, ALLOWED_PLATINUM],
      ['blackgold', BLACK_GOLD_RETURNED, ALLOWED_BLACK_GOLD],
    ] as const

    for (const [account, orderId, text] of cases) {
      const caller = await callerFor(app, account)
      const verdict = await run(app, caller, 'validate_refund', { orderId })
      expect(verdict.isError).toBe(false)
      expect(outcomeValue<Verdict>(verdict)).toEqual({ verdict: 'allowed', text })
      expect(outcomeText(verdict)).toContain(text)
    }
  })

  it('refuses a tier below 铂金 on an Order that is already 已归还', async () => {
    const app = await boot()
    const cases = [['silver', SILVER, SILVER_RETURNED], ['gold', GOLD, GOLD_RETURNED]] as const

    for (const [account, customerId, orderId] of cases) {
      const caller = await callerFor(app, account)
      const verdict = await run(app, caller, 'validate_refund', { orderId })
      expect(outcomeValue<Verdict>(verdict)).toEqual({ verdict: 'denied', text: NOT_QUALIFIED })
      expect(outcomeText(verdict)).toContain(NOT_QUALIFIED)

      // A refused validation issues nothing, so the action has nothing to spend.
      const refused = await run(app, caller, 'refund', { orderId })
      expect(refused.isError).toBe(true)
      expect(outcomeText(refused)).toContain('凭证')
      expect(app.order(customerId, orderId)?.refundedAt).toBeUndefined()
    }
  })

  it('refuses a qualifying tier while the Order is still 进行中', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'platinum')

    // The tier alone is not the rule: a power bank that is still out cannot have
    // its money returned, so the same Customer is refused on this Order.
    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_refund', { orderId: PLATINUM_IN_PROGRESS })))
      .toEqual({ verdict: 'denied', text: STILL_OUT })

    const refused = await run(app, caller, 'refund', { orderId: PLATINUM_IN_PROGRESS })
    expect(refused.isError).toBe(true)
    expect(app.order(PLATINUM, PLATINUM_IN_PROGRESS)?.refundedAt).toBeUndefined()
  })

  it('reads the status before the tier, so 进行中 is never called a tier problem', async () => {
    const app = await boot()
    // 白银's in-progress Order fails both conditions; the status is what the
    // Customer is told, because that is what the rule reads first.
    const caller = await callerFor(app, 'silver')

    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_refund', { orderId: 'ord-silver-1' })))
      .toEqual({ verdict: 'denied', text: STILL_OUT })
    // And the tier refusal is what is left once the Order is back.
    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_refund', { orderId: SILVER_RETURNED })))
      .toEqual({ verdict: 'denied', text: NOT_QUALIFIED })
  })
})

describe('the grant a passing 校验 issues', () => {
  it('is spent by the refund it authorises, and only once', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'platinum')
    vi.setSystemTime(NOW)
    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_refund', { orderId: PLATINUM_RETURNED })).verdict)
      .toBe('allowed')

    expect((await run(app, caller, 'refund', { orderId: PLATINUM_RETURNED })).isError).toBe(false)
    expect(app.order(PLATINUM, PLATINUM_RETURNED)?.refundedAt).toBe(REFUNDED_AT)

    // The same grant asked for the same Order again: it was used, so nothing
    // runs — and the recorded time proves the mark was not written twice.
    vi.setSystemTime(NOW + 60 * 1000)
    const again = await run(app, caller, 'refund', { orderId: PLATINUM_RETURNED })
    expect(again.isError).toBe(true)
    expect(outcomeText(again)).toContain('凭证')
    expect(app.order(PLATINUM, PLATINUM_RETURNED)?.refundedAt).toBe(REFUNDED_AT)
  })

  it('is still good at exactly ten minutes', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'platinum')
    vi.setSystemTime(NOW)
    await run(app, caller, 'validate_refund', { orderId: PLATINUM_RETURNED })

    vi.setSystemTime(NOW + GRANT_TTL)
    expect((await run(app, caller, 'refund', { orderId: PLATINUM_RETURNED })).isError).toBe(false)
    expect(app.order(PLATINUM, PLATINUM_RETURNED)?.refundedAt).toBe('2026-10-10T09:40:00.000+08:00')
  })

  it('is refused a millisecond past ten minutes, and changes nothing', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'blackgold')
    vi.setSystemTime(NOW)
    await run(app, caller, 'validate_refund', { orderId: BLACK_GOLD_RETURNED })

    vi.setSystemTime(NOW + GRANT_TTL + 1)
    const late = await run(app, caller, 'refund', { orderId: BLACK_GOLD_RETURNED })
    expect(late.isError).toBe(true)
    expect(outcomeText(late)).toContain('过期')
    expect(app.order(BLACK_GOLD, BLACK_GOLD_RETURNED)?.refundedAt).toBeUndefined()
  })

  it('dies when the Order changes under it', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'platinum')
    vi.setSystemTime(NOW)
    await run(app, caller, 'validate_refund', { orderId: PLATINUM_RETURNED })

    // The back office (issue #9) rewrites the same Order row in the meantime.
    const byTheBackOffice = '2026-10-08T20:00:00.000+08:00'
    await app.markReturned(PLATINUM, PLATINUM_RETURNED, byTheBackOffice)

    const stale = await run(app, caller, 'refund', { orderId: PLATINUM_RETURNED })
    expect(stale.isError).toBe(true)
    expect(outcomeText(stale)).toContain('变更')
    // The stale grant wrote nothing, so the back office's record stands.
    expect(app.order(PLATINUM, PLATINUM_RETURNED)).toMatchObject({ returnedAt: byTheBackOffice })
    expect(app.order(PLATINUM, PLATINUM_RETURNED)?.refundedAt).toBeUndefined()
  })

  it('authorises the action it was issued for, and not the other one', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'blackgold')
    vi.setSystemTime(NOW)
    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_refund', { orderId: BLACK_GOLD_RETURNED })).verdict)
      .toBe('allowed')

    // A 退款 grant is not a 人工还宝 grant: the action that did not earn it is
    // refused for want of its own.
    const other = await run(app, caller, 'manual_return', { orderId: BLACK_GOLD_RETURNED })
    expect(other.isError).toBe(true)
    expect(outcomeText(other)).toContain('凭证')
    expect(app.order(BLACK_GOLD, BLACK_GOLD_RETURNED)?.returnedAt).toBeUndefined()

    // And the refused attempt did not spend the grant: the refund it authorises
    // still runs.
    expect((await run(app, caller, 'refund', { orderId: BLACK_GOLD_RETURNED })).isError).toBe(false)
    expect(app.order(BLACK_GOLD, BLACK_GOLD_RETURNED)?.refundedAt).toBe(REFUNDED_AT)
  })

  it('is not what a 人工还宝 grant hands the refund tool', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'platinum')
    // Inside the two-hour window, so the 人工还宝 校验 passes and issues a grant.
    vi.setSystemTime(INSIDE_RETURN_WINDOW)
    expect(outcomeValue<Verdict>(await run(app, caller, 'validate_manual_return', { orderId: PLATINUM_IN_PROGRESS }))
      .verdict).toBe('allowed')

    const refused = await run(app, caller, 'refund', { orderId: PLATINUM_IN_PROGRESS })
    expect(refused.isError).toBe(true)
    expect(outcomeText(refused)).toContain('凭证')
    expect(app.order(PLATINUM, PLATINUM_IN_PROGRESS)?.refundedAt).toBeUndefined()
  })

  it('refuses with no validation behind it, and changes nothing', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'platinum')

    const bare = await run(app, caller, 'refund', { orderId: PLATINUM_RETURNED })
    expect(bare.isError).toBe(true)
    expect(outcomeText(bare)).toContain('校验')
    expect(app.order(PLATINUM, PLATINUM_RETURNED)).toMatchObject({ status: 'returned' })
    expect(app.order(PLATINUM, PLATINUM_RETURNED)?.refundedAt).toBeUndefined()
  })
})

describe('refund', () => {
  it('marks the whole Order amount refunded, and leaves the status alone', async () => {
    const app = await boot()
    const { sessionId } = await login(app.port, platinum)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(NOW)
    await run(app, caller, 'validate_refund', { orderId: PLATINUM_RETURNED })

    const outcome = await run(app, caller, 'refund', { orderId: PLATINUM_RETURNED })
    expect(outcome.isError).toBe(false)
    expect(outcomeValue<RefundedOrder>(outcome)).toEqual({
      order: {
        orderId: PLATINUM_RETURNED,
        location: seededOrder(PLATINUM_RETURNED).location,
        rentedAt: seededOrder(PLATINUM_RETURNED).rentedAt,
        amountCents: seededOrder(PLATINUM_RETURNED).amountCents,
        status: 'returned',
        refundedAt: REFUNDED_AT,
      },
    })
    const said = outcomeText(outcome)
    expect(said).toContain('已退款')
    expect(said).toContain('¥9.00')
    expect(said).toContain('退款时间 2026-10-10 09:30')
    expect(said).not.toContain(PLATINUM)

    // 物 and 钱 are two things: the money is back, the rental is still 已归还.
    expect(app.order(PLATINUM, PLATINUM_RETURNED)).toMatchObject({ status: 'returned', refundedAt: REFUNDED_AT })
  })

  it('shows the mark on the card, and on every later query about that Order', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, platinum)
    const caller = await app.agent(sessionId)
    vi.setSystemTime(NOW)
    await run(app, caller, 'validate_refund', { orderId: PLATINUM_RETURNED })
    await run(app, caller, 'refund', { orderId: PLATINUM_RETURNED })

    const running = run(app, caller, 'search_orders', { location: '深圳湾' })
    const question = await waitForQuestion(app.port, cookie)
    expect(question.candidates).toEqual([{
      orderId: PLATINUM_RETURNED,
      location: seededOrder(PLATINUM_RETURNED).location,
      rentedAt: seededOrder(PLATINUM_RETURNED).rentedAt,
      amountCents: seededOrder(PLATINUM_RETURNED).amountCents,
      status: 'returned',
      statusLabel: '已归还',
      refundedAt: REFUNDED_AT,
    }])
    await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: PLATINUM_RETURNED },
    })
    expect(outcomeOrder(await running)).toMatchObject({ status: 'returned', refundedAt: REFUNDED_AT })
  })

  it('keeps the mark when the store is opened again', async () => {
    const first = await boot()
    const caller = await callerFor(first, 'platinum')
    vi.setSystemTime(NOW)
    await run(first, caller, 'validate_refund', { orderId: PLATINUM_RETURNED })
    await run(first, caller, 'refund', { orderId: PLATINUM_RETURNED })
    await first.dispose()

    // The mark is a stored field, not process state: a restarted demo shows the
    // same 已退款 badge, and the row the grant's change reading compares stays
    // the one the Order really has.
    const second = await boot({ storageRoot: first.storageRoot })
    expect(second.order(PLATINUM, PLATINUM_RETURNED)).toMatchObject({
      status: 'returned',
      refundedAt: REFUNDED_AT,
    })
  })

  it('refuses an Order that belongs to another Customer', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'silver')

    for (const name of NEW_TOOLS) {
      const outcome = await run(app, caller, name, { orderId: PLATINUM_RETURNED })
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain(PLATINUM_RETURNED)
    }
    expect(app.order(PLATINUM, PLATINUM_RETURNED)?.refundedAt).toBeUndefined()
  })

  it('refuses an Order that does not exist', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'platinum')

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

    for (const name of NEW_TOOLS) {
      const outcome = await run(app, caller, name, { orderId: PLATINUM_RETURNED })
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain('没有绑定客户')
    }
  })

  it('rejects arguments it cannot use, including a customer id', async () => {
    const app = await boot()
    const caller = await callerFor(app, 'platinum')

    const rejected: readonly [unknown, string][] = [
      [[], '参数必须是一个对象'],
      [{ orderId: 7 }, 'orderId'],
      [{ orderId: '' }, 'orderId'],
      [{ customerId: SILVER, orderId: PLATINUM_RETURNED }, '未知参数：customerId'],
      // The shape a model reaches for when it wants the rule out of the way.
      [{ orderId: PLATINUM_RETURNED, tier: 'black_gold' }, '未知参数：tier'],
    ]
    for (const name of NEW_TOOLS) {
      for (const [args, expected] of rejected) {
        const outcome = await run(app, caller, name, args)
        expect(outcome.isError).toBe(true)
        expect(outcomeText(outcome)).toContain(expected)
      }
    }
    expect(app.order(PLATINUM, PLATINUM_RETURNED)?.refundedAt).toBeUndefined()
  })
})

describe('the tools this issue adds to the allowlist', () => {
  it('offers both of them beside the three that were already there', async () => {
    const app = await boot()
    const caller = await app.agent('session-1')

    const offered = await app.offered(caller)
    expect([...offered.tools].sort()).toEqual([
      'manual_return',
      'refund',
      'search_orders',
      'validate_manual_return',
      'validate_refund',
    ])

    for (const name of ['refund_all', 'run_code', 'bash', 'subagent']) {
      expect(offered.tools).not.toContain(name)
      const outcome = await run(app, caller, name, { orderId: PLATINUM_RETURNED })
      expect(outcome.isError).toBe(true)
      expect(outcomeText(outcome)).toContain(`unknown tool "${name}"`)
    }
  })
})
