/**
 * Browser half of the customer-service UI plugin (issues #3 and #4). Hand-written
 * in the closure factory form the Client module system loads (ADR-0006): no build
 * step, no `@deepseek-ai/dsh-*` import, `require` answers from the loader's
 * module table.
 *
 * Two surfaces:
 *   - `shell.overlay` carries a full-viewport mask while nobody is logged in, so
 *     the conversation is neither visible nor reachable, and carries the login
 *     form with the demo credentials; once a login is live it renders nothing.
 *   - `sidebar` is the frame's whole left column, which this file takes over
 *     (issue #4): the Customer's account name and VIP tier, and the way out. The
 *     shipped occupant is registered at the default priority 0, so this file
 *     registers at priority -1 — the lowest-priority live entry of a single slot
 *     renders (see ADR-0007). The native navigation — session list, workspaces,
 *     settings — stops rendering with it, and while nobody is logged in the
 *     occupant renders nothing at all.
 *
 * The login state lives in the `cs_session` cookie the host sets; this file
 * only ever reads the answer to `GET /customer-service/session`. The one piece
 * of client state it owns is the recorded current Session (`dsh.sessions.current`):
 * login adopts the Session the server opened, and logout drops that record, so
 * the next Customer never lands in the previous one's conversation.
 */
window.__ModuleLoader__.load({
  id: '@customer-service/ui',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Route prefix of the customer-service HTTP routes. */
    const ROUTE_PREFIX = '/customer-service'
    /** Key the shell persists the selected Session under. */
    const CURRENT_SESSION_KEY = 'dsh.sessions.current'
    /** Shown for any rejected credential pair; names neither field, on purpose. */
    const CREDENTIALS_ERROR = '账号或密码错误'
    /** Shown when the routes could not be reached at all. */
    const NETWORK_ERROR = '无法连接客服服务，请稍后重试'
    /** Shown when leaving failed, so a Customer is not left thinking they are out. */
    const SIGN_OUT_ERROR = '退出登录失败，请重试'

    // Copy is written in Chinese rather than routed through the harness's
    // locale mechanism: this directory is outside the client-copy gate, and the
    // demo is Chinese-only by decision (issue #1, Out of Scope).

    /**
     * Call one customer-service route.
     * @param path - path below {@link ROUTE_PREFIX}.
     * @param init - `fetch` options.
     * @returns the response status, ok flag, and parsed JSON body when there is one.
     */
    async function requestJson(path, init) {
      const response = await fetch(`${ROUTE_PREFIX}${path}`, init)
      let payload
      try {
        payload = await response.json()
      } catch {
        // A non-JSON body carries nothing this file reads; the callers fall back
        // to their own message.
        payload = undefined
      }
      return { ok: response.ok, status: response.status, payload }
    }

    /**
     * Read the Session id the shell recorded.
     * @returns the recorded id, or `undefined` when nothing is recorded.
     */
    function readStoredSessionId() {
      try {
        const raw = window.localStorage.getItem(CURRENT_SESSION_KEY)
        if (raw === null) return undefined
        const parsed = JSON.parse(raw)
        return typeof parsed?.sessionId === 'string' ? parsed.sessionId : undefined
      } catch {
        // Storage can be unavailable or hold a foreign value; either way there is
        // no recorded Session to honour.
        return undefined
      }
    }

    /**
     * Record a Session id as the shell's current selection.
     *
     * Both callers reload afterwards, but only the boot path may condition its
     * reload on the answer: a reload that reads back an unwritten value would
     * repeat forever. The login path reloads regardless — it must rebuild the
     * page for the new cookie — and converges through the boot path's guard.
     * @param sessionId - the Session the shell should open after the reload.
     * @returns whether the record was written. `false` means storage is
     *   unavailable; the login itself still stands, and only landing in the
     *   bound Session is lost.
     */
    function writeStoredSessionId(sessionId) {
      try {
        window.localStorage.setItem(CURRENT_SESSION_KEY, JSON.stringify({ sessionId }))
        return true
      } catch {
        return false
      }
    }

    /** Drop the recorded Session so no conversation is restored. */
    function clearStoredSessionId() {
      try {
        window.localStorage.removeItem(CURRENT_SESSION_KEY)
      } catch {
        // Nothing recorded that this file could remove.
      }
    }

    /**
     * Leave: end the login on the host, then rebuild the page around the login
     * mask.
     *
     * Only a route that answered `ok` ends the login. `cs_session` is `HttpOnly`,
     * so this file cannot clear the cookie itself; reloading after a call that
     * failed would re-authenticate and bring the sidebar back with no sign that
     * anything went wrong. The caller reports the failure instead.
     * @returns whether the login ended. `true` means the page is reloading.
     */
    async function signOut() {
      let ok = false
      try {
        ({ ok } = await requestJson('/logout', { method: 'POST' }))
      } catch {
        // A failed call leaves the cookie in place, same as a rejected one.
      }
      if (!ok) return false
      clearStoredSessionId()
      window.location.reload()
      return true
    }

    // Adopting the bound Session happens once per page load, not once per
    // surface: the sidebar and the login mask each resolve the login state, and
    // whichever answers first does the adopting. Afterwards a Session the
    // Customer opens themselves must not be pulled back.
    let adopted = false

    /**
     * Resolve the login state for a surface that renders it.
     * @returns the phase (`loading`, `anonymous`, or `authenticated`), the public
     *   Customer payload once a login is live, and a connection error to show.
     */
    function useCustomerSession() {
      const [session, setSession] = useState({ phase: 'loading', customer: null, error: '' })
      useEffect(() => {
        let cancelled = false
        void (async () => {
          const { ok, payload } = await requestJson('/session')
          if (cancelled) return
          if (ok && payload?.loggedIn === true) {
            if (!adopted) {
              adopted = true
              if (readStoredSessionId() !== payload.sessionId
                && writeStoredSessionId(payload.sessionId)) {
                window.location.reload()
                return
              }
            }
            setSession({ phase: 'authenticated', customer: payload, error: '' })
            return
          }
          clearStoredSessionId()
          setSession({ phase: 'anonymous', customer: null, error: '' })
        })().catch(() => {
          if (cancelled) return
          clearStoredSessionId()
          setSession({ phase: 'anonymous', customer: null, error: NETWORK_ERROR })
        })
        return () => {
          cancelled = true
        }
      }, [])
      return session
    }

    // Above the shared Modal's own layer (1000). The mask is portalled to the
    // body, so it covers body-portalled dialogs too, not just the frame: while
    // nobody is logged in the welcome dialog must not sit on the login form.
    const mask = {
      position: 'fixed',
      inset: 0,
      zIndex: 2000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f6f8',
      pointerEvents: 'auto',
      font: '14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
      color: '#1f2329',
    }

    const card = {
      width: 'min(360px, calc(100vw - 48px))',
      boxSizing: 'border-box',
      padding: '28px 28px 20px',
      background: '#fff',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(31, 35, 41, .14)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }

    const field = {
      boxSizing: 'border-box',
      width: '100%',
      padding: '9px 12px',
      border: '1px solid #d5d9e0',
      borderRadius: '8px',
      font: 'inherit',
      color: 'inherit',
      background: '#fff',
    }

    const submit = {
      padding: '10px 12px',
      border: 'none',
      borderRadius: '8px',
      background: '#247bbf',
      color: '#fff',
      font: 'inherit',
      fontWeight: 600,
      cursor: 'pointer',
    }

    // The sidebar paints in the app's own design tokens rather than the mask's
    // literal light palette: it sits inside the frame, whose column already
    // supplies `--dsw-specific-sidebar-fill`, and must follow the active theme.
    const SIDEBAR_CSS = `
.cs-sidebar {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  block-size: 100%;
  padding: 14px 12px;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.cs-sidebar--rail { align-items: center; padding: 14px 6px; gap: 10px; }
/* 56px fits an initial, not a name; the account name rides on the tooltip. */
.cs-sidebar__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: 30px;
  block-size: 30px;
  border-radius: 50%;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
}
.cs-sidebar__brand { font-size: 14px; font-weight: 600; }
.cs-sidebar__account { display: flex; flex-direction: column; gap: 6px; min-inline-size: 0; }
.cs-sidebar__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-sidebar__badges { display: flex; flex-wrap: wrap; gap: 6px; }
.cs-sidebar__spacer { flex: 1; min-block-size: 0; }
.cs-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.cs-badge--tier {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.cs-sidebar__error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.cs-signout {
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
}
.cs-signout:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.cs-signout--rail { inline-size: 100%; padding: 8px 0; font-size: 12px; }
`

    /**
     * The login mask, and nothing once a Customer is signed in.
     * @returns the mask, or `null` for a signed-in Customer.
     */
    function LoginGate() {
      const { phase, error: connectionError } = useCustomerSession()
      const [accounts, setAccounts] = useState([])
      const [accountName, setAccountName] = useState('')
      const [password, setPassword] = useState('')
      const [formError, setFormError] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (phase !== 'anonymous') return undefined
        let cancelled = false
        void (async () => {
          const demo = await requestJson('/demo-accounts')
          if (!cancelled && demo.ok && Array.isArray(demo.payload?.accounts)) {
            setAccounts(demo.payload.accounts)
          }
        })().catch(() => {
          // The small print is optional; a failed fetch leaves it out.
        })
        return () => {
          cancelled = true
        }
      }, [phase])

      const signIn = useCallback(event => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setFormError('')
        void (async () => {
          const { ok, status, payload } = await requestJson('/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accountName, password }),
          })
          if (ok && typeof payload?.sessionId === 'string') {
            writeStoredSessionId(payload.sessionId)
            window.location.reload()
            return
          }
          setBusy(false)
          setFormError(status === 401 ? CREDENTIALS_ERROR : payload?.error ?? NETWORK_ERROR)
        })().catch(() => {
          setBusy(false)
          setFormError(NETWORK_ERROR)
        })
      }, [accountName, password, busy])

      if (phase === 'loading') {
        // Opaque from the first paint: a conversation must never flash before the
        // login state is known.
        return createPortal(h('div', { 'data-customer-service-gate': 'loading', style: mask }), document.body)
      }

      if (phase === 'authenticated') return null

      return createPortal(h('div', { 'data-customer-service-gate': 'anonymous', style: mask },
        h('form', { style: card, onSubmit: signIn },
          h('div', { style: { fontSize: '17px', fontWeight: 600 } }, '共享充电宝智能客服'),
          h('div', { style: { color: '#646a73' } }, '登录后开始对话。'),
          h('input', {
            style: field,
            name: 'accountName',
            autoComplete: 'username',
            placeholder: '账号',
            value: accountName,
            onChange: event => setAccountName(event.target.value),
          }),
          h('input', {
            style: field,
            name: 'password',
            type: 'password',
            autoComplete: 'current-password',
            placeholder: '密码',
            value: password,
            onChange: event => setPassword(event.target.value),
          }),
          h('div', {
            role: 'alert',
            style: { color: '#d92c20', minHeight: '20px' },
          }, formError || connectionError),
          h('button', { type: 'submit', disabled: busy, style: submit }, busy ? '登录中…' : '登录'),
          accounts.length === 0 ? null : h('div', { style: { borderTop: '1px solid #eef0f3', paddingTop: '10px', color: '#8a9099', fontSize: '12px' } },
            h('div', null, '演示账号'),
            ...accounts.map(account => h('div', { key: account.accountName },
              `${account.accountName} / ${account.password}（${account.tierLabel}）`)),
          ),
        ),
      ), document.body)
    }

    /**
     * The left column's occupant: who the Customer is, and the way out.
     * @param props - the slot owner's share: the frame's live column state.
     * @returns the column, or `null` while nobody is logged in.
     */
    function CustomerSidebar({ collapsed }) {
      const { phase, customer } = useCustomerSession()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const leave = useCallback(() => {
        if (busy) return
        setBusy(true)
        setError('')
        void signOut().then(left => {
          if (left) return
          setBusy(false)
          setError(SIGN_OUT_ERROR)
        })
      }, [busy])

      if (phase !== 'authenticated' || customer === null) return null

      const tier = h('span', { className: 'cs-badge cs-badge--tier', 'data-customer-service-tier': '' },
        customer.tierLabel)

      // The rail is 56px wide and clips, so the failure message rides on the
      // tooltip there and gets a line of its own in the full column.
      const signOutButton = (className, label) => h('button', {
        type: 'button',
        className,
        title: error || '退出登录',
        disabled: busy,
        onClick: leave,
      }, label)

      if (collapsed) {
        // The frame collapses the column and clips it; the occupant owns what
        // the rail shows. The name is one initial wide, so the full account name
        // is the tooltip's job here.
        return h('div', { className: 'cs-sidebar cs-sidebar--rail', 'data-customer-service-sidebar': 'rail' },
          h('div', {
            className: 'cs-sidebar__avatar',
            title: customer.accountName,
            'data-customer-service-account': '',
          }, customer.accountName.slice(0, 1).toUpperCase()),
          tier,
          h('div', { className: 'cs-sidebar__spacer' }),
          signOutButton('cs-signout cs-signout--rail', '退出'),
        )
      }

      return h('div', { className: 'cs-sidebar', 'data-customer-service-sidebar': 'full' },
        h('div', { className: 'cs-sidebar__brand' }, '共享充电宝智能客服'),
        h('div', { className: 'cs-sidebar__account', 'data-customer-service-account': '' },
          h('div', { className: 'cs-sidebar__name' }, customer.accountName),
          h('div', { className: 'cs-sidebar__badges' },
            tier,
            customer.isAdmin ? h('span', { className: 'cs-badge' }, '管理员') : null,
          ),
        ),
        h('div', { className: 'cs-sidebar__spacer' }),
        error === '' ? null : h('div', { className: 'cs-sidebar__error', role: 'alert' }, error),
        signOutButton('cs-signout', '退出登录'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.customerService = 'sidebar'
          style.textContent = SIDEBAR_CSS
          document.head.append(style)
          return () => {
            style.remove()
          }
        }, 'customer-service-ui: sidebar styles')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'customer-service.gate',
          order: 1000,
        }, LoginGate))
        // -1 shadows the shipped occupant; ADR-0007 has the mechanism. Declaring
        // into `sidebar.*` is not an option — the shipped occupant declares those
        // seats, and a slot has one declarer.
        ctx.slots.inject('sidebar', () => ctx.slots.register({
          name: 'sidebar',
          priority: -1,
        }, CustomerSidebar))
      },
    }
  },
})
