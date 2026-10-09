# 共享充电宝智能客服

一套跑在 DeepSeek Harness 上的智能客服演示系统，全部代码放在本目录，经 `--patch` 覆盖层加载，不改动 `packages/`（见 [ADR-0003](docs/adr/0003-out-of-tree-local-plugin-directory.md)）。产品说明见 [docs/product-overview.md](docs/product-overview.md)，术语见 [CONTEXT.md](CONTEXT.md)。

## 启动

先构建一次 harness（本目录的插件不需要构建，理由见下）：

```sh
pnpm install --frozen-lockfile
pnpm run build
```

然后从**仓库根目录**启动 Web：

```sh
pnpm dsh --profile web --patch customer-service/app.overlay.yml
```

`--profile web` 必须写在 `--patch` 前面：启动器在遇到第一个非选项参数（profile 名）后就停止解析选项，写成 `pnpm dsh web --patch …` 会把 `--patch` 当成应用参数而报 `unknown option`。

覆盖层**内部**的插件名相对覆盖层文件所在目录解析，所以那里写的相对路径不受调用目录影响，换目录执行只需要改 `--patch` 这一个参数。覆盖层里有**两个**值相对调用目录解析——数据库路径 `customer-service/data/customer-service.sqlite`，以及客服会话所属工作区 `process.getBuiltinModule('node:path').resolve('customer-service')`——这就是启动命令要求从仓库根目录执行的原因。

## 演示账号

四个 VIP 等级各一个，密码在库里以加盐哈希（`scrypt$盐$哈希`）保存，明文只出现在这里和登录页的小字里。

| 账号 | 密码 | VIP 等级 | 管理员 |
| --- | --- | --- | --- |
| `silver` | `silver123` | 白银 | 否 |
| `gold` | `gold123` | 黄金 | 否 |
| `platinum` | `platinum123` | 铂金 | 否 |
| `blackgold` | `blackgold123` | 黑金 | 是 |

账号在首次启动时播种，已存在的行不会被覆盖；删掉 `customer-service/data/customer-service.sqlite` 即可重新播种。库里存的只有哈希，可以直接看：`sqlite3 customer-service/data/customer-service.sqlite 'select value from u_customer_customers'` 出来的每一行都是 `scrypt$…`（表名来自存储域的 KV 形式，一行一个账号，`value` 是 JSON）。

## 当前状态：登录、身份、侧栏、订单卡片、开场、人工还宝、退款与管理面板（issue #3、#4、#5、#6、#7、#8、#9）

```
app.overlay.yml                   覆盖层：SQLite 后端、Customer 域、下面五个插件
plugins/shared/vocabulary.js      等级取值与中文名、订单状态（进行中/已归还/已退款）与中文名
plugins/shared/http.js            裸 HTTP 路由的注册与 JSON 收发
plugins/shared/time.js            演示时区（UTC+8）与时间戳渲染
plugins/shared/orders.js          Order 的模型可见投影、卡片投影、一行文案与时间格式
plugins/shared/grants.js          一次性校验凭证：签发、使用、过期、订单变更即失效
plugins/store/index.js            Customer 表、Order 表、演示数据播种、customerStore 服务
plugins/store/passwords.js        scrypt 加盐哈希与定时安全比较
plugins/auth/index.js             裸 HTTP 路由、会话绑定、开场投递、注入模型的身份与开场协议
plugins/tools/index.js            search_orders 工具、订单卡片作答路由、工具白名单
plugins/tools/validation.js       校验 + 动作这一对工具的共用实现（凭证的签发与使用）
plugins/tools/manual-return.js    人工还宝：规则与两个工具的声明
plugins/tools/refund.js           退款：规则与两个工具的声明
plugins/orders/index.js           管理面板的裸 HTTP 路由：看自己的订单、造一笔、归还一笔
plugins/ui/                       浏览器半边：登录页、侧栏接管、订单卡片、管理面板、还宝/退款卡片与开场请求
  index.js                        宿主半边（空 apply，只为让 Loader 有一行）
  client.js                       手写的闭包工厂，无构建步骤
```

