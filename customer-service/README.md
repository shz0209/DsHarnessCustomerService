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

## 当前状态：登录、身份与侧栏（issue #3、#4）

```
app.overlay.yml                   覆盖层：SQLite 后端、Customer 域、下面三个插件
plugins/shared/vocabulary.js      等级取值与中文名（白银 / 黄金 / 铂金 / 黑金）
plugins/store/index.js            Customer 表、演示账号播种、customerStore 服务
plugins/store/passwords.js        scrypt 加盐哈希与定时安全比较
plugins/auth/index.js             裸 HTTP 路由、会话绑定、注入模型的客户身份
plugins/ui/                       浏览器半边：登录页与侧栏接管
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

左栏整列由本项目的浏览器插件接管：账号名、VIP 等级徽章（中文）、底部「退出登录」。原生侧栏的会话列表、工作区、设置入口都不再出现，而对话界面本身不动——订单卡片（issue #5）之后要渲染在它里面。未登录时这个占用者不渲染任何内容。

机制是槽位系统的遮盖（[ADR-0007](docs/adr/0007-sidebar-takeover-by-lower-slot-priority.md)）：`sidebar` 是 `kind: 'single'` 的根槽位，一格只渲染一个条目，**最低 `priority` 的存活条目渲染**；原生占用者 `ui-sidebar` 用默认的 0 注册，本项目注册 `priority: -1` 把它遮盖掉。列宽、折叠、拖拽仍归 `AppFrame`——折叠成 56px 轨道时本项目只留等级徽章与「退出」。

## 校验

打开 Web UI，未登录时整个界面被登录页盖住：看不到也碰不到对话界面，此时服务端不会创建任何会话，左栏也是空的。用小字列出的任一账号登录，页面刷新后进入新会话，左栏换成客服侧栏。

- **密码不是明文**：`sqlite3 customer-service/data/customer-service.sqlite 'select value from u_customer_customers'` 只会看到 `scrypt$…`（表名来自存储域的 KV 形式，一行一个账号，`value` 是 JSON）。
- **错误提示**：故意输错账号或密码，登录页显示「账号或密码错误」——账号错与密码错是同一句，不透露是哪一项。
- **身份注入模型**：登录后问客服「我是谁」，回答里会带上当前账号名与 VIP 等级（如「黑金」）。注进模型的那一行是 `当前客户：blackgold（VIP 等级：黑金，管理员）。`，未绑定的会话不注入任何内容。
- **侧栏接管**：用 `blackgold` 登录后，左栏是「共享充电宝智能客服 / blackgold / 黑金 / 管理员 / 退出登录」，没有会话列表、工作区与设置入口；中间的对话界面照常可用。按 ⌥⌘B 折叠左栏，轨道里只留「黑金」「退出」这类内容——轨道放不下账号名，等级徽章与退出是它仅有的两样。
- **退出登录**：点侧栏底部的「退出登录」后回到登录页，客户端记录的当前会话被清掉；换另一个账号登录会落到一个全新的空会话，**对话区**里看不到上一个客户说过的话。
- **关掉浏览器再打开需要重新登录**：登录 cookie 不设 `Max-Age`，是会话 cookie——演示不做「记住登录」。

自动化验收在 `tests/auth.spec.ts`：用真实的 web server、storage 与 prompt 插件驱动这四条路由，覆盖登录、退出、绑定、身份注入与播种幂等。跑法是从仓库根目录执行

```sh
pnpm exec vitest run --config customer-service/vitest.config.ts
```

浏览器半边（登录页、侧栏）**没有自动化覆盖**：仓库的浏览器用例都住在 `apps/web/tests/`，而本目录不改动本目录之外的文件（ADR-0003），因此与 #3 一样靠上面几条手动走查。

## 附：issue #2 的 spike 骨架

`spike.overlay.yml`、`plugins/spike-host/`、`plugins/spike-banner/` 是实证「仓库外本地目录里的插件能否被加载」留下的最小骨架，不在启动命令里，结论与证据见 [docs/spike-out-of-tree-plugins.md](docs/spike-out-of-tree-plugins.md)。
