# 定案：附加方向的四项增强（历史胶囊点击 / 信息框历史聚合 / 移除胶囊即撤销 / `@` 引用可用密钥）

- 任务：`t1`（设计定案）· 轮次：round 4 · 目标版本：`0.3.0`（`package.json` 的 version 由发布任务负责，本任务不改）
- 前置：`docs/round3-attach-secret-design.md`（0.2.0 附加方向定案，0.2.1 已发布并修复 t11 缺陷）
- 基准运行版本：DSH `0.2.0-rc.2`（**本定案复核实测：唯一权威证据根 = `C:\Program Files\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`**；第三轮文档引用的第二证据根 `C:\Users\admin\.dsh\profiles\web\node_modules\@deepseek-ai\` 在本轮只含 `cosmokit`/`schemastery`，**已不再是 client 包的解析位置**——凡引用该路径的历史结论，本条按新事实复述）
- 第三方环境事实：`dsh-better-sidebar` **0.24.1** 已装在本 profile（`C:\Users\admin\.dsh\profiles\web\node_modules\dsh-better-sidebar`），它注册了一个 `extension` 优先级的 `dsh-resource://file/**` 兜底类型——这是候选 O1 的决定性约束（§2.2）
- 本任务基线（本轮实测）：`npm test` → `tests 78 / pass 78 / fail 0`；`npm run typecheck` → exit 0；`git status --porcelain` → 空
- 本文件是**只新增的文档**：不改任何 `src/` 代码、不改 `lib/`、不改 `package.json`。第 5 节给出 t2 的文件级改动点，第 9 节给出实施顺序。

> 体例沿用第三轮定案：**机制结论 + file:line 证据** → **定案形态与逐字契约** → **事件/状态机** → **文件级改动点** → **兜底阶梯** → **验证清单（区分「可机器证明」与「需真人确认」）** → **风险与未决（含需用户拍板项）**。

---

## 0. 结论摘要（每条指向第 2 节的证据行）

1. **首要待证问题（转录里的变量名胶囊点击查看详情）：没有任何官方钩子能把「原始转录胶囊」的点击改到我们的输入框胶囊上；但有一条干净可行的官方路径能让点击**在转录里**开出我们的详情面，另有两条次优路径。** 结论与排序（§2.1–§2.6）：
   - **O2（推荐主力）插件自有旁挂节点**：新注册一个 `ConversationNodeDefinition`（`kind:'sr-chip'`，7 字符——最终实现值，§2.3 O2-7），匹配带标记的 `user/message`，在**同一条消息的位置**渲染我们自己的可点胶囊行，点击打开我们既有的 `detail` 胶囊。机制与既有的 `secret-request` 卡片**同一条**（第三轮已验证），排序、可见性、不可折叠全部可推导（§2.3）。代价：多一行，原始胶囊仍是老行为。
   - **O1（次优，需用户拍板）接管 `openFile` 的落点：注册文档查看器**。证据链成立：点原始胶囊 → `references.openFile(label)` → chat 的 `openFile` → `fileAddressFor` → `ctx.sidebarRight.openResource('dsh-resource://file/session/<sid>/DSH_SECRET_X')` → 注册表 `claim`。我们注册一个 `priority:'extension'` 的类型即可**接管这次打开**，用户看到的是右栏里我们的详情页而不是「文件不存在」。**但它把答案放进右栏，而不是输入框上的胶囊**；且它必须用**更长的 glob** 才能压过已安装的 `dsh-better-sidebar` 0.24.1 的同档兜底（§2.2 有完整排名规则与当前竞争事实）。
   - **O3（不推荐默认启用，建议做成默认关的开关）页面级点击拦截**：唯一能让**原始**胶囊直接开出**我们的输入框胶囊**的办法，因为它拦的正是 `data-ref-chip="file"` 的 `onClick`（§2.4）。属 UI hack，失效风险必须写明（DOM 形态、React 委托根、任何同形态元素）。
   - **O4 其它官方钩子：不存在。** `references` 是 chat 座位自己从 `inject(sessionId)` 里拼出来的 `{openFile, openSkill}`，插件无法参与；`openReference` 只在草稿编辑器被调用；没有 reference 种类注册面（`appearance` 是闭集）；`conversation.chat.node` 的 `user` key **可以**影子注册，但 chat 包**不导出**用户气泡渲染器，接管等于从零重绘整条气泡（§2.5）——维持第三轮 R3 的否决，理由比当时更硬。
2. **需求 2（信息框内「历史记录」聚合区）：新增一个纯内存、按会话、有上限、值无关的历史流，并新增只读路由 `GET /api/secret.history`。** 0.2.1 只有「现状」（staged 列表 + 仍有效的 bound 元数据），失效/回退/丢弃一律被删除或遗忘，因此**没有历史可读**（§2.7）。定案见 §3.2：8 类事件、按会话上限 32、刷新后仍在（Host 未重启）、Host 重启/重放/fork 不重建（与第三轮 §5.4 的 fail-closed 一致）。**推荐新增路由而不是往 `attached` 上挂字段**，理由是 0.2.1 的 `attached` 形状已被 t3 逐字段钉住，冻结它更便宜。
3. **需求 3（移除胶囊即撤销）：可以做到，且不需要新路由——用既有的 `POST /api/secret.release`，只加一个可选 `reason`。** 关键在于**发送也会清空草稿**（乐观清空时序，§2.8），所以判定必须是多信号：`InputState.draft` 里标记消失 **且** 没有任何 `pendingSubmission` 的文本携带该标记 **且** `phase==='plain'` **且** 该变量曾在草稿里出现过 **且** 本地状态是 `staged`，持续 600ms 才撤销。撤销范围**只有 staged**；已 bound 的记录只能靠回退消息失效（`revoked-anchor`），与既有语义一致（§3.3）。
4. **需求 4（`@` 菜单列出可用密钥并标注来源/作用域）：菜单条目支持逐条的 label/description/section/icon**（`InputTriggerCandidate`，§2.9），所以「来源与作用域」可以逐条写清，不需要把信息编码进名字。定案见 §3.4：两个 section（`本会话可用` / `凭据库（持久）`），`label`＝变量名、`name`＝凭据键（成为灰色别名）+ 搜索键、`description`＝来源·作用域·状态、`value`＝JSON 载荷；`codec` 与 `lexicon` **一个字都不改**。「凭据库已持久化」只能枚举**本插件提交过的 credential record**（凭据库的 reference 半边没有枚举面，§2.9 有契约原文）。
5. **需要用户拍板的 6 件事**见 §8.1（O1/O3 是否启用、撤销的「重附代价」、凭据库条目的点击语义、历史展示的边界等）。
6. **不动的东西（回归护栏）**：附加链路（日志保留 `@` 形态 + 注记承担模型侧映射 + `session/event` 绑定）、`secret_request` 索要方向、作用域语义、值不变量（明文仍只允许出现在第三轮 §1.3 的 P1–P6）、客户端 classic script（无 import/export）与 ambient `declare module` 手法、既有三处 slot 注册与两处引用源行为。

---

## 1. 范围与不变量

### 1.1 本轮只做（四项，全部是加法）

1. 转录区新增我们自己的**旁挂胶囊行**（O2）+（可选，用户拍板）**接管 `openFile` 落点的文档查看器**（O1）+（可选，默认关）**页面级拦截**（O3）。
2. Host 新增**按会话的历史流** + 只读路由 `GET /api/secret.history`；客户端信息框新增「历史记录」区。
3. 草稿里标记消失 → **去抖撤销 staged 记录**（复用 `POST /api/secret.release`，加 `reason`）。
4. `@` 菜单列出「本会话当前可用 + 凭据库已持久化（本插件提交的记录）」并逐条标注来源与作用域；新增只读路由 `GET /api/secret.available`；新增 `POST /api/secret.adopt`（凭据库条目改用时的登记路径，值不跨线）。

### 1.2 不做（明确排除）

- 不做「修改原始转录胶囊的 `onClick`」的一切官方以外手段，除 O3 这一条**默认关闭**的可选项。
- 不注册新的 reference 种类、不碰 Lexical 注册表、不接管 `conversation.chat.node` 的 `user` key。
- 不把来源/作用域编码进 `codec.serialize` 的返回值（那会破坏 `MARKER_RE` 与绑定，见 §3.4）。
- 不做 Host 重启后的历史重建、不做已失效记录从会话日志反推。
- 不做 URL/查询串/GET 携带值；`adopt` 的取值只发生在 Host 进程内（`credentials.resolve`），值不跨线。

### 1.3 不变量（第三轮 §1.3 的口径继续有效，本轮只增补）

**允许值存在的全部位置（穷举，仍是第三轮那 6 处，不多一个）：** P1 填值胶囊本地 state / P2 一次 `POST /api/secret.attach` 请求体 / P3 Host `AttachStore` / P4 Host `GrantStore` / P5 `shellEnv` 注入 / P6 仅当人类显式选「持久」时的凭据库。

**本轮新增的四条约束（都要被测试钉住）：**

| # | 约束 | 判据 |
|---|---|---|
| N1 | 历史条目、`available` 条目、菜单候选、旁挂节点的 `data` **全部值无关** | 对每个新 SEAM/响应做 `JSON.stringify` 哨兵扫描，0 命中 |
| N2 | `adopt` 的值解析只发生在 Host（`credentials.resolve`）；响应与任何客户端状态都不含值 | 同上；`adopt` 响应字段集合被断言为白名单 |
| N3 | 撤销只作用于 `staged`；任何路径都不得删除/改写 `Grant` | `release` 的 bound 分支只读；测试断言 bound 时 `grants.size()` 与 grant 内容不变 |
| N4 | 客户端仍是 classic script：无 `import`/`export`，跨包类型只用本地结构类型或 ambient `declare module` | `Select-String lib/client/entry.js -Pattern '^\s*(import|export)\s'` → 0 命中 |

### 1.4 版本与兼容

- 目标 `0.3.0`（由发布任务改 `package.json`；本任务不改）。
- **只加不改**：既有 78 条测试只增不减；`GET /api/secret.attached` 的响应形状**逐字节冻结**（这是 §3.2 选择新增路由而不是加字段的直接原因）；`secret_request` 的工具 schema、结果形状、卡片注册形状不变。
- 客户端 `dsh.client.inject` 的追加（若采纳 O1）：`@deepseek-ai/dsh-client-ui-sidebar-right`。**所有新服务一律走 `ctx.inject([...], cb)` 可选座位**，缺任何一个都只降级、不阻断 entry（第三轮 t7 的发布阻塞缺陷不改回来）。

---

## 2. 机制结论与证据

### 2.1 需求 1：现状全链（含「今天点了会发生什么」）

