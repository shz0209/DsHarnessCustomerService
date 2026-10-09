# Customer Service — Context

Glossary for the shared-power-bank customer service demo built as plugins on DeepSeek Harness.
This file is a glossary only: no implementation detail, no specs.

## Language

### Parties

**Customer** (客户):
The person who rented a power bank and is talking to the customer service agent. Identified by `customerId`.
_Avoid_: User, 用户 — the harness already uses "user" for its own identity and settings concepts (`packages/identity`, `packages/settings`).

**Agent** (机器人客服):
The AI customer service agent a Customer converses with. Distinct from a Customer.

**Administrator** (管理员):
A Customer whose account carries an admin flag. Not a separate kind of account, and nothing in the demo requires one: the flag is a label the sidebar and the Agent's identity line show.

### Rental

**Order** (订单):
One power bank rental: a customer takes a power bank from a location and is expected to return it to a location.
Carries 订单号, 金额, 租借时间, 租借地点, customerId and status; a closed Order may also carry 归还时间, and a refunded one 退款时间. A Customer may have many Orders.

**Order status** (订单状态):
`进行中` (in progress) — the power bank is out with the Customer.
`已归还` (returned) — the power bank came back, so the rental is closed.
`已退款` (refunded) — the money went back as well.
These three are the whole lifecycle, and it runs one way: 进行中 → 已归还 → 已退款.

**租借时间 / 借出时间** (rental time):
The same field: the moment the power bank left the location. The two names are used interchangeably in the business rules; this glossary treats them as one term.

**归还时间** (return time):
The moment the power bank came back, recorded when an Order becomes `已归还`. It is there only when the return was recorded: an Order may be `已归还` without one.

**退款时间** (refund time):
The moment the money went back, recorded when an Order becomes `已退款`.

**租借地点** (rental location):
The location a power bank was taken from. Also what the panel's create form calls 地址.

**VIP tier** (会员等级):
The Customer's membership tier. Four tiers, ordered:
1. 白银 (Silver)
2. 黄金 (Gold)
3. 铂金 (Platinum)
4. 黑金 (Black Gold)

### Service actions

**开场** (opening):
The Agent's first move of a conversation, made as soon as the Customer logs in: it greets them and presents the Customer's most recently rented Order as a card to confirm. The Customer says nothing first.

**人工还宝** (manual return):
The Agent closing a rental on the Customer's behalf, for a Customer who cannot return the power bank to a location themselves.
It sets the Order to `已归还` and records the return time.

**退款** (refund):
The Agent returning the whole Order amount to the Customer. It moves a `已归还` Order to `已退款` and records the refund time.

**校验** (validation):
A check the Agent must run before 人工还宝 or 退款, deciding whether that action is permitted for the Order. Each action has its own validation rules. A passing validation authorises exactly one action on exactly one Order.

**凭证** (grant):
What a passing 校验 hands the Agent. Bound to the Customer, the Order, the action and the conversation that earned it; spent by its first use, and short-lived. The action tools accept nothing else as authority.

### Around the service

**管理面板** (order panel):
The logged-in Customer's own view of their Orders: it lists every Order they have whatever its status, creates one, and returns one. It is not a service action — nothing there runs a 校验 or spends a 凭证, because the Agent is not the one acting. What it does is scoped to the Customer by the login, like everything else.