宿主半边不 import 任何包（服务全部由 `ctx` 提供），浏览器半边是 `window.__ModuleLoader__.load({ id, factory })` 形式的普通 JavaScript。这个写法的理由是仓库外的代码解析不到 `@deepseek-ai/dsh-*`，见 [ADR-0006](docs/adr/0006-out-of-tree-plugin-authoring-constraints.md)。客户身份一律从登录态解析，工具不接收客户标识，见 [ADR-0004](docs/adr/0004-customer-identity-from-login-not-parameter.md)。

**登录与退出。** 四条路由都由 `webServer.register` 直接注册，不经远程方法装饰器（远程方法读不到登录 cookie）：

| 路由 | 作用 |
| --- | --- |
| `POST /customer-service/login` | 校验账号密码；通过则新建 harness 会话并下发 `cs_session` cookie |
| `POST /customer-service/logout` | 解绑会话并清除 cookie |
| `GET /customer-service/session` | 当前登录态（账号名、等级、绑定的会话 id） |
| `GET /customer-service/demo-accounts` | 登录页小字用的演示账号清单 |

会话绑定只活在本进程内：登录时建立，退出时删除，重启后需要重新登录。这也是库里没有绑定表的原因——演示够用，且少一张表。

登录建立的会话挂在 `config.workspacePath` 指向的工作区上（覆盖层里解析为 `customer-service/`）。这一步不能省：只带工作目录、不挂工作区的会话，浏览器会渲染成「选择一个工作区」落地页，客户于是在另一个未绑定的会话里提问，`customerIdentity` 永远匹配不上，模型什么也收不到。

## 侧栏接管（issue #4）

左栏整列由本项目的浏览器插件接管：账号名、VIP 等级徽章（中文）、底部「退出登录」。原生侧栏的会话列表、工作区、设置入口都不再出现，而对话界面本身不动——订单卡片渲染在它里面。未登录时这个占用者不渲染任何内容。

机制是槽位系统的遮盖（[ADR-0007](docs/adr/0007-sidebar-takeover-by-lower-slot-priority.md)）：`sidebar` 是 `kind: 'single'` 的根槽位，一格只渲染一个条目，**最低 `priority` 的存活条目渲染**；原生占用者 `ui-sidebar` 用默认的 0 注册，本项目注册 `priority: -1` 把它遮盖掉。列宽、折叠、拖拽仍归 `AppFrame`——折叠成 56px 轨道时本项目只留等级徽章与「退出」。

## 订单卡片（issue #5）

**数据。** Customer 与 Order 在同一个存储域（`customer`）下各占一张表（`customers`、`orders`）。四个演示账号各播种两笔订单——一笔「进行中」、一笔「已归还」，各有订单号、金额、租借地点、租借时间。`blackgold` 另有**当天（2026-10-09）**的三笔（`ord-black-gold-3/4/5`，两个地点在不同时段），这样「今天」这种宽口径的时间查询能一次命中多笔，走到卡片「从中挑选」那条路径。播种按主键判断，已存在的行不覆盖，所以重启不掉数据、也不重复插；这些行和其他演示数据一样是冻结日期，不跟随系统时钟。

**`search_orders`。** 客服唯一能调用的工具，三个可选参数：`location`（按包含匹配）、`rentedFrom` / `rentedTo`（ISO-8601，含端点）。**两个都不给**时查的是该客户**时间最近**的一笔——「我最近的订单」这句话要的就是这笔；给了任一参数才是一次按条件的检索。查询只在当前客户名下进行——工具**没有客户参数**，身份一律从登录态解析（[ADR-0004](docs/adr/0004-customer-identity-from-login-not-parameter.md)），所以别人的订单号完全不可达。一笔都没查到时返回 `none`：如实告诉模型，不弹卡片、不阻塞。

