/**
 * Browser half of the customer-service UI plugin (issue #3). Hand-written in
 * the closure factory form the Client module system loads (ADR-0006): no build
 * step, no `@deepseek-ai/dsh-*` import, `require` answers from the loader's
 * module table.
 *
 * Two surfaces, both in the frame-wide `shell.overlay` layer:
 *   - a full-viewport mask while nobody is logged in, so the conversation is
 *     neither visible nor reachable, carrying the login form and the demo
 *     credentials; and
 *   - a small account chip once a login is live, carrying `退出登录`.
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
    const { useCallback, useEffect, useRef, useState } = React

    /** Route prefix of the customer-service HTTP routes. */
    const ROUTE_PREFIX = '/customer-service'
    /** Key the shell persists the selected Session under. */
    const CURRENT_SESSION_KEY = 'dsh.sessions.current'
    /** Shown for any rejected credential pair; names neither field, on purpose. */
    const CREDENTIALS_ERROR = '账号或密码错误'
    /** Shown when the routes could not be reached at all. */
    const NETWORK_ERROR = '无法连接客服服务，请稍后重试'

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

    const chip = {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: 999,
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 10px',
      background: '#fff',
      border: '1px solid #e3e6eb',
      borderRadius: '999px',
      boxShadow: '0 4px 16px rgba(31, 35, 41, .12)',
      pointerEvents: 'auto',
      font: '13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      color: '#1f2329',
    }

    const badge = {
      padding: '1px 8px',
      borderRadius: '999px',
      background: '#eef4fb',
      color: '#247bbf',
      fontSize: '12px',
    }

    const plainButton = {
      border: 'none',
      background: 'none',
      padding: '0 2px',
      color: '#247bbf',
      font: 'inherit',
      cursor: 'pointer',
    }

    /**
     * The login mask and the account chip.
     * @returns the mask while anonymous, the chip once logged in.
     */
    function CustomerGate() {
      const [phase, setPhase] = useState('loading')
      const [customer, setCustomer] = useState(null)
      const [accounts, setAccounts] = useState([])
      const [accountName, setAccountName] = useState('')
      const [password, setPassword] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      // Adopting the bound Session happens once per page load: afterwards a
      // Session the Customer opens themselves must not be pulled back.
      const adopted = useRef(false)

      useEffect(() => {
        let cancelled = false
        void (async () => {
          const { ok, payload } = await requestJson('/session')
          if (cancelled) return
          if (ok && payload?.loggedIn === true) {
            if (!adopted.current) {
              adopted.current = true
              if (readStoredSessionId() !== payload.sessionId
                && writeStoredSessionId(payload.sessionId)) {
                window.location.reload()
                return
              }
            }
            setCustomer(payload)
            setPhase('authenticated')
            return
          }
          clearStoredSessionId()
          setPhase('anonymous')
          const demo = await requestJson('/demo-accounts')
          if (!cancelled && demo.ok && Array.isArray(demo.payload?.accounts)) setAccounts(demo.payload.accounts)
        })().catch(() => {
          if (cancelled) return
          clearStoredSessionId()
          setPhase('anonymous')
          setError(NETWORK_ERROR)
        })
        return () => {
          cancelled = true
        }
      }, [])

      const signIn = useCallback(event => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
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
          setError(status === 401 ? CREDENTIALS_ERROR : payload?.error ?? NETWORK_ERROR)
        })().catch(() => {
          setBusy(false)
          setError(NETWORK_ERROR)
        })
      }, [accountName, password, busy])

      const signOut = useCallback(() => {
        setBusy(true)
        void (async () => {
          try {
            await requestJson('/logout', { method: 'POST' })
          } catch {
            // Leaving is a client decision: the recorded Session is dropped and
            // the page reloaded whether or not the route answered.
          }
          clearStoredSessionId()
          window.location.reload()
        })()
      }, [])

      if (phase === 'loading') {
        // Opaque from the first paint: a conversation must never flash before the
        // login state is known.
        return createPortal(h('div', { 'data-customer-service-gate': 'loading', style: mask }), document.body)
      }

      if (phase === 'authenticated' && customer !== null) {
        return h('div', { 'data-customer-service-account': '', style: chip },
          h('span', { style: { fontWeight: 600 } }, customer.accountName),
          h('span', { style: badge }, customer.tierLabel),
          customer.isAdmin ? h('span', { style: badge }, '管理员') : null,
          h('button', { type: 'button', onClick: signOut, disabled: busy, style: plainButton }, '退出登录'),
        )
      }

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
          }, error),
          h('button', { type: 'submit', disabled: busy, style: submit }, busy ? '登录中…' : '登录'),
          accounts.length === 0 ? null : h('div', { style: { borderTop: '1px solid #eef0f3', paddingTop: '10px', color: '#8a9099', fontSize: '12px' } },
            h('div', null, '演示账号'),
            ...accounts.map(account => h('div', { key: account.accountName },
              `${account.accountName} / ${account.password}（${account.tierLabel}）`)),
          ),
        ),
      ), document.body)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'customer-service.gate',
          order: 1000,
        }, CustomerGate))
      },
    }
  },
})
