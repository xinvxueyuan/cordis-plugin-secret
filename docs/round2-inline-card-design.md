# 定案：secret_request 改为「会话流内一级卡片」

- 任务：`t1`（设计定案）· 轮次：round 2 · 基准运行版本：DSH `0.2.0-rc.2`
- 实施任务：`t2` · 独立验证：`t3` · 质量门：`t4`
- 视觉基准（用户已验收，直接复用，不重新设计）：`projects/cordis-plugin-secret-demo/client.js` 的 `CARD` 对象与 CSS。

本文件是可直接实施的定案：给出**机制结论 + 证据**、**文件级改动点**、**事件→节点状态机**、**客户端渲染状态机与兜底阶梯**、以及 **t3 可机械执行的验证清单**。

---

## 0. 结论摘要（一句话版本）

1. 卡片 = 插件自有 `ConversationNodeDefinition`（`kind: 'secret-request'`，`target: 'chat'`）+ `conversation.chat.node` 的 `key: 'secret-request'` 占位；
2. **`buildViewNode` 必须把节点的 `location` 覆写为 `{ kind: 'session' }`**（无 turn 坐标）。这是唯一能把自定义 kind 排除在「已调用工具」步骤进程分组之外、且在四档下都不被折叠的机制（第 2 节给证明链）；
3. **`tool.call.toolview` 的 `key: 'secret_request'` 注册一个恒返回 `null` 的占位**，用来替换泛型工具行（该 key 无其他占位者，泛型行只是 `renderSlot` 的 fallback）；
4. 待答状态**在 `tool/call` 阶段就 materialize 节点**（不等工具结果），表单数据来自「调用参数（durable）」+「Host 的 `/api/secret.pending`（权威且含可提交 id）」；
5. 结算状态**不解析散文**：给 `secret_request` 加 `output.presentationMeta`，把无明文的结算载荷写进 `tool/result.data.meta`（官方规定的"tool-private presentation payload，持久化且对模型不可见"），重放/刷新后卡片自证；
6. 「假过期」按语义重写：**非 2xx / 网络失败 / 解析失败一律不是"请求已结束"的证据**；只有「HTTP ok 且 (sessionId, callId) 确实不在等待列表」才收束，且**只降级为卡片内提示、永不消失**；已提交后不再有任何"过期"判定。

---

## 1. 范围与不变量

