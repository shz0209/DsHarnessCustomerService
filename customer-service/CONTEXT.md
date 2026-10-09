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
A Customer whose account carries an admin flag, used only for the back-office test panel. Not a separate kind of account.

### Rental

**Order** (订单):
One power bank rental: a customer takes a power bank from a location and is expected to return it to a location.
Carries 订单号, 金额, 租借时间, 租借地点, customerId, and status. A Customer may have many Orders.

**Order status** (订单状态):
`进行中` (in progress) — the power bank is out with the Customer.
`已归还` (returned) — the rental is closed.
These two are the whole lifecycle; nothing else is a status. A refund does not change an Order's status.

**租借时间 / 借出时间** (rental time):
The same field: the moment the power bank left the location. The two names are used interchangeably in the business rules; this glossary treats them as one term.

**租借地点** (rental location):
The location a power bank was taken from. Also what the back-office form calls 地址.

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
The Agent returning the whole Order amount to the Customer. Recorded on the Order without changing its status.

**校验** (validation):
A check the Agent must run before 人工还宝 or 退款, deciding whether that action is permitted for the Order. Each action has its own validation rules. A passing validation authorises exactly one action on exactly one Order.