| # | 事实 | 证据 |
|---|---|---|
| A1 | 用户气泡正文由 `projectUserText(text, referenceLabels, skillNames, 'skill', references)` 渲染，`references` 由 chat 座位给出 `{openFile, openSkill}` | `dsh-client-ui-chat/lib/client.js:1370-1377`（调用点）、`:1446-1453`（`UserMessageNodeView` 组装 `references`） |
| A2 | 裸 `@token` 的正则与种类判定：`@` 开头的 token **必然**映射为 `file` 或 `folder`，只有 `/name` 且 caller 点名时才可能是 `void 0` | `dsh-client-ui-primitives/lib/index.js:6724`（正则）、`:6729`（尾标点剥离）、`:6753`（`referenceKind`） |
| A3 | 显示文本 = 去掉 `@` 后按 `[\\/]` 取最后一段 ⇒ `@DSH_SECRET_OPENAI` 显示的就是变量名；`title` 是整个 token | 同上 `:6754`（`displayLabel`）、`:6769`/`:6775`（`title: label`） |
| A4 | **file 形的胶囊一定可点，点击硬编码到 `references.openFile`**：`open = references === undefined ? undefined : referenceKind === 'file' ? () => references.openFile(label.slice(1)...) : …` | 同上 `:6760-6761`；`:6762-6763` 是无 chip 时的 skill 分支 |
| A5 | 有 `open` 才渲染 `<button data-ref-chip=… title=… onClick=…>`，否则渲染无点击的 `<span data-ref-chip=…>` | 同上 `:6766-6781`（两条分支各自的 `data-ref-chip`） |
| A6 | chat 的 `openFile` 实现：`fileAddressFor(sessionId, cwd, path)` → `ctx.sidebarRight.openResource(url)`（带 `line` 时给 `params`） | `dsh-client-ui-chat/lib/client.js:12423-12429` |
| A7 | 地址文法：`dsh-resource://file/session/<sessionId>/<path>`（相对/工作区内）或 `…/absolute/<path>` | `dsh-util-workspace-path/lib/index.js:9`、`:28-31`、`:38-43`、`:169-176` |
| A8 | 点胶囊走的是 `requestOpenFile`（带 busy/错误态），打开失败会在 Chat 视图里出提示而不是静默 | `dsh-client-ui-chat/lib/client.js:5166-5181`、`:5282`/`:5296` 把 `requestOpenFile` 作为 `openFile` 下传 |
| A9 | **插件注册面的 `openReference` 只在草稿编辑器被调用**：`registerReferenceActivation(editor, (source, reference) => this.deps.openReference(...))`，且它挂在 Lexical 编辑器的命令上（主键、单击、选区折叠） | `dsh-client-ui-conversation/lib/client.js:12784-12800`（实现）、`:13166`（绑定）、`:13518`（转发到 `inputTriggers.openReference`） |
| A10 | 因此**不存在**一个「转录胶囊点击 → 插件钩子」的官方通道 | A4+A9 的合取；A5 说明只有「file 形可点」这一种可能 |

**今天点一个 `@DSH_SECRET_X` 胶囊会发生什么（逐字可证）：** 打开地址 `dsh-resource://file/session/<sid>/DSH_SECRET_X`。没有任何类型专门认领它时，最低档的兜底是 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 的 text 类型（`patterns:['dsh-resource://file/**']`、`priority:'fallback'`、`canOpen: scope==='session'`），右栏会展开一个标题为 `DSH_SECRET_X` 的标签页，正文是**「文件不存在，可能已被移动或删除」**（`error.notFound`）。即：**今天的行为无害但错误**——这也是第三轮 R3 接受的「已知限制」的实测形态。

| # | 事实 | 证据 |
|---|---|---|
| A11 | 兜底 text 类型的声明 | `dsh-client-ui-sidebar-documentpreview/lib/client.js:1079-1088`（`patterns`/`priority`/`canOpen`）、`:6811`（注册） |
| A12 | 失败文案逐字：`error.notFound = 文件不存在，可能已被移动或删除` | 同上 `:1466-1471` |
| A13 | 若**没有任何**类型认领该地址：`claim()` 抛错（契约原文「An address no type will open is a wiring mistake, not a user error, so this throws」）⇒ `openResource` 抛 ⇒ A8 的 `requestOpenFile` 捕获后出提示 | `dsh-client-ui-sidebar-right/lib/client.js:8812-8829` |

### 2.2 候选 O1：接管 `openFile` 的落点（注册文档查看器）

**机制链（每一跳都有证据）：**

```
点转录胶囊
  → primitives 硬编码 references.openFile('DSH_SECRET_X')         (§2.1 A4)
  → chat 的 openFile: async (path) => ctx.sidebarRight.openResource(fileAddressFor(...))
  → 地址 dsh-resource://file/session/<sid>/DSH_SECRET_X            (§2.1 A7)
  → SidebarRightTabRegistry.claim(address) 排名选型                (下表)
  → 中选类型在 sidebar.right.pane.tab 座位里渲染自己的 body        (body 注册见下)
```

| # | 事实 | 证据 |
|---|---|---|
| O1-1 | 两阶段注册是公开契约：① 类型 `ctx.sidebarRightTabs.register({id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted?})`；② 正文 `ctx.slots.register({name:'sidebar.right.pane.tab', key: definition.id}, Body)`，标题可另注册 `sidebar.right.pane.tab.title` | `dsh-client-ui-sidebar-right/README.md:83-84`；座位声明 `lib/client.js:9150-9163`（两个 keyed + 一个 list，`scope:'session'`，注入 `useTabInfo`） |
| O1-2 | 排名规则（**决定性**）：先比 priority 档（`extension` 3 > `builtin` 2 > `fallback` 1），再比**命中的 pattern 长度**，再比注册顺序 | `lib/client.js:8619-8625`（`RANKS`/`DEFAULT_BAND='extension'`）、`:8782-8798`（`candidates` 排序 `right.rank-left.rank || right.length-left.length || left.order-right.order`） |
| O1-3 | 同档同 kind 的冲突规则：`extension` 与 `builtin` 可共存（extension 生效），`fallback` 不与任何档共存；**不同 kind 互不冲突** | 同上 `:8630-8632`（`coexists`）、`:8696-8697` |
| O1-4 | pattern 语义：含 `:` 的按**整地址**做 picomatch；不含 `:` 的按 **URI path 的 basename** 匹配（`basename: true`），忽略大小写 | 同上 `:8638-8658`（`pathOf`/`matcherFor`） |
| O1-5 | 打开动作会**自动展开右栏**（「the panel expands, because content the user cannot see is not opened」），并按 `(kind, contentId)` 去重 | `README.md:93` |
| O1-6 | 正文拿到 `useTabInfo()` 的 `{sidebar, panel, tab}`，`tab.contentId` 就是地址（可据此解析出变量名） | `README.md:84`；第三方先例用同一字段：`dsh-better-sidebar/lib/client.js:21319-21326` |
| O1-7 | **当前环境已有一个同档竞争者**：`dsh-better-sidebar` 0.24.1 的 native surface 注册 `priority:'extension'`、`patterns:['dsh-resource://file/**']`（**实测长度 22**）、`canOpen` 仅排除 host owned 扩展名 | `dsh-better-sidebar/lib/client.js:21365-21380`（注册形状）、`:21231-21235`（`hostOwnedPath`：只按扩展名判定，`DSH_SECRET_X` 无点 ⇒ 不排除） |

**O1 的两条用户可见后果（必须写清）：**
1. **采用 O1 后**：点原始胶囊 → 右栏展开/聚焦一个我们拥有的标签页，正文是我们的详情（变量名/凭据键/作用域/状态/历史摘要），**不再出现「文件不存在」**。代价：详情出现在**右栏**，而不是输入框上方的胶囊；且它只在「右栏可用 + 本会话有该记录」时有意义（记录已被撤销时我们仍可以展示「该变量在本会话不再可用」）。
2. **不采用 O1 时**（今天）：右栏出现「文件不存在，可能已被移动或删除」（A11–A12）；若连兜底 text 类型都没加载，则退化为一条打开失败的提示（A13）。

**O1 的确定性边界（必须在定案里写明）：** O1-2 的排名只看档位与**命中 pattern 的长度**。我们若用 basename 型 `DSH_SECRET_*`（长度 12）会**输给** better-sidebar 的 `dsh-resource://file/**`（**实测长度 22**）；必须用**含 `:` 且更长**的整地址型 glob，即 `dsh-resource://file/**/DSH_SECRET_*`（**实测长度 35**，`**` 允许零段，`file/session/<sid>/DSH_SECRET_X` 命中），并配合 `canOpen`（basename 必须匹配 `^DSH_SECRET_[A-Z][A-Z0-9_]*$`）把误伤面收到 0。**残余风险**：任何后来者只要声明更长且同档的 pattern，就会静默抢走这次打开（我们不再收到点击），这属于「无法用契约保证的确定性」。

### 2.3 候选 O2：插件自有旁挂节点（推荐主力）

| # | 事实 | 证据 |
|---|---|---|
| O2-1 | 一个 `ConversationNodeDefinition` = 一个独立的事件→节点状态机：`{kind, target?, match(event), start(...), update(...), publication?, buildLocationData?, buildViewNode?}` | `dsh-client-ui-conversation/lib/types/client/contract/conversation.d.ts:163-215` |
| O2-2 | **同一个事件可以被多个 Definition 同时匹配**：装配器遍历 `eventDefinitions.entries()`，`match !== null` 就全部接受（`matchedTargets` 只用于决定 fallback 是否兜底） | `dsh-client-ui-conversation/lib/client.js:2144-2161` |
| O2-3 | 唯一键：`conversationContextKey(kind, id) = ${kind.length}:${kind}${id}`；节点的 `key` 就是这个键 | 同上 `:1122-1124`；chat 侧 `chatNode()` 用 `key: context.key`：`dsh-client-ui-chat/lib/client.js:7211-7222` |
| O2-4 | keyed 座位按 `routedNode.kind` 派发，所以新 kind ⇒ 新格子，**不影子化**任何既有渲染器 | `dsh-client-ui-chat/lib/client.js:1770-1778`（`entryKey: routedNode.kind`） |
| O2-5 | 可见性/位置：节点没有 turn/step 坐标时 `presentationPosition` 返回 `{anchor: anchorSeq, rank: 0}`（**永不折进步骤过程组**）——第三轮卡片的「无坐标 = 根流条目」正是这条 | 同上 `:8231-8238`；独立 kind 集合 `:1518-1527`（`TURN_PROCESS_INDEPENDENT_KINDS`，我们的 kind 不在其中也不需要） |
| O2-6 | 同 anchor 的顺序：`orderedVisibleChatNodes` 依次比 `anchor → rank → originalAnchor → key.localeCompare` | 同上 `:8273-8281` |
| O2-7 | ⇒ **`anchorSeq` 相同的两个节点，谁在前由 key 的字典序决定**。真正参与比较的键来自**人类消息 definition 的 kind `input-message`（13 字符 ⇒ 键前缀 `13:`）**——键是 `conversationContextKey(definition.kind, id)`，**不是**节点 kind `user`（4 字符）。`node -e` 实测（与实现用的 `key.localeCompare` 同语义）：长度 **10/11/12** ⇒ `10:`/`11:`/`12:` 都 `< '13:'`，**排在气泡之前**。**一般规则（必须逐个实测，不能只看长度）**：该键是**整体字典序**比较，**长度前缀与 kind 文本共同决定顺序**——前缀不同时由前缀决定（实测：长度 1 的 key 因 `':'` 排在 `'3'` 之前而**排前**；长度 2–9、14 的样本**排后**），前缀打平（长度恰为 13）时由 kind 文本决定（实测：13 个 `a` 组成的 `13:aaa…` **排在气泡之前**，因为 `'a' < 'i'`）。**更正**：早前版本把「长度 4 到 9、以及 13 及以上」当作一律排在后面的安全长度区间，**该说法不成立**（见上两条反例），位置一律以实测为准。最终实现取 `sr-chip`（长 7 ⇒ `7:`）⇒ **经机器证明排在气泡之后**，在 `13:input-message…` 与假想 `4:user…` 两种对照下都成立。**更正记录（避免后人重复踩坑）**：captain 曾据错误对照键 `4:user` 判定本表「规则写反」（"两位长度前缀排前"），该判断**已作废**——对照键是 `13:input-message…`，以本表为准 | 同上 `:8273-8281`、`:1122-1124`（第三轮卡片能出现在消息下方，靠的是它锚在 `tool/call` 的 seq，而不是这条比较） |
| O2-8 | 可见性：`isVisibleChatNode` 只要求 `visibility==='visible'` 且不是 system-prompt/空 context/权限命令 | 同上 `:7718-7720` |
| O2-9 | 用户的 `user/message` 事件由 chat 的 `messageDefinition`（kind `input-message`）匹配，`match` 的 `id` 是 `String(event.data.id)`，`start` 里能拿到 `event.seq`/`content`/`source` | 同上 `:9262-9307` |
| O2-10 | 我们已有一条完全同形的先例：`secretRequestDefinition`（`kind:'secret-request'`，`target:'chat'`，match `tool/call`/`tool/result`，`buildViewNode` 返回 `{key, kind, id, target, anchorSeq, location, visibility, data}`） | 本仓库 `src/client/entry.ts:663-733`（自证） |

