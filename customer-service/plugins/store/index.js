/**
 * Customer Service store: the Customer and Order tables, their seeded demo
 * rows, and the `customerStore` service the other host plugins read them
 * through.
 *
 * This plugin owns the database. It is the only place that opens a storage
 * domain, so the table layout and the credentials never leak past the service
 * surface. Every read and write of an Order is scoped by `customerId`, which
 * the caller takes from the login binding rather than from a tool argument or a
 * request field (ADR-0004) — that scoping is the whole isolation guarantee, and
 * it holds for the panel's routes exactly as it does for the Agent's tools.
 *
 * Imports `zod` because a storage-domain table schema must be a zod schema.
 * The repository root has `zod`, so Node resolves it from here even though this
 * directory is not a workspace member (ADR-0006).
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { hashPassword, verifyPassword } from './passwords.js'
import { ORDER_STATUSES, TIERS } from '../shared/vocabulary.js'

/** Cordis plugin name. */
export const name = 'customer-service-store'

/** Required service: the storage-domain facility that opens the tables. */
export const inject = ['storageDomain']

/** Customer table name inside the `customer` domain. */
export const CUSTOMERS_TABLE = 'customers'

/** Order table name inside the `customer` domain. */
export const ORDERS_TABLE = 'orders'

/** One Customer row. `customerId` is the key, so it is also stored in the value. */
const customerRecord = z.object({
  customerId: z.string().min(1),
  accountName: z.string().min(1),
  passwordHash: z.string().min(1),
  tier: z.enum(TIERS),
  isAdmin: z.boolean(),
})

/**
 * One Order row. `orderId` is the key, so it is also stored in the value; it is
 * a UUID, minted by this plugin and never by a caller or a request body.
 *
 * `amountCents` is an integer so a demo about money never rounds, and
 * `rentedAt` is an offset-carrying ISO-8601 timestamp so the card shows the
 * rental time the Customer experienced rather than one the browser guesses.
 * `returnedAt` is the same kind of stamp, written when an Order is closed;
 * seeded Orders that arrive 已归还 carry none, because no return was recorded
 * for them. `refundedAt` is the same again, written when the money went back
 * and the status became 已退款.
 */
const orderRecord = z.object({
  orderId: z.string().min(1),
  customerId: z.string().min(1),
  location: z.string().min(1),
  amountCents: z.number().int().min(0),
  rentedAt: z.string().min(1),
  status: z.enum(ORDER_STATUSES),
  returnedAt: z.string().min(1).optional(),
  refundedAt: z.string().min(1).optional(),
})

/**
 * The `customer` domain declaration.
 *
 * Written as a literal rather than through `defineDomain`, which is a load-time
 * validator this directory cannot import; the same constraints are restated
 * here by hand: the name and table name match `/^[a-z][a-z0-9_]*$/`, and the
 * version is a non-negative integer.
 */
export const customerDomain = {
  name: 'customer',
  version: 1,
  tables: {
    [CUSTOMERS_TABLE]: { valueSchema: customerRecord },
    [ORDERS_TABLE]: { valueSchema: orderRecord },
  },
}

/**
 * The shape of an Order number: what `randomUUID()` mints.
 *
 * A number that does not read as one is a number this build did not write,
 * which is what {@link carryOrderNumbersForward} looks for.
 */
const ORDER_NUMBER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The number each seeded Order carried before Order numbers were UUIDs, and the
 * number it carries now.
 *
 * The old numbers name the same rows in an existing demo database; the mapping
 * is what lets the change land on the rows already there instead of beside them.
 */
const FORMER_DEMO_ORDER_NUMBERS = new Map([
  ['ord-silver-1', 'cbb14662-4d88-4361-9710-9a4229c1c960'],
  ['ord-silver-2', 'a5ca2d55-ff76-4f63-8b51-96f7a0df182c'],
  ['ord-gold-1', '33163a30-6164-43d5-b2b3-c5e1b377d219'],
  ['ord-gold-2', '442b2a2c-b8f9-4b65-9c65-df4f3319d947'],
  ['ord-platinum-1', '9233d92c-3a2f-487e-8af6-e6556c0e478d'],
  ['ord-platinum-2', '9a83ac26-7657-48c2-91b8-4d15baedd6e8'],
  ['ord-black-gold-1', '92dfba28-f40c-486f-8709-6362bfb93c5f'],
  ['ord-black-gold-2', 'd62e2d37-0c5a-4c73-b007-cb4acd8bd9fc'],
  ['ord-black-gold-3', '6a4227b1-0b95-443f-97fa-a3433eaa7cea'],
  ['ord-black-gold-4', '73d2144d-1701-4fd5-9de0-469163c0c20c'],
  ['ord-black-gold-5', '33b8d967-5741-4f78-b189-10ca0ecfcf23'],
])