**时间一律是北京时间（UTC+8）。** 库里的订单时间戳带 `+08:00`，harness 每轮注入的时钟也告诉模型「没有时区的时间按浏览器所在时区解释」（演示就跑在该时区），所以工具对参数的读法与之对齐：只写日期（`2026-10-09`）表示那一天的北京时间，不带偏移的时间（`2026-10-09T18:40:00`）按北京时间读，带了偏移的照写照算——三处同口径，不会出现「卡片上的日期差一天」这种事。

**卡片。** 查到订单后工具**阻塞**，把候选推给客户，等作答后才返回（[ADR-0001](docs/adr/0001-order-card-as-blocking-tool.md)）；返回值就是客户确认的那一笔 Order，于是「订单进了模型上下文」与「内容可从会话日志重建」两件事同时成立。卡片注册在按键槽位 `tool.call.toolview` 上，`key` 就是工具名 `search_orders`。单笔命中时只问「是 / 否」；按条件检索命中多笔时逐条列出租借地点、租借时间、金额与状态供挑选。客户说「都不是」时返回 `declined`。

候选与作答走两条裸 HTTP 路由，和登录一样不经远程方法装饰器：

| 路由 | 作用 |
| --- | --- |
| `GET /customer-service/order-question?callId=…` | 卡片读取待作答的查询条件与候选订单 |
| `POST /customer-service/order-question/answer` | 回传 `{callId, orderId}`；`orderId: null` 表示都不是 |

候选不走会话日志，是因为仓库外的插件无法新增 session 事件类型（[ADR-0006](docs/adr/0006-out-of-tree-plugin-authoring-constraints.md)）。两条路由都要求登录，并且只认**发起这次查询的那个会话**：别人的 `callId` 得到 404 而不是 403——谁正在被服务不是客户该知道的事。回合被取消（关标签页、停止生成）时工具调用立即结束，卡片随之失效。

**工具白名单。** 客服既看不到也调不动白名单之外的任何工具，包括 harness 自带的一切：调用 `bash`、`read`、`run_code` 之类的名字得到的是「工具不存在」。白名单写死在插件里，没有配置开关，凡本进程的 agent（已经在的与之后新建的）都在**各自的 agent 作用域**上被约束。

一个作用域上要四条声明才盖得住，缺一条都有能实测出来的缺口：`tools.restrict({ allow })` 管全局层与祖先作用域；`tools.guard(...)` 管**自己这一层**——agent preset 正是把 `subagent` 这类工具注册进这一层，而作用域过滤器按设计不过滤自己这层的注册，所以 guard 补上「调不动」；`system-prompt/assemble` 的过滤补上「看不到」，因为模型的工具列表来自组装后的提示词而非注册表视图，被隐藏工具的提示词段落（`tool:<工具名>`）也一并去掉，免得模型被指使去调一个它没有的工具；`tools.presentAs('native')` 管 PTC 的保留传输名 `run_code`，它不是能力、白名单排除不掉。其余取舍见 [ADR-0005](docs/adr/0005-tool-allowlist-enforced-at-agent-scope.md)。

## 开场：登录即推最近一笔订单（issue #6）

客户登录后不必自己开口。浏览器半边一接管到登录会话，就发一次 `POST /customer-service/opening`；宿主据此投递一条内容固定为「你好」的消息，模型随即开场——先说「您好，请问您咨询的是这个订单吗？」，并在同一个回合里**不带任何参数**调用 `search_orders`，把该客户时间最近的那一笔订单作为卡片推出来。客户点「否」时工具返回 `declined`，模型转而请客户说个大概的租借时间和地点，而不是重复推同一张卡片。