**O2 的用户可见后果：** 带标记的消息下方多一行只显示变量名的胶囊（每个变量一个），点击展开我们既有的 `detail` 胶囊；刷新/重放后该行由日志重建（与卡片同理）。**原始气泡里的胶囊保持 A4 的老行为**（除非同时启用 O1/O3）。代价：每条带标记的消息多一行；视觉上需要与气泡贴近（用 `anchorSeq` 与紧凑样式）。

### 2.4 候选 O3：页面级点击拦截

| # | 事实 | 证据 |
|---|---|---|
| O3-1 | 原始胶囊的 DOM 是可选择的：`<button data-ref-chip="file" title="@DSH_SECRET_X">`（有 `open` 时） | `dsh-client-ui-primitives/lib/index.js:6771-6781` |
| O3-2 | 草稿里的 chip 用的是**另一个**属性 `data-composer-chip`，所以 `[data-ref-chip]` 选择器天然不会误伤草稿 | 第三轮 §2.1 A2（`dsh-client-ui-conversation/lib/client.js:12465-12471`） |
| O3-3 | `data-ref-chip` 也被 session/skill 形使用，但只有 file 形带 `onClick`；我们的过滤条件（`title` 匹配 `^@DSH_SECRET_[A-Z][A-Z0-9_]*$`）把它们全部排除 | `:6753`、`:6768`/`:6774` |

**O3 的规则（若启用）：** `document.addEventListener('click', handler, true)`；命中 `event.target.closest('[data-ref-chip="file"]')` 且其 `title` 匹配标记正则 → `preventDefault()` + `stopPropagation()` → `setAttachMode({kind:'detail', variable})`。

**失效风险（逐条写明，这是不默认启用的理由）：**
1. **依赖 DOM 形态**：`data-ref-chip`/`title` 一旦改名或改结构，拦截静默失效（退回今天的行为，不报错）。
2. **依赖 React 的委托根在 `document` 之内**（React 17+ 把监听挂在根容器上）。凭 `stopPropagation` 在 document 捕获阶段截断依赖这个实现事实，**不是契约**；若未来 harness 换成直接绑定或改委托位置，拦截可能不生效或半生效。
3. **可能误伤**：任何页面上同形态的元素（例如真的存在名为 `DSH_SECRET_X` 的路径被别的 UI 渲染成 file chip）都会被我们接管。
4. **不受版本约束**：这是对**产品 DOM** 的耦合，harness 升级不在我们控制内。
5. 收益是**唯一**的：只有它能让「原始转录胶囊」直接开出我们的输入框胶囊。

### 2.5 候选 O4：其它官方钩子（逐条证伪）

| # | 假设 | 结论 | 证据 |
|---|---|---|---|
| O4-1 | 存在 reference 种类注册面（让 `@DSH_SECRET_*` 成为「我们这一种」引用） | **不存在**。`ReferenceInsert.appearance` 是闭集 `'session' \| 'file' \| 'folder'`；`projectUserText` 自己推导 `referenceKind`，没有注入点 | `dsh-client-ui-conversation/lib/types/client/contract/draft-editor.d.ts:16`；`dsh-client-ui-primitives/lib/index.js:6753` |
| O4-2 | 转录的 `references` 能从插件侧扩展 | **不能**。它是 chat 座位 `inject(sessionId)` 返回的对象字面量，逐字段构造，`ChatNodeSeat` 原样下传 | `dsh-client-ui-chat/lib/client.js:12409-12438`、`:1446-1453`、`:1727-1755` |
| O4-3 | `conversation.chat.node` 的 `user` key 可增量（包住内置渲染器） | **不可增量，可以影子化**：同 `key` 同格子按 priority 升序，最小者渲染（同 priority 重复注册抛错） | `dsh-client-ui-slots/lib/types/index.d.ts:757-791`、`:823-834` |
| O4-4 | 「影子化 `user` + 复用内置渲染器」是否可行 | **不可行**：chat 的浏览器产物只导出 `EMPTY_CHAT_SNAPSHOT/apply/inject/isRunningTool/isSettledTool`，**没有** `UserMessageNodeView`；接管等于从零重绘气泡（内容投影、图片、`referenceLabels`/`skillNames`、动作行、pending/echo 两态） | `dsh-client-ui-chat/lib/client.js:12507-12511`（导出清单）、`:1446-1466`（被接管对象） |
| O4-5 | 别的官方钩子（如 transcript 专用的引用渲染座位） | 未发现：`conversation.chat.node` 是转录节点的唯一派发口（`:1770-1778`），`conversation.message.images` 只服务图片 | `dsh-client-ui-chat/lib/client.js:12398-12407`（子座位声明） |

### 2.6 排序与推荐（结论）

| 排序 | 路径 | 官方性 | 确定性 | 是否需要用户拍板 | 用户可见结果 |
|---|---|---|---|---|---|
| **1（推荐主力）** | **O2 旁挂节点** | 全官方（冻结契约 + 本插件已有同形先例） | 高（key 字典序可推导，附看门狗） | 否（形态与座位已定） | 带标记的消息下多一行胶囊，点击开我们的详情；原始胶囊保持老行为 |
| 2（可选补充） | **O1 文档查看器接管** | 全官方（`sidebarRightTabs` 两阶段注册） | 中（同档比 pattern 长度，当前靠更长的 glob 赢） | **是**：详情落在右栏是否可接受 | 点原始胶囊 → 右栏我们的详情页（不再「文件不存在」） |
| 3（可选，默认关） | **O3 页面拦截** | UI hack | 低（DOM/委托耦合） | **是**：是否接受这个 hack | 点原始胶囊 → 输入框上方的我们的胶囊 |
| 4 | O4 | — | — | — | 证伪，不采用 |

**推荐组合：O2（必做）＋ O1（若用户接受右栏）＋ O3（默认关的开关，用户显式同意才开）。** 理由：O2 用最小代价把「点得开详情」做成**可依赖的官方行为**；O1 用很小的工作量把「原始胶囊点下去不再报文件不存在」修成正确行为（这是用户抱怨的根源），代价只是落点不同；O3 是唯一能让两条路径**合并**的手段，但它的收益可以用 O2+O1 覆盖（详情总能找到，只是分别在两处），因此不牺牲确定性。

### 2.7 需求 2：历史聚合的数据面现状与缺口

| # | 事实 | 证据 |
|---|---|---|
| H1 | staged 记录的存储与生命周期：`AttachStore` 按 `(sessionId, envVar)` 存值 + TTL 计时器；`remove`/`forget`/`disposeAll` 直接删除，**不保留任何痕迹** | 本仓库 `src/attach.ts:55-148`、`:82-98` |
| H2 | bound 的**元数据**只保留「label + createdAt」，且一旦 grant 不再有效就被删除（`known.delete(envVar)`） | 本仓库 `src/service.ts:185-193`（`attached` 映射）、`:328-362`（`attachedViews` 的剪枝） |
| H3 | `release` 删除 staged 记录后顺带删掉元数据；bound 时返回 `{released:false, state:'bound'}` 而**不动**元数据 | 本仓库 `src/service.ts:301-319` |
| H4 | 撤销语义现算：grant 的锚点离开 live surface ⇒ `revoked-anchor` 并丢弃；`RevocationNote` 只留最近一条、只用于「为何再次索要」 | 本仓库 `src/grants.ts:109-133`、`:154-168`、`:180-200` |
| H5 | 会话结束清空：`session/disposed` → `grants.forget` + `forgetAttachments` | 本仓库 `src/index.ts:76-85` |
| H6 | 凭据库里只留**持久作用域**的值无关标记，且只有「本插件提交过记录的」才可枚举 | 本仓库 `src/service.ts:258-277`、`:531-537`；`dsh-credentials/lib/types/index.d.ts:166-174` |

**结论：0.2.1 里「历史」是不存在的数据类。** 用户在信息框里能看到的只有「现在还在的」——撤销过、丢弃过、TTL 过期过、回退过的一律查不到。要满足需求 2 必须**新增一条只读的历史流**，且它必须是值无关的（N1）。

### 2.8 需求 3：草稿观测面与发送时序（决定成败的三条事实）

| # | 事实 | 证据 |
|---|---|---|
| W1 | 可观测的草稿投影：`InputState.draft` 是**编辑器文档的剪贴板投影**（chip 展开成 `clipboardText`），`occurrences` 是 **chip 的出现视图**，`phase` 是提交相位 | `dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:236-255`（`:237`/`:243`/`:251-252`） |
| W2 | **`occurrences` 只投影 chip 节点**：刷新后草稿是纯文本、由 lexicon 装饰成引用（`TextRefNode`），此时 `occurrences` **为空** ⇒ 只用 `occurrences` 判定会漏掉 L3/刷新后的形态；应当用 `draft` + `MARKER_RE` 判定 | `.../contract/draft-editor.d.ts:74-101`（「projected from the editor's chip nodes」）；第三轮 §2.2 的 B2 证据链 |
| W3 | **发送会乐观清空草稿**：`beginDetached` 先 `phase='plain'`，随后同一批效果是 `[default-sink, commit-draft]`，`commit-draft` 立即清编辑器并切掉 undo 历史 | `dsh-client-ui-conversation/lib/client.js:3880-3899`（`beginDetached` + `detachedEffects`）、`:13923-13928`（效果执行）、`:13936-13942`（`commitDraft`） |
| W4 | ⇒ **`phase` 无法区分「发送」与「手工删除」**：普通发送全程 `plain`（W3 第一行）。任何只看 `phase` 的设计都会在发送时误撤销 | W3 |
| W5 | 但 `pendingSubmission` 回显是**同步先行**的，且 `text` 就是将要发送的文本：sink 里先 `session.beginSubmission({mode, text, ...})`，然后才 `await nextPaint()` 与 `prompt(..., requestId)`；而 `text` 是 `sinkSerialized` 传进来的、已按我们的 `codec` 序列化过的字符串 | `.../lib/client.js:3443-3463`（`beginSubmission` 先于 `prompt`）、`:13949-13991`（`sinkSerialized` 把每个 occurrence 换成 `serializeReference` 的结果）；契约 `dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts:38-49`（`PendingSubmission.text`）、`:58-61`（`pendingSubmissions`）、`.../contract/session.d.ts:29-46`（类型）与 `:63-73`（契约原文「synchronously, before the caller serializes and sends the prompt」） |
| W6 | ⇒ **「这次消失是发送造成的」有官方可观测信号**：`useSession(s => s.pendingSubmissions)` 里出现携带该标记的回显。它必须与 `draft` 合成判定 | W5；`dsh-client-ui-session/lib/types/client/index.d.ts:77-84`（`useSession`） |
| W7 | 还要防「刚 attach 完还没插进去」：L4 是手动输入，草稿里从未出现过标记；若只看「标记不在草稿里」就会把刚登记的记录立刻撤销 | 第三轮 §7.1 的 L4；本仓库 `src/client/entry.ts:1535-1554`（梯级返回 `'chip'|'text'|'manual'`） |
| W8 | 既有撤销入口就是 `POST /api/secret.release`，它**已经是**「只删 staged、bound 只报告」的语义 ⇒ 需求 3 不需要新路由 | 本仓库 `src/service.ts:308-319`；`src/routes.ts:64-80` |
| W9 | `useInput`/`useSession`/`inputActions` 都在 session 槽位的标准 props 里；`conversation.input.overlay` 是 `{kind:'list', scope:'session'}`。**更强的证据（不依赖第三方注解）**：0.2.1 的「填值胶囊」是**同一组件**在 `mode.kind==='idle'` 时 `return null`（`src/client/entry.ts:1642-1643`），而按钮只往模块级 store 写 `{kind:'fill'}`（`:2112-2113`）——表单能出现，只能是该组件在 idle 态**仍然挂载并订阅**的结果。⇒ 把观测器放进这个组件是可行的 | `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:213-238`（座位）、`:332-347`（标准 props）、`dsh-client-ui-slots/lib/types/index.d.ts:185-222`（props 组合）、`dsh-client-ui-session/lib/types/client/index.d.ts:77-84`（`useSession`）；本仓库 `src/client/entry.ts:1621-1643`、`:2105-2129` |