/**
 * The four demo accounts, one per VIP tier, with the highest tier doubling as
 * the Administrator. The passwords are demo credentials: they are listed in the
 * README and on the login page, and stored in the table only as salted hashes.
 */
export const DEMO_ACCOUNTS = [
  { customerId: 'cust-silver', accountName: 'silver', password: 'silver123', tier: 'silver', isAdmin: false },
  { customerId: 'cust-gold', accountName: 'gold', password: 'gold123', tier: 'gold', isAdmin: false },
  { customerId: 'cust-platinum', accountName: 'platinum', password: 'platinum123', tier: 'platinum', isAdmin: false },
  { customerId: 'cust-black-gold', accountName: 'blackgold', password: 'blackgold123', tier: 'black_gold', isAdmin: true },
]

/**
 * Two demo Orders per demo account: one still out with the Customer, one
 * already returned. The in-progress Order is the more recent of the two, so a
 * query with no filter lands on it — the demo's opening question.
 *
 * The locations share the vocabulary a Customer would actually use ("购物中心",
 * "地铁站") so a fuzzy query has something to match, and no two Orders of one
 * Customer sit at the same place or time.
 *
 * `blackgold` carries three more, all rented on 2026-10-09: without them a
 * time-range query broad enough to be interesting still matches one Order per
 * Customer, and the Card's "pick the one you mean" path never comes up. They
 * are seeded rows like the rest, so they are frozen at that date rather than
 * following the clock.
 */
export const DEMO_ORDERS = [
  { orderId: 'cbb14662-4d88-4361-9710-9a4229c1c960', customerId: 'cust-silver', location: '万象城购物中心 B1 层服务台', amountCents: 300, rentedAt: '2026-10-08T19:24:00+08:00', status: 'in_progress' },
  { orderId: 'a5ca2d55-ff76-4f63-8b51-96f7a0df182c', customerId: 'cust-silver', location: '深圳北站候车厅 3 号点位', amountCents: 1200, rentedAt: '2026-09-21T08:05:00+08:00', status: 'returned' },
  { orderId: '33163a30-6164-43d5-b2b3-c5e1b377d219', customerId: 'cust-gold', location: '海岸城购物中心 4 楼电梯口', amountCents: 400, rentedAt: '2026-10-07T13:40:00+08:00', status: 'in_progress' },
  { orderId: '442b2a2c-b8f9-4b65-9c65-df4f3319d947', customerId: 'cust-gold', location: '科技园地铁站 A 出口', amountCents: 600, rentedAt: '2026-09-30T21:12:00+08:00', status: 'returned' },
  { orderId: '9233d92c-3a2f-487e-8af6-e6556c0e478d', customerId: 'cust-platinum', location: '华强北电子市场 2 号门', amountCents: 200, rentedAt: '2026-10-09T10:15:00+08:00', status: 'in_progress' },
  { orderId: '9a83ac26-7657-48c2-91b8-4d15baedd6e8', customerId: 'cust-platinum', location: '深圳湾公园欢乐海岸入口', amountCents: 900, rentedAt: '2026-09-12T16:48:00+08:00', status: 'returned' },
  { orderId: '92dfba28-f40c-486f-8709-6362bfb93c5f', customerId: 'cust-black-gold', location: '宝安国际机场 T3 到达厅', amountCents: 500, rentedAt: '2026-10-06T22:30:00+08:00', status: 'in_progress' },
  { orderId: 'd62e2d37-0c5a-4c73-b007-cb4acd8bd9fc', customerId: 'cust-black-gold', location: '前海壹方城 B2 停车场', amountCents: 1500, rentedAt: '2026-08-28T11:20:00+08:00', status: 'returned' },
  { orderId: '6a4227b1-0b95-443f-97fa-a3433eaa7cea', customerId: 'cust-black-gold', location: '深南大道腾讯大厦 1 楼大堂', amountCents: 400, rentedAt: '2026-10-09T09:12:00+08:00', status: 'returned' },
  { orderId: '73d2144d-1701-4fd5-9de0-469163c0c20c', customerId: 'cust-black-gold', location: '深圳湾万象城 3 号门', amountCents: 800, rentedAt: '2026-10-09T13:05:00+08:00', status: 'returned' },
  { orderId: '33b8d967-5741-4f78-b189-10ca0ecfcf23', customerId: 'cust-black-gold', location: '车公庙地铁站 C 出口', amountCents: 600, rentedAt: '2026-10-09T18:40:00+08:00', status: 'in_progress' },
]