**这条消息不是客户说的。** 它的来源是宿主自己的 `customer-service`，不是 `user`，所以对话区把它显示成 harness 为「非人类输入启动了一个回合」准备的**折叠触发行**（与定时提醒、Webhook 同类），而不是客户侧的一条气泡——客户不会读到一句自己没打过的话。取舍见 [ADR-0008](docs/adr/0008-opening-trigger-from-the-client.md)。

**时区由协议补上。** harness 只从浏览器自己发出的消息里读浏览器时区，所以开场这一轮的时钟上下文会说「浏览器时区不可用」——而且时钟每十分钟才注入一次，接下来几分钟的回合会一直沿用这句话。宿主因此把登录时拿到的时区记在会话账本上，由开场协议直接说出「客户浏览器的时区是 Asia/Shanghai」，并明说注入的时钟若说不可用就按它读、不要反问客户。「上周三」这类模糊说法正是靠它换算成绝对日期范围的。

**只开场一次。** 宿主按登录会话记账（`openings`）：浏览器刷新多少次，客服都只打一次招呼。投递本身被拒（例如会话已被别处持有、会话不存在）时这一格交还，下次刷新重试，路由以 503 报告失败原因；客户端不额外提示——客户仍可以直接开口，而服务端日志里有原因。投递成功之后模型没答上来不在此列：开场消息已经在会话里，刷新不会重发。

**开场协议在提示词里**（system prompt 的 `customer-service:opening` 段，与身份行一样只对已绑定客户的会话贡献）：它把「你好」定义为开场信号，规定开场那句话与那次 `search_orders` 调用，并要求把模糊时间按本轮注入的当前时间与浏览器时区换算成绝对范围再传参。消息与提示词都落盘，整轮开场因此可以从会话日志重建。

| 路由 | 作用 |
| --- | --- |
| `POST /customer-service/opening` | 投递开场触发消息；请求体可选带 `clientTimeZone`。每个登录会话只投一次，重复请求答 `{"opened": false}` |

## 人工还宝：先校验，再结单（issue #7）

客户问「能不能人工还宝」时，客服不能自己下结论，也不能直接动手：它必须先调用 `validate_manual_return`，再拿校验签发的凭证去调用 `manual_return`。

**规则是代码，不是提示词。** 校验只可能给出三句话之一，且由服务端时钟判定：

| 情形 | 结论 |
| --- | --- |
| 订单已「已归还」 | 「不允许人工还宝，该订单已归还」 |
| 订单已「已退款」 | 「不允许人工还宝，该订单已退款」 |
| 当前时间 − 租借时间 **严格大于** 两小时 | 「不允许人工还宝，借出时间已超过两小时」 |
| 其余（含**恰好**两小时） | 「允许人工还宝」 |

状态先于时间判定：已经还过的单子被告知的是它自己的状态（「已归还」或「已退款」），而不是「超过两小时」——后者说的是一条它已经不再适用的规则；退款过的那笔也不会被说成「已归还」，那是它已经没有的状态。规则里没有配置项：窗口长度、文案、判定顺序都写死在 `plugins/tools/manual-return.js`，没有任何 `Config` 字段能移动它。

**凭证（ADR-0002）。** 校验通过时签发一张凭证，绑定**客户 + 订单 + 动作 + 会话 + 签发时间**五样东西，并且：**用一次即废**、**十分钟过期**、**所涉订单一经变更即失效**。三条都由 `plugins/shared/grants.js` 判定，动作工具无从绕过；退款（issue #8）复用同一个机制，只换动作名。凭证只活在进程内存里，判定「订单已变更」的方式是签发时记下整行 Order、使用时重新读出来逐字比对——取舍见 [ADR-0009](docs/adr/0009-grants-live-in-process-and-die-with-the-order-row.md)。

**动作工具没有旁门。** `manual_return` 只接一个 `orderId`，别的字段一律报「未知参数」（`customerId` 与 `force` 都在此列）；身份来自登录态，别人的订单号在它这里根本查不到。没有有效凭证时它**直接拒绝、不做任何改动**——校验没通过、或者通过后过了十分钟、或者订单在这中间被别处改过，都会落到这里。凭证在动作真正写库之前就被取走，所以两次调用不可能用掉同一张。

