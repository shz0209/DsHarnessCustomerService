# 侧栏接管：以更低优先级遮盖 `sidebar` 单槽位

左栏整列由本项目的浏览器插件接管：`plugins/ui/client.js` 向槽位 `sidebar` 注册自己的占用者，并给 `priority: -1`。

机制来自槽位系统本身：`sidebar` 是 `kind: 'single'`、根作用域的槽位（`packages/client/ui-layout/src/client/index.ts`），一格只渲染一个条目，**最低 priority 的存活条目渲染**（默认 0，同优先级的第二次注册直接抛错）。原生占用者是 `ui-sidebar` 的 `SidebarRoot`，用默认优先级注册，因此一个负值就把它遮盖掉——它仍留在注册表里，只是不再渲染。这条决定就是 ticket 里「以低优先级遮盖原生侧栏槽位」的落地方式。

## Considered Options

- **注册进内层座位**（`sidebar.workspaces`、`sidebar.settings`、`sidebar.panellist`）**。** 每次只换掉会话列表、设置行或面板导航之一，品牌与其余部分仍在，达不到「原生侧栏内容不再出现」。
- **重写外壳**（替换 `root` 槽位，自绘布局）。代价是重新实现整个框架层，issue #1 已把它列为 Out of Scope。
- **不接管，留一条空白竖条。** 外壳的几何形状消除不掉：列宽、折叠、拖拽、macOS 半透明都归 AppFrame。接管左栏比留白更有用。

## 后果

- 列的几何形状仍归 `AppFrame`。占用者拿到 `{ collapsed, width }`，折叠时列被压到 56px 轨道（`collapsedWidth` 在 `data-platform=darwin` 与 `data-windows-titlebar` 上是 0）；轨道里显示什么由占用者自己决定——本项目只发 Web 半边，落到的是 56px，折叠时只留等级徽章与「退出」。
- 原生侧栏声明的那批座位（`sidebar.brand.*`、`sidebar.toggle.badge`、`sidebar.panellist`、`sidebar.workspaces`、`sidebar.settings`、`sidebar.footer.action`）**仍然处于已声明状态**：声明跟着注册走，不跟着渲染走。因此本目录**不能**再声明这些键（一个槽位只有一个声明者，重复声明会抛错），#9 的管理入口要挂进本项目自己的侧栏组件里。
- 原生侧栏插件（`ui-sidebar`、`ui-workspace`、`ui-settings-general` 等）仍然被加载，只是看不见。要卸载它们得改 profile 组成或动 `packages/`，两者都违反 ADR-0003。
- 升级 harness 时要人工核对的约定多一处：槽位名 `sidebar`，以及原生占用者是否仍用默认优先级。约定面见 [ADR-0006](0006-out-of-tree-plugin-authoring-constraints.md)。