/**
 * Open the Customer and Order tables, seed the demo rows, and publish
 * `customerStore`.
 * @param ctx - plugin context carrying the storage-domain facility.
 */
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(customerDomain)
  ctx.effect(() => () => domain.close(), 'customer-service-store: close domain')
  const customers = domain.table(CUSTOMERS_TABLE)
  const orders = domain.table(ORDERS_TABLE)
  // Before seeding: a database seeded by an earlier build still holds the rows
  // under their old numbers, and seeding first would add the new numbers beside
  // them rather than finding them.
  await carryOrderNumbersForward(orders)
  await seed(customers, DEMO_ACCOUNTS, 'customerId', account => ({
    customerId: account.customerId,
    accountName: account.accountName,
    passwordHash: hashPassword(account.password),
    tier: account.tier,
    isAdmin: account.isAdmin,
  }))
  await seed(orders, DEMO_ORDERS, 'orderId', order => ({ ...order }))
  await carryRefundMarksForward(orders)

  ctx.provide('customerStore', {
    /**
     * Look up one Customer by id.
     * @param customerId - the Customer identifier.
     * @returns the Customer row, or `undefined` when no such Customer exists.
     */
    findById(customerId) {
      return customers.get(customerId)
    },

    /**
     * Check account credentials.
     * @param accountName - the account name the Customer typed.
     * @param password - the password the Customer typed.
     * @returns the matching Customer row, or `undefined` when either the
     *   account name or the password is wrong. The caller cannot tell which.
     */
    authenticate(accountName, password) {
      const customer = findByAccountName(customers, accountName)
      if (customer === undefined) return undefined
      if (!verifyPassword(password, customer.passwordHash)) return undefined
      return customer
    },

    /**
     * The demo credentials the login page lists.
     * @returns account name, password, tier, and admin flag per demo account,
     *   in tier order. Plaintext passwords are the point of a demo account.
     */
    demoAccounts() {
      return DEMO_ACCOUNTS.map(account => ({
        accountName: account.accountName,
        password: account.password,
        tier: account.tier,
        isAdmin: account.isAdmin,
      }))
    },

    /**
     * Search one Customer's own Orders, most recently rented first.
     *
     * The `customerId` scoping is the isolation guarantee: an Order belonging
     * to anyone else is unreachable through this method, whatever the filter.
     * `location` matches by substring containment, the fuzzy match a Customer
     * recalling "那个购物中心" needs. `rentedFrom`/`rentedTo` are compared as
     * instants, so an offset-carrying ISO-8601 bound from any zone orders
     * correctly against the stored timestamps; the model-facing tool
     * normalizes and validates them before they arrive (ADR-0004).
     * @param customerId - the Customer whose Orders may be returned.
     * @param filter - `location` substring, and inclusive `rentedFrom`/
     *   `rentedTo` instants; an absent field does not narrow the search, so the
     *   empty filter matches every Order this Customer owns.
     * @returns the matching Order rows, most recent `rentedAt` first.
     */
    searchOrders(customerId, filter) {
      const from = filter.rentedFrom === undefined ? undefined : Date.parse(filter.rentedFrom)
      const to = filter.rentedTo === undefined ? undefined : Date.parse(filter.rentedTo)
      const matches = []
      for (const [, order] of orders.entries()) {
        if (order.customerId !== customerId) continue
        if (filter.location !== undefined && !order.location.includes(filter.location)) continue
        const rentedAt = Date.parse(order.rentedAt)
        if (from !== undefined && rentedAt < from) continue
        if (to !== undefined && rentedAt > to) continue
        matches.push(order)
      }
      return matches.sort((left, right) => Date.parse(right.rentedAt) - Date.parse(left.rentedAt))
    },

    /**
     * Read one of a Customer's own Orders by its number.
     *
     * Same scoping as `searchOrders`: the Order is looked up under the caller's
     * own `customerId`, so anyone else's Order is simply not found and the
     * caller has nothing to compare it against (ADR-0004).
     * @param customerId - the Customer whose Order may be read.
     * @param orderId - the Order number.
     * @returns the Order row, or `undefined` when this Customer owns no such
     *   Order.
     */
    findOrder(customerId, orderId) {
      return ownedOrder(orders, customerId, orderId)
    },

    /**
     * Close one of a Customer's own Orders: set it 已归还 and record when.
     *
     * The write is unconditional — the business rules that decide whether an
     * Order may be closed belong to the tool that owns them (the 人工还宝 tool
     * refuses a 凭证 earned before the Order changed). The panel closes Orders
     * through {@link closeOpenOrder}, which does carry a rule of its own.
     * @param customerId - the Customer whose Order may be written.
     * @param orderId - the Order number.
     * @param returnedAt - the return time, an offset-carrying ISO-8601 stamp.
     * @returns the stored Order as it now stands, or `undefined` when this
     *   Customer owns no such Order and nothing was written.
     */
    async markReturned(customerId, orderId, returnedAt) {
      const order = ownedOrder(orders, customerId, orderId)
      if (order === undefined) return undefined
      const updated = closedOrder(order, returnedAt)
      await orders.put(orderId, updated)
      return updated
    },

    /**
     * Mark one of a Customer's own Orders refunded, recording when.
     *
     * The whole Order amount is what a refund returns, so the amount is not a
     * parameter: the row already says how much. The write is unconditional, like
     * {@link markReturned} — the 退款 rules that decide whether this may happen
     * belong to the tool that owns them (ADR-0009's change reading covers the
     * status and the new stamp like any other field).
     * @param customerId - the Customer whose Order may be written.
     * @param orderId - the Order number.
     * @param refundedAt - the refund time, an offset-carrying ISO-8601 stamp.
     * @returns the stored Order as it now stands, or `undefined` when this
     *   Customer owns no such Order and nothing was written.
     */
    async markRefunded(customerId, orderId, refundedAt) {
      const order = ownedOrder(orders, customerId, orderId)
      if (order === undefined) return undefined
      const updated = refundedOrder(order, refundedAt)
      await orders.put(orderId, updated)
      return updated
    },

    // What the panel (issue #9) does to a Customer's own Orders. These are
    // scoped like the ones above — the `customerId` comes from the login
    // binding, never from the request — because the panel is part of the same
    // surface: a Customer prepares and inspects their own demo data, and no
    // tool and no route reaches anyone else's row.

    /**
     * Create an Order under a Customer, minting its number.
     *
     * The status is not a parameter: an Order the panel creates is one the
     * power bank is still out with, which is the state the two-hour rule is
     * demonstrated from. The number is minted here rather than accepted from
     * the caller so the table's key space stays this plugin's to keep unique,
     * and it is a UUID, which is unique without a check against the table.
     * @param input - the owning Customer, the rental location, the amount in
     *   integer cents, and the rental time as an offset-carrying ISO-8601 stamp.
     * @returns the stored Order, or `undefined` when no such Customer exists
     *   and nothing was written.
     */
    async createOrder(input) {
      if (customers.get(input.customerId) === undefined) return undefined
      const order = {
        orderId: randomUUID(),
        customerId: input.customerId,
        location: input.location,
        amountCents: input.amountCents,
        rentedAt: input.rentedAt,
        status: 'in_progress',
      }
      await orders.put(order.orderId, order)
      return order
    },

    /**
     * Close one of a Customer's own Orders that is still 进行中.
     *
     * Unlike {@link markReturned} this carries the panel's own rule — an Order
     * that is already 已归还 is refused rather than written a second return time
     * — because the panel's button is the only thing that would otherwise ask
     * for it. The scoping is the same as every other Customer-facing write.
     * @param customerId - the Customer whose Order may be closed.
     * @param orderId - the Order number.
     * @param returnedAt - the return time, an offset-carrying ISO-8601 stamp.
     * @returns the closed Order, or `missing` when this Customer owns no such
     *   Order and `closed` — with the row, so the caller can name the status it
     *   is in — when it is not 进行中 any more. Nothing is written either way.
     */
    async closeOpenOrder(customerId, orderId, returnedAt) {
      const order = ownedOrder(orders, customerId, orderId)
      if (order === undefined) return { ok: false, reason: 'missing' }
      if (order.status !== 'in_progress') return { ok: false, reason: 'closed', order }
      const updated = closedOrder(order, returnedAt)
      await orders.put(orderId, updated)
      return { ok: true, order: updated }
    },
  })
}

