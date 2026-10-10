/**
 * Browser half of the customer-service UI plugin (issues #3, #4, #5, #6, #7,
 * #8, #9). Hand-written in the closure factory form the Client module system
 * loads (ADR-0006): no build step, no `@deepseek-ai/dsh-*` import, `require`
 * answers from the loader's module table.
 *
 * The surfaces:
 *   - `shell.overlay` carries a full-viewport mask while nobody is logged in, so
 *     the conversation is neither visible nor reachable, and carries the login
 *     form with the demo credentials; once a login is live it renders nothing.
 *   - `sidebar` is the frame's whole left column, which this file takes over
 *     (issue #4): the Customer's initial and the way out, with the account name
 *     and VIP tier on the circle's hover card rather than written out beside it.
 *     The shipped occupant is registered at the default priority 0, so this file
 *     registers at priority -1 — the lowest-priority live entry of a single slot
 *     renders (see ADR-0007). The native navigation — session list, workspaces,
 *     settings — stops rendering with it, and while nobody is logged in the
 *     occupant renders nothing at all.
 *   - `conversation.header.leading` is the demo's name, laid over the view tab
 *     strip: the row above 对话 and 轨迹 reads as the page's title.
 *   - `conversation.view` is the panel (issue #9): a third tab in the row 对话
 *     and 轨迹 share, whose body takes the center pane while it is selected. It
 *     lists the logged-in Customer's own Orders, creates one, and returns one,
 *     all through `plugins/orders/`' routes. Registering `order: 20` puts it
 *     after the shipped views (0 and 10); a view needs no conversation target of
 *     its own when it renders from its own data.
 *   - `tool.call.toolview` keyed by `search_orders` is the order card (issue #5):
 *     the Orders the running call matched, and the buttons that answer it. The
 *     answer is the tool's return value, so a settled call renders from the
 *     result the host logged and replays with no host state at all (ADR-0001).
 *   - `tool.call.toolview` keyed by `manual_return` is the 人工还宝 card (issue
 *     #7): the Order the action closed, with its 归还时间, so the Customer sees
 *     the change on the card as well as hearing it from the Agent.
 *   - `tool.call.toolview` keyed by `refund` is the 退款 card (issue #8), the
 *     same way: the Order the action moved to 已退款, with its 退款时间. The
 *     status carries the money being back, so no card needs a badge for it.
 *
 * And one thing that is not a surface: the opening (issue #6). A Customer who
 * has just logged in has nothing to say yet, so this file asks the host to
 * admit the trigger message the Agent's opening protocol is written for; the
 * Agent then greets and cards the newest Order without being asked.
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
    /** What the demo is called, over the view tabs. */
    const BRAND = '共享充电宝智能客服'
    /** Key the shell persists the selected Session under. */
    const CURRENT_SESSION_KEY = 'dsh.sessions.current'
    /** Shown for any rejected credential pair; names neither field, on purpose. */
    const CREDENTIALS_ERROR = '账号或密码错误'
    /** Shown when the routes could not be reached at all. */
    const NETWORK_ERROR = '无法连接客服服务，请稍后重试'
    /** Shown when leaving failed, so a Customer is not left thinking they are out. */
    const SIGN_OUT_ERROR = '退出登录失败，请重试'
    /** Wire tool name this file's order card occupies; must equal the host tool's name. */
    const ORDER_TOOL_NAME = 'search_orders'
    /** Wire tool name of 人工还宝, whose settled call renders the closed Order. */
    const MANUAL_RETURN_TOOL_NAME = 'manual_return'
    /** Wire tool name of 退款, whose settled call renders the marked Order. */
    const REFUND_TOOL_NAME = 'refund'
    /** Everything the 人工还宝 card says, beside the Order it shows. */
    const MANUAL_RETURN_CARD = {
      kind: 'returned',
      running: '正在办理人工还宝…',
      unfinished: '人工还宝未完成',
      badge: '人工还宝已完成',
    }
    /** The same, for the 退款 card. */
    const REFUND_CARD = {
      kind: 'refunded',
      running: '正在办理退款…',
      unfinished: '退款未完成',
      badge: '退款已完成',
    }
    /** The panel's routes: the calling Customer's own Orders. */
    const ORDERS_PATH = '/orders'
    const ORDERS_CREATE_PATH = '/orders/create'
    const ORDERS_RETURN_PATH = '/orders/return'
    /** The center-pane view this file adds beside 对话 and 轨迹 (issue #9). */
    const ORDERS_VIEW_ID = 'customer-service-orders'
    const ORDERS_VIEW_LABEL = '管理'
    /** View order: the shipped 对话 is 0 and 轨迹 is 10, so this lands third. */
    const ORDERS_VIEW_ORDER = 20
    /** Everything the panel says. */
    const PANEL_CARD = {
      title: '我的订单',
      create: '创建订单',
      createLead: '造一笔「进行中」的订单：',
      location: '租借地点',
      rentedAt: '租借时间',
      rentedAtHint: '租借时间按北京时间填写，留空表示当前时间。订单号与状态由系统生成，金额按借出时长计算：每分钟 ¥0.10，封顶 ¥99.00。',
      submit: '创建',
      cancel: '取消',
      returnOrder: '归还',
      working: '处理中…',
      empty: '还没有订单，点「创建订单」造一笔。',
      loading: '正在加载…',
      loadError: '订单暂时无法加载，请稍后重试',
      createError: '创建订单失败，请重试',
      returnError: '归还失败，请重试',
    }
    /** Order-card polling interval while the host has not published the question yet. */
    const ORDER_POLL_INTERVAL_MS = 800
    /** Order-card polls before it stops and says it could not load the question. */
    const ORDER_POLL_ATTEMPTS = 15
    /** Shown when the order card could not read the question from the host. */
    const ORDER_QUESTION_ERROR = '订单卡片暂时无法加载，请让客服重新查询'
    /** Shown once an answer is on its way, while the blocked tool call finishes. */
    const ORDER_SUBMITTED = '已提交，等待客服回复…'
    /** Shown for an order card whose call never produced a readable outcome. */
    const ORDER_UNFINISHED = '订单查询未完成'
    /** The badge a settled order card carries once the Customer picked the Order. */
    const ORDER_CONFIRMED = '客户已确认'

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

    /**
     * The browser's IANA time zone, as every message the composer sends
     * carries it.
     *
     * The opening request carries it for the same reason: the host admits the
     * trigger as a message from this browser, and the clock the harness injects
     * into that turn is read in this zone. Without it the model is told to ask
     * the Customer which zone they mean.
     * @returns the zone name, or `undefined` when the browser names none.
     */
    function browserTimeZone() {
      try {
        // A runtime can report an empty zone, which is not a zone name: send
        // none instead, so the opening is admitted without one rather than
        // refused for carrying something unusable.
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
      } catch {
        // A browser that cannot name a zone sends none either way.
        return undefined
      }
    }

    // Asking to open happens once per page load. The host admits the trigger
    // only once per Session, so a repeat is a no-op — but both surfaces below
    // resolve the login state, so this flag keeps the ask to one.
    let openingRequested = false

    /**
     * Ask the host to open the conversation, which admits the one trigger
     * message the Agent's opening protocol is written for.
     *
     * A refused opening is reported by the host and not shown here: the Customer
     * is left with an empty conversation they can still type into, which beats a
     * notice over a conversation that is otherwise fine.
     */
    function openConversation() {
      if (openingRequested) return
      openingRequested = true
      void requestJson('/opening', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientTimeZone: browserTimeZone() }),
      }).catch(() => {
        // An unreachable host is the same empty conversation, and the next page
        // load asks again.
      })
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
            openConversation()
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
.cs-sidebar__spacer { flex: 1; min-block-size: 0; }
/* The whole of who is signed in: an initial, and a card on hover. Nothing else
   in the column names the account, so the circle has to read as something to
   point at — hence the highlight on hover and the same one on focus, which is
   how a keyboard reaches the card. */
