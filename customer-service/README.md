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

账号在首次启动时播种，已存在的行不会被覆盖；删掉 `customer-service/data/customer-service.sqlite` 即可重新播种。

## 当前状态：登录、身份、侧栏与订单卡片（issue #3、#4、#5）

```
app.overlay.yml                   覆盖层：SQLite 后端、Customer 域、下面四个插件
plugins/shared/vocabulary.js      等级取值与中文名、订单状态与中文名
plugins/shared/http.js            裸 HTTP 路由的注册与 JSON 收发
plugins/store/index.js            Customer 表、Order 表、演示数据播种、customerStore 服务
plugins/store/passwords.js        scrypt 加盐哈希与定时安全比较
plugins/auth/index.js             裸 HTTP 路由、会话绑定、注入模型的客户身份
plugins/tools/index.js            search_orders 工具、订单卡片作答路由、工具白名单
plugins/ui/                       浏览器半边：登录页、侧栏接管与订单卡片
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

## 校验

打开 Web UI，未登录时整个界面被登录页盖住：看不到也碰不到对话界面，此时服务端不会创建任何会话，左栏也是空的。用小字列出的任一账号登录，页面刷新后进入新会话，左栏换成客服侧栏。

- **密码不是明文**：`sqlite3 customer-service/data/customer-service.sqlite 'select value from u_customer_customers'` 只会看到 `scrypt$…`（表名来自存储域的 KV 形式，一行一个账号，`value` 是 JSON）。
- **错误提示**：故意输错账号或密码，登录页显示「账号或密码错误」——账号错与密码错是同一句，不透露是哪一项。
- **身份注入模型**：登录后问客服「我是谁」，回答里会带上当前账号名与 VIP 等级（如「黑金」）。注进模型的那一行是 `当前客户：blackgold（VIP 等级：黑金，管理员）。`，未绑定的会话不注入任何内容。
- **侧栏接管**：用 `blackgold` 登录后，左栏是「共享充电宝智能客服 / blackgold / 黑金 / 管理员 / 退出登录」，没有会话列表、工作区与设置入口；中间的对话界面照常可用。按 ⌥⌘B 折叠左栏（窗口窄于 1024px 时会自动折叠），轨道里只剩账号首字母头像、等级徽章与「退出」——56px 放不下账号名，全名挂在头像的 tooltip 上。
- **退出登录**：点侧栏底部的「退出登录」后回到登录页，客户端记录的当前会话被清掉；换另一个账号登录会落到一个全新的空会话，**对话区**里看不到上一个客户说过的话。
- **关掉浏览器再打开需要重新登录**：登录 cookie 不设 `Max-Age`，是会话 cookie——演示不做「记住登录」。
- **订单卡片**：问客服「我最近的订单是哪一笔」，客服调用 `search_orders` 并推出卡片，卡片上就是那笔最近的订单——租借地点、租借时间、金额、状态，问「是不是这一笔」；点「是」后客服念出被确认的那一笔（含订单号）。点「不是」时客服会请客户补充大概的时间或地点，再问一次并按条件一次列出多笔供挑选。
- **多笔挑选**：用 `blackgold` 登录，问「我今天的订单有哪几笔」，命中当天三笔，卡片逐条列出，点某一笔即确认那一笔。
- **查不到就如实说**：问一个不存在的地点（例如「机场」），客服说没查到，**不弹卡片**。
- **只看得到自己的订单**：用 `silver` 登录问「深圳北站」能查到，换成 `gold` 问同一个地点则查不到——`gold` 自己那笔在「前海壹方城」。
- **白名单**：让客服「用 bash 列一下当前目录」，它会说自己没有这个工具；这是白名单在起作用，不是它不愿意。硬证据在会话日志里：`session.v4.jsonl.zstd` 的 `request/header` 事件记录着模型实际拿到的工具清单，只有 `search_orders` 一项。

自动化验收有两份：`tests/auth.spec.ts` 覆盖登录、退出、绑定、身份注入与播种幂等，`tests/orders.spec.ts` 覆盖订单播种、`searchOrders` 的过滤与隔离、白名单（含部署改成 PTC 时仍然只放行一个工具），以及卡片的整条阻塞流程——工具阻塞、卡片取候选、客户作答、工具返回被选中的订单。跑法是从仓库根目录执行

```sh
pnpm exec vitest run --config customer-service/vitest.config.ts
```

两份 spec 用真实的工具注册表、web server、storage 与 prompt 插件驱动，只对 `connection`、`sessionController`、`workspaceRegistry` 与 `agents` 用替身。浏览器半边（登录页、侧栏、订单卡片）**没有自动化覆盖**：仓库的浏览器用例都住在 `apps/web/tests/`，而本目录不改动本目录之外的文件（ADR-0003），因此与 #3、#4 一样靠上面几条手动走查。

本目录的 TypeScript 测试**没有类型检查通道**：仓库的类型检查按根部的 project references 组织，仓库外的目录既进不去那套 program，单独跑 `tsc` 又会把 `vendor/` 源码按本目录的设置重新编译一遍、报出一堆与这里无关的既有错误。

## 附：issue #2 的 spike 骨架

`spike.overlay.yml`、`plugins/spike-host/`、`plugins/spike-banner/` 是实证「仓库外本地目录里的插件能否被加载」留下的最小骨架，不在启动命令里，结论与证据见 [docs/spike-out-of-tree-plugins.md](docs/spike-out-of-tree-plugins.md)。