- 只做：交互形态改造（Client 半）+ 支撑它所需的最小 Host 侧字段/元数据 + 客户端假过期修复 + 测试/README。
- O1/O2 属于 `t2` 的合同（`service.ts`）。本定案只钉住它们的位置与不变量（第 7 节），不重复设计。
- 安全不变量（不得回退）：明文值只存在于卡片的 `<input>` 本地状态与一次 `POST /api/secret.answer` 的 body；不进入工具结果、异常消息、console、会话日志、URL、`meta`、DOM 属性或任何落盘文件。工具结果永远只给变量名。
- 运行版本锚定：所有"shipped 代码"证据来自 `@deepseek-ai/dsh-client-ui-{chat,tool,conversation}@0.2.0-rc.2`（`C:\Program Files\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` 与 `C:\Users\admin\.dsh\profiles\node_modules\@deepseek-ai\` 两处同版本）。

---

## 2. 机制结论 A：自定义 chat node 为什么**会**被折进「已调用工具」，以及如何逃出

### 2.1 事实链（全部逐行读过）

| # | 事实 | 证据（`@deepseek-ai/dsh-client-ui-chat/lib/client.js`） |
|---|---|---|
| A1 | 分组是硬编码集合：只有 `user/steering/turn-trigger/model-retry/turn-error/turn-max-tokens/turn-tail` 是"独立"的；**其它任何可见 node kind 一律进 `pending` → 成为步骤进程分组成员** | `10633` `const INDEPENDENT = new Set([...])`；`10790–10825` `TurnGroups.rebuild`：`INDEPENDENT.has(kind) ? flush+emit : pending.push(...)` |
| A2 | 分组体的折叠由展示档位决定，与 kind 无关 | `2289–2361` `ChatGroupSeat`：`grouped = stepGrouping === 'collapsed' \|\| (stepGrouping === 'history' && turn.status !== 'open')`；`2325` `bodyRef = useSearchableHidden(grouped && !open, reveal)` |
| A3 | 档位表：简洁/标准=`collapsed`，详细=`history`，完全展开=`none` | `12100–12129` `POLICIES` |
| A4 | 节点自身还会被 Turn-process 隐藏：`processMember` 只看 kind 是否在 `TURN_PROCESS_INDEPENDENT_KINDS`、anchorSeq 与 spec 的关系，**不看 location** | `1518–1527`；`1689` `processMember = ...`；`1709` `processHidden = foldable && processMember && !processOpen` |
| A5 | 但 **turn 坐标缺失的节点不是 process member**：presentation 由 `nodeTurn(node)` 派生，无 turn ⇒ `undefined` ⇒ `processWindowReady=false` ⇒ `processMember=false` | `7793–7796` `nodeTurn`；`7843–7846` `ChatTurnProcessProjector.get`；`1688–1689` |
| A6 | **turn 坐标缺失的节点是 flow 根条目**（直接进 `entries`，不在任何 group 内） | `10936–10951` `ProcessState.rootEntries`：`readPosition(key).turn === undefined → [{kind:'node',key}]`；`5091–5108` `ChatNodeList` 无差别渲染 node 条目 |
| A7 | 无 turn 坐标的判定就是 location 本身 | `8184–8191` `locationCoordinates`：非 `step`/`turn` ⇒ `{}`；引擎自己的回退值就是 `{kind:'session'}`（`dsh-client-ui-conversation/lib/client.js:1376` `SESSION_LOCATION`） |
| A8 | 官方 `chatNode()` 辅助函数**显式支持覆写 location** | `7211–7222` `chatNode(context, kind, anchorSeq, data, options)`：`location: options.location ?? contextLocation(context)` |
| A9 | 引擎对 `buildViewNode` 的返回值只校验 key/target，不校验 location | `dsh-client-ui-conversation/lib/client.js:2436–2443` |

### 2.2 结论

- **只用自有 kind 注册 `conversation.chat.node` 是不够的**：该 kind 不在 `INDEPENDENT` 里 ⇒ 它是步骤进程分组成员 ⇒ 简洁/标准（以及详细档下的已结束 turn）默认被折叠 ⇒ 违反「四档下都可见」「不在分组内」。参照实现 `@nanmicoder/dsh-agent-teams` 正是这个形状，所以它的 chat-node 卡片在 turn 关闭后 **return null**，改由 `conversation.chat.turnTail`（INDEPENDENT 的 `turn-tail` 节点的子槽）再画一张 —— 这是它绕开折叠的代价，我们不能照抄（turnTail 只在 `turn/end` 之后才 materialize，待答期间根本不存在）。
- **唯一非破坏性的逃逸路径**：`buildViewNode` 返回节点时把 `location` 覆写为 `{ kind: 'session' }`。于是：`locationCoordinates → {}`（A7）⇒ `rootEntries` 直接把节点作为一级条目输出（A6）⇒ 不是任何 group 的成员（A1/A2 与它无关）⇒ `nodeTurn` 为 undefined ⇒ 永远不是 process member（A5）⇒ 四档下都可见。全程只依赖 shipped 代码里**已存在**的分支（根条目、location 覆写、`SESSION_LOCATION`），无 hack、无 monkey-patch、无对被冻结对象的写入。
- 明确的代价（可接受）：卡片不再属于某个 turn 的导航/滚动锚（不影响可读性）；`turnProcess` prop 为 `undefined`（我们本来也不用它）。
- **排位**：`anchorSeq` 取 `tool/call` 事件的 seq。根条目按 anchorSeq 与其它根条目排序（`orderedVisibleChatNodes`：无 turn 坐标时 `rank 0`，`8234–8238`）。因此卡片紧贴"包含本工具行的那个分组"渲染（分组根条目的锚点 ≤ 调用 seq，故卡片通常在其**之后**；当工具行是该 turn 的第一个可见进程成员且 contextKey 参与 tie-break 时可能在其**之前**——两种顺序都是"调用位置上的一级条目"，都不在分组内）。tl3 只验证"不在分组内 + 可见"，不绑定"必须在其后"。

---

## 3. 机制结论 B：同一次调用如何避免两个竞争面

- 工具行来自 `dsh-client-ui-tool/lib/client.js:1856–1871`：
  `renderSlot('tool.call.toolview', owner, { entryKey: toolName, hookContext, fallback: <GenericToolCard/> })`。
  即：**该 key 没有占位者时**才渲染泛型工具行；**keyed 命中即替换**（同文件 `:74–82` 注释明说 "a keyed hit REPLACES the generic row"）。
- 决策：注册 `tool.call.toolview` + `key: 'secret_request'` 的占位组件 `HiddenSecretToolRow`，函数体恒 `return null`。
  - 槽契约允许任意工具名（`dsh-client-ui-tool/lib/types/client/contract/slots.d.ts:9–25`："Any name is allowed … unclaimed keys use the generic row"）。
  - `priority` 用默认 0，且**不参与本决策**：`tool.call.toolview` 是 keyed 槽，**一个 key 只保留一条条目、后来注册者替换前者**。活体证据：该槽上 `secret_request` 一直是单条条目——demo 加载前是 `priority:0`，加载后变成 demo 的 `priority:1`；两条观察都是"同 key 单条"，中间只发生了替换。排序确实是升序（`dsh-client-ui-slots/lib/index.js:221`），但那是同格多条目时的次序，不是本槽的替换机制；demo 里 `priority: 1` 那句"outrank"注释因此是误导，本定案不复制它。
- **抑制工具行不会让请求变得不可见或不可回答**，理由是可分层证明的：
  1. 可见性/可答性由**卡片节点**拥有，它由同一个 `tool/call` 事件 materialize（第 4 节），与 `tool.call.toolview` 的注册**无数据依赖**：占位组件是纯 `null`，没有逻辑、没有状态、不参与任何判断。
  2. 占位**加载失败**（例如 ui-tool 未装载 ⇒ `slots.inject` 永远等不到声明）只会退化成"泛型工具行重新出现"＝多一个面，**不会**让请求消失。
  3. 反向失败（卡片没渲染出来）由第 6 节的兜底阶梯覆盖；两者互不依赖，不存在"共同失败点"。
- 残留的 harness 原生面（**必须如实承认，不得声称"全流只有一个字符"**）：
  - 步骤进程分组的**标题行**仍会把本次调用计入 `tools` 计数，并可能把调用参数里的 `description`（或退化为 `name`）当作 live 细节显示（`dsh-client-ui-chat/lib/client.js:10575–10618`，`liveToolDetail` 的 key 表 `10521–10544`）。这是所有工具共有的既有 chrome，非交互面、不含明文值、插件无权改判（`activity()` 是硬编码表 `10494–10518`，`secret_request` 落 `tools`）。
  - 判定标准因此是：**"只有一处可见的交互卡片面"** + "任何位置不出现明文值"，而不是"工具名/参数文本一次都不出现"。

---

## 4. 事件 → 节点状态机（ConversationNodeDefinition）

```ts
const CARD_KIND = 'secret-request'
const TOOL_NAME = 'secret_request'
const SESSION_LOCATION = Object.freeze({ kind: 'session' })   // 稳定引用，保证 identity 不抖动
```

| 事件 | match | role | 状态迁移 |
|---|---|---|---|
| `tool/call` 且 `data.name === 'secret_request'` | `{ id: String(data.callId), role: 'start' }` | start | `start()`：`state = { callId, request: parseCallRequest(data.arguments), settled: false, outcome: null, failure: null }`（`parseCallRequest` 失败 ⇒ `request: null`，仍然建节点） |
| `tool/result`（`data.message.source.kind === 'tool'`） | `{ id: String(data.message.source.callId), role: 'update' }` | update | `update()`：`settled = true`；`outcome = readMeta(data.meta)`；`failure = data.message.isError ? { name: data.error?.name, code: data.error?.code, reason: data.error?.reason } : null`；与本次调用无关的 result（无 start 的 update）由引擎丢弃（`dsh-client-ui-conversation/lib/client.js:2181–2208`：role=update 且 `context.start === undefined` ⇒ 不建 state，`buildViewNode` 返回 null） |
| 其它事件 | `null` | — | 无 |

`buildViewNode(context)`（**永不返回 null**，只要 `context.start !== undefined`）：

```ts
return {
  key: context.key,              // 必须 === context.key（引擎校验，:2440）
  kind: CARD_KIND,
  id: context.id,
  target: 'chat',
  anchorSeq: context.start.event.seq,
  location: SESSION_LOCATION,    // ← 见第 2 节：逃出步骤进程分组的唯一手段
  visibility: 'visible',
  data: context.state,           // 纯 durable 事实；不含任何交互态、不含明文值
}
```
可选优化（对齐 shipped 写法）：若与 `context.current.get('chat')` 的 `data/anchorSeq/visibility/location` 完全一致，返回旧节点以保持引用稳定（`dsh-client-ui-tool:9798`）。

**状态必须是事件的纯函数**（刷新/重放可重建）：交互态（Host 视图、草稿、提交中、错误）一律放组件本地 state，不进 `node.data`。

Host 侧同期改动（唯一原因：卡片需要按 callId 认领自己的那条等待请求）：

- `src/types.ts`：`PendingView` 增加 `readonly callId: string`、`readonly sessionId: string`；新增值无关的 `SecretPresentationMeta` 类型。
- `src/pending.ts`：`PendingRequest` 增加 `callId`、`sessionId`。
- `src/protocol.ts`：`pendingView()` 原样带出这两个字段（只做类型/字符串校验，不做拼接）。
- `src/service.ts`：`this.pending.add({ ..., callId: caller.callId, sessionId: String(session.id) }, ...)`。
- `src/tool.ts`：新增 `output.presentationMeta(args, value)`，返回
  `{ v: 1, kind: 'secret-request', decision, variable, scope, source, notice? }`（rejected/ignored/other 只带各自字段）。
  该载荷由 `@deepseek-ai/dsh-tools` 直接持久化到 `tool/result.data.meta`（`dsh-tools/lib/types/index.js:1203–1221`；字段语义见 `dsh-session/lib/types/types.d.ts:361–388`：「tool-private presentation payload… durable log reproduces the identical card on replay」），**不是模型内容**、不改变 `render()` 的模型可见文本。

---

## 5. 客户端渲染状态机（组件本地）

阶段（`internal`，覆盖 demo 的三相位）：

| 内部阶段 | 触发 | 外观（复用 demo） |
|---|---|---|
| `preparing` | 有节点、`settled === false`、Host 视图尚未认领 | 展开态骨架 + 标题/理由/范围（来自调用参数）+ 底部状态行「正在登记本次授权请求…」，四个决策按钮 **disabled** |
| `linked` | `settled === false` 且 Host 视图已按 (sessionId, callId) 认领 | 展开态完整表单（= demo 的 `start`）：理由、补充说明、范围单选 + 「持久 / 仅本次会话」显式标注与当前选择提示、掩码输入 + 显示/隐藏、同意/拒绝/忽略/其他 + 其他自由文本 |
| `submitted` | 本卡片 POST 成功、`settled === false` | 表单就地置灰 + 「已提交，等待 Agent 继续…」；**不再有任何过期判定** |
| `settled` | `settled === true` | 折叠摘要（= demo 的 `result`）：同意→`已授权 · DSH_SECRET_X · 持久/仅本次会话`；拒绝/忽略/其他→各自语义；失败→按 `error.code` 给文案；可展开为只读回看 |

数据来源优先级：**Host 视图（`linked` 时）> 调用参数（durable fallback）> 空**。变量名展示：Host 视图的 `variable` 优先；未认领时按 `effectiveEnvVar` 的同规则本地推导（`envVar ?? 'DSH_SECRET_' + name.replace(/[-_]+/g,'_').toUpperCase()`），并由测试钉住两者一致（第 8 节 T7）。

轮询（模块级共享 store，非每卡一个 interval）：

- 参与者引用计数：只有"存在 `settled === false` 的卡片"时才发请求；全部结算后停止。
- 间隔自适应：`ok → 1200ms`；`unreachable → ×2，封顶 8000ms`；恢复 ok 立即回到 1200ms。
- `visibilitychange`（页面隐藏）时暂停，重新可见时立即补一次（可选但推荐，减少后台噪声）。
- 请求体/回答体与现有实现完全一致（`GET /api/secret.pending`、`POST /api/secret.answer`，`credentials:'same-origin'`）。
- **认领规则**：主键是 `callId`（唯一）；`sessionId` 只在两侧都存在时作为附加收紧（写成 `entry.callId === callId && (sessionId === undefined || entry.sessionId === sessionId)`）。这样即使 slot 标准 props 里的 `sessionId` 在某些组合下缺失，卡片仍能认领。
- **顺带修掉的旧缺陷**：旧 overlay 只渲染 `requests[0]`，多个并发请求时其余请求不可见/不可答；按 callId 认领后，每个请求由自己的卡片承载，天然并行可答（`maxPendingRequests` 默认 4）。
- **刷新即恢复**：Host 侧 pending 记录仍在时，刷新页面后卡片重新认领、继续可答；已结算的调用由重放的 `tool/call + tool/result` 直接重建折叠摘要（草稿类交互态重置属预期）。

**假过期修复的规范化判定**（纯函数 `nextPendingState(...)`，可被 t3 机械测试）：

```
输入：fetch 结果 { httpOk, status, body } 或 { unreachable }；本地 submitted 布尔
- unreachable（网络错误 / 非 2xx / JSON 解析失败）→ 'unreachable'：保留表单，只显示"暂时无法连接宿主，正在重试"
- httpOk 且 (sessionId, callId) 命中 → 'linked'
- httpOk 且未命中：
    submitted === true  → 'awaiting-result'（等待工具结果，绝不判过期）
    submitted === false → 'lapsed'（卡片内提示"宿主已不再等待本次请求"，表单转只读；节点仍在，若之后到达 tool/result 则正常结算）