.cs-visuallyHidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.cs-avatar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 34px;
  block-size: 34px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--dsw-alias-state-business-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  cursor: default;
  user-select: none;
  transition: background-color .15s ease, border-color .15s ease;
}
.cs-avatar:hover, .cs-avatar:focus-visible {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent);
  outline: none;
}
/* Fixed and portalled to the body: the column clips its own overflow, and the
   rail is 56px wide, so a card laid out inside it would be cut in half. */
.cs-avatarCard {
  position: fixed;
  z-index: 1600;
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* Placed at the circle's own middle, so it reads as a label for it. */
  transform: translateY(-50%);
  padding: 9px 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 6px 20px rgba(0, 0, 0, .16);
  color: var(--dsw-alias-label-primary);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  white-space: nowrap;
  pointer-events: none;
}
.cs-avatarCard__name { font-weight: 600; }
.cs-avatarCard__tier { color: var(--dsw-alias-label-secondary); font-size: 12px; }
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

    // The header's leading seat holds no box of its own — the brand is laid over
    // the header instead, because the seat is a grid column and the header's rows
    // are fixed heights that nothing may grow (ConversationRoot.module.css).
    const HEADER_CSS = `
.cs-brand {
  position: absolute;
  /* The header's own 10px top inset and its 30px title row: the text sits on
     the row above the tab strip, centered over the strip's own width. */
  top: 10px;
  left: 50%;
  display: flex;
  align-items: center;
  block-size: 30px;
  transform: translateX(-50%);
  color: var(--dsw-alias-label-primary);
  font: 600 15px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: .02em;
  white-space: nowrap;
  /* The row is the window's drag band on the desktop shell, and the session
     title and its controls sit in it: the brand must not take a click. */
  pointer-events: none;
}
`

    // The order card sits in the conversation, not in a themed frame column, so
    // it paints with the same design tokens the surrounding transcript uses.
    const ORDER_CSS = `
.cs-order {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary);
  font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.cs-order__title { font-weight: 600; }
.cs-order__query { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cs-order__hint { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cs-order__error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.cs-order__list { display: flex; flex-direction: column; gap: 8px; }
.cs-order__item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
}
.cs-order__item--selected {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent);
}
.cs-order__field { display: flex; gap: 8px; }
/* A form row in the panel: label beside input, rather than above it. */
.cs-panel__field { display: flex; align-items: center; gap: 10px; }
.cs-order__input {
  flex: 1;
  min-inline-size: 0;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
}
.cs-order__label { flex: 0 0 4.5em; color: var(--dsw-alias-label-secondary); }
.cs-order__value { flex: 1; min-inline-size: 0; word-break: break-word; }
.cs-order__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.cs-order__button {
  padding: 6px 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.cs-order__button:hover:enabled { background: var(--dsw-alias-interactive-bg-hover); }
.cs-order__button:disabled { cursor: default; opacity: .55; }
.cs-order__button--primary {
  border-color: transparent;
  background: var(--dsw-alias-state-business-primary);
  color: #fff;
}
.cs-order__button--primary:hover:enabled {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 85%, #000);
}
.cs-order__badge {
  align-self: flex-start;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  color: var(--dsw-alias-state-business-primary);
  font-size: 12px;
}
`

    // The panel is a Conversation View: a third tab beside 对话 and 轨迹, whose
    // body takes the center pane. It is a column of the app rather than an
    // overlay, so everything in it paints with the app's own tokens — and it
    // leaves the composer, which floats over the pane, the room the
    // conversation publishes for it.
    const PANEL_CSS = `
.cs-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  block-size: 100%;
  overflow: auto;
  color: var(--dsw-alias-label-primary);
  font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding-block: 20px calc(var(--dsh-composer-height, 152px) + 16px);
  padding-inline: 24px;
}
.cs-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.cs-panel__title { font-size: 15px; font-weight: 600; }
.cs-panel__notice { color: var(--dsw-alias-state-business-primary); }
.cs-panel__actions { display: flex; gap: 8px; }
.cs-panel__list { display: flex; flex-direction: column; gap: 10px; }
.cs-panel__orderHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.cs-panel__orderId { font-weight: 600; }
.cs-panel__status {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.cs-panel__status--in_progress {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
/* The create dialog is the one overlay this file draws over the signed-in app,
   so it takes the mask and the layer from the app's tokens too. */
.cs-panel__overlay {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 24px;
}
.cs-panel__backdrop {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-3);
}
.cs-panel__dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  inline-size: min(480px, 100%);
  padding: 18px 20px 20px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 12px 40px rgba(0, 0, 0, .24);
}
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
     *
     * The column carries the initial alone. The account name and the VIP tier —
     * and nothing about roles, which is the server's business rather than the
     * Customer's — are on a card the circle shows on hover or focus, so the
     * corner stays one mark wide at every column width.
     * @param props - the slot owner's share: the frame's live column state.
     * @returns the column, or `null` while nobody is logged in.
     */
    function CustomerSidebar({ collapsed }) {
      const { phase, customer } = useCustomerSession()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [card, setCard] = useState(null)
      const circle = useRef(null)

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

      // The card is measured from the circle rather than laid out beside it:
      // the column clips its overflow and the collapsed rail is 56px wide, so
      // only a fixed-position card can hang outside it at both widths.
      const showCard = useCallback(() => {
        const box = circle.current?.getBoundingClientRect()
        if (box === undefined) return
        setCard({ left: `${box.right + 10}px`, top: `${box.top + box.height / 2}px` })
      }, [])
      const hideCard = useCallback(() => {
        setCard(null)
      }, [])

      if (phase !== 'authenticated' || customer === null) return null

      // The rail is 56px wide and clips, so the failure message rides on the
      // button's tooltip there and gets a line of its own in the full column.
      const signOutButton = (className, label) => h('button', {
        type: 'button',
        className,
        title: error || '退出登录',
        disabled: busy,
        onClick: leave,
      }, label)

      return h('div', {
        className: collapsed ? 'cs-sidebar cs-sidebar--rail' : 'cs-sidebar',
        'data-customer-service-sidebar': collapsed ? 'rail' : 'full',
      },
      h('div', {
        ref: circle,
        className: 'cs-avatar',
        'data-customer-service-account': '',
        tabIndex: 0,
        onMouseEnter: showCard,
        onMouseLeave: hideCard,
        onFocus: showCard,
        onBlur: hideCard,
      },
      customer.accountName.slice(0, 1).toUpperCase(),
      // The circle says everything the card does, for whoever cannot see it:
      // the card is the same two facts drawn beside the mark, so it is hidden
      // from assistive technology rather than read twice.
      h('span', { className: 'cs-visuallyHidden' },
        `当前账号 ${customer.accountName}，VIP 等级 ${customer.tierLabel}`),
      ),
      h('div', { className: 'cs-sidebar__spacer' }),
      error === '' ? null : h('div', { className: 'cs-sidebar__error', role: 'alert' }, error),
      signOutButton(collapsed ? 'cs-signout cs-signout--rail' : 'cs-signout', collapsed ? '退出' : '退出登录'),
      card === null ? null : createPortal(h('div', {
        className: 'cs-avatarCard',
        'aria-hidden': 'true',
        style: card,
        'data-customer-service-account-card': '',
      },
      h('div', { className: 'cs-avatarCard__name' }, customer.accountName),
      h('div', { className: 'cs-avatarCard__tier' }, `VIP 等级：${customer.tierLabel}`),
      ), document.body),
      )
    }

    /**
     * The demo's name, centered over the row that holds the view tabs.
     *
     * It rides the header's leading seat, which is the only seat the frame
     * leaves above the tab strip. The seat is a grid column — one whose width
     * the header's own layout solves — so the brand is taken out of that flow
     * and positioned against the conversation column instead (the column is the
     * positioning context its own stylesheet publishes for slot chrome).
     * @returns the brand.
     */
    function BrandTitle() {
      return h('div', { className: 'cs-brand', 'data-customer-service-brand': '' }, BRAND)
    }

    /**
     * Flatten settled result content blocks into one line of copy.
     * @param content - the result node's content blocks.
     * @returns the text, or `''` when the blocks carry none.
     */
    function resultText(content) {
      if (!Array.isArray(content)) return ''
      return content
        .map(item => (item !== null && typeof item === 'object' && item.type === 'text' ? item.text : ''))
        .join('\n')
        .trim()
    }

    /**
     * Read one pending order question from the host.
     *
     * The candidates cannot ride the session log — an out-of-tree plugin
     * cannot mint a session event — so the card fetches them from the route.
     * The host publishes the question when the tool starts, a moment after the
     * call reaches the browser, so a `404` means "not yet" and the poll waits.
     * @param callId - the tool call the card belongs to.
     * @param phase - the call's stage; only a running call has a live question.
     * @returns the load state, and the query and candidate Orders once loaded.
     */
    function useOrderQuestion(callId, phase) {
      const [question, setQuestion] = useState({ status: 'loading' })
      useEffect(() => {
        if (phase !== 'start') return undefined
        let cancelled = false
        const controller = new AbortController()
        void (async () => {
          const path = `/order-question?callId=${encodeURIComponent(callId)}`
          for (let attempt = 0; attempt < ORDER_POLL_ATTEMPTS; attempt++) {
            let answer
            try {
              answer = await requestJson(path, { signal: controller.signal })
            } catch {
              // The page is unloading or the host is unreachable; either way a
              // retry cannot succeed, so the card stops rather than spinning.
              if (!cancelled) setQuestion({ status: 'unavailable' })
              return
            }
            if (cancelled) return
            if (answer.ok && Array.isArray(answer.payload?.candidates)) {
              setQuestion({
                status: 'ready',
                query: answer.payload.query ?? {},
                candidates: answer.payload.candidates,
              })
              return
            }
            if (answer.status !== 404) {
              setQuestion({ status: 'unavailable' })
              return
            }
            await new Promise(resolve => setTimeout(resolve, ORDER_POLL_INTERVAL_MS))
            if (cancelled) return
          }
          setQuestion({ status: 'unavailable' })
        })()
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [callId, phase])
      return question
    }

    /**
     * Answer the pending order question for one call.
     * @param callId - the tool call the answer belongs to.
     * @returns the submit callback, whether a submit is in flight, and the last
     *   failure to show. `orderId` is `null` for "none of these Orders".
     */
    function useOrderAnswer(callId) {
      const [state, setState] = useState({ busy: false, error: '' })
      // The request starts in the handler, never inside the updater: an updater
      // must be pure, and React may call one twice — which would post the
      // answer twice and paint the second (404) over the first one's success.
      const busy = useRef(false)
      const submit = useCallback(orderId => {
        if (busy.current) return
        busy.current = true
        setState({ busy: true, error: '' })
        void (async () => {
          let answer
          try {
            answer = await requestJson('/order-question/answer', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ callId, orderId }),
            })
          } catch {
            busy.current = false
            setState({ busy: false, error: NETWORK_ERROR })
            return
          }
          // A refused answer releases the buttons so the Customer can try
          // again; an accepted one stays busy, because the card now waits for
          // the blocked tool call to come back with the chosen Order.
          if (answer.ok) return
          busy.current = false
          setState({ busy: false, error: answer.payload?.error ?? NETWORK_ERROR })
        })()
      }, [callId])
      return { ...state, submit }
    }

    /** Amount as the Customer sees it; the host stores integer cents. */
    function formatAmount(amountCents) {
      return typeof amountCents === 'number' ? `¥${(amountCents / 100).toFixed(2)}` : ''
    }

    /**
     * The stored offset-carrying timestamp as local wall-clock text.
     * @param stamp - an ISO-8601 timestamp the host stored.
     * @returns `YYYY-MM-DD HH:MM`, which is the time at the venue.
     */
    function formatStamp(stamp) {
      return typeof stamp === 'string' ? stamp.slice(0, 16).replace('T', ' ') : ''
    }

    /**
     * One labelled field of an Order.
     * @param label - the Chinese field name.
     * @param value - the already-formatted value.
     * @returns the field row.
     */
    function orderField(label, value) {
      return h('div', { className: 'cs-order__field', key: label },
        h('span', { className: 'cs-order__label' }, label),
        h('span', { className: 'cs-order__value' }, value),
      )
    }

    /**
     * The fields a Customer recognizes an Order by, plus its money and state.
     *
     * 归还时间 appears once the Order carries one, which is how a Customer sees
     * that a 人工还宝 really closed it rather than only saying so; 退款时间 does
     * the same for a 退款, beside a status that the refund left alone.
     * @param order - an Order as the host projected it, with its status label.
     * @returns the field rows.
     */
    function orderFields(order) {
      return [
        orderField('租借地点', order.location),
        orderField('租借时间', formatStamp(order.rentedAt)),
        orderField('金额', formatAmount(order.amountCents)),
        orderField('状态', order.statusLabel ?? ''),
        ...(typeof order.returnedAt === 'string' ? [orderField('归还时间', formatStamp(order.returnedAt))] : []),
        ...(typeof order.refundedAt === 'string' ? [orderField('退款时间', formatStamp(order.refundedAt))] : []),
      ]
    }

    /**
     * One Order as the card shows it: the fields a Customer reads it by, the
     * status among them — 已退款 is a status, so the money being back needs no
     * badge of its own.
     * @param order - an Order as the host projected it.
     * @returns the rows one `cs-order__item` holds.
     */
    function orderBody(order) {
      return orderFields(order)
    }

    /** The query the host ran, as one line, or `null` when it had no filter. */
    function queryLine(query) {
      const parts = []
      if (typeof query.location === 'string') parts.push(`地点：${query.location}`)
      if (typeof query.rentedFrom === 'string') parts.push(`租借时间从 ${query.rentedFrom.slice(0, 10)}`)
      if (typeof query.rentedTo === 'string') parts.push(`到 ${query.rentedTo.slice(0, 10)}`)
      if (parts.length === 0) return null
      return h('div', { className: 'cs-order__query' }, parts.join('，'))
    }

    /** A card that carries one line of copy and nothing to click. */
    function orderNotice(text, className) {
      return h('div', { className: className ?? 'cs-order', 'data-customer-service-order': 'notice' },
        h('div', { className: 'cs-order__title' }, text),
      )
    }

    /**
     * A settled card showing one Order under a badge that says how it got there.
     * @param kind - the `data-customer-service-order` state this card renders.
     * @param badge - the badge copy.
     * @param order - an Order as the host projected it.
     * @returns the card.
     */
    function settledOrderCard(kind, badge, order) {
      return h('div', { className: 'cs-order', 'data-customer-service-order': kind },
        h('div', { className: 'cs-order__badge' }, badge),
        h('div', { className: 'cs-order__list' },
          h('div', { className: 'cs-order__item cs-order__item--selected' }, ...orderBody(order)),
        ),
      )
    }

    /**
     * A settled card for a call that published no read Order: the call's own
     * result text is then the only honest thing to show.
     * @param title - what the card says happened.
     * @param block - the settled result node.
     * @returns the card.
     */
    function unreadableCallCard(title, block) {
      const text = resultText(block.content)
      return h('div', { className: 'cs-order', 'data-customer-service-order': 'failed' },
        h('div', { className: 'cs-order__title' }, title),
        text === '' ? null : h('div', { className: 'cs-order__error' }, text),
      )
    }

    /**
     * The settled state, rendered from the result the host logged so a replayed
     * Session shows the same card with no host state at all.
     * @param block - the settled result node.
     * @returns the confirmed Order, or why the call returned none.
     */
    function OrderResult(block) {
      const meta = block.meta
      const outcome = meta !== null && typeof meta === 'object' ? meta.outcome : undefined
      if (outcome === 'selected' && meta.order !== undefined) {
        return settledOrderCard('confirmed', ORDER_CONFIRMED, meta.order)
      }
      if (outcome === 'declined') {
        return orderNotice('客户没有选中这次查到的订单，请再问一次大概的时间或地点')
      }
      if (outcome === 'none') return orderNotice('没有查到符合条件的订单')
      return unreadableCallCard(ORDER_UNFINISHED, block)
    }

    /**
     * The order card for one `search_orders` call: the Orders the call matched,
     * and the Customer's answer to them.
     *
     * Every hook runs before any branch, so the card can move from the running
     * stage to the settled one without changing its hook order.
     * @param props - the slot owner's share: the call identity and its stage.
     * @returns the card.
     */
    function OrderCard(props) {
      const { callId, phase, block } = props
      const question = useOrderQuestion(callId, phase)
      const answer = useOrderAnswer(callId)

      if (phase === 'result') return OrderResult(block)
      if (phase === 'preparing' || question.status === 'loading') {
        return orderNotice('正在查询订单…')
      }
      if (question.status === 'unavailable') {
        return h('div', { className: 'cs-order', 'data-customer-service-order': 'unavailable' },
          h('div', { className: 'cs-order__title' }, ORDER_QUESTION_ERROR),
        )
      }

      const candidates = question.candidates
      const choose = (label, orderId, primary) => h('button', {
        type: 'button',
        key: label,
        className: primary ? 'cs-order__button cs-order__button--primary' : 'cs-order__button',
        disabled: answer.busy,
        onClick: () => answer.submit(orderId),
      }, label)

      // One match is the demo's opening question, answered yes or no; several
      // means the Customer has to say which one, and "none of them" is the
      // honest third answer either way.
      const items = candidates.map(candidate => h('div', {
        key: candidate.orderId,
        className: 'cs-order__item',
      },
      ...orderBody(candidate),
      candidates.length === 1
        ? h('div', { className: 'cs-order__actions' },
          choose('是，就是这一笔', candidate.orderId, true),
          choose('不是', null, false),
        )
        : h('div', { className: 'cs-order__actions' }, choose('选这笔', candidate.orderId, false)),
      ))

      return h('div', { className: 'cs-order', 'data-customer-service-order': 'pending' },
        h('div', { className: 'cs-order__title' },
          candidates.length === 1 ? '请问您咨询的是这个订单吗？' : `查到 ${candidates.length} 笔订单，请选择要咨询的那一笔`),
        queryLine(question.query),
        h('div', { className: 'cs-order__list' }, ...items),
        candidates.length > 1
          ? h('div', { className: 'cs-order__actions' }, choose('都不是', null, false))
          : null,
        answer.error === '' ? null : h('div', { className: 'cs-order__error', role: 'alert' }, answer.error),
        answer.busy ? h('div', { className: 'cs-order__hint' }, ORDER_SUBMITTED) : null,
      )
    }

    /**
     * The settled state of one action call: the Order as the host left it.
     *
     * Like the order card, this renders from the result the host logged — the
     * Order it returned is persisted with the call, status label included — so a
     * replayed Session shows the same written Order with no host state at all.
     * @param copy - the action's card copy.
     * @param block - the settled result node.
     * @returns the written Order, or why the call returned none.
     */
    function actionResult(copy, block) {
      const meta = block.meta
      const order = meta !== null && typeof meta === 'object' ? meta.order : undefined
      if (order !== null && typeof order === 'object') return settledOrderCard(copy.kind, copy.badge, order)
      return unreadableCallCard(copy.unfinished, block)
    }

    /**
     * The card for one 人工还宝 call.
     *
     * There is nothing to answer here — the verdict was reached before this call
     * and the Customer already heard it — so the running state says what is
     * happening and the settled state shows what happened.
     * @param props - the slot owner's share: the call's stage and its result.
     * @returns the card.
     */
    function ManualReturnCard(props) {
      if (props.phase !== 'result') return orderNotice(MANUAL_RETURN_CARD.running)
      return actionResult(MANUAL_RETURN_CARD, props.block)
    }

    /**
     * The card for one 退款 call, exactly as the 人工还宝 card works. The Order
     * it shows reads 已退款 in its status field, with the 退款时间 beside it.
     * @param props - the slot owner's share: the call's stage and its result.
     * @returns the card.
     */
    function RefundCard(props) {
      if (props.phase !== 'result') return orderNotice(REFUND_CARD.running)
      return actionResult(REFUND_CARD, props.block)
    }

    /**
     * The create dialog: the panel's one form, and the only thing in this file
     * that writes an Order.
     *
     * The dialog posts and reports back; the panel decides what to say and
     * reloads, so the form never has to know how the list is kept.
     * @param props - how to close the dialog, and what to do with a created Order.
     * @returns the dialog.
     */
    function CreateOrderDialog({ onClose, onCreated }) {
      const [form, setForm] = useState({ location: '', rentedAt: '' })
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      /** Change one form field. */
      const edit = (field, value) => setForm(current => ({ ...current, [field]: value }))

      /** Post the Order the form describes, and hand it back to the panel. */
      const submit = useCallback(event => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
        void (async () => {
          const answer = await requestJson(ORDERS_CREATE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              location: form.location,
              // An empty field means "now", which is the host's reading too; a
              // filled one is the time the Customer picked. The amount is the
              // host's to bill from it.
              ...form.rentedAt === '' ? {} : { rentedAt: form.rentedAt },
            }),
          })
          setBusy(false)
          if (!answer.ok) {
            setError(answer.payload?.error ?? PANEL_CARD.createError)
            return
          }
          onCreated(answer.payload.order)
        })().catch(() => {
          setBusy(false)
          setError(NETWORK_ERROR)
        })
      }, [busy, form, onCreated])

      /** One labelled input of the form. */
      const field = (label, input) => h('label', { className: 'cs-panel__field' }, label, input)

      return createPortal(h('div', {
        className: 'cs-panel__overlay',
        'data-customer-service-panel': 'create',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': PANEL_CARD.create,
      },
      h('div', { className: 'cs-panel__backdrop', onClick: onClose }),
      h('form', { className: 'cs-panel__dialog', onSubmit: submit },
        h('div', { className: 'cs-panel__title' }, PANEL_CARD.createLead),
        field(PANEL_CARD.location, h('input', {
          className: 'cs-order__input',
          name: 'location',
          value: form.location,
          placeholder: '万象城购物中心 B1 层服务台',
          disabled: busy,
          onChange: event => edit('location', event.target.value),
        })),
        field(PANEL_CARD.rentedAt, h('input', {
          className: 'cs-order__input',
          name: 'rentedAt',
          type: 'datetime-local',
          value: form.rentedAt,
          disabled: busy,
          onChange: event => edit('rentedAt', event.target.value),
        })),
        h('div', { className: 'cs-order__hint' }, PANEL_CARD.rentedAtHint),
        error === '' ? null : h('div', { className: 'cs-order__error', role: 'alert' }, error),
        h('div', { className: 'cs-panel__actions' },
          h('button', {
            type: 'submit',
            className: 'cs-order__button cs-order__button--primary',
            disabled: busy || form.location.trim() === '',
          }, busy ? PANEL_CARD.working : PANEL_CARD.submit),
          h('button', {
            type: 'button',
            className: 'cs-order__button',
            disabled: busy,
            onClick: onClose,
          }, PANEL_CARD.cancel),
        ),
      )), document.body)
    }

    /**
     * The panel (issue #9): every Order the logged-in Customer has, a way to
     * create one, and a way to close one — the third Conversation View, beside
     * 对话 and 轨迹.
     *
     * It renders the routes' answer rather than anything it holds itself: which
     * Orders exist, what state they are in and what number a new one gets are
     * the server's to say, and the Customer it asks about is the one the login
     * cookie names. So the panel has nothing to keep in step, and a reload shows
     * the same thing.
     * @returns the panel.
     */
    function OrdersPanel() {
      const [data, setData] = useState({ status: 'loading', orders: [] })
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [creating, setCreating] = useState(false)

      const load = useCallback(async () => {
        const answer = await requestJson(ORDERS_PATH)
        if (!answer.ok || !Array.isArray(answer.payload?.orders)) throw new Error(PANEL_CARD.loadError)
        setData({ status: 'ready', orders: answer.payload.orders })
      }, [])

      useEffect(() => {
        let cancelled = false
        void load().catch(() => {
          if (!cancelled) setData({ status: 'unavailable', orders: [] })
        })
        return () => {
          cancelled = true
        }
      }, [load])

      /** Take the created Order into the list, and say which number it got. */
      const created = useCallback(order => {
        setCreating(false)
        setError('')
        setNotice(`已创建订单 ${order.orderId}：${order.location}，${formatStamp(order.rentedAt)} 租出，`
          + `${formatAmount(order.amountCents)}，状态「${order.statusLabel}」。`)
        void load().catch(() => {
          setError(PANEL_CARD.loadError)
        })
      }, [load])

      /** Close one Order, and say when it was returned. */
      const returnOrder = useCallback(orderId => {
        if (busy) return
        setBusy(true)
        setError('')
        setNotice('')
        void (async () => {
          let answer
          try {
            answer = await requestJson(ORDERS_RETURN_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ orderId }),
            })
          } catch {
            setBusy(false)
            setError(NETWORK_ERROR)
            return
          }
          setBusy(false)
          if (!answer.ok) {
            setError(answer.payload?.error ?? PANEL_CARD.returnError)
            return
          }
          const order = answer.payload.order
          setNotice(`订单 ${order.orderId} 已归还，归还时间 ${formatStamp(order.returnedAt)}。`)
          // The write stands whether or not the reload lands; a reload that
          // fails is a stale list, not a failed 归还.
          void load().catch(() => {
            setError(PANEL_CARD.loadError)
          })
        })()
      }, [busy, load])

      const body = data.status === 'loading'
        ? h('div', { className: 'cs-order__hint' }, PANEL_CARD.loading)
        : data.status === 'unavailable'
          ? h('div', { className: 'cs-order__error', role: 'alert' }, PANEL_CARD.loadError)
          : data.orders.length === 0
            ? h('div', { className: 'cs-order__hint' }, PANEL_CARD.empty)
            : h('div', { className: 'cs-panel__list' }, ...data.orders.map(order => h('div', {
              key: order.orderId,
              className: 'cs-order__item',
              'data-customer-service-panel-order': order.orderId,
            },
            h('div', { className: 'cs-panel__orderHead' },
              h('span', { className: 'cs-panel__orderId' }, order.orderId),
              h('span', {
                className: `cs-panel__status cs-panel__status--${order.status}`,
                'data-customer-service-panel-status': order.status,
              }, order.statusLabel ?? ''),
            ),
            ...orderFields(order),
            // Only a power bank that is still out can come back; the other two
            // statuses are further along the lifecycle than this button.
            order.status === 'in_progress'
              ? h('div', { className: 'cs-order__actions' },
                h('button', {
                  type: 'button',
                  className: 'cs-order__button',
                  disabled: busy,
                  onClick: () => returnOrder(order.orderId),
                }, PANEL_CARD.returnOrder),
              )
              : null,
            )))

      return h('div', { className: 'cs-panel', 'data-customer-service-panel': 'orders' },
        h('div', { className: 'cs-panel__header' },
          h('div', { className: 'cs-panel__title' }, PANEL_CARD.title),
          h('button', {
            type: 'button',
            className: 'cs-order__button cs-order__button--primary',
            'data-customer-service-panel-create': '',
            onClick: () => {
              setCreating(true)
            },
          }, PANEL_CARD.create),
        ),
        notice === '' ? null : h('div', { className: 'cs-panel__notice', role: 'status' }, notice),
        error === '' ? null : h('div', { className: 'cs-order__error', role: 'alert' }, error),
        body,
        creating ? h(CreateOrderDialog, { onClose: () => setCreating(false), onCreated: created }) : null,
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
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.customerService = 'header'
          style.textContent = HEADER_CSS
          document.head.append(style)
          return () => {
            style.remove()
          }
        }, 'customer-service-ui: header styles')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.customerService = 'order'
          style.textContent = ORDER_CSS
          document.head.append(style)
          return () => {
            style.remove()
          }
        }, 'customer-service-ui: order card styles')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.customerService = 'panel'
          style.textContent = PANEL_CSS
          document.head.append(style)
          return () => {
            style.remove()
          }
        }, 'customer-service-ui: panel styles')
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
        // The seat above the view tabs, which the shipped chrome leaves empty.
        ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
          name: 'conversation.header.leading',
        }, BrandTitle))
        // The panel is a Conversation View: a third tab in the row 对话 and 轨迹
        // share, whose body takes the center pane while it is selected. The
        // shipped views sit at orders 0 and 10, so 20 puts this one last, to
        // their right. A View needs no conversation target of its own — this one
        // renders from its own routes rather than from the transcript.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: ORDERS_VIEW_ID,
          order: ORDERS_VIEW_ORDER,
          label: ORDERS_VIEW_LABEL,
        }, OrdersPanel))
        // Keyed by the wire tool name: the key IS the dispatch value, so a
        // rename on either side would silently fall back to the generic row.
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: ORDER_TOOL_NAME,
        }, OrderCard))
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: MANUAL_RETURN_TOOL_NAME,
        }, ManualReturnCard))
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: REFUND_TOOL_NAME,
        }, RefundCard))
      },
    }
  },
})