### 2.9 需求 4：候选契约与菜单渲染边界

| # | 事实 | 证据 |
|---|---|---|
| M1 | **条目支持逐条 label/description/section/icon/hint/value/drill**：`{name, label?, description?, icon?, hint?, section?, value?, drill?}`；`name` = pick 载荷/精确匹配键/第一搜索键，`label` = 第二搜索键 | `dsh-client-ui-input-trigger/lib/types/types.d.ts:35-59`（`:38-44` 的 label 语义） |
| M2 | **菜单实际渲染**：`label ?? name` 作主文本（`.itemName`，`max-width:40%`，省略号）→ `label !== name`（忽略大小写）时把 `name` 作灰色别名（`.itemAlias`，`max-width:20%`）→ `description` 右对齐余下整行（`.itemDescription`，`flex:1;min-width:0`，省略号）→ `drill` 时右侧给提示 | `dsh-client-ui-input-trigger/lib/client.js:1162-1173`（渲染）、`:976`（CSS 串内的三个类） |
| M3 | `section` 会在**同组相邻条目之间变化时**插入一行小标题；只要组里有任一条目带 `section`，该组的组标题行就被抑制 | 同上 `:1112`（组标题抑制）、`:1136-1139`（小节标题） |
| M4 | `icon` 只支持 `'file'\|'folder'\|'session'` 三个字符串（或一个组件） | 同上 `:1154-1161`；类型 `types.d.ts:32-33`、`:46-47` |
| M5 | **`hint` 这个字段在菜单视图里没有被渲染**（视图里只有 `drill.hint` 这套 drill 文案）⇒ 来源/作用域不能放 `hint` | 同上 `:1174-1199`（唯一的 hint 使用点是 drill 文案）、`:1220`/`:1232` |
| M6 | 被 shipped 参考源验证过的写法：`name`（含目录尾斜杠）、`description`（父目录，或 `位置 · 相对时间`）、`icon:'file'/'folder'/'session'`、`section`（文件/会话/子代理）、`value`（JSON 载荷），`showGroupTitle:false` + `onPick` 解析 `value` 返回 `{insert: ReferenceInsert}` | `dsh-client-ui-reference/lib/client.js:159-232`（源形状）、`:281-319`（`fileCandidate`/`sessionCandidate`） |
| M7 | pick 管线把**整条 candidate**原样交给源：`src.onPick({candidate, session, position, via:'menu', action, span})`，源返回 `PickOutcome`，管线用 span 调 scoped bail 事件落实插入 | `dsh-client-ui-input-trigger/lib/client.js:807-821`（`settle`）、`:712-728`（`execute`）；`PickOutcome`：`.../contract/input.d.ts:52-59` |
| M8 | `onPick` 在契约里是**必填**：今天的空候选让 `pick()` 永远走不到它（`settle` 只在 `pick`/`crumb` 里被调），所以现在不写也能跑；本轮一旦给出候选就**必须**实现 | `types.d.ts:161`；`lib/client.js:485-495`、`:807-821` |
| M9 | `codec` 是发送链路的必备件，且**返回值就是模型侧看到的文本**：`sinkSerialized` 对每个 occurrence 调 `serializeReference(source, ref)`，失败即拒绝发送 | `lib/client.js:615-619`（无 codec 直接 reject）、`.../lib/client.js:13949-13991`（逐 occurrence 替换） |
| M10 | `lexicon` 是**同步热快照**（不 warm 不装饰），`subscribeLexicon` 的通知会让控制器重聚合并在菜单开着时重取候选 | `types.d.ts:181-198`；`lib/client.js:730-747`（聚合）、`:748-760`（通知→重取） |
| M11 | 菜单候选**不做过滤**，过滤是源自己的事；某源 `candidates` reject 时该组被静默移除（只 `console.error`） | `lib/client.js:762-791` |
| M12 | **凭据库只能枚举 record，不能枚举 reference**：`describe/resolve` 按名字问；`listRecords()` 才给「每个存储记录的地址与 tag」，契约原文写明「Unlike the reference half, which has no enumeration …records have no such discovery path」 | `dsh-credentials/lib/types/index.d.ts:129-174`；`CredentialRecordEntry = {key, kind}`：`:91-97` |
| M13 | record 的键是 `<scope>/<id>`，schema 段必须是 lowercase hyphenated；本插件的 scope 段是 `cordis-plugin-secret`，id 段由 `recordKeyId(name)` 把 `_` 换成 `-` | `dsh-credentials/lib/types/types.d.ts:13-26`、`index.d.ts:39-54`；本仓库 `src/naming.ts:6-7`、`:51-63` |
| M14 | 两个方向的 marker 载荷形状不同（附加方向带 `kind:'attachment'`，索要方向不带），但都含 `envVar`/`name`/`scope:'persistent'`/`authorizedAt` ⇒ 读 payload 时必须容忍两种 | 本仓库 `src/service.ts:258-277`（附加）与 `:531-537`（索要） |
| M15 | 载荷只能靠 `readRecord(key)` 逐个读回（`listRecords` 不给 payload）；record 数量需设上限 | M12；`index.d.ts:153-165` |

---

## 3. 定案（形态与逐字契约）

### 3.1 需求 1 定案

**3.1.1（必做）O2 旁挂胶囊行**

- 新常量：`CHIP_KIND = 'sr-chip'`（最终实现值，长度 7 ⇒ 上下文键前缀 `7:`，**经机器证明排在 `13:input-message…` 之后**；§2.3 O2-7 的实测：长度 10/11/12 会排到气泡之前，而该键是整体字典序比较——前缀与 kind 文本共同决定，**是否排在后必须逐个实测**，不能只看长度）。
- 新 Definition（照 `secretRequestDefinition` 的形状，§2.3 O2-10），逐字契约：

```ts
const secretAttachChipDefinition = {
  kind: CHIP_KIND,
  target: 'chat',
  match(event) {
    if (event.type !== 'user/message') return null
    const data = event.data
    if (data?.source?.kind !== 'user') return null          // 只认人类自己发的消息
    const markers = messageMarkers(data)                     // src/attach.ts:291-299 的同款规则
    if (markers.length === 0) return null
    return { id: String(data.id), role: 'start' }
  },
  start(_context, match) {
    const markers = messageMarkers(match.event.data)
    return { messageId: String(match.event.data.id), variables: markers }
  },
  update: (context) => context.state,
  buildViewNode(context) {
    if (context.start === undefined) return null
    const seq = context.start.event.seq
    const state = context.state
    if (state === undefined || state.variables.length === 0) return null
    return {
      key: context.key, kind: CHIP_KIND, id: context.id, target: 'chat',
      anchorSeq: typeof seq === 'number' ? seq : 0,
      location: SESSION_LOCATION,                           // {kind:'session'}：永不折进过程组（O2-5）
      visibility: 'visible',
      data: { messageId: state.messageId, variables: state.variables },
    }
  },
}
```

- 注册（**新增，既有 4 处注册一行不改**）：
  - `ctx.uiConversation.events.register(secretAttachChipDefinition)`
  - `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name:'conversation.chat.node', key: CHIP_KIND }, SecretAttachChipRow))`
- 行形态 `SecretAttachChipRow`：一个 `div[data-secret-attach-chip="<messageId>"]`，内部每个变量一个 `<button class="srd_pill" title="@DSH_SECRET_X">`（文案＝变量名，与第三轮 D3 的显示口径一致）；点击 `setAttachMode({kind:'detail', variable})`。**不渲染任何值**（N1）。
- 失效判据（看门狗）：`conversationContextKey(CHIP_KIND, id) > conversationContextKey('input-message', id)` 必须为真；`presentationPosition` 对 `location.kind==='session'` 必须走 rank 0 分支。

**3.1.2（可选，需用户拍板）O1 文档查看器接管**

- `ctx.inject(['sidebarRightTabs'], (scoped) => scoped.effect?.(...))` 内注册（**必须挂在 effect 上**，`register` 返回的 disposer 要随插件卸载释放）：

```ts
{
  id: `${PACKAGE_ID}/secret-attach-detail`,
  kind: 'secret-attach-detail',
  patterns: ['dsh-resource://file/**/DSH_SECRET_*'],   // 含 ':' ⇒ 整地址匹配；实测长度 35 > better-sidebar 的 22（O1-2）
  priority: 'extension',                                // 与竞争者同档，靠 pattern 长度取胜（O1-2）
  canOpen: (address) => /(^|\/)DSH_SECRET_[A-Z][A-Z0-9_]*$/.test(pathOf(address)),
  title: (address) => variableOf(address) ?? '密钥详情',
}
```

- 正文：`ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key: id }, AttachDetailTab))`，`AttachDetailTab` 用 `useTabInfo().tab.contentId` 解析变量名（O1-6），渲染与 `detail` 胶囊同源的信息（变量名/凭据键/作用域/状态/该变量的历史）；标题座位 `.title` 可省（`title(address)` 已在开标签时捕获，README:146「Titles are fixed at open time」）。
- 用户可见后果与代价照 §2.2 写进 README（右栏、面板自动展开、不再「文件不存在」）。
- **明确写进文档的残余风险**：同档更长 pattern 的后来者会静默抢走打开（无法用契约保证）。

**3.1.3（可选，默认关）O3 页面拦截**

- 由 config（客户端读不到 host config；用一个**客户端常量**默认关闭，或由 host 的 `attachClickInterception` 通过新的只读路由下发——定案取前者：编译期常量 `INTERCEPT_TRANSCRIPT_CHIPS = false`，避免为一个 hack 增加协议面）。
- 规则与失效风险照 §2.4；命中时只做 `preventDefault/stopPropagation` + 开我们的 detail，**不做任何其它 DOM 修改**（不删节点、不改属性、不插样式）。
- README 必须写明：这是非契约的、可能随 harness 升级失效的可选增强，失效后回到「文件不存在」。

**3.1.4 需求 1 的兜底阶梯（写进 §6）**

### 3.2 需求 2 定案（历史聚合）

**数据模型（Host，新增 `src/history.ts`）**

```ts
type SecretHistoryEvent =
  | 'staged'       // 一次附加登记成功（含 replaced）
  | 'bound'        // 提升为 Grant（带 anchorSeq）
  | 'discarded'    // 人类在胶囊里点「丢弃」
  | 'withdrawn'    // 草稿里标记消失触发的自动撤销（需求 3）
  | 'revoked'      // 读取时观测到 bound 记录的锚点已离开 live surface
  | 'expired'      // staged TTL 到期
  | 'authorized'   // 索要方向（secret_request）授权成功产生 Grant

interface SecretHistoryEntry {
  readonly at: number
  readonly event: SecretHistoryEvent
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: SecretScope
  readonly anchorSeq?: number
  readonly source: 'attach' | 'request'
  readonly replaced?: boolean
}
```