- 兼容路径：pending 列表里**所有**条目都没有 callId 字段（客户端新、Host 旧）且恰好只有 1 条 → 认领它（等同旧 overlay 的语义，但仅限唯一一条），保证版本错配时"仍然可答"
```

---

## 6. 兜底阶梯（"卡片构建失败 / 状态缺失时请求仍可见且可回答"）

| 编号 | 失效场景 | 设计行为 |
|---|---|---|
| F1 | 调用参数 JSON 不可解析 | `buildViewNode` 仍返回节点（`request: null`）。卡片渲染：标题用工具名、`用途` 段落显示"参数无法解析"，并持续轮询；Host 视图到达后用**权威数据**渲染完整表单 → 可见且可答 |
| F2 | 组件内部读到未知/缺字段 | 组件全程防御式读取（每个字段取前判类型），任何未知载荷退化为最小卡片，不抛异常（脚本型 Client 半没有错误边界，只能靠不抛） |
| F3 | Host 不可达（网络/非 2xx/解析失败） | 表单可见、按钮 disabled + 就地状态行 + 退避重试；**不关窗、不判失效**（= 假过期修复） |
| F4 | HTTP ok 且本请求不在等待列表（未提交） | `lapsed`：卡片内提示，表单转只读；节点保留；后续 `tool/result` 到达即正常结算 |
| F5 | 已提交但工具结果迟迟不到（> requestTimeout + 30s） | 显示"结果未到达（宿主可能已重启）"，卡片保留，不再重试提交 |
| F6 | `tool.call.toolview` 占位未生效/未加载 | 泛型工具行重新出现（多一个面），卡片仍在且可答；只增不减 |
| F7 | Chat UI 包缺失（无 `conversation.chat.node` / `uiConversation`） | `dsh.client.inject` 声明这三个包 ⇒ 该环境下 Client 半整体不 apply，行为等同"没有 Web UI"（工具超时失败闭合）。**不保留 shell.overlay 退路**（t2 验收明确要求不再存在全视口遮罩） |
| F8 | 已结算但既无 `meta` 也无 `error`（例如 PTC/嵌套调用不投影 `presentationMeta`，或旧日志） | 卡片显示"已结束（未记录结算细节）"，仍保留调用参数、理由与范围，绝不回退成"空白面"；模型侧语义不受影响 |

---

## 7. 文件级改动点

| 文件 | 改动 |
|---|---|
| `src/client/entry.ts` | **重写**（仍是单文件、无 import/export 的 classic script）：常量（`SESSION_LOCATION` / `CARD_KIND` / `TOOL_NAME` / 路径 / 轮询参数）；纯函数 `parseCallRequest`、`readMeta`、`readFailure`、`nextPendingState`、`deriveEnvVarForDisplay`；`secretRequestDefinition`（第 4 节）；轮询 store（第 5 节）；`SecretRequestCard`（复用 demo 的 `CARD` 外壳/CSS/文案与"调用中展开 / 结算后折叠"）；`HiddenSecretToolRow`（`return null`）；`apply(ctx)` 三处注册：`ctx.uiConversation.events.register(def)`、`ctx.slots.inject('conversation.chat.node', … key: 'secret-request')`、`ctx.slots.inject('tool.call.toolview', … key: 'secret_request')`；`inject: ['slots', 'uiConversation']`；**删除** `shell.overlay` 注册、`firstView/waitingIds`、`NOTICE_MS`/`expired`/`dismiss` 等 overlay 专用代码；`declare module '@deepseek-ai/dsh-client-ui-chat/client' { interface ChatNodeDataMap { 'secret-request': SecretRequestCardData } }`（**ambient 形式，已实测可编译**：`tsc -p tsconfig.client.json` exit 0 且产物无 import/export） |
| `src/tool.ts` | 新增 `output.presentationMeta`（第 4 节）；`render()` 与模型可见文本**不变** |
| `src/types.ts` | `PendingView` += `callId`、`sessionId`；新增 `SecretPresentationMeta` |
| `src/pending.ts` | `PendingRequest` += `callId`、`sessionId` |
| `src/protocol.ts` | `pendingView()` 带出两字段 |
| `src/service.ts` | `pending.add({ ..., callId: caller.callId, sessionId: String(session.id) })`；**O1/O2 修复就在本文件**（t2 合同）：`converse()` 里 `recorded()` 与 `attempt.status === 'failed'` 的判定次序、persistent 超时要呈现为 `TIMEOUT` 而非被包装成 `AUTHORIZATION_FAILED` |
| `package.json` | `dsh.client.inject`：`['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-tool']`（containers 由这三个包声明：`conversation.view → conversation.chat.node` 由 ui-chat 声明 `client.js:12390–12407`；`tool.call.toolview` 由 ui-tool 的 `conversation.chat.node` 条目 children 表声明 `:4554–4564`）。`files` 不含 `docs/`，本设计文档不会进入 npm 包体 |
| `test/client-card.test.ts`（新） | 见第 8 节 T1–T8 |
| `test/unit.test.ts` / `test/register.test.ts` | 追加：`pendingView` 带 callId/sessionId；`presentationMeta` 覆盖四种决策且无明文；既有 32 条断言不得删改 |
| `README.md` | 交互形态章节改写：流内一级卡片、无全视口遮罩、四档可见、分组逃逸的原因与兜底；安全不变量章节保持不变 |

**测试可达性（关键工程约束，务必遵守）**：Client 半是 classic script，**不能有 import/export**，所以它的纯函数无法被 `import` 直接测试。因此在本文件里放置一个**显式的、只读的测试缝**：

```ts
;(globalThis as any).__cordisSecretClient = Object.freeze({
  version: 1, parseCallRequest, readMeta, readFailure, nextPendingState,
  secretRequestDefinition, HiddenSecretToolRow, CARD_KIND, TOOL_NAME,
})
```
该对象不含任何明文、不含交互态、不改变行为，只用于测试/诊断；测试通过 `globalThis` 读取（第 8 节 T1–T4 的写法见 T0 引导）。若 captain 认为页面全局不可接受，可改为"仅 grep 级断言"，但 `t3` 的第 3、7 条验收将退化为代码阅读而非机械复现——不建议。

---

## 8. t3 机械执行清单

> 约定：`$R = projects/cordis-plugin-secret`。每条给出**命令**与**判据**；判据不成立即 fail。需要浏览器/DOM 的条目单独标注为"活体（条件）"，无法执行时必须如实标注"未验证"，不得推定通过。

### T0 客户端测试引导（所有客户端断言的公共写法，确定可行）

单文件、无依赖、Node 原生跑 TS（仓库既有 `node --test test/*.ts` 已经这么跑）：

```ts
const loaded: any[] = []
;(globalThis as any).__ModuleLoader__ = { load: (r: unknown) => loaded.push(r) }
await import('../src/client/entry.ts')                    // 只为触发 loader.load 副作用
const mod = loaded[0].factory((name: string) => stubReact) // stub require
const api = (globalThis as any).__cordisSecretClient       // 测试缝

// 用假 ctx 跑 mod.apply，捕获三处注册（这也验证了注册形状本身）：
const definitions: any[] = []
const registrations: { name: string; component: unknown }[] = []
mod.apply({
  uiConversation: { events: { register: (def: any) => definitions.push(def) } },
  slots: {
    inject: (_owner: string, declare: () => unknown) => declare(),   // 立即执行，等同"槽已声明"
    register: (options: any, component: unknown) => registrations.push({ name: options.name, ...options, component }),
  },
})
```
`stubReact` 只需 `{ createElement, useState, useEffect }`（不渲染时的最简对象）。
断言 `definitions` 恰 1 个、`registrations` 恰 2 个（`conversation.chat.node` + `tool.call.toolview`，后者 `key === 'secret_request'`）。

### T1 无重复面（静态 + 单元）

1. `Select-String -Path $R/src/client/entry.ts -Pattern 'shell\.overlay|position: *''fixed''|inset: *0|pointerEvents'` → **0 命中**（`shell.overlay`、fixed 定位、整屏 pointerEvents 全部消失）。
2. `grep -c "tool.call.toolview" src/client/entry.ts` → 恰好 1 处注册，且 `key: 'secret_request'`；`api.HiddenSecretToolRow({} as any)` **返回 null**。
3. `grep -c "conversation.chat.node" src/client/entry.ts` → 恰好 1 处注册，`key: 'secret-request'`；`api.TOOL_NAME === 'secret_request'`。
4. `grep -c "conversation.composer" src/client/entry.ts` → 0（不占用输入框）。
5. 机制引用（人工复核一次即可，用于结论落地）：ui-tool `:74–82`/`:1856–1871` 证明 keyed 命中替换泛型行；`entriesOfSlot`（slots 包 `lib/index.js:278–293`）证明每格取唯一存活者。
6. 残余面如实记录：进程分组标题仍会统计该工具并可能显示 `description`/`name` 文本（chat `:10575–10618`）——**不算第二个交互面**，但必须在 verdict 里写明。

### T2 四档模式下均位于分组之外（结构证明 + 单元；活体为条件项）

1. **结构证明（必做）**：逐行引用并复核第 2.1 节 A1/A4/A5/A6/A7/A8 —— 判据是"无 turn 坐标 ⇒ 根条目 + 非 process member"两个分支确实存在于 shipped 代码中（给出 file:line 与代码片段）。
2. **单元（必做）**：对 `api.secretRequestDefinition` 造 4 个事件（`tool/call`、成功 `tool/result`、错误 `tool/result`、参数不可解析的 `tool/call`），断言每次 `buildViewNode(...)` 的返回值满足：
   - `node.location.kind === 'session'`（**这是逃逸的全部依据**）；
   - `node.kind === 'secret-request'`、`node.target === 'chat'`、`node.key === context.key`；
   - `node.anchorSeq === <tool/call 事件 seq>`；`node.visibility === 'visible'`；
   - 任一阶段 `!== null`（不是只在有结果时才出现）。
3. **活体（条件）**：`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, root="conversation.chat.node")` → occupants 含 `{key:"secret-request"}`；`root="tool.call.toolview"` → occupants 含 `{key:"secret_request"}`；`root="shell.overlay"` → 没有 `cordis-plugin-secret` 的占位。若 Client 桥超时，如实标注"未验证"。
4. **活体 DOM（条件，推荐）**：在四种"工作步骤展示"档位各切一次，对卡片元素执行
   `const el = [...document.querySelectorAll('[data-chat-node-key]')].find(n => n.dataset.chatFlowKind === 'secret-request')`；
   断言 `el.closest('[data-step-process-body]') === null`、`el.getBoundingClientRect().height > 0`、`getComputedStyle(el).display !== 'none'`，四种档位全真。可用 `opencli-browser` 技能驱动真实 Chrome 执行；无法执行则标"未验证"。
5. **不遮挡（必做，静态）**：卡片渲染路径不含 `fixed/inset:0`；`data-step-process-*` 之外无整屏容器；CSS 里 `pointerEvents` 仅出现在按钮（若有），不在任何全屏容器上（T1.1 已覆盖）。

### T3 待答请求始终可见且可答（单元 + 既有测试）

1. `settled === false` 时 `buildViewNode` 非空（T2.2 已断言）——即 `tool/call` 阶段就 materialize，不依赖工具结果。
2. 表单可达性：以桩 React 单次渲染 `SecretRequestCard`（`useState` 桩返回初值、`useEffect` 桩不执行），断言描述树里同时存在：理由段落、`持久保存到凭据库` 与 `仅本次会话有效` 两个范围选项、`type:"password"` 的输入、显隐切换按钮、`同意/拒绝/忽略/其他` 四个按钮，以及"其他"模式下的 textarea。
3. 参数不可解析的兜底：用 `request: null` 的 node 渲染，断言**不抛异常**且卡片根元素仍存在（F1）。
4. 版本错配兼容：`nextPendingState` 在"列表所有条目都无 callId 且仅 1 条"时返回 `'linked'`（F/兼容路径）。
5. 既有 6 条已验收行为不回归：四选一语义、范围改写如实回报、掩码 + 显隐、拒绝不回显输入、工具结果只给变量名、无全视口遮罩（`npm test` 全绿 + T1.1）。

### T4 假过期修复（机械复现，必做）

1. `api.nextPendingState({ unreachable: true }, { submitted: false })` → `'unreachable'`，**且** 不返回 `'lapsed'`/`'expired'`；
   `api.nextPendingState({ httpOk: false, status: 500 }, …)` → `'unreachable'`；
   `api.nextPendingState({ httpOk: true, body: NOT_JSON }, …)` → `'unreachable'`。
2. `api.nextPendingState({ httpOk: true, body: { requests: [] } }, { submitted: false })` → `'lapsed'`（唯一可以被判"宿主不再等待"的输入）；
   同输入但 `{ submitted: true }` → `'awaiting-result'`（提交后永不判过期）。
3. `api.nextPendingState({ httpOk: true, body: { requests: [entry] } }, …)` → `'linked'`（无论是否已提交）。
4. 兼容路径：`requests: [{id, callId 缺失}]` 且仅 1 条 → `'linked'`。
5. 正向对照（避免空真空结论）：把 1 里任一调用的 `unreachable` 换成 `httpOk:true, body:{requests:[]}`，其结论必须**改变**为 `'lapsed'`。

### T5 明文值不出现（必做）

1. `npm test` 全绿，既有"值不进入返回值/异常/落盘"断言一条不删。
2. `JSON.stringify(api.secretRequestDefinition.buildViewNode(settledContext))` 中不含任何被测试驱动的哨兵值；`presentationMeta` 的返回值对四种决策都不含 `value` 字段（新增单测：`tool.output.presentationMeta(args, value)` 逐字段断言）。
3. 源码面：`Select-String $R/src/client/entry.ts -Pattern 'console\.|JSON\.stringify'` → 只允许出现在**不含值**的路径（判据：值只在 `submit()` 的局部变量与 POST body 中出现，`setValue('')` 之后不再持有）。
4. DOM：`<input type="password">` 之外无任何 `data-*`/`title`/`aria-label` 携带值（活体条件项；静态侧断言卡片不把 value 放进属性）。

### T6 机械三连（沿用 t2 verify，不新增未验证命令）

```
npm --prefix projects/cordis-plugin-secret run typecheck   # exit 0
npm --prefix projects/cordis-plugin-secret test            # 全绿，测试数 ≥ 32（只增不减）
npm --prefix projects/cordis-plugin-secret run build       # exit 0，lib/client/entry.js 无 import/export
```

### T7 命名一致性（漂移防护）

客户端本地推导的展示变量名必须与 Host 的 `effectiveEnvVar` 一致：
对 `[{name:'openai'}, {name:'openai-key'}, {name:'openai_key'}, {name:'x', envVar:'DSH_SECRET_CUSTOM'}]` 逐条断言
`definition.start(...).request.variable === effectiveEnvVar(input)`（Host 函数在测试里可直接 import）。

---

## 9. 风险与未决项

| 项 | 说明 | 处置 |
|---|---|---|
| R1 | 自定义 kind 依赖 `location` 覆写这一"官方辅助函数支持、但 shipped 定义未使用"的路径 | 已在第 2 节逐行证明分支存在；若未来 rc 版把 `rootEntries` 改成按 turn 强绑定，需要重新定案（t3 的 T2.1 就是这条的看门狗） |
| R2 | 卡片排位是"紧邻分组"，不保证在分组之后 | 已明确验收只要求"不在分组内 + 四档可见"；若用户要求严格在其后，需要在 `anchorSeq` 上加合成偏移（可用，但要新增验证） |
| R3 | 进程分组标题可能回显 `description` | 属 harness 既有行为；README 与本文件如实记录 |
| R4 | 无 DOM 自动化时"四档可见"只能结构证明 | T2.4 给了 opencli-browser 的具体做法；否则如实标注未验证 |
| R5 | 可选：placement 探针（卡片把自身 `closest('[data-step-process-body]')` 结果 POST 回 Host 并写日志）可把 T2.4 变成完全机械可证 | **本定案不默认实施**；若 captain 要求"无人工介入的 DOM 级证据"，再单独批准（约 25 行 + 1 个只读路由，载荷仅 callId/布尔/档位） |

## 10. 由本定案直接决定的 t2 实施顺序

1. Host 侧字段与 meta（`types/pending/protocol/service/tool`）→ 先让 `npm test` 绿；
2. `src/client/entry.ts` 重写（定义 → store → 卡片 → 两处 slot 注册 → 删 overlay）；
3. `package.json` 的 `dsh.client.inject`；
4. 新增 `test/client-card.test.ts`（T0 引导 + T2.2/T3/T4/T7）；
5. README；
6. 三连（typecheck / test / build），并在报告里贴原始输出。