动作工具**不重新跑一遍校验规则**：判定只发生一次，就在校验那一次，凭证的十分钟寿命是这条结论的保鲜期。因此 1 小时 59 分校验通过、中间不再校验、2 小时 04 分才执行时，这笔单子仍会被结掉——理由与代价见 [ADR-0009](docs/adr/0009-grants-live-in-process-and-die-with-the-order-row.md)。反过来，**结论变成不允许时凭证据此作废**：窗口关闭后再校验一次，此前那张立刻失效，客服不会刚说完「不行」就把单子结掉。

**客户看得见结果。** 还宝成功后订单状态变为「已归还」并在 Order 上记下**归还时间**；对话里随之出现一张还宝卡片，列出这笔订单的租借地点、租借时间、金额、状态与归还时间，之后再查这笔订单，卡片上同样显示「已归还」与归还时间。

**白名单随之变长。** 客服能看到的工具从 `search_orders` 一个变成 `search_orders`、`validate_manual_return`、`manual_return` 三个，其余仍然不可用。

## 退款：状态三步判完，钱回了就是「已退款」（issue #8）

退款与人工还宝**同一套机制**：先 `validate_refund` 校验、签发凭证，再 `refund` 拿凭证执行。机制只有一份实现（`plugins/tools/validation.js`），两个动作各自只声明自己的规则、文案与写入；凭证绑定的动作就是执行它的工具名，所以人工还宝的凭证退不了款，退款的凭证也结不了单——见 [ADR-0010](docs/adr/0010-service-actions-share-one-validation-pair.md)。

**规则是代码，不是提示词。** 校验按固定顺序看三件事，只可能给出四句话之一：

| 顺序 | 情形 | 结论 |
| --- | --- | --- |
| ① | 订单仍是「进行中」 | 「不允许退款，该订单仍在进行中」 |
| ② | 订单已「已退款」 | 「不允许退款，该订单已退款」 |
| ③ | 订单「已归还」，且客户是**铂金或黑金**会员 | 「用户为{该客户自己的等级}会员，允许退款」 |
| ③ | 订单「已归还」，但等级不是铂金/黑金 | 「非铂金/黑金会员，不允许退款」 |

状态先判——一笔「进行中」的订单被拒时，客户听到的是充电宝还没还，而不是在等级上被冤枉（这话对铂金客户是假的）；已退款的订单被拒时听到的是钱已经退过了，同样不是等级问题。等级取自**当前登录客户**，不由模型提供，谁登录就按谁的等级算。规则里没有配置项：判定顺序、可退的最低等级（`platinum`）、文案都写死在 `plugins/tools/refund.js`，`TIERS` 的顺序就是等级高低的依据。

**凭证语义与人工还宝完全一致**（[ADR-0002](docs/adr/0002-validation-enforced-by-single-use-grant.md)）：绑定客户 + 订单 + 动作 + 会话 + 签发时间，用一次即废、十分钟过期、所涉订单一经变更即失效；没有有效凭证时 `refund` 直接拒绝、不做任何改动。

**全额，并且把订单推到「已退款」。** `refund` 按**订单金额**全额退款——金额不是参数，订单上有多少就退多少——记下**退款时间**并把状态从「已归还」改成「已退款」。订单状态因此是一条单向的三级链：**进行中 → 已归还 → 已退款**，客户在卡片上看到的「状态」一栏直接就是「已退款」，退款时间在旁边；[ADR-0011](docs/adr/0011-refund-is-a-status-and-the-panel-is-per-customer.md) 记录了这条从「退款只是标记」改过来的取舍（它推翻了 ADR-0010 里「规则里没有已退款这一条」的旧决定）。