**写入点（逐一对应现有代码，全部值无关）**

| 事件 | 写入位置 | 依据 |
|---|---|---|
| `staged` | `SecretService.attach()` 成功返回前（`replaced` 字段来自 `written.replaced`） | `src/service.ts:279-299` |
| `bound` | `onBound` 回调（`index.ts` 已接 `service.noteBound`），同时写历史 | `src/index.ts:97-99`、`src/service.ts:365-369` |
| `discarded` / `withdrawn` | `release()` 的 staged 分支（按新增的 `reason` 区分） | `src/service.ts:308-319`、`src/routes.ts:64-80` |
| `revoked` | `attachedViews()` 观测到 bound 记录失效时（懒写入，与 `known.delete` 同一处） | `src/service.ts:345-351` |
| `expired` | `AttachStore` 新增可选回调 `onDrop(sessionId, envVar, reason)`，TTL 与显式 remove 都报出 | `src/attach.ts:82-98`、`:137-147` |
| `authorized` | `complete()` 成功产出 Grant 处 | `src/service.ts:587+`（`planGrant`/`grants.put`） |

**保留语义**

| 维度 | 定案 |
|---|---|
| 存储 | **纯内存**，按会话，不落盘 |
| 上限 | `maxHistoryPerSession`，默认 **32**，超出丢最旧（`assertConfig` 增加正整数校验） |
| 页面刷新 | **保留**（Host 进程未变） |
| 会话切换 | 每会话独立；切回仍在 |
| 会话结束 | `session/disposed` 清空（与 grants/attachments 同一处） |
| Host 重启 / 插件重载 | **丢失**；不做日志反推（与第三轮 §5.4 的 fail-closed 一致） |
| 重放 / fork | 不重建历史；fork 子会话从空历史开始（父的 grant/记录一律不可见，`src/grants.ts:77-85`） |

**读取面（新增只读路由，`attached` 形状冻结）**

| 路由 | 方法 | 请求 | 成功 | 失败（固定文案纪律） |
|---|---|---|---|---|
| `/api/secret.history` | GET | `?sessionId=…` | `200 {"ok":true,"entries":[{at,event,variable,name,label,scope,anchorSeq?,source,replaced?}]}`（时间倒序，最多 `maxHistoryPerSession` 条） | `400 {"ok":false,"error":"history.sessionId is required"}` |

- 无值断言：响应的 `JSON.stringify` 不含任何值（N1）。
- **不改** `GET /api/secret.attached`（该形状已被 t3 逐字段钉住；若要合并，须同时更新第三轮的 A4 断言——定案选择不改）。

**「历史」的边界（展示口径）**

- 已失效/已回退/已丢弃/已过期**都展示**，用 `event` 标注中文文案（`已登记`/`已绑定到消息 #seq`/`已丢弃`/`已随草稿移除撤销`/`已随消息回退失效`/`已过期`/`经授权生效`）。
- 当前仍有效的条目（staged/bound）在展示上取「现算状态」而非历史最后一条：胶囊的现状区仍走 `GET /api/secret.attached`；历史区是**流水**，两者并列不互斥。
- `revoked` 是**懒观测**：只有在有人读过该变量的状态后才会出现；未观测到就不虚报（宁缺勿假）。

**客户端形态**

- `AttachMode` 增加 `{ kind:'history' }`（整体流水）与 `{ kind:'confirm'; variable; name }`（需求 4 用；**不含 label**——凭据库记录里没有人类标题，见 §3.4）。
- `fill` 态头部增加一行链接 `历史记录 (N)`（N 来自历史条数，取不到时不显示数字）→ 切 `history`。
- `detail` 态在现有行下增加「历史记录」小节：只列该变量的条目（最多 5 条 + 「查看全部」→ `history`）。
- `history` 态：列表（变量名 · 事件 · 作用域 · 时间 · 锚点），失败时显示固定文案「历史暂不可用」，不阻塞其它操作。
- 进入 `history` 时调一次 `GET /api/secret.history`（与 `refreshAttached` 同法），失败保持上一次结果。

### 3.3 需求 3 定案（移除胶囊即撤销）

**判定纯函数（可单测，输入全部来自可观测面）**

```ts
type WithdrawVerdict = 'keep' | 'arm' | 'cancel'

function decideWithdraw(input: {
  readonly state: 'staged' | 'bound' | 'withdrawn'   // 本地元数据
  readonly seenPresent: boolean                       // 该变量曾在草稿里出现过
  readonly markerPresent: boolean                     // 当前 draft 含该标记（MARKER_RE）
  readonly submissionCarries: boolean                 // 某个 pendingSubmission.text 含该标记（W5/W6）
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}): WithdrawVerdict {
  if (input.state !== 'staged') return 'keep'
  if (input.markerPresent || input.submissionCarries) return 'cancel'
  if (!input.seenPresent) return 'keep'                // W7：刚 attach 还没插进去，不动
  if (input.phase !== 'plain') return 'keep'
  return 'arm'
}
```

**去抖与生命周期**

- `WITHDRAW_DEBOUNCE_MS = 600`（常量，可测）。`'arm'` 只在「该变量当前没有待发计时器」时真正建表；`'cancel'` 清掉计时器。
- 计时器闭包捕获 `(sessionId, variable, generation)`；触发时**重新读取最新的** `draft`/`pendingSubmissions`/`meta`，若 `generation` 变了（期间重新附加过）或判定不再是 `'arm'` ⇒ 中止（fail-safe：记录留着）。
- 触发时调 `POST /api/secret.release {sessionId, variable, reason:'withdrawn'}`：
  - `{ok:true, released:true, state:'staged'}` ⇒ 本地元数据置 `withdrawn`，从「本会话可用」集合与 lexicon 里移除，`publishAttached()`，并记录本地流水（Host 侧也记了，这里只为即时反馈）。
  - `{ok:true, released:false, state:'bound'}` ⇒ **有人在窗口内发送成功**：本地元数据置 `bound`，不报错、不提示失败。
  - `{ok:true, released:false, state:'none'}` ⇒ 记录已不在（过期/被别人撤销）：本地元数据移除。
  - 网络失败/非 2xx ⇒ **不做任何本地状态变更**，下次草稿变化再判定（fail-safe）。

**撤销范围（写死在契约里）**

- **只有 `staged` 可被撤销。** 已 `bound`（消息 durable）的记录**不允许**被本机制删除：唯一的撤销方式是回退/改写那条消息（`revoked-anchor` 现算，`src/grants.ts:124-131`），这与既有的「丢弃」按钮语义完全一致（`src/service.ts:301-307` 的注释与实现）。
- `reason:'discarded'`（人手点丢弃）与 `reason:'withdrawn'`（草稿移除触发）在历史里是两类事件，但**对授予的影响完全相同**（都是删除 staged 记录）。`revoked-anchor` 仍是第三类：它发生在 bound 之后、由回退触发，与「移除胶囊」无关。

**边界表**

| 场景 | 设计行为 | 理由 |
|---|---|---|
| 删掉胶囊 → 600ms 内又插回（含剪切/粘贴） | `'cancel'`，记录保留 | 去抖窗口覆盖编辑器内的短暂缺字 |
| 删掉胶囊 → 等 2s 后再插回 | 记录已撤销；`@` 菜单不再列出该变量；重新附加需重填值（**除非原 scope 是 persistent**，可从凭据库 `adopt` 回来） | §8.1 第 4 条需用户拍板（见下） |
| 发送（Enter/发送按钮） | **不撤销**：`pendingSubmissions` 先于 `commit-draft` 出现（W5/W6），判定返回 `'cancel'` | 这是本设计存在的主要理由（W3/W4） |
| 发送失败（编辑区恢复草稿） | 标记回到草稿 ⇒ `'cancel'`；记录保持 staged | 与第三轮「发送失败不丢值」一致 |
| 发送中又手动删标记 | `submissionCarries` 为真 ⇒ 不撤销；消息 durable 后记录由绑定消费（变 bound） | 人类删除的是草稿，不是已发出的消息 |
| 刷新页面（Host 未重启） | 草稿恢复为纯文本 `@VAR`（`MARKER_RE` 命中）⇒ 不撤销；本地 `seenPresent` 从「当前草稿里就有」重建 | W2：不能用 occurrences 判定 |
| 刷新后草稿里**没有**标记（例如发送后刷新） | 本地元数据来自 `GET attached`：此时该变量已是 `bound`（或 `none`）⇒ `state !== 'staged'` ⇒ `'keep'` | 状态是权威 |
| L4 手动插入路径 | 从未 `seenPresent` ⇒ `'keep'`（记录留到 TTL/丢弃） | W7 |
| 用户手工键入 `@DSH_SECRET_X` 又删掉（无本地 staged 记录） | 无关：没有候选 | 判定只对本地 `staged` 元数据生效 |
| 会话切换 | 每会话独立判定；切走不会触发任何请求 | 记录是会话级的 |
| 插件/客户端 watcher 未挂载（座位不再渲染空条目） | 不撤销（退化为只能手点「丢弃」） | §6 R2 兜底 |
| 撤销后重新附加同一凭据键 | 新 staged 记录 + `generation++`；任何旧计时器因 generation 不匹配而作废 | 防「旧计时器杀掉新记录」 |

### 3.4 需求 4 定案（`@` 菜单列出可用密钥）

**条目形态（逐字）**

```ts
// 本会话当前可用（staged 或 bound）
{ name: 'openai',                                // 凭据键：pick 载荷/精确匹配键/第一搜索键
  label: 'DSH_SECRET_OPENAI',                    // 主显示文本＝变量名
  description: '本会话 · 仅本次会话有效 · 已登记，等待发送',
  icon: 'session',
  section: '本会话可用',
  value: JSON.stringify({ v: 'DSH_SECRET_OPENAI', origin: 'session' }) }

// 凭据库已持久化（本插件提交过 record，且本会话当前没有）
{ name: 'openai',
  label: 'DSH_SECRET_OPENAI',
  description: '凭据库 · 持久保存到凭据库 · 尚未用于本会话',
  icon: 'session',
  section: '凭据库（持久）',
  value: JSON.stringify({ v: 'DSH_SECRET_OPENAI', origin: 'store' }) }
```

- **来源与作用域如何编码（回答「是否只有名字字符串」）**：菜单**支持**逐条的 `label`/`description`/`section`（M1–M4），所以来源写进 `section`、作用域写进 `description`，**不采用**「把来源塞进名字」的退化方案；`hint` **不可用**（M5），因此不把关键字放 `hint`。
- 名字与键的分工是刻意的：主文本是**变量名**（人类要知道消息里出现什么），灰色别名是**凭据键**（人类要知道对应哪一份凭据），`value` 承载真正的载荷 ⇒ 显示与语义解耦（M1 的 `value` 就是为此存在）。
- 排序：本会话条目在前、`bound` 先于 `staged`，然后按变量名；凭据库条目按变量名。**同一变量同时存在于两会话面时只出「本会话」一条**（去重优先本会话）。
- 过滤：源自己按 `query` 做大小写不敏感的子串过滤（变量名 / 凭据键 / label 三处），上限 20 条；无命中返回 `[]`（组会自然收缩，全空时菜单自动关闭）。

**pick 语义（按来源分开，这是本需求唯一有风险的语义决定）**