/**
 * Read one of a Customer's Orders, scoped to the Customer the caller resolved.
 *
 * This one lookup is the isolation guarantee: an Order belonging to anyone else
 * is not found, whatever the caller asks for (ADR-0004). Every read and write
 * that names a single Order goes through it, so there is one place that decides
 * what "this Customer's Order" means.
 * @param table - the open `orders` table.
 * @param customerId - the Customer whose Orders may be read.
 * @param orderId - the Order number.
 * @returns the Order row, or `undefined` when this Customer owns no such Order.
 */
function ownedOrder(table, customerId, orderId) {
  const order = table.get(orderId)
  return order?.customerId === customerId ? order : undefined
}

/**
 * The stored Order as closing it writes it.
 *
 * Spread first so the stored field order is preserved: a rewrite that only adds
 * the return time is what the grant's change reading expects (ADR-0009).
 * @param order - the Order as it stands.
 * @param returnedAt - the return time, an offset-carrying ISO-8601 stamp.
 * @returns the row to store.
 */
function closedOrder(order, returnedAt) {
  return { ...order, status: 'returned', returnedAt }
}

/**
 * The stored Order as refunding it writes it.
 *
 * Spread first for the same reason closing one spreads first: a rewrite that
 * only moves the status and adds the refund time is what the grant's change
 * reading expects (ADR-0009).
 * @param order - the Order as it stands.
 * @param refundedAt - the refund time, an offset-carrying ISO-8601 stamp.
 * @returns the row to store.
 */
