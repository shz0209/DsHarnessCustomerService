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
import { afterEach, describe, expect, it } from 'vitest'
import { DEMO_ACCOUNTS, DEMO_ORDERS } from '../plugins/store/index.js'
import { bodyOf, call, disposeAll } from './support.js'
import { boot, demoAccount, login, outcomeOrder, outcomeText, waitForQuestion } from './composition.js'
import type { OrderQuestion } from './composition.js'

/** One demo account's credentials, as the login route takes them. */
const silver = demoAccount('silver')
const gold = demoAccount('gold')

/** Every tool this deployment allows, in the order the registry lists them. */
const ALLOWED = ['search_orders', 'validate_manual_return', 'manual_return', 'validate_refund', 'refund']

/** The same set as the assembled prompt offers it: a tool list reads by name. */
const ALLOWED_BY_NAME = [...ALLOWED].sort()

afterEach(disposeAll)

describe('the seeded Orders', () => {
  it('gives every demo account an in-progress and a returned Order, and nothing shared', async () => {
    const app = await boot()
    for (const account of DEMO_ACCOUNTS) {
      const orders = app.searchOrders(account.customerId)
      const seeded = DEMO_ORDERS.filter(order => order.customerId === account.customerId)
      // The account's own seeded Orders, not a shared set handed to everyone.
      expect(orders.map(order => order.orderId).sort()).toEqual(seeded.map(order => order.orderId).sort())
      expect(seeded.length).toBeGreaterThanOrEqual(2)
      expect(new Set(seeded.map(order => order.status))).toEqual(new Set(['in_progress', 'returned']))
      for (const order of orders) {
        expect(order).toMatchObject({ customerId: account.customerId })
        expect(order.orderId).toMatch(/^ord-/)
        expect(order.location).not.toBe('')
        expect(order.amountCents).toBeGreaterThan(0)
        expect(Number.isFinite(Date.parse(order.rentedAt))).toBe(true)
      }
      // Distinct places and distinct times, or the Card cannot tell two Orders
      // apart when it asks the Customer which one they mean.
      expect(new Set(orders.map(order => order.location)).size).toBe(orders.length)
      expect(new Set(orders.map(order => order.rentedAt)).size).toBe(orders.length)
    }
  })

  it('dates the extra blackgold Orders on one day, so a broad query matches several', async () => {
    const app = await boot()
    const today = app.searchOrders('cust-black-gold', {
      rentedFrom: '2026-10-09T00:00:00.000Z',
      rentedTo: '2026-10-09T23:59:59.999Z',
    })
    // Several Orders on one day, which is what makes a broad time query reach
    // the Card's "pick the one you mean" path.
    expect(today.map(order => order.orderId)).toEqual(['ord-black-gold-5', 'ord-black-gold-4', 'ord-black-gold-3'])
    expect(today.every(order => order.customerId === 'cust-black-gold')).toBe(true)
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
  it('returns the most recently rented Order first when nothing is filtered', async () => {
    const app = await boot()
    for (const account of DEMO_ACCOUNTS) {
      const seeded = DEMO_ORDERS.filter(order => order.customerId === account.customerId)
      const newest = seeded.reduce((latest, order) =>
        Date.parse(order.rentedAt) > Date.parse(latest.rentedAt) ? order : latest)
      // Newest first is what makes the unfiltered query answer with one Order:
      // the tool takes the head of this list.
      expect(app.searchOrders(account.customerId)[0]?.orderId).toBe(newest.orderId)
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
  it('shows an Agent the allowed tools and nothing else', async () => {
    const app = await boot()
    const caller = await app.agent('session-1')
    expect(app.ctx.tools.schemas(caller).map(schema => schema.name)).toEqual(ALLOWED)
  })

  it('masks an Agent that was already live when the plugin loaded', async () => {
    const app = await boot()
    expect(app.ctx.tools.schemas(app.liveAgent).map(schema => schema.name)).toEqual(ALLOWED)
    expect((await app.execute('bash', {}, app.liveAgent, new AbortController().signal)).isError).toBe(true)
  })

  it('answers "unknown tool" for every name outside the allowlist', async () => {
    const app = await boot()
    const caller = await app.agent('session-1')
    const offered = await app.offered(caller)
    expect(offered.tools).toEqual(ALLOWED_BY_NAME)
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
    expect(offered.tools).toEqual(ALLOWED_BY_NAME)
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
    expect(app.ctx.tools.schemas(caller).map(schema => schema.name)).toEqual(ALLOWED)
    expect((await app.execute('run_code', { code: 'bash()' }, caller, new AbortController().signal)).isError).toBe(true)
    // The deployment default is still whatever the profile asked for; only the
    // Customer-facing scopes are forced native.
    expect(app.ctx.tools.schemas(app.liveAgent).map(schema => schema.name)).toEqual(ALLOWED)
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

    // A date-only bound means that whole day in Beijing, the zone the seeded
    // Orders and the injected clock both speak, so it covers an Order rented at
    // 08:05+08:00 on it and would cover one rented at 00:30.
    const running = app.execute('search_orders', { rentedFrom: '2026-09-21', rentedTo: '2026-09-21' }, caller, new AbortController().signal)
    const question = await waitForQuestion(app.port, cookie)
    expect(question.query).toEqual({
      rentedFrom: '2026-09-21T00:00:00.000+08:00',
      rentedTo: '2026-09-21T23:59:59.999+08:00',
    })
    expect(question.candidates.map(candidate => candidate.orderId)).toEqual(['ord-silver-2'])

    await call(app.port, '/order-question/answer', {
      method: 'POST',
      cookie,
      body: { callId: 'call-1', orderId: 'ord-silver-2' },
    })
    expect(outcomeOrder(await running)?.orderId).toBe('ord-silver-2')
  })

  it('reads a time with no offset as Beijing time, and keeps one that has it', async () => {
    const app = await boot()
    const { cookie, sessionId } = await login(app.port, silver)
    const caller = await app.agent(sessionId)

    const ask = async (args: Record<string, string>, orderId: string) => {
      const running = app.execute('search_orders', args, caller, new AbortController().signal)
      const question = await waitForQuestion(app.port, cookie)
      await call(app.port, '/order-question/answer', { method: 'POST', cookie, body: { callId: 'call-1', orderId } })
      expect(outcomeOrder(await running)?.orderId).toBe(orderId)
      return question
    }

    // 08:05 with no offset is 08:05 in Beijing, which is when ord-silver-2 was
    // rented — the same instant the seeded row records.
    expect((await ask({ rentedFrom: '2026-09-21T08:05:00', rentedTo: '2026-09-21T08:05:00' }, 'ord-silver-2')).query)
      .toEqual({ rentedFrom: '2026-09-21T08:05:00.000+08:00', rentedTo: '2026-09-21T08:05:00.000+08:00' })
    // The same instant written in Z reaches the same Order; the offset the model
    // wrote is honoured rather than overruled.
    expect((await ask({ rentedFrom: '2026-09-21T00:05:00Z', rentedTo: '2026-09-21T00:05:00Z' }, 'ord-silver-2')).query)
      .toEqual({ rentedFrom: '2026-09-21T08:05:00.000+08:00', rentedTo: '2026-09-21T08:05:00.000+08:00' })
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