| 来源 | pick 行为 | 理由 |
|---|---|---|
| `origin:'session'`（本会话已有 staged/bound 记录） | 返回 `{ insert: { source:'secret', ref: variable, label: variable, appearance:'session', clipboardText:'@'+variable } }` | 与既有 `insertChip` 的 L1 载荷**逐字相同**，不产生任何新暴露；插入后 Host 侧的绑定规则不变（staged 已存在） |
| `origin:'store'`（仅凭据库有） | **不插入**，返回 `'handled'`，把胶囊切到 `{kind:'confirm'}`：一行「把凭据库里的 `DSH_SECRET_X`（键 `openai`）用于这条消息？」+ 一个动作按钮 + 取消。**注意凭据库记录里没有人写过的标题**（两种 marker 载荷都只有 `envVar`/`name`/`scope`，见 M14），所以确认文案只能显示变量名与凭据键，不得编造标题 | 直接在消息里放一个没有 staged 记录的标记会让 `session/event` 绑定不到东西 ⇒ 注记不会生成、模型拿不到变量 ⇒ **谎言**。必须先登记再插 chip（与第三轮「先 attach 成功、再插 chip」同一纪律） |
| `confirm` 的动作 | `POST /api/secret.adopt {sessionId, variable}` → Host 用 `credentials.resolve(envVar)` 取值、`AttachStore.put` 登记 → 成功后按既有 L1→L3→L4 插 chip 并切 `detail`；失败显示固定文案且**不插任何东西** | 值不跨线（N2）；失败 fail-closed |

**新增只读/写入路由**

| 路由 | 方法 | 请求 | 成功 | 失败（固定文案） |
|---|---|---|---|---|
| `/api/secret.available` | GET | `?sessionId=…` | `200 {"ok":true,"entries":[{variable,name,label,scope,state,source}]}`，`source ∈ {session,store}`，`state ∈ {staged,bound,stored}` | `400 available.sessionId is required` |
| `/api/secret.adopt` | POST | `{sessionId, variable}` | `200 {"ok":true,"variable":…,"scope":"persistent","replaced":false}` | `400 adopt.* …` / `404 adopt: 找不到该会话或该凭据` / `409` 上限 / `500` 固定文案（**绝不复述上游文本**，第二层 `redactSecrets`） |

- `available` 的组装：会话侧来自 `attachedViews(sessionId)`（`src/service.ts:328-362`）；凭据库侧 = `credentials.listRecords()` 过滤 `key` 的 scope 段为 `cordis-plugin-secret`（M13）→ 逐条 `readRecord` 读 payload（M15）→ 取 `envVar`/`name`/`scope`（**两种载荷形状都要容忍**，M14）→ 与会话侧按变量去重（会话侧优先）→ 上限 32 条、读不回的条目静默跳过。
- `adopt` 只接受**本插件 record 里已有且 `scope==='persistent'`** 的变量；`credentials.resolve` 返回空 ⇒ 404（**不落任何记录**）。
- **`codec` 与 `lexicon` 明确不变**：
  - `codec.clipboardText`/`serialize` 继续返回 `'@'+ref`。**禁止**把来源/作用域编码进序列化结果（会破坏 `MARKER_RE`、破坏 `session/event` 绑定、破坏模型侧注记，见 M9 与第三轮 §3.2）。
  - `lexicon` 继续只返回**本会话可用**的变量名。理由：lexicon 决定「纯文本 `@token` 是否被装饰成引用并路由 `openReference`」，把「仅凭据库有、本会话尚未登记」的名字放进去，会让人类看到一个「看起来可用」的引用而在发送后拿不到变量（`describeVariable` 只认 staged/已绑定）。
- `openReference` 不变（点 detail 仍可用）。

---

## 4. 事件 / 状态机

### 4.1 客户端

```ts
type AttachMode =
  | { kind: 'idle' }
  | { kind: 'fill' }
  | { kind: 'detail';   variable: string }
  | { kind: 'history' }                                   // 新增：本会话历史聚合区
  | { kind: 'confirm';  variable: string; name: string }   // 新增：凭据库条目改用确认（无 label：记录里没有人类标题）
```

| 事件 | 迁移 | 说明 |
|---|---|---|
| 点我们的旁挂胶囊行（O2） | `→ detail(variable)` | 与既有点卡片/草稿 chip 同一条入口 |
| 点「历史记录 (N)」链接 | `fill/detail → history` | 进入时 `GET /api/secret.history` |
| `history` 里点某条 | `→ detail(variable)` | 从流水回到现状（现状仍以 `attached` 为准） |
| `@` 菜单 pick（会话来源） | 无模式变化（菜单关闭） | 插入 chip，与既有 insertChip 的 L1 载荷相同 |
| `@` 菜单 pick（凭据库来源） | `→ confirm(variable,name,label)` | 不插入任何东西 |
| `confirm` 确认 | `→ detail(variable)`（adopt 成功后插 chip） | 失败留 `confirm` + 固定文案 |
| `confirm`/`history` 取消 | `→ idle` 或回 `detail` | 无请求 |
| 草稿观测（需求 3） | 无模式变化，只驱动 §3.3 的判定 | 观测器挂在**已常驻的 overlay 条目**里（W9）；若该条目不再渲染空态，则退化为 R2 兜底 |
| 页面刷新 | `idle` 起 | 本地元数据由 `GET attached` 重建；历史由 `GET history` 重取 |

### 4.2 Host

```
attach(raw)                         → AttachStore.put → history.push({event:'staged', replaced})
session/event(user/message)         → bindStaged → onBound → history.push({event:'bound', anchorSeq})
release(raw, reason)   staged 命中  → AttachStore.remove → history.push({event: reason === 'withdrawn' ? 'withdrawn' : 'discarded'})
release(raw)           bound        → 只报告 {released:false,state:'bound'}（不动 grant、不写历史）
attachedViews(sessionId)             → 观测到 bound 失效 → known.delete + history.push({event:'revoked'})
AttachStore TTL 到期                 → onDrop(sessionId, envVar, 'expired') → history.push({event:'expired'})
complete()（索要方向授权成功）        → history.push({event:'authorized', source:'request'})
available(sessionId)                 → attachedViews ∪ credentials.listRecords→readRecord（去重、限流、值无关）
adopt(raw)                           → 校验 record 与 resolve → AttachStore.put → history.push({event:'staged', source:'attach'})
session/disposed                     → grants.forget + attachments.forget + history.forget
```

### 4.3 需求 3 的时序（关键窗口）

```
人类点发送
  [同一批效果] default-sink → sinkSerialized
      ├ 对每个 occurrence 调 codec.serialize(ref)   → 我们的 codec 被调用（**可选的第二重信号**）
      └ sink() → session.beginSubmission({text:'…@DSH_SECRET_X…'})   ← 回显同步出现（W5）
  [同一批效果] commit-draft → 编辑器清空 → useInput.draft 变化（W3）
  我们的判定：markerPresent=false，但 submissionCarries=true ⇒ 'cancel'（**不撤销**）
  之后：消息 durable → session/event → bindStaged 消费 staged 记录 ⇒ GET attached 报 bound
```

---

## 5. 文件级改动点

### 5.1 Client 半（`src/client/entry.ts`，仍是单文件 classic script）

> **本表是计划稿**：保留原始设计意图，不按实现逐行回填；实际落点以 §3 的逐字契约与 `src/client/entry.ts` 为准。与最终实现的 5 处差异（计划 → 实际）：
> 1. 常量 `TAB_KIND` → 实际为 `DETAIL_TAB_KIND`（`entry.ts:1182`），并另有本表未提的 `DETAIL_TAB_ID`（`:1181`）与 `DETAIL_TAB_PATTERN`（`:1184`）；
> 2. 计划项 `INTERCEPT_TRANSCRIPT_CHIPS = false` → **未实现**：用户裁定不做 O3 页面级拦截，实现里不存在该开关（全文 0 命中）；
> 3. 计划函数 `eventLabel(event, scope)` → 实现里**无同名函数**；状态文案由 `ATTACH_ZH.evStaged…evUnknown`（`entry.ts:1248-1255`，取用于 `:1959`/`:3260`）承担；
> 4. 计划组件 `SecretAttachHistory` → 实现里**无此组件**；历史区是胶囊自身的 `history` 态、行内渲染（`entry.ts:3220`，区块标题 `:3232`）；
> 5. 计划类型 `InputTriggerCandidateLike` → 实现里的名字是 `CandidateLike`（`entry.ts:1635`）。

| 区块 | 改动 |
|---|---|
| 头注释 | 增补四项增强的说明（含 O1/O2/O3 的取舍与失效风险） |
| 常量 | `CHIP_KIND='sr-chip'`、`HISTORY_PATH='/api/secret.history'`、`AVAILABLE_PATH='/api/secret.available'`、`ADOPT_PATH='/api/secret.adopt'`、`WITHDRAW_DEBOUNCE_MS=600`、`INTERCEPT_TRANSCRIPT_CHIPS=false`、`TAB_KIND='secret-attach-detail'`；`TEXT`/`ATTACH_ZH`/`ATTACH_EN` 增补：历史区标题/事件文案/确认文案/new 失败文案 |
| 类型 | `InputStateLike`（`draft`/`phase`）、`SessionSnapshotLike`（`pendingSubmissions`）、`TabInfoLike`、`InputTriggerCandidateLike`、`HistoryEntry`、`AvailableEntry`；全部本地结构类型，不新增 import |
| 纯函数 | `decideWithdraw`、`readHistoryList`、`readAvailableList`、`candidateRows(entries, query)`、`variableOfAddress(address)`、`eventLabel(event, scope)` |
| store | 模块级 `historyBySession`（只读缓存）、`withdrawTimers`；`AttachedMeta` 增加 `generation`/`seenPresent`（**仍不含值**） |
| 组件 | `SecretAttachChipRow`（O2 行）、`SecretAttachHistory`（历史区）、`SecretAttachCapsule` 增加 `history`/`confirm` 两态与历史小节、`AttachDetailTab`（仅 O1 采用时注册） |
| source | `secretSource` 增加 `onPick`（会话来源→insert；凭据库来源→`'handled'`+confirm）；`candidates` 改为取 `GET /api/secret.available`（失败时只回退会话侧本地已知）；`codec`/`lexicon`/`openReference` **不改** |
| 注册 | 新增 2 处：`uiConversation.events.register(secretAttachChipDefinition)`、`slots.register({name:'conversation.chat.node', key:CHIP_KIND})`；（O1 时）`ctx.inject(['sidebarRightTabs'], …)` + `sidebar.right.pane.tab` 座位。**既有 4 处注册不改** |
| 测试缝 | `ATTACH_SEAM` 升到 `version: 2`，追加 `CHIP_KIND`/`decideWithdraw`/`candidateRows`/`readHistoryList`/`readAvailableList`/`secretAttachChipDefinition`/`SecretAttachChipRow`/`WITHDRAW_DEBOUNCE_MS`/`HISTORY_PATH`/`AVAILABLE_PATH`/`ADOPT_PATH`；**不得**导出任何持值对象 |
| 样式 | 第二条 stylesheet 里追加 pill/历史行/确认框样式；只用 theme token；仍无 `position:fixed`、无全视口 |

**tsconfig 约束不变**：`tsconfig.client.json` 是 `types: []` + `moduleDetection: legacy`，新代码不得 import 任何 `@deepseek-ai/*`；跨包类型只用本地结构类型或 ambient `declare module`。

### 5.2 Host 半