**旧数据会被带正一次。** store 在打开时把「状态仍是已归还、却已经带着退款时间」的行改成「已退款」——这一对取值不可能由现在的代码写出，读法唯一，所以不需要版本号，也不需要删库重来。

**白名单再长两个。** 客服现在能看到的工具是 `search_orders`、`validate_manual_return`、`manual_return`、`validate_refund`、`refund` 五个，其余仍然不可用。

## 管理面板：每个客户自己的订单（issue #9）

对话区顶部那一行是「对话 / 轨迹」，本插件在它**右边**加了第三个视图**「管理」**（`conversation.view` 槽位，`order: 20`；原生两个视图是 0 与 10）。点进去，**每个登录客户**都能看到**自己名下**的全部订单——进行中、已归还、已退款都在，每笔带租借地点、租借时间、金额、状态，归还时间与退款时间有就显示——并且可以：

- **创建订单**：点「创建订单」弹出一个表单，填**租借地点**与**租借时间**（按北京时间填，留空表示当前时间）。订单号、状态与金额都由服务端生成：状态固定为「进行中」，**金额按借出时长计费——每分钟 ¥0.10，封顶 ¥99.00**（不足一分钟按一分钟计），所以刚造出来的订单是 ¥0.10，隔三小时的是 ¥18.00，再久就封顶。
- **归还**：每笔「进行中」的订单带一个「归还」按钮，点了就变成「已归还」并记下归还时间。

**演示两小时规则的两侧全靠它。** 播种数据里的订单租借时间固定，隔一天就只演示得出「拒绝」；在面板里造一笔**刚借出**的订单，回到对话问一句「能人工还宝吗」就是「允许人工还宝」，造一笔租借时间在三小时前的就是「借出时间已超过两小时」。

**为什么每笔都是自己的。** 三条路由都从**登录态**取客户，请求体里没有客户字段（[ADR-0004](docs/adr/0004-customer-identity-from-login-not-parameter.md)）：创建出来的订单一定属于当前登录客户，别人的订单号在面板里是「不存在」（404）而不是「被拒绝」。所以面板不需要管理员身份，`plugins/orders/index.js` 里没有 `isAdmin` 判断——隔离靠的是同一条登录态规则，而不是角色。

**面板的「归还」不走校验、不签发凭证。** 校验 + 凭证拦的是**模型**在规则没跑的情况下动手（[ADR-0002](docs/adr/0002-validation-enforced-by-single-use-grant.md)、[ADR-0005](docs/adr/0005-tool-allowlist-enforced-at-agent-scope.md)），面板不是模型，改的是客户自己的行；模型也够不到这些路由，它能调的仍然只有那五个工具。这也是它与「人工还宝」的差别所在——面板能让一笔超过两小时的订单直接变成「已归还」，它是演示用的数据准备口，不是客户服务的一部分（[ADR-0011](docs/adr/0011-refund-is-a-status-and-the-panel-is-per-customer.md)）。

| 路由 | 作用 |
| --- | --- |
| `GET /customer-service/orders` | 当前登录客户的全部订单，按租借时间倒序 |
| `POST /customer-service/orders/create` | 创建订单：`{location, rentedAt?}`；订单号、「进行中」与金额由服务端决定（金额＝借出分钟数 × ¥0.10，封顶 ¥99.00），未知字段一律 400 |
| `POST /customer-service/orders/return` | 归还：`{orderId}`；不属于自己或不存在 → 404，已归还 → 409 |

## 自动化验收

