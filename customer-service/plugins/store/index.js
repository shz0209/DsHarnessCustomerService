/**
 * Customer Service store: the Customer and Order tables, their seeded demo
 * rows, and the `customerStore` service the other host plugins read them
 * through.
 *
 * This plugin owns the database. It is the only place that opens a storage
 * domain, so the table layout and the credentials never leak past the service
 * surface. Every read and write of an Order is scoped by `customerId`, which
 * the caller takes from the login binding rather than from a tool argument
 * (ADR-0004).
 *
 * Imports `zod` because a storage-domain table schema must be a zod schema.
 * The repository root has `zod`, so Node resolves it from here even though this
 * directory is not a workspace member (ADR-0006).
 */
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
 * One Order row. `orderId` is the key, so it is also stored in the value.
 *
 * `amountCents` is an integer so a demo about money never rounds, and
 * `rentedAt` is an offset-carrying ISO-8601 timestamp so the card shows the
 * rental time the Customer experienced rather than one the browser guesses.
 * `returnedAt` is the same kind of stamp, written when an Order is closed;
 * seeded Orders that arrive 已归还 carry none, because no return was recorded
 * for them.
 */
const orderRecord = z.object({
  orderId: z.string().min(1),
  customerId: z.string().min(1),
  location: z.string().min(1),
  amountCents: z.number().int().min(0),
  rentedAt: z.string().min(1),
  status: z.enum(ORDER_STATUSES),
  returnedAt: z.string().min(1).optional(),
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
  { orderId: 'ord-silver-1', customerId: 'cust-silver', location: '万象城购物中心 B1 层服务台', amountCents: 300, rentedAt: '2026-10-08T19:24:00+08:00', status: 'in_progress' },
  { orderId: 'ord-silver-2', customerId: 'cust-silver', location: '深圳北站候车厅 3 号点位', amountCents: 1200, rentedAt: '2026-09-21T08:05:00+08:00', status: 'returned' },
  { orderId: 'ord-gold-1', customerId: 'cust-gold', location: '海岸城购物中心 4 楼电梯口', amountCents: 400, rentedAt: '2026-10-07T13:40:00+08:00', status: 'in_progress' },
  { orderId: 'ord-gold-2', customerId: 'cust-gold', location: '科技园地铁站 A 出口', amountCents: 600, rentedAt: '2026-09-30T21:12:00+08:00', status: 'returned' },
  { orderId: 'ord-platinum-1', customerId: 'cust-platinum', location: '华强北电子市场 2 号门', amountCents: 200, rentedAt: '2026-10-09T10:15:00+08:00', status: 'in_progress' },
  { orderId: 'ord-platinum-2', customerId: 'cust-platinum', location: '深圳湾公园欢乐海岸入口', amountCents: 900, rentedAt: '2026-09-12T16:48:00+08:00', status: 'returned' },
  { orderId: 'ord-black-gold-1', customerId: 'cust-black-gold', location: '宝安国际机场 T3 到达厅', amountCents: 500, rentedAt: '2026-10-06T22:30:00+08:00', status: 'in_progress' },
  { orderId: 'ord-black-gold-2', customerId: 'cust-black-gold', location: '前海壹方城 B2 停车场', amountCents: 1500, rentedAt: '2026-08-28T11:20:00+08:00', status: 'returned' },
  { orderId: 'ord-black-gold-3', customerId: 'cust-black-gold', location: '深南大道腾讯大厦 1 楼大堂', amountCents: 400, rentedAt: '2026-10-09T09:12:00+08:00', status: 'returned' },
  { orderId: 'ord-black-gold-4', customerId: 'cust-black-gold', location: '深圳湾万象城 3 号门', amountCents: 800, rentedAt: '2026-10-09T13:05:00+08:00', status: 'returned' },
  { orderId: 'ord-black-gold-5', customerId: 'cust-black-gold', location: '车公庙地铁站 C 出口', amountCents: 600, rentedAt: '2026-10-09T18:40:00+08:00', status: 'in_progress' },
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
  await seed(customers, DEMO_ACCOUNTS, 'customerId', account => ({
    customerId: account.customerId,
    accountName: account.accountName,
    passwordHash: hashPassword(account.password),
    tier: account.tier,
    isAdmin: account.isAdmin,
  }))
  await seed(orders, DEMO_ORDERS, 'orderId', order => ({ ...order }))

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
      const order = orders.get(orderId)
      return order?.customerId === customerId ? order : undefined
    },

    /**
     * Close one of a Customer's own Orders: set it 已归还 and record when.
     *
     * The write is unconditional — the business rules that decide whether an
     * Order may be closed belong to the tool that owns them (the 人工还宝 tool
     * refuses a 凭证 earned before the Order changed), and the back office
     * (issue #9) closes Orders through this same call.
     * @param customerId - the Customer whose Order may be written.
     * @param orderId - the Order number.
     * @param returnedAt - the return time, an offset-carrying ISO-8601 stamp.
     * @returns the stored Order as it now stands, or `undefined` when this
     *   Customer owns no such Order and nothing was written.
     */
    async markReturned(customerId, orderId, returnedAt) {
      const order = orders.get(orderId)
      if (order === undefined || order.customerId !== customerId) return undefined
      // Spread first so the stored field order is preserved: a rewrite that only
      // adds the return time is what the grant's change reading expects.
      const updated = { ...order, status: 'returned', returnedAt }
      await orders.put(orderId, updated)
      return updated
    },
  })
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