| 文件 | 改动 |
|---|---|
| `src/history.ts`（**新**） | `SecretHistoryEntry`/`SecretHistoryEvent` + `HistoryStore`（`push/list/forget/disposeAll`，按会话上限、时间倒序读出，值无关） |
| `src/attach.ts` | `AttachStore` 增可选 `onDrop?(sessionId, envVar, reason:'expired'|'removed')`；`put`/`remove`/`forget`/TTL 各自报出（**既有语义不变**） |
| `src/service.ts` | 注入 `history`；`attach`/`release`/`attachedViews`（revoked 观测）/`noteBound`/`complete` 写历史；新增 `available(sessionId)`、`adopt(raw)`、`historyFor(sessionId)` |
| `src/protocol.ts` | 新增 `parseRelease` 的 `reason?`（仅接受 `'discarded'|'withdrawn'`，其余 400）、`parseSessionIdQuery`、`historyView`、`availableView`、`parseAdopt`；既有 `parseAttach`/`attachedView` 不动 |
| `src/routes.ts` | 新增 3 条路由（`GET history`、`GET available`、`POST adopt`）；`RELEASE_PATH` 的 handler 透传 `reason`。既有 5 条路由注册形状不变 |
| `src/adapters.ts` | `CredentialsPort` 增 `listRecords()`、`readRecord(key)`（薄封装 `ctx.credentials`） |
| `src/naming.ts` | 新增 `isHistoryReason(raw)`、`variableOfFileAddress(address)`（纯字符串解析，不引新依赖） |
| `src/config.ts` | 新增 `maxHistoryPerSession: 32`、`maxAvailableEntries: 32`、`adopt` 沿用 `attachTtlMs`/`maxAttachmentsPerSession`；`assertConfig` 增校验 |
| `src/index.ts` | 组装 `HistoryStore`；`installAttachBinding` 的 `onBound` 同时写历史；`session/disposed` 增 `history.forget`；`event 'session/disposed'` 处不改既有两行 |
| `package.json` | **不改 version**；仅当采纳 O1 时 `dsh.client.inject` 追加 `@deepseek-ai/dsh-client-ui-sidebar-right`（peerDependencies 已足够，客户端包不进 peer） |
| `README.md` | 新增四节：转录详情（O2 主力 + O1/O3 可选与代价）、历史记录（保留语义与失效边界）、移除胶囊即撤销（含发送竞态的诚实说明）、`@` 菜单（来源/作用域编码 + 凭据库条目的确认语义） |

### 5.3 测试文件（只增）

| 文件 | 内容 |
|---|---|
| `test/history.test.ts`（新） | `HistoryStore`（上限/顺序/会话隔离/forget）、事件写入点（attach/bound/release/expired/revoked/authorized）、`available` 组装（去重、两种载荷、读不回跳过、值无关）、`parseRelease` 的 `reason` |
| `test/client-attach.test.ts`（追加） | `decideWithdraw` 的真值表、`secretAttachChipDefinition` 的 match/start/buildViewNode、上下文键排序性质、`candidateRows`（label/description/section/value + 过滤 + 上限）、`onPick` 两分支、`readHistoryList`/`readAvailableList` 的防御式校验、SEAM v2 无值 |
| `test/unit.test.ts` / `register.test.ts` / `attach*.test.ts` | 只追加，既有断言一条不删（78 → 只增） |

---

## 6. 兜底阶梯

### 6.1 需求 1

| 级 | 机制 | 失败判据 | 后果 |
|---|---|---|---|
| **N1** | O2 旁挂节点 | `events.register` 抛错 / 节点 kind 未派发 | → N4 |
| **N2** | （可选）O1 查看器接管 | 同档更长的 pattern 抢走 claim / 右栏不可用 | 点原始胶囊仍是老行为 |
| **N3** | （可选，默认关）O3 页面拦截 | DOM 形态变化 / 委托根变化 | 退回今天的行为（打开不存在的文件） |
| **N4** | 都不成立 | — | **如实说明**：原始胶囊点击会尝试打开同名文件（第三轮 R3 的已知限制），详情只能从我们的旁挂行/草稿胶囊进入 |

判据纪律：只有 N1 成功才允许在 UI/文档里说「历史消息旁的变量名胶囊点击可查看详情」；若额外启用了 N3，必须写明它是非契约增强。

### 6.2 需求 2

| 编号 | 场景 | 行为 |
|---|---|---|
| H1 | `GET history` 不可达 | 历史区显示「历史暂不可用」，现状区照常，不阻塞任何操作 |
| H2 | 条目超过上限 | 丢最旧；读取侧无感 |
| H3 | Host 重启/插件重载 | 历史为空；现状区由 `attached` 重建；**不虚报**任何历史 |
| H4 | fork/重放 | 子会话历史为空；不回填 |

### 6.3 需求 3

| 编号 | 场景 | 行为 |
|---|---|---|
| R1 | 三信号齐全 | 600ms 去抖后撤销（唯一正常路径） |
| R2 | `useInput` 或 `useSession` 不在 props 里 | **完全不撤销**（记录只能手点「丢弃」或等 TTL）；在胶囊里显示一句「宿主未提供草稿观测能力，自动撤销不可用」 |
| R3 | `release` 不可达/非 2xx | 保持记录，下次草稿变化再判定；不重试成风暴（同一变量同一 generation 只发一次） |
| R4 | 窗口内发送成功 | 服务端返回 `state:'bound'` ⇒ 本地置 bound，不报错 |
| R5 | 计时器触发时草稿又被改动 | 重新判定，留到下一次 |

### 6.4 需求 4

| 编号 | 场景 | 行为 |
|---|---|---|
| C1 | `available` 可达 | 两个 section 完整展示 |
| C2 | `available` 不可达 | 只用**本会话已知**条目（本地 map），`description` 写「本会话 · 状态未知」；**不列**凭据库条目（无法核实，不虚报） |
| C3 | 凭据库 record 读不回 | 跳过该条，不影响其余 |
| C4 | `adopt` 失败 | 固定文案，`confirm` 态保留，**不插 chip** |
| C5 | 选定凭据键对应的 record 不是 `persistent` | 不计入「凭据库（持久）」section |

---

## 7. 验证清单

> 约定：`$R = projects/cordis-plugin-secret`；`$H = C:\Program Files\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`。带「活体」的条目需要浏览器/真实会话，无法执行时**必须标注「未验证」**，不得推定通过。

### 7.0 A 段：可机器证明

**A1 机制复核（静态证据，逐条 grep 到行）**
1. `$H\dsh-client-ui-primitives\lib\index.js:6760-6781`：file 形胶囊的点击仍硬编码 `references.openFile`，非 file 形仍是无 `onClick` 的 `<span>`。
2. `$H\dsh-client-ui-conversation\lib\client.js:12784-12800`、`:13166`、`:13518`：`openReference` 仍只由编辑器激活路径调用。
3. `$H\dsh-client-ui-chat\lib\client.js:12423-12429`：`openFile` 仍是 `fileAddressFor` → `sidebarRight.openResource`。
4. `$H\dsh-client-ui-sidebar-right\lib\client.js:8619-8658`、`:8782-8798`：档位/pattern 长度/注册顺序的排名规则未变。
5. `$H\dsh-client-ui-conversation\lib\client.js:1122-1124` 与 `$H\dsh-client-ui-chat\lib\client.js:8273-8281`：上下文键格式与同 anchor 的 `key.localeCompare` 兜底未变（N1 的排序前提）。
6. `$H\dsh-client-ui-conversation\lib\client.js:3880-3899`、`:13923-13942`、`:13949-13991` 与 `$H\dsh-api-session-controller\lib\types\client\contract\snapshot.d.ts:38-49`：发送清空草稿的时序与 `pendingSubmission.text` 仍未变（需求 3 的前提）。
7. `$H\dsh-client-ui-input-trigger\lib\client.js:1162-1173` 与 `lib\types\types.d.ts:35-59`：条目 label/description/section 的渲染能力仍在（需求 4 的前提）。
8. `$H\dsh-credentials\lib\types\index.d.ts:153-174`：`listRecords`/`readRecord` 仍在，且 reference 半边仍无枚举面。
   任一条消失 ⇒ 对应定案须重审（不是测试失败，而是假设失效）。

**A2 客户端单元（扩 `test/client-attach.test.ts`）**
1. `decideWithdraw` 真值表：`state!=='staged'`→`keep`；`markerPresent`→`cancel`；`submissionCarries`→`cancel`；`!seenPresent`→`keep`；`phase!=='plain'`→`keep`；其余→`arm`。
2. `secretAttachChipDefinition.match`：带标记的 `source.kind==='user'` 消息 → `{id,role:'start'}`；无标记 → `null`；`source.kind!=='user'`（如我们的注记）→ `null`；非 `user/message` → `null`。
3. `buildViewNode`：`location` 为 `{kind:'session'}`、`visibility==='visible'`、`anchorSeq` = 起始事件 seq、`key` = 引擎键；`data` 里**没有**值。
4. **排序性质**（钉住 N1 的前提）：`conversationContextKey('sr-chip', id) > conversationContextKey('input-message', id)`（按字符串比较实现同一规则）。断言只钉住**实测成立的事实**：kind 长度为 10/11/12 时该不等式**不成立**（会排到气泡之前），`sr-chip`（7 字符）时成立；**不要**写成「某几个长度区间一律成立」——该键是整体字典序比较（前缀与 kind 文本共同决定），长度 1 与长度 13（kind 文本排在 `input-message` 之前）两个样本都已实测为**不成立**，任何新 kind 的位置都必须逐个实测。
5. `candidateRows(entries, '')` 的字段表：`label` 是变量名、`description` 同时含来源词与作用域词、`section ∈ {本会话可用, 凭据库（持久）}`、`value` 可 `JSON.parse` 且 `v` 是变量名；`candidateRows(entries,'openai')` 命中凭据键过滤；上限 20。
6. `onPick`：会话来源 → `{insert}` 且 `clipboardText === '@'+variable`、`source === 'secret'`；凭据库来源 → `'handled'` 且**不返回** `insert`，且胶囊模式被置为 `confirm`。
7. `readHistoryList` / `readAvailableList` 的防御式校验：字段缺失/类型错/未知 `state`/未知 `source` 一律丢弃该条；整个 payload 畸形返回 `null`。
8. 值面：`JSON.stringify(api)`（整个 ATTACH_SEAM v2）不含任何测试哨兵值；新增对象的 `Object.keys` 集合断言。
9. `release` 的请求体带 `reason:'withdrawn'`；`state:'bound'` 的响应不产生任何错误提示与本地删除。

**A3 Host 单元（新 `test/history.test.ts` + 扩既有）**
1. `HistoryStore`：上限 32 丢最旧；按会话隔离；`forget(sessionId)` 只清该会话；读出时间倒序。
2. 写入点：`attach()` 成功 → 一条 `staged`（`replaced` 正确）；`bindStaged` → `onBound` 收到后 → 一条 `bound` 带 `anchorSeq`；`release(reason:'withdrawn')` → `withdrawn`；`release(reason:'discarded')` → `discarded`；`release` 命中 bound → **无**历史写入且 `released:false`；TTL 触发 → `expired`；`attachedViews` 观测失效 → `revoked`；`complete()`（索要方向）→ `authorized`。
3. `parseRelease`：`reason` 缺省 = `discarded`；非法的 `reason` → 400 固定文案；`variable`/`sessionId` 校验不回归。
4. `available`：会话侧与凭据库侧合并去重（同变量只出会话侧）；凭据库侧两种载荷形状都能读出 `envVar/name/scope`；`listRecords` 抛错时仍返回会话侧且 `ok:true`；读不回的 record 被跳过；响应 `JSON.stringify` 不含哨兵值。
5. `adopt`：合法 → 产生 staged 记录且响应无值；record 不存在 → 404 且**不产生** staged 记录；`resolve` 返回空 → 404；上限触顶 → 409；`credentials.resolve` 抛错 → 500 固定文案（不含上游文本）。
6. `AttachStore.onDrop`：TTL 与显式 `remove` 分别报 `'expired'`/`'removed'`；覆盖写（replaced）不产生多余的 drop 通知（旧计时器不得杀掉新记录——沿用既有 stored 身份判断）。
7. 需求 3 不回归：bound 时 `grants.size()` 与 grant 字段在 `release` 调用前后完全一致。