界面上的手动走查——登录、开场、订单卡片、人工还宝、退款、白名单与会话日志里的硬证据——连同每条用例的账号与预期，都在 [docs/product-overview.md](docs/product-overview.md#怎么演示启动登录与逐条验收)。这一节只说自动化测试。

自动化验收有六份：`tests/auth.spec.ts` 覆盖登录、退出、绑定、身份注入与播种幂等，`tests/orders.spec.ts` 覆盖订单播种、`searchOrders` 的过滤与隔离、白名单（含部署改成 PTC 时仍然只放行这五个工具），以及卡片的整条阻塞流程——工具阻塞、卡片取候选、客户作答、工具返回被选中的订单，`tests/opening.spec.ts` 覆盖开场路由（只投一次、未登录被拒、投递被拒后交还这一格、请求体校验）与开场协议进入模型上下文。`tests/manual-return.spec.ts` 覆盖人工还宝：三条固定规则（含恰好两小时的边界，靠 `vi.setSystemTime` 把服务端时钟放到窗口的开合点上）、已退款订单同样被拒、凭证的订单绑定与会话绑定、三条失效路径（用掉、十分钟过期、订单被别处改动）与「后一次不允许的校验把它作废」、没有凭证时的拒绝与「什么都没改」、跨客户与跨会话的隔离、参数校验，以及成功结单后归还时间的落库与后续查询。`tests/refund.spec.ts` 覆盖退款：三条规则及其顺序（「进行中」先被状态挡下、已退款被拒、等级不够被拒、等级够且已归还允许，并断言结论里念的是**客户自己的**等级）、凭证的一次性与十分钟边界、订单被别处改动即失效、**两个动作的凭证互不通用**（人工还宝的凭证退不了款，退款的凭证结不了单）、没有凭证时的拒绝与「什么都没改」、全额退款把状态推到「已退款」并记下退款时间、卡片与后续查询都带着新状态，以及跨客户、未绑定会话与参数校验。凭证的**客户**绑定在这套测试里测不到——会话与客户是一对一的，会话绑定成立时客户绑定必然成立；等级走的正是这条绑定，所以四个等级各问一次就看得出来。`tests/panel.spec.ts` 覆盖管理面板：三条路由都要求登录、列出的是自己名下的全部订单（别人的订单号在这里不可达）、创建时订单号由服务端铸造而 `orderId`/`customerId`/`status`/`amountCents` 都拒收、金额按借出分钟数计费（含不足一分钟与 ¥99.00 封顶两端）、租借时间按北京时间读且留空取服务端当前时间、已归还的订单不能重复归还、以及造出一笔刚借出的订单后模型那边确实能校验出「允许人工还宝」、造一笔三小时前的则得到「借出时间已超过两小时」；还有一条把旧模型写下的行（状态已归还但带退款时间）带正为「已退款」。跑法是从仓库根目录执行

```sh
pnpm exec vitest run --config customer-service/vitest.config.ts
```

六份 spec 用真实的工具注册表、web server、storage 与 prompt 插件驱动，只对 `connection`、`sessionController`、`workspaceRegistry` 与 `agents` 用替身；其中 `orders`、`manual-return`、`refund` 与 `panel` 四份共用 `tests/composition.ts` 里那套组合。浏览器半边（登录页、侧栏、订单卡片、管理面板、还宝/退款卡片与开场请求）**没有自动化覆盖**：仓库的浏览器用例都住在 `apps/web/tests/`，而本目录不改动本目录之外的文件（ADR-0003），所以与 #3、#4、#5、#6 一样只能按 [docs/product-overview.md](docs/product-overview.md#怎么演示启动登录与逐条验收) 手动走查。

本目录的 TypeScript 测试**没有类型检查通道**：仓库的类型检查按根部的 project references 组织，仓库外的目录既进不去那套 program，单独跑 `tsc` 又会把 `vendor/` 源码按本目录的设置重新编译一遍、报出一堆与这里无关的既有错误。

## 附：issue #2 的 spike 骨架

`spike.overlay.yml`、`plugins/spike-host/`、`plugins/spike-banner/` 是实证「仓库外本地目录里的插件能否被加载」留下的最小骨架，不在启动命令里，结论与证据见 [docs/spike-out-of-tree-plugins.md](docs/spike-out-of-tree-plugins.md)。
