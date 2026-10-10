/**
 * One-time 校验凭证: the mechanism that makes a passing validation the only way
 * an action runs (ADR-0002).
 *
 * A 校验 tool issues a grant; the action tool it authorises spends it. The
 * grant binds the Customer, the Order, the action and the Session it was issued
 * for, and the instant it was issued. Spending it is what the semantics are:
 * one use only, ten minutes at most, and dead the moment the Order it concerns
 * changes. All three decisions live here rather than at the call sites, so the
 * refund tools (issue #8) inherit them instead of restating them.
 *
 * Grants live in this process only, like the Session ↔ Customer binding: a
 * restart loses them, which costs the model one re-validation and nothing else.
 */

/** How long a grant stays usable after it was issued. */
export const GRANT_TTL_MS = 10 * 60 * 1000

/** Why a spent grant's claim was refused. */
export const GRANT_REFUSALS = {
  /** Nothing was issued for this Customer, Order, action and Session. */
  missing: 'missing',
  /** Issued, but more than {@link GRANT_TTL_MS} ago. */
  expired: 'expired',
  /** Issued, but the Order is no longer the one that was validated. */
  changed: 'changed',
}

/**
 * Create the grant store for one process.
 * @returns the store, whose `issue` and `claim` are documented below.
 */
export function createGrants() {
  /** One live grant per Customer, Order, action and Session. */
  const live = new Map()

  return {
    /**
     * Issue the grant for one Customer, Order, action and Session.
     *
     * A grant still live for the same four is replaced: 校验 has no side effects
     * and may be run again at any time (ADR-0002), and the newest verdict is the
     * one that describes the Order.
     * @param grant - the Customer, Order, action and Session it binds, the
     *   server instant it was issued at, and the Order row it was decided on.
     */
    issue(grant) {
      live.set(bindingKey(grant), {
        customerId: grant.customerId,
        orderId: grant.orderId,
        action: grant.action,
        sessionId: grant.sessionId,
        issuedAt: grant.issuedAt,
        order: orderReading(grant.order),
      })
    },

    /**
     * Drop whatever grant one Customer, Order, action and Session holds.
     *
     * A 校验 that refuses calls this, so what the store holds is always the
     * latest verdict rather than the latest passing one: an Order validated
     * inside the window and then refused by a later 校验 cannot still be closed
     * by the earlier verdict. Refusing costs the model nothing — 校验 is
     * side-effect free and may be run again whenever the Order allows it.
     * @param binding - the Customer, Order, action and Session to clear.
     */
    revoke(binding) {
      live.delete(bindingKey(binding))
    },

    /**
     * Spend the grant for one Customer, Order, action and Session.
     *
     * The grant is gone whatever this returns: a claim that is refused for age
     * or for a changed Order leaves nothing behind either, so a second attempt
     * with the same four reports `missing` rather than repeating the verdict.
     * @param claim - the Customer, Order, action and Session claiming, the
     *   server instant of the claim, and the Order row as it is now.
     * @returns `ok` when the claim may proceed; otherwise the
     *   {@link GRANT_REFUSALS} reason.
     */
    claim(claim) {
      const key = bindingKey(claim)
      const grant = live.get(key)
      if (grant === undefined) return { ok: false, reason: GRANT_REFUSALS.missing }
      live.delete(key)
      if (claim.now - grant.issuedAt > GRANT_TTL_MS) return { ok: false, reason: GRANT_REFUSALS.expired }
      if (orderReading(claim.order) !== grant.order) return { ok: false, reason: GRANT_REFUSALS.changed }
      return { ok: true }
    },
  }
}

/**
 * The key one grant is filed under.
 *
 * A grant authorises one action on one Order for one Customer in one Session,
 * so all four are part of the key rather than conditions checked after a
 * lookup: a grant earned elsewhere is then not found at all.
 * @param binding - the Customer, Order, action and Session.
 * @returns the store key.
 */
function bindingKey(binding) {
  return `${binding.customerId}\n${binding.orderId}\n${binding.action}\n${binding.sessionId}`
}

/**
 * A stable reading of one Order row, taken when a grant is issued and compared
 * when it is spent.
 *
 * Every field counts, so a later issue that adds one to the Order table is
 * covered without touching this function, and a rewrite that carries the same
 * values in another key order is not a change.
 * @param order - the stored Order row.
 * @returns the reading.
 */
function orderReading(order) {
  return JSON.stringify(Object.entries(order).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}
