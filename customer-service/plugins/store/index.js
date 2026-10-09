/**
 * Customer Service store: the Customer table, its seeded demo accounts, and the
 * `customerStore` service the other host plugins read it through.
 *
 * This plugin owns the database. It is the only place that opens a storage
 * domain, so the table layout and the credentials never leak past the service
 * surface. Order data joins the same domain in a later ticket.
 *
 * Imports `zod` because a storage-domain table schema must be a zod schema.
 * The repository root has `zod`, so Node resolves it from here even though this
 * directory is not a workspace member (ADR-0006).
 */
import { z } from 'zod'
import { hashPassword, verifyPassword } from './passwords.js'
import { TIERS } from '../shared/vocabulary.js'

/** Cordis plugin name. */
export const name = 'customer-service-store'

/** Required service: the storage-domain facility that opens the table. */
export const inject = ['storageDomain']

/** Table name inside the `customer` domain. */
export const CUSTOMERS_TABLE = 'customers'

/** One Customer row. `customerId` is the key, so it is also stored in the value. */
const customerRecord = z.object({
  customerId: z.string().min(1),
  accountName: z.string().min(1),
  passwordHash: z.string().min(1),
  tier: z.enum(TIERS),
  isAdmin: z.boolean(),
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
  tables: { [CUSTOMERS_TABLE]: { valueSchema: customerRecord } },
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
 * Open the Customer table, seed the demo accounts, and publish `customerStore`.
 * @param ctx - plugin context carrying the storage-domain facility.
 */
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(customerDomain)
  ctx.effect(() => () => domain.close(), 'customer-service-store: close domain')
  const table = domain.table(CUSTOMERS_TABLE)
  await seed(table)

  ctx.provide('customerStore', {
    /**
     * Look up one Customer by id.
     * @param customerId - the Customer identifier.
     * @returns the Customer row, or `undefined` when no such Customer exists.
     */
    findById(customerId) {
      return table.get(customerId)
    },

    /**
     * Check account credentials.
     * @param accountName - the account name the Customer typed.
     * @param password - the password the Customer typed.
     * @returns the matching Customer row, or `undefined` when either the
     *   account name or the password is wrong. The caller cannot tell which.
     */
    authenticate(accountName, password) {
      const customer = findByAccountName(table, accountName)
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
  })
}

/**
 * Write the demo accounts that are not in the table yet.
 *
 * Seeding is idempotent and never overwrites: a row that already exists keeps
 * its hash, so restarting the server does not invalidate a stored password.
 * @param table - the open `customers` table.
 */
async function seed(table) {
  for (const account of DEMO_ACCOUNTS) {
    if (table.get(account.customerId) !== undefined) continue
    await table.put(account.customerId, {
      customerId: account.customerId,
      accountName: account.accountName,
      passwordHash: hashPassword(account.password),
      tier: account.tier,
      isAdmin: account.isAdmin,
    })
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