function refundedOrder(order, refundedAt) {
  return { ...order, status: 'refunded', refundedAt }
}

/**
 * Write the demo rows that are not in the table yet.
 *
 * Seeding is idempotent and never overwrites: a row that already exists keeps
 * its stored value, so restarting the server neither invalidates a stored
 * password hash nor discards an Order the demo has since modified.
 * @param table - the open table to seed.
 * @param demos - the demo rows.
 * @param keyField - the field of the stored record that is the table key.
 * @param project - builds the stored record from one demo row.
 */
async function seed(table, demos, keyField, project) {
  for (const demo of demos) {
    const record = project(demo)
    if (table.get(record[keyField]) !== undefined) continue
    await table.put(record[keyField], record)
  }
}

/**
 * Bring Order numbers written before they were UUIDs forward.
 *
 * A demo database outlives the change: a row seeded by an earlier build holds
 * `ord-silver-1` where this one holds a UUID. Each such number is re-minted
 * under the row's own key, taking the row with it — its status, its 归还时间, its
 * 退款时间 — so a Customer's demo state survives the change. The seeded rows land
 * on the numbers {@link DEMO_ORDERS} names, which is what lets the seeding that
 * follows recognise them as the rows already there; an Order the panel created
 * lands on a fresh UUID, which nothing else reads.
 *
 * Runs before seeding and walks a snapshot: it writes under new keys as it
 * deletes the old ones.
 * @param table - the open `orders` table.
 */
async function carryOrderNumbersForward(table) {
  for (const [orderId, order] of [...table.entries()]) {
    if (ORDER_NUMBER.test(orderId)) continue
    const number = FORMER_DEMO_ORDER_NUMBERS.get(orderId) ?? randomUUID()
    // A former number standing beside the number it became means an earlier
    // build seeded it a second time; the row already there is the live one, so
    // the stale copy is dropped rather than written over it.
    if (table.get(number) === undefined) await table.put(number, { ...order, orderId: number })
    await table.delete(orderId)
  }
}

/**
 * Bring Orders refunded before 已退款 was a status forward to it.
 *
 * A demo database outlives a change to what a refund writes: a row refunded
 * under the old model reads 已归还 while carrying a 退款时间, which the refund
 * rule would now let through a second time. Nothing writes that pair any more,
 * so the reading is unambiguous, and it is corrected on open rather than left
 * to look like a bug in a demo. The record schema itself did not change —
 * every stored row still parses, and only what a refund *writes* moved — so
 * this needs no domain version of its own.
 * @param table - the open `orders` table.
 */
async function carryRefundMarksForward(table) {
  for (const [orderId, order] of table.entries()) {
    if (order.refundedAt === undefined || order.status === 'refunded') continue
    await table.put(orderId, { ...order, status: 'refunded' })
  }
}

/**
 * Find a Customer by account name.
 * @param table - the open `customers` table.
 * @param accountName - the account name to match, exactly.
 * @returns the Customer row, or `undefined`.
 */
function findByAccountName(table, accountName) {
  for (const [, record] of table.entries()) {
    if (record.accountName === accountName) return record
  }
  return undefined
}