**A4 路由/协议**
1. 捕获 `registerSecretRoutes` 的注册表：路径集合 = 既有 5 条 + `history`/`available`/`adopt`；方法/`requestBody:'buffered'` 正确。
2. 三个新响应的字段集合被断言为白名单（无 `value`、无未知字段）。
3. `GET /api/secret.attached` 的响应与 0.2.1 逐字段相同（**冻结断言**）。

**A5 静态面**
1. `Select-String $R/src/client/entry.ts -Pattern '^\s*(import|export)\s'` → 0 命中（源码层）；`lib/client/entry.js` 同判据。
2. `Select-String $R/src -Pattern 'value'` 人工复核：值只出现在既有 P1–P6 位置；`history`/`available`/候选/节点 data 四处**零命中**。
3. `Select-String $R/src/client/entry.ts -Pattern 'position:fixed|inset:0'` → 0（不复活全视口面）。
4. `grep -c "conversation.chat.node"` 从 1 → 2（卡片 + 旁挂行）；`grep -c "conversation.input.left"` 仍 = 1；`grep -c "slash/input-insert-reference"` ≤ 1。
5. `$H` 侧机制复核脚本：把 A1 的 8 条路径/行号与内容摘要一起打印，人工比对（防「行号漂移」）。

**A6 机械三连（沿用 t2 verify）**

```
npm --prefix projects/cordis-plugin-secret run typecheck   # exit 0
npm --prefix projects/cordis-plugin-secret test            # 全绿，用例数只增不减（≥78）
npm --prefix projects/cordis-plugin-secret run build       # exit 0；lib/client/entry.js 无 import/export
npm --prefix projects/cordis-plugin-secret run build 后 git status 只允许出现 lib/ 的构建产物差异
```

### 7.1 B 段：需真人确认（或活体 DOM）

| # | 事项 | 判据（人工/活体） |
|---|---|---|
| B1 | 旁挂行出现在**该条消息下方**（不是上方、不是被折进「已调用工具」） | 活体：`[data-secret-attach-chip]` 的 `getBoundingClientRect().top` ≥ 同一 `data-chat-anchor-key` 气泡的 `bottom`；简洁/标准/详细/完全展开四种模式下都在 |
| B2 | 点旁挂行的胶囊 → 输入框上方的大胶囊展开 detail，显示变量名/作用域/状态，**无值** | 目视 + `textContent` 不含输入的值 |
| B3 | （若采纳 O1）点**原始**转录胶囊 → 右栏展开我们的详情页，不再出现「文件不存在」 | 目视截图；同时用 `document.querySelectorAll('[data-ref-chip="file"]')` 确认点的是原始胶囊 |
| B4 | （若采纳 O1）装/卸 `dsh-better-sidebar` 或注册一个更长的同档 pattern 时行为如何 | 目视 + 记录：我们被抢走时表现为对方的查看器/「文件不存在」，说明残余风险真实存在 |
| B5 | （若启用 O3）点原始胶囊 → 我们的输入框胶囊，且**不再**向 `sidebarRight.openResource` 发请求 | 目视 + Network/DOM 观察 |
| B6 | 信息框里的「历史记录」区能翻到本会话的：已登记、已绑定（带锚点）、已丢弃/已撤销、已回退失效 | 活体四条动作各做一次，再打开历史区逐条核对 |
| B7 | 撤销：删掉草稿里的胶囊 → 约 0.6s 后 `GET /api/secret.attached` 里该条目消失，历史区多一条「已随草稿移除撤销」 | 活体 + 手测 `GET attached` |
| B8 | 删掉又在 0.6s 内插回 ⇒ 记录**仍在**；间隔 5s 再插回 ⇒ 记录已撤销、菜单不再列出（session 作用域需重填值） | 活体，两条时序各一次（这也是 §8.1 第 4 条的验收素材） |
| B9 | **发送不触发撤销**：带胶囊发送后，记录变 bound（`GET attached` 报 bound），历史里没有 `withdrawn` | 活体，至少 3 次 |
| B10 | 刷新页面后草稿里的 `@VAR` 仍被装饰成可点引用，且**不触发**撤销 | 活体：刷新 → 等 2s → `GET attached` 仍是 staged |
| B11 | `@` 菜单里两项 section 的标题、每行的变量名 + 灰色凭据键 + 右侧来源/作用域文案都能读清、不被截断 | 目视截图（窄宽度下也要看一次） |
| B12 | `@` 菜单选「本会话可用」条目 → 草稿出现可点胶囊；选「凭据库（持久）」条目 → 弹出确认，不插任何东西 | 目视 + 草稿检查 |
| B13 | 确认后：变量在本会话的后续 shell 里可取到值（`$env:DSH_SECRET_X`），且值从未进入对话/日志 | 与第三轮 B6/B7 同法；另检 `$env:DSH_HOME/sessions` 下的日志 grep 哨兵 → 0 命中 |
| B14 | Host 重启后：历史为空、`available` 的凭据库 section 仍在（record 在盘上）、本会话可用 section 仅剩已 bound 且锚点仍 live 的 | 活体（重启由人类手动执行） |
| B15 | 四种会话形态都不炸：无会话 / `session-maybe` / 无 `sidebarRightTabs` / 无 `locale` | 目视：**不得**出现整页 boot 失败（第三轮 t7 的缺陷类型） |

---

## 8. 风险与未决

### 8.1 需要用户拍板（6 条，均已给出推荐）

| # | 问题 | 推荐 | 若不采纳的后果 |
|---|---|---|---|
| U1 | 路径组合：只要 O2，还是 O2+O1，还是再开 O3？ | **O2 + O1（可用时）**；O3 默认关 | 只做 O2：原始胶囊仍会打开不存在的文件（第三轮已知限制延续） |
| U2 | O1 的落点：详情出现在**右栏**（面板自动展开）是否可接受？ | 接受（这是唯一能修好「原始胶囊点得对」的官方路径） | 不接受 ⇒ 只剩 O3 能修原始胶囊，或维持已知限制 |
| U3 | O3 是否作为默认关闭的开关提供？ | 提供但默认关；README 明写非契约 | 不提供 ⇒ 用户体验上「点原胶囊」与「点旁挂行」行为不一致 |
| U4 | 撤销的代价：session 作用域的记录被自动撤销后**无法找回值**（要重填）；是否接受？ | 接受（撤销= 真实撤销），并把「删掉又插回」用 600ms 去抖覆盖 | 不接受 ⇒ 改成「惰性撤销」：宽限期内值保留但**不可绑定**，需要新增第三态与 Host 侧守卫，复杂度与语义成本都上升 |
| U5 | 「凭据库（持久）」条目的点击语义：先确认再从凭据库登记（推荐）还是直接登记并插入？ | 先确认（保留人类显式动作，符合「先 attach 成功、再插 chip」） | 直接登记 ⇒ 一次菜单点击就构成一次会话内的暴露授权，安全姿态变松 |
| U6 | 历史的边界：已失效/已回退/已丢弃是否展示？ | 全部展示并标注事件；`revoked` 只在被观测到时才出现（宁缺勿假） | 不展示 ⇒ 需求 2 的「集中查看历史」名存实亡 |

### 8.2 风险表

| 项 | 说明 | 处置 |
|---|---|---|
| R1 | O2 行序依赖「上下文键 = `${kind.length}:${kind}${id}`」+ 同 anchor 的 `key.localeCompare`（§2.3 O2-6/O2-7） | 取 7 字符 kind（`sr-chip`，实测排在 `13:input-message…` 之后）；A2.4 用一条性质测试钉住；A1.5 是看门狗 |
| R2 | 观测器挂在 overlay 条目里（空态返回 `null`）；若未来条目在空态不渲染，自动撤销静默失效 | 兜底 R2：不撤销（绝不误撤销）；README 写明；B10 活体确认 |
| R3 | O1 的 claim 是「同档比 pattern 长度」的竞争结果，`dsh-better-sidebar` 0.24.1 已占同档（§2.2 O1-7） | 用更长 glob + 严格 `canOpen`；把「后来者用更长 pattern 抢走」写成已知残余风险；B4 提供现场确认 |
| R4 | O3 的 DOM/委托耦合 | 默认关；只做只读式拦截（不改 DOM）；失效即回到今天的行为 |
| R5 | 撤销竞态：`pendingSubmissions` 信号若在某个 harness 版本里不再先行，会误撤销正在发送的记录 | 三重信号 + `phase` 守卫 + 600ms 去抖；B9 连测 3 次；若信号消失，A1.6 的看门狗触发重审 |
| R6 | `available` 的凭据库侧要逐条 `readRecord`（`listRecords` 不给 payload） | 上限 32 + 静默跳过读不回；错误不影响会话侧 |
| R7 | 需求 4 让 `candidates` 变为异步取数；`candidates` reject 时该组被静默移除（M11） | 取数失败回退到本地会话侧（C2）；`console.error` 只打来源名与事件名，不打内容 |
| R8 | 新路由扩大面：`adopt` 把「一次点击」变成「一次登记」 | 只接受本插件 record 内的 `persistent` 变量；仍需 `confirm` 态的人类动作；同信任围栏（loopback + 同源 + 签名 cookie） |
| R9 | 历史是纯内存态，Host 重启即空 | 明确写进 README 与 UI 空态文案（「本进程内暂无记录」），不虚报 |
| R10 | 索要方向（`secret_request`）也写入历史 | 只加一条写入调用；工具结果形状、卡片形状、pending 视图**一字不改** |

---

## 9. 由本定案直接决定的 t2 实施顺序

1. **Host 地基**：`src/history.ts` → `AttachStore.onDrop` → `protocol`（`reason`/`parseAdopt`/视图函数）→ `config` 两键 → `credentialsPort.listRecords/readRecord`；先让 `test/history.test.ts` 的存储/协议部分绿。
2. **Host 写入点与路由**：`service.attach/release/attachedViews/noteBound/complete` 写历史 → `available`/`adopt`/`historyFor` → `routes` 三条新路由 + `release` 透传 `reason` → `index.ts` 组装与 `session/disposed`；A3/A4 全绿（尤其「响应无值」与「bound 不写历史」）。
3. **Client 常量/纯函数/store**：`decideWithdraw`、`readHistoryList`、`readAvailableList`、`candidateRows`、`AttachedMeta.generation/seenPresent`；A2 的纯函数部分先绿。
4. **Client O2**：`secretAttachChipDefinition` + `SecretAttachChipRow` + 两处注册；A2.2/A2.3/A2.4 绿。
5. **Client 需求 3/4**：观测器（三信号 → 去抖 → release）→ `secretSource.onPick`/`candidates` → `confirm` 态与 `adopt` 调用。
6. **Client 需求 2**：历史区（`history` 态 + detail 小节 + fill 头部链接）。
7. **（若 U1/U2 通过）O1**：manifest inject + `sidebarRightTabs.register` + `sidebar.right.pane.tab` 正文；（若 U3 通过）O3 常量与拦截。
8. **SEAM v2 + README 四节**；`package.json` 只在 O1 时动 `dsh.client.inject`（**不动 version**）。
9. **三连**（typecheck / test / build）+ A5 静态判据 + A1 机制复核打印，报告里贴原始输出。
10. 把 §7.1 的 B1–B15 交给独立验证：**A 段全绿** + **B 段逐条给出人工结论或「未验证」**，不得推定。
