# 定案（已实施）：密钥键可选 + 后台 AI 命名 / 粘贴按钮 / 粘贴命中隐私规则转胶囊 / 胶囊 ✕＝解绑 / 选区「转为密钥」

> **实施状态（0.5.0）**：本文各项**已全部落地**（R1–R5；代码由 0.5.0 的开发任务实现与提交，本文只补事实登记）。**上文原始结论一律保留为历史依据**，落地/差异/被取代逐条对照见文末 **§12 实施结果（0.5.0）**；被实现取代的命名（`looksLikeSecret` → `classifyPastedText`）在该节明确标注。
> **唯一仍需真人验证的是 §11 的 C 方案**（契约外 `selectionchange` 实时文案）：注册层在本套件里未经执行验证、也从未在活体 DOM 验证 ⇒ **需真人确认**；见 §12.7 与 README「已知限制」。
>
> 体例沿用第三/四/五轮定案：**机制结论 + file:line 证据** → **定案形态与逐字契约** → **状态机与时序** → **文件级改动点** → **兜底阶梯** → **验证清单（区分「可机器证明」与「需真人确认」）** → **风险与未决（含需用户拍板项）**。
> 本文只新增文档，不改任何 `src/`、`test/` 代码。
> 约定：`$R = projects/cordis-plugin-secret`；`$H = C:\Program Files\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`（下文非 `$R` 的路径都在该目录下）。行号是 0.4.3 工作树（`git status` 干净）的实测——**实施 0.5.0 后行号已漂移，引用时以语义为准**。

---

## 0. 结论摘要（每条指向第 2 节的证据）

| # | 需求 | 结论 | 一句话依据 |
|---|---|---|---|
| R1 | 密钥键可选 + **消息发出后**后台 AI 命名 | **可行**，且宿主**自带一个正好干这件事的机制**；但「命名结果写到哪」有一个必须用户拍板的岔路（见 §3.1 / §8 U1） | `ctx.llm.stream(GenerateOptions)` 是**无会话、纯流式**的模型调用面，`sessionId?` 可选、有 `purpose:'session-title'`，且 `@deepseek-ai/dsh-session-title-llm` 就是这条路上的第一方先例 |
| R1 | 命名调用**不进会话上下文** | **成立**，机制上三重保证 | `llm` 服务只有「适配器注册 + 模型信息 + stream」，**没有任何写入会话的方法**；`sessionId` 可选；第一方先例若要把请求记进日志必须**显式** `session.append('session/title-llm-request', …)`，而该事件被格式层明确排除在消息序列之外 |
| R1 | 「尽量关闭思考或最低档」 | **宿主已内置该行为** | DeepSeek 适配器在 `purpose === 'session-title'` 时**强制** `effort = 'off'`（`dsh-llm-deepseek/lib/index.js:1694`） |
| R2 | 所有输入框右侧加「粘贴」按钮 | **部分可达**：输入区有官方右侧座位 `conversation.input.right`；**插件自己的**输入框可自定义；**其它插件/宿主的**输入框没有通用座位（见 §3.2 / §8 U2） | `slots.d.ts:234-238` 声明 `'conversation.input.right'`（kind `list`、scope `session`），由 `ComposerBarProps` 渲染（`:489`） |
| R2 | Clipboard 可用性 | **可用**，但必须处理被拒绝 | 已发布产物里就有 `navigator.clipboard.readText()` 的**点击内调用 + try/catch + console.warn + 兜底**（`dsh-client-ui-sidebar-documentpreview/lib/client.excel.js:130169-130183`）；本机 GUI 是 loopback（默认端口 3080），属可信来源 ⇒ 安全上下文 |
| R3 | 值输入框粘贴命中隐私规则即真登记并转胶囊 | **可行**，且**不需要任何模型** | 走既有 `POST /api/secret.attach`（stage）链路 + 既有 `insertChip` 插入阶梯（`entry.ts:3144`）；分类在页面本地完成，明文仍只在 P1/P2 |
| R4 | 胶囊尾部 ✕ ＝**解绑** | **落点是我们自己的消息旁胶囊行**；✕ 必须**按状态分流**：`staged` 走既有 `release`，`bound` 走 0.4.0 的 `manage unbind` | `release` 对已绑定的项**拒绝删除**（`service.ts:552` 返回 `{released:false, state:'bound'}`），而 `grants.unbind`（`service.ts:1180`）才是「从本会话移除、凭据库不动」 |

---

## 1. 范围与不变量

### 1.1 本轮只做（全部是加法）

1. **R1**：附加胶囊的填值面里，`name`（密钥键）字段**移到 `label`（标题）下方**并改为**可选**；为空时在消息发出后由**当前会话配置的模型**在后台自动命名。
2. **R2**：输入区右侧（`conversation.input.right`）与**本插件自有**的输入框上，加一个 `type="button"`、`aria-label="粘贴"` 的 suffix 动作按钮。
3. **R3**：填值面的**值输入框**上装 `onPaste` 拦截：命中隐私过滤规则 ⇒ 走真实登记链路 ⇒ 插入标记胶囊并清空输入框。
4. **R4**：消息旁胶囊行的每个变量胶囊尾部加一个默认隐藏的 ✕（`hover` / `focus-within` / 触屏媒体查询显示），点击＝**解绑**。

### 1.2 不做（明确排除）

- 不改 `secret_request` / `secret_manage` 的**工具参数面**（本轮不新增工具参数，也不新增工具）。
- **不收紧任何工具 schema 的参数根**（理由见第四轮 F2 裁定：参数根是隐式开放根，承重拒绝在服务侧）。
- 不做「全局给所有第三方输入框注入按钮」的 DOM 猴补丁（见 §3.2 的证据与 §8 U2）。
- 不做移动端的长按手势状态机（改用 CSS 媒体查询默认显示，成本 0、无定时器）。

### 1.3 不变量（第三/四/五/六轮口径继续有效，本轮增补 3 条）

- **P1–P6 明文位置穷举不变**（README「安全不变量」）：明文只在人类输入面（P1）、该次提交请求体（P2）、Host 内存暂存/授权表（P3/P4）、经人类确认的持久写入（P5）、`shellEnv` 注入（P6）。
- **Agent 任何路径只拿到变量名**；工具结果/错误/日志/DOM 文本/未发送草稿的持久化投影/URL/响应体/异常一律不含明文。
- **N1（新增）**：**Auto-naming 的模型调用请求里不得出现明文、也不得出现会话内容**；只允许「人类给的标题 + 本地算出的价值形态特征」。形态特征必须是**固定词表里的类别 token**，不是值的任何切片。
- **N2（新增）**：**R3 的分类与登记全在页面本地完成**，不引入任何模型调用；命中后仍走既有 `attach` 链路，因此明文位置集合不变（只是「一次 attach 请求体」多了一个触发入口）。
- **N3（新增）**：**✕ 只能是解绑，永远不删凭据库**；删除仍必须走管理面的危险确认 + `confirm:true`。

---

## 2. 机制结论与证据

### 2.1 （a）R1 的模型调用面：存在，且是「会话外」的

**A1 · `ctx.llm` 服务与其唯一模型调用方法**（活体 Service 目录 + 精确契约）

- 服务条目原文：`llm` —「The abstract `llm` service: an adapter registry plus a streaming model-call API, interceptable via the `llm/stream` waterfall.」，`cordis_inspect_query(host, Service, listService)` 实测。
- 访问形态（同一查询的 `access`）：硬依赖 `inject: ['llm']` ⇒ `ctx.llm`；**可选**写法 `ctx.get("llm")` + `requiresUndefinedCheck: true`。
- 全部方法里与调用相关的是：`stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；其余是 `registerAdapter` / `listProviders` / `registerConfigurableProviders` / `listConfigurableProviders` / `registerModelDiscovery` / `discoverModels` / `providerRetryPolicy` / `imageRequestPricing` / `fileRequestText` / `listModels` / `resolveModelInfo` / `resolveCallConfig` / `prepareCall`。**没有任何写入会话/日志的方法**（这是「不进上下文」的第一重证据）。

**A2 · 调用参数逐字**（`GenerateOptions` 声明，来自同一查询的 `referencedTypes`）

```
export interface GenerateOptions {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
    messages: RequestMessage[];
    system?: string;
    tools?: ToolSchema[];
    toolHistory?: ToolHistory;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;
    purpose?: 'compaction' | 'session-title';
}
```

三点关键：**`sessionId` 是可选**（可以完全不提任何会话）；`purpose` 是**受限联合**，只有 `'compaction' | 'session-title'`；`messages` 完全由调用方构造。

**A3 · 第一方先例**：`@deepseek-ai/dsh-session-title-llm` 就是「后台用模型命名」的实现（`$H/dsh-session-title-llm/lib/index.js`）：

- `:197-203` 只构造**一条 user 消息**：`createUserMessage({ content: [{type:'text', text: framedInput}], source: { kind: 'dsh-session-title-llm' } })`。
- `:206-215` 组装调用：`deepFreeze({ provider, model, messages, system, maxTokens, sessionId: request.session.id, purpose: 'session-title', signal: callDeadline.signal })`。
- `:226-229` 消费流：`for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`。
- `:161-173` 把终止原因翻译成失败（`max-tokens` / `tool-calls` / `error` / `aborted` 各一条固定消息）；`:234-236` 断言输出**只含文本**（出现 `tool-call` 即失败）。
- `:205` 有超时：`deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)`；`:114` 校验 `timeoutMs` 是正整数且有上限。
- 路由来源：`:138-146` `resolveRoute(config, request)` — **要么**配置里显式给 `provider/model`，**要么**用 `request.route`（`:144` 明确「no logged request route is available; configure provider and model together」）。

**A4 · 「当前会话配置的模型」怎么读**（R1 的 `provider/model` 来源）

- `$H/dsh-session/lib/types/index.d.ts:259`：`requestHeader(): EpochHeader | undefined;`（`:247` 注释「Cached fold of the request-header events」）。
- `$H/dsh-session/lib/types/types.d.ts:217-219`：`interface EpochHeader { /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */ config: LlmCallConfig; … }`。
- 第一方用法同样如此：`$H/dsh-session-title/lib/index.js:424` `const route = session.requestHeader()?.config;`（同一文件的 `:256` / `:214` 监听 `'request/header'` 事件来确认头部已 fold）。
- 兜底来源：`agentDefaultModel` 服务 `currentSelection(): ModelSelection`；`$H/dsh-agent/lib/types/model-selection.d.ts:16-23`：`interface ModelSelection { provider: string; model: string; reasoningEffort?: ReasoningEffortId }`。
- 会话内还有一条**durable** 的模型选择来源：`model-selection.d.ts:8-13` 给 `MessageSourceMap` 增加了 `'model-selection': { kind: 'model-selection' } & ContextFormed`，`:31-49` 说明 provider/model 变更会「append a durable user-role notice to the next admitted request」。

**A5 · 「尽量关闭思考或最低档」的确切证据**

- `$H/dsh-llm-deepseek/lib/index.js:1694` 原文：
  `const effort = options.purpose === "session-title" ? "off" : options.reasoningEffort ?? connection.defaults.reasoningEffort ?? (connection.defaults.thinking === "disabled" ? "off" : "high");`
  ⇒ 只要 `purpose === 'session-title'`，DeepSeek 适配器**无条件**把该次调用降到 `off`（比「最低档」更低）。**这是宿主已经写好的行为，不是本插件要实现的。**
- 其它适配器：`dsh-llm-deepseek/lib/types/config.d.ts:14` 允许 `'off' | 'low' | 'high' | 'max'`（同一个类型在 `dsh-llm-deepseek-account` / `dsh-llm-deepseek-api-key` 的 config 里重复）。
- **风险与处置**：`resolveCallConfig` 的契约原文：「Unsupported explicit efforts reject before provider I/O; no clamping or aliasing is performed.」⇒ 显式传 `reasoningEffort` 时**可能被拒**（不是被降级）。因此定案要求：**不显式传 effort**，靠 `purpose:'session-title'` 拿到 `off`；若适配器不支持该 purpose 的降级，也仍然只是「按模型默认」，不额外失败。

**A6 · 「不进本会话上下文/日志」的完整证据链（三重）**

1. **服务侧没有写入口**（A1）：`llm` 的全部方法里没有任何 session append/record 能力；`stream()` 只返回 `AsyncIterable<StreamChunk>`。
2. **参数侧允许无会话**（A2）：`sessionId?` 可选 ⇒ 契约上支持「不提会话」的调用。
3. **反证：要写进会话必须显式做，而且会被排除在消息序列之外**
   - 先例显式做的那一步：`$H/dsh-session-title-llm/lib/index.js:216-223` `request.session.append("session/title-llm-request", { titleProvider, messageSeqs, route, system, messages, maxTokens })` —— 注意这是**先例自己的**动作，不是 `llm` 服务的行为。
   - 该事件**不是对话消息**：`$H/dsh-session-format-v3-to-v4/lib/index.js:851` 的格式守卫原文把这类记录判为不合法消息 ——「session/title-llm-request messages do not represent messageSeqs」；`$H/dsh-session-format-v0-to-v1/lib/index.js:2569` 同旨（`source.kind !== 'dsh-session-title-llm'` 即报错）。即：这类请求记录**在格式上被定义为「不代表消息序列」**。
   ⇒ **定案：本插件绝不调用 `session.append(...)`、绝不把命名提示词或结果放进任何消息，也不传 `tools`/`toolHistory`**（避免任何工具调用/审批副作用）。如此，命名调用在会话日志与会话上下文里**零痕迹**。

**A7 · 「命名结果写到哪」与「发出时的临时键如何处置」——这是 R1 的真实岔路**

已核对的硬约束：

- `attach.name` **当前必填**：`$R/src/protocol.ts:168-172`（`if (name === undefined) return { ok:false, error:'attach.name is required' }`；非法形状另报错）。
- 变量名**由 name 推导**：`$R/src/naming.ts:55` `deriveEnvVar(name)`；协议里 `parseAttach` 用 `deriveEnvVar(name)` 或人类显式 `envVar`（`protocol.ts:187-200`）。
- 持久记录的**键也由 name 推导**：`$R/src/naming.ts:63-70`（`recordKeyId(name)` 把 `_` → `-`，`recordKey(name) = 'cordis-plugin-secret/' + recordKeyId(name)`），`RECORD_SCOPE` 在 `:7`；写入点 `$R/src/service.ts:480`（attach 侧 `commitRecord(recordKey(input.name), …)`）、`:1397`（升持久）、`:1677`（`secret_request`）。
- **消息里的标记是变量名，且是 durable 的用户消息正文**（第三/四轮已成定局：正文不改写）。⇒ 变量名必须在**消息发出前**就存在，且**发出后不可更名**（更名会让正文里的标记指向一个不存在的变量）。

于是「发出后再让模型命名」只能落在两个目标之一：

| 方案 | 命名结果写到 | 变量名 | 持久副作用 | 评价 |
|---|---|---|---|---|
| **A. 命名＝显示标题（推荐）** | 会话内存里的 attached meta（`label`）+ 历史/管理列表的显示名 | 由**本地规则**在 attach 时确定（如 `github-token` → `DSH_SECRET_GITHUB_TOKEN`） | **零**（不碰凭据库键） | 满足「发出后后台命名」「不进上下文」「明文不外泄」，且不需要人类二次确认（不动持久态）。代价：凭据键不是模型生成的，而是本地规则生成的 |
| **B. 命名＝凭据键** | 凭据记录的键 | 同上（必须发出前定） | **非零**：要么 `commitRecord(新键)`+`deleteRecord(旧键)`（两次持久写，且按「影响持久状态的动作仍需人类确认」需人类确认，与「后台静默」冲突），要么让键与变量名长期不一致 | 与不变量冲突，**不推荐** |
| **C. 命名＝凭据键且改名发生在发送前** | 凭据记录的键 | 发出前就定 | 零额外确认（键在提交时就是最终键） | 唯一能「让凭据键＝模型命名」的合规路径，但它与用户原话「**消息发出后**」的时序相反 |

⇒ **定案取 A（§3.1）**，并把 B/C 作为 §8 U1 供用户改判；**无论取哪个，变量名都在 attach 时确定、发出后永不改写**。

### 2.2 （b）R2 的 Clipboard 面与「所有输入框」

**B1 · 输入区右侧确实有官方座位**

- `$H/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:234-238`：
  `/** Compact controls before the composer submit action. */ 'conversation.input.right': { kind: 'list'; scope: 'session'; }`
- 同文件 `:230-233`（`conversation.input.left`）、`:220-223`（`overlay`）、`:214-218`（`dock`）、`:239-244`（`activity`，`kind:'single'`）、`:274-278`（`model`）。
- 渲染在场：`:489` `ComposerBarProps = PropsRuntime<'conversation.composer.bar'> & PropsRenderSlots<'conversation.input.attachments' | 'conversation.input.overlay' | 'conversation.input.permission' | 'conversation.input.left' | 'conversation.input.plan' | 'conversation.input.right' | 'conversation.input.model' | 'conversation.input.activity' | 'conversation.composer.dock'> …`
  ⇒ `conversation.input.right` 是**会话作用域的 list 座位**，插件用 `ctx.slots.register({ name: 'conversation.input.right', id: 'secret-paste', order: … })` 注册即可（本插件已有同型注册先例：`$R/src/client/entry.ts:5323` 注册 `conversation.chat.node` 的 `CHIP_KIND`）。
- **「所有输入框」的现实边界（如实）**：座位系统只暴露**输入区**这一个容器给第三方；其它输入框（设置页、命令面板、别的插件的表单）**没有通用 suffix 座位**。能拿到的只有两类：**(i) 输入区**（上表座位）、**(ii) 本插件自己的输入框**（自己写 DOM）。**不做** DOM 猴补丁式全局注入（违反本插件纪律，且会污染别人的无障碍树）。⇒ §8 U2。

**B2 · `navigator.clipboard.readText()` 的前置条件与本环境的真实情况**

- **安全上下文**：`readText()` 只在 secure context 可用；本机 GUI 是 loopback 上的 http（默认端口证据：`$H/dsh-cmdline/lib/index.js:15`「`port: !!js ctx.webStartup.port ?? 3080` — so a flag beats the value written…」；实际地址 `http://127.0.0.1:3080`），而 **loopback 属 potentially trustworthy origin** ⇒ secure context 成立。
- **跨源/权限策略**：全树 `grep` `Permissions-Policy|clipboard-read` = **0 命中**（本次实测）；唯一的 `Content-Security-Policy` 是 `$H/dsh-api-session-controller/lib/index.js:2342` 的 `"Content-Security-Policy": "sandbox; default-src 'none'"`，而它服务的是**媒体引用**（同文件 `lib/types/media-references.js:14`），**不是**应用页面；另有一处在文档预览**自己的 iframe** 上设 CSP（`dsh-client-ui-sidebar-documentpreview/lib/client.js:3845`）。⇒ 应用页面没有会阻断 `clipboard-read` 的 CSP/Permissions-Policy。
- **已发布的第一方先例（同时是「会被拒」的证据）**：`$H/dsh-client-ui-sidebar-documentpreview/lib/client.excel.js:130169-130183` —— 在 `onClick` 里 `clipboardText = ""` → `sessionClipboardText = sessionStorage.getItem("localClipboard") || ""` → `try { clipboardText = await navigator.clipboard.readText() } catch { console.warn("Clipboard access blocked. Attempting to use sessionStorage fallback.") }` → `finalText = clipboardText || sessionClipboardText`。
  ⇒ 事实：**能用**；**也可能被拒**；被拒时必须降级并提示，不能静默。
- **写剪贴板的既有约定**（本需求不写，只用于对照按钮探测写法）：`$H/dsh-client-ui-primitives/lib/index.js:4552` `if (navigator.clipboard?.writeText) try { await navigator.clipboard.writeText(text) } …`。

**B3 · 「写入受控 value 并触发 React 的 onChange」的正确写法（本插件两种输入面不同）**

- **本插件自有输入框**（填值面的值输入、管理改值面、R1 的新键输入）是 **React 受控组件**：`$R/src/client/entry.ts:3688-3699`（`value`、`onChange: e => setValue(e.target.value)`、`type: reveal ? 'text' : 'password'`）。
  ⇒ 正确写法是**直接调用同一个 setter**（`setValue(text.trim())`），**不要**去 `dispatchEvent(new Event('input'))` 或改 `input.value`（受控组件会立刻覆盖，且打断 React 的状态一致性）。校验随后由同一条路径触发（提交时的既有校验）。
- **输入区（composer）不是我们的组件**：插件只有**编辑器插入**这一个受支持的写入面，接口是 `$R/src/client/entry.ts:1817-1820`：
  `interface InputActionsLike { captureInsertion?(): TokenSpanLike; insertText?(text: string, span: TokenSpanLike): boolean }`
  既有先例 `insertChip(...)`（`entry.ts:3144`）就是「`captureInsertion()` 取光标 → `insertText()` / 引用插入 → 失败降级纯文本」的阶梯。
  ⇒ composer 上的「粘贴」按钮**只能**走 `captureInsertion()` + `insertText(文本, span)`（把剪贴板文本插到光标处），**做不到**「写进一个受控 value」。这一点必须如实写进按钮行为与文档（它不是缺陷，是座位契约）。

**B4 · 点击不抢输入框焦点**

- `onMouseDown: e => e.preventDefault()`（阻止默认的焦点转移）+ `type="button"` + `aria-label="粘贴"`；键盘激活（Enter/Space）不会走 mousedown，所以处理函数最后**显式** `focus()` 目标输入框（对本插件自有输入用 `ref.current.focus()`；composer 用同一 `InputActionsLike` 的插入路径，焦点本就在编辑器内）。
- 不要用 `tabIndex=-1` 达成「不抢焦点」——那会让键盘用户无法到达该按钮（无障碍回退）。

### 2.3 （c）R3 的规则与流程

**C1 · 现状：插件里没有任何隐私/厂商前缀规则**

- `grep`（`sk-|ghp_|AKIA|xoxb|entropy|前缀|vendor`）在 `$R/src` 只命中两条无关注释（`entry.ts:778`/`:783` 讲 vendor ignore 属性）。⇒ 规则集是**新建**，必须自带依据与代价表（§3.3）。
- 既有可复用的判定原语：`naming.ts:40` `isCredentialName`、`:55` `deriveEnvVar`、`:69` `recordKey`；标记识别在客户端（`carriesMarker` / `parseMarkers` 一族）。

**C2 · 登记走哪条链路：`attach`（stage），不是 `adopt`**

- `POST /api/secret.attach`（`$R/src/client/entry.ts:1273` 常量、`$R/src/routes.ts` 注册、`:3313` 提交）→ `parseAttach`（`$R/src/protocol.ts:160-213`）→ `service.attach`（Host 内存暂存 + 人类消息绑定后成为授权）。
- `adopt` 是「把**凭据库里已有**的记录登记到本会话」（无值），与 R3「人类刚粘贴了一个新值」不符。
- 因此 R3 = 「用粘贴的值**替人类填完填值面并提交**」，与手填完全同一条链路、同一套不变量（明文只进 P1 与该次 POST 体）。
- **默认作用域**：取填值面**当前选择**（`entry.ts:3713-3731` 的 `scope` 状态）；默认 `session`（会话级零落盘），人类可在胶囊里改。

**C3 · 拦截与「不吞内容」**

- 在值输入框上挂 `onPaste`：`const text = event.clipboardData?.getData('text/plain') ?? ''`。
- 命中规则 → `event.preventDefault()`（不让原文本落进输入框）→ 立即 `POST /api/secret.attach`（值 = `text.trim()`）→ 成功后 `insertChip(...)`（实时插入标记胶囊）+ `setValue('')` + 报告一句固定文案。
- **失败兜底（硬要求）**：任何失败（网络/500/校验/插入阶梯全失败）都必须把人类的内容**还回去**：`setValue(text.trim())` + 固定错误文案（不含明文）。**不得**因为 preventDefault 而丢掉用户粘贴的内容。
- 顺序细节：为防止「先清空再失败」，实现上**先**发请求再决定 UI；`preventDefault()` 可以照做（值已在我们的 `text` 变量里），失败时用 setter 写回（P1 仍是明文唯一落点）。

**C4 · 触发面（用户裁定 ②：只在值输入框、且是真登记）**

- 只在**填值面**的值输入框（`id="dsh-secret-attach-value"`，`entry.ts:3691`）触发。
- 管理面的**改值**面（`kind:'edit'`）**不触发自动登记**（它是「改一个已存在变量的值」，不是新登记），只享受 R2 的粘贴按钮。
- 标记串（`@DSH_SECRET_*` / `[secret DSH_SECRET_*]`）必须**显式排除**：它不含值，把它当密钥登记会造成一个假的密码条目。

### 2.4 （d）R4 的落点与语义

**D1 · 「密钥胶囊」指哪一处：消息旁的胶囊行（我们的组件）**

- 组件：`SecretAttachChipRow`（`$R/src/client/entry.ts:4880-4915`），节点 kind `CHIP_KIND = 'sr-chip'`（`:1323`），注册于 `:5323`（`conversation.chat.node`，key `sr-chip`）。
- 它按变量渲染：`variables.map(variable => h('button', { className: A.chipPill, 'data-secret-variable': variable, onClick: () => setAttachMode({kind:'detail', variable}) }, variable))`（`:4897-4913`）。
- **只有它是「每个变量一枚胶囊、且是我们的 DOM」**：
  - 草稿里的 chip 由编辑器/`projectUserText` 渲染（第三轮已定性：正文改写会落盘、`@` 标记必被渲染成 file chip），**加不了我们的按钮**；
  - 信息框/管理列表是行式列表（已有动作按钮），不是「胶囊」。
- ⇒ ✕ 加在 `chipPill` 上。**结构改动是必须的**：现在胶囊本体就是 `<button>`（`:4899`），而按钮里再放按钮是非法 HTML/无障碍违规。定案改为「容器 + 主按钮 + ✕ 按钮」两件式：

```
h('span', { className: A.chipPillGroup, 'data-secret-variable': variable },   // 容器（不再可点击）
  h('button', { className: A.chipPill, onClick: 打开详情 }, variable),        // 原有主交互不变
  h('button', { className: A.chipRemove, type: 'button', 'aria-label': `移除 @${variable}`, onClick: 解绑 }, '✕'),
)
```

**D2 · ✕ 的语义＝解绑：必须按状态分流（**这是本节最关键的结论**）**

- **`staged`（已登记、消息还没发出去/还没绑定）**：走既有 `POST /api/secret.release`（`entry.ts:1274` 常量、`:2413` 调用）——这正是 0.3.0 的「移除即撤销」，语义一字不改。
- **`bound`（已绑定到某条消息）**：`release` **明确拒绝**：`$R/src/service.ts:550-552` 在找不到 staged 项时返回 `{ ok: true, released: false, state: bound ? 'bound' : 'none' }`（`released:false` 就是「没删」）。能真正从本会话移除的是 **0.4.0 的管理动作 `unbind`**：
  - 执行器：`$R/src/service.ts:1180` `const dropped = this.grants.unbind(sessionId, facts.variable)`；
  - 线上形态：`POST /api/secret.manage`，体 `{ sessionId, action:'unbind', variable }`（**不带** `confirm`；`parseManage` 对 unbind 带 `confirm` 会 400）；
  - 结果：变量立刻不再注入，凭据库的值与记录**原样保留**（历史写一条 `unbound`）。
- ⇒ ✕ 的实现 = 「读该变量当前状态 → staged ? `release` : `manage('unbind')`」，两条路都要如实报告结果（`released:false` 时不能假装移除成功）。

**D3 · CSS 体系与移动端**

- 现有 CSS 是模板字符串常量（`:hover` / `:focus-visible` 成对出现）：`$R/src/client/entry.ts:1753-1755`（`A.chipPill` 的底色、`999px` 圆角、`:hover`、`:focus-visible`）、`:1717-1718`（`A.close` 的既有「关闭」按钮样式，可作 ✕ 的视觉基准）、`:324`（`.…:focus-visible,.…:focus-within{outline:…}` 的既有焦点环写法）。
- 新增（逐字建议）：
  ```
  .${A.chipRemove}{background:0 0;border:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;line-height:18px;padding:0 4px;visibility:hidden}
  .${A.chipPillGroup}:hover .${A.chipRemove},
  .${A.chipPillGroup}:focus-within .${A.chipRemove},
  .${A.chipRemove}:focus-visible{visibility:visible}
  @media (hover:none){.${A.chipRemove}{visibility:visible}}
  ```
- **移动端取舍**：不用 `(hover:hover)` 反查，也不做长按定时器；直接对**无 hover 的设备**用媒体查询默认显示 ✕（成本 0、无 JS、无定时器泄漏风险）。理由：长按需要计时器与手势状态机，且与「点击主按钮打开详情」冲突。

---

## 3. 定案（逐字契约）

### 3.1 R1 · 密钥键可选 + 后台命名

**3.1.1 表单（填值面新字段顺序，逐字）**

```
1) 标题（label）        ← 原第 2 项，现在第一项；保持必填（它就是人类的意图）
2) 密钥键（name）       ← 原第 1 项，移到这里；改为可选，placeholder 写「留空则由 AI 命名」
3) 值（value）          ← 掩码输入 + 显示/隐藏 + R2 的「粘贴」按钮 + R3 的 onPaste
4) 作用域（scope）      ← 不变
5) 「插入到光标处」「取消」 ← 不变
```

**3.1.2 Host 侧契约（`attach`）**

- `parseAttach`（`$R/src/protocol.ts:160-213`）改为：`name` **可缺省**；缺省时按**本地规则**生成本地键：

  ```
  provisionalKey(label, value) =
     命中 §3.3 的厂商类别  → 该类别的固定键（openai-key / github-token / aws-access-key / slack-token / google-api-key / jwt-payload …）
     否则按字符集类别        → secret-token / secret-key / secret-passphrase
     再冲突                  → 追加 -2/-3…（同会话内已存在的键）
  ```

  ⇒ `name` 与 `envVar`（`DSH_SECRET_*`）以及持久记录键 `cordis-plugin-secret/<recordKeyId(name)>` 全部**在 attach 时确定**，之后**永不改写**（理由：正文标记 durable，见 §2.1 A7）。
- 请求体新增**只增**字段（旧客户端不受影响）：`autoName?: true`。它表示「人类没有给键，允许后台命名显示标题」。
- 记录/元数据里新增**只增**的展示字段：attached meta 增加 `autoNamed?: { at: number; model: string }`（值无关），供界面显示「AI 命名」徽标与时间。

**3.1.3 后台命名调用（逐字）**

```
// 仅在 (a) 该次 attach 的 name 由本地规则生成 且 (b) 消息发出并绑定成功 之后触发
const route = session.requestHeader()?.config                       // {provider, model}
           ?? ctx.agentDefaultModel?.currentSelection()             // 兜底
if (route === undefined) → 不命名（留空并如实显示「未命名」），绝不猜
const shape = classifyShape(value)   // 见下；纯本地计算，明文不出组件/服务内存
const reply = await collect(ctx.llm.stream({
  provider: route.provider,
  model: route.model,
  messages: [{ role: 'user', content: [{ type: 'text', text: renderNamingPrompt(label, shape) }] }],
  system: NAMING_SYSTEM_PROMPT,
  maxTokens: 24,
  purpose: 'session-title',      // 借它的「思考关闭」语义（A5）；不显式传 reasoningEffort
  signal,                        // requestTimeoutMs 级别的 deadline
}))
// 只取文本、只取单行、长度/字符集白名单校验后写入 attached meta.label
```

- **`classifyShape(value)`（N1 的唯一"值信息"出口，逐字词表）**

  | 输出字段 | 取值 | 依据 |
  |---|---|---|
  | `length` | 整数 | 值已在本进程；长度不是明文 |
  | `charset` | `'base64url' \| 'hex' \| 'mixed' \| 'path-like' \| 'url-like' \| 'other'` | 字符集类别 |
  | `category` | `'openai-like' \| 'anthropic-like' \| 'github-pat-like' \| 'aws-access-key-like' \| 'slack-like' \| 'google-api-key-like' \| 'jwt-like' \| 'pem-private-key-like' \| 'stripe-like' \| 'unknown'` | 前缀**类别**，不是前缀切片 |
  | `label` | 人类填的标题**原文** | 人类本来就会把它显示在界面上 |

  **不得**出现：值的任何切片（含前缀字符）、值的哈希、值的长度以外的统计量、会话内容、文件名、cwd、工具结果。
  `renderNamingPrompt(label, shape)` 的逐字骨架：

  ```
  Suggest one lowercase kebab-case credential key (max 4 words, ASCII) for a secret.
  Human-supplied title: {label}
  Value shape: length={length}, charset={charset}, category={category}
  Return only the key on one line, no quotes, no explanation.
  ```

- **结果落地**：只写 attached meta 的 `label`（会话内存；**不落盘**、**不改记录键**、**不改变量名**）。UI 在胶囊与详情面显示该标题，并给一个中性的「AI 命名」徽标；管理列表的 label 也随之变好（`factsFor` 的 label 已优先取 attached meta，见 `$R/src/service.ts` 的 `attendViews`/`factsFor` 路径）。
- **时序**：触发点＝该变量**绑定成功**之后（与 `noteBound` 同一条链路的尾部）。**不阻塞**消息发送、不阻塞任何工具调用；结果只更新内存与 UI。
- **失败/超时**：任何失败（无 route / 无 llm 服务 / 被拒 / 超时 / 输出非法 / 空串）⇒ **保持本地规则生成的键与人类标题**，并在胶囊里如实显示「未命名（AI 命名不可用）」。**绝不**重试到把界面卡住；最多一次重试（网络类错误），上限 1 次。
- **重名/覆盖**：命名结果只用于显示，**不触发**任何重命名 ⇒ 天然无覆盖风险。若未来采纳 §8 U1 的 C 方案（发出前命名并作为键），则必须在这一步就做「同会话重名 → 追加 `-2`」的既有 `recordKey` 去重逻辑，并明确它发生在**提交之前**。

### 3.2 R2 · 「粘贴」suffix 动作按钮 —— **0.5.0 已落地**（结果与差异见 §12.2）

**逐字行为（三种落点，两种环境）**

| 落点 | 注册/实现 | 写入路径 | 提示 |
|---|---|---|---|
| 输入区（composer） | `ctx.slots.register({ name:'conversation.input.right', id:'secret-paste', order: … })` | `captureInsertion()` + `insertText(text, span)`；失败降级 `insertText(text, cursor)`；再失败→固定提示 | 「无法读取剪贴板，请手动粘贴」 |
| 本插件的值输入（填值面 / 改值面 / R1 的键输入） | 组件内联 `h('button', …, className: A.paste)` | `setXxx(text.trim())`（受控 setter）+ 既有校验 + `ref.focus()` | 同上 |

**逐字属性与事件**

- `type="button"`；`aria-label="粘贴"`（`ATTACH_ZH.paste` / `ATTACH_EN.paste`，新增文案键）。
- `onMouseDown: e => e.preventDefault()`（不抢焦点）。
- `onClick: async () => { … }`：
  1. `const read = globalThis.navigator?.clipboard?.readText`；不存在 ⇒ 直接提示「当前浏览器不支持读取剪贴板，请手动粘贴（Ctrl+V）」。
  2. `try { const text = (await navigator.clipboard.readText()).trim() } catch { 提示同上 }`。
  3. `text === ''` ⇒ **不改变任何状态**（不改写已有内容），只提示「剪贴板是空的」。
  4. 写入（按上表）→ `focus()` 目标输入。
- **不得**：把剪贴板内容写进 `localStorage`/`sessionStorage`/URL/console/日志；不得为了让 composer 支持「写值」去猴补丁编辑器。
- 新增文案键（zh/en 各一对，既有键一字不改）：`paste`、`pasteUnsupported`、`pasteEmpty`、`pasteFailed`。

### 3.3 R3 · 值输入框粘贴命中隐私规则 ⇒ 真登记并转胶囊 —— **0.5.0 已落地**（含命名被取代，见 §12.3）

**3.3.1 隐私过滤规则（逐条依据 + 误报/漏报代价）**

| # | 规则 | 依据 | 误报代价 | 漏报代价 |
|---|---|---|---|---|
| 1 | 已知厂商前缀：`sk-`、`sk-ant-`、`ghp_`/`gho_`/`ghs_`/`github_pat_`、`AKIA`/`ASIA`、`xoxb-`/`xoxp-`/`xoxa-`、`AIza`、`ya29.`、`glpat-`、`npm_`、`pypi-`、`hf_`、`dop_v1_`、`SG.`、`sk_live_`/`rk_live_` | 各厂商公开的 token 形态 | 把一段看起来像 token 的注释/文档样例登记成一个密钥（人类可一键 ✕ 解绑，代价低） | 人类粘的是真密钥却没登记（**回到今天的行为**，无回归） |
| 2 | JWT 形态：`eyJ` 开头且 `a.b.c` 三段 | JWT 头固定 base64(`{"`) | 同 1 | 同 1 |
| 3 | PEM 私钥：`-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----` | RFC 7468 | 极低 | 极低 |
| 4 | 结构阈值：单行、无空白、长度 ≥ 20、字符集 ⊂ base64url/hex | 高熵串的一般形态 | 中（40 位 git SHA、长哈希、UUID 去掉连字符） | 中（未知厂商的中等长度密钥可能不命中） |
| 5 | 熵阈值：Shannon 熵 ≥ 3.5 bit/char（长度 ≥ 24 时） | 经验阈值 | 见 4 | 见 4 |
| 6 | **排除**：URL（`^[a-z]+://`）、Windows/POSIX 路径（`^[A-Za-z]:\\`、`^/`、含 `\`）、邮箱、纯单词/中文句子 | 这些是常见「非密钥」误报源 | — | — |
| 7 | **排除**：本插件标记 `@DSH_SECRET_*` / `[secret DSH_SECRET_*]` | 标记不是值（第三/四轮不变量） | — | — |
| 8 | 冲突裁决：同时像「路径」又像「token」⇒ **不登记**（保守侧） | 误报把人类内容变成密钥更难解释 | — | — |

- **规则表落在哪**：新增 `$R/src/privacy.ts`（Host 与 Client 共享的**纯函数**，无 IO），导出 `looksLikeSecret(text): { hit: boolean; category: … ; reason: string }`；客户端只需 `hit` 与 `category`（用于给本地规则键一个更好的名字，§3.1.2）。**同一份实现**被 Host（若将来做服务侧兜底）与 Client 使用，避免两套说法。
- **阈值可配置**：`Config` 增 `pasteAutoAttach?: boolean = true`、`pasteMinLength?: number = 20`（可关、可调），默认开启。

**3.3.2 流程（逐字）**

```
onPaste(event):
  text = event.clipboardData?.getData('text/plain') ?? ''
  verdict = looksLikeSecret(text.trim())
  if (!verdict.hit) return                     // 不拦截：完全走浏览器的默认粘贴行为
  event.preventDefault()                        // 值已在我们手上，不让它落进输入框
  name   = provisionalKey(label, text)          // §3.1.2 的同一个本地规则
  scope  = 当前作用域选择（默认 session）
  result = await POST /api/secret.attach { sessionId, name, label, scope, value: text.trim() }
  if (result.ok):
      insertChip(sessionId, result.variable, span, actions)   // 阶梯：chip → 文本 → 手动
      setValue('')                                            // 输入框清空（值已在暂存表）
      报告固定文案「已识别并登记为密钥 DSH_SECRET_X；凭据库未被写入（会话级）」
  else:
      setValue(text.trim())                                   // **把人类的内容还回去**
      报错固定文案（不含明文）
```

- **明文去向**：P1（`text` 变量在组件闭包内）→ P2（那一次 `attach` 请求体）→ P3（Host 暂存表）。**没有新增落点**。
- **不做**：不把命中的文本写历史、不 console、不 toast 出内容、不写 storage。
- **可机器证明**：`looksLikeSecret` 的真值表（正例/反例各若干）、`onPaste` 命中后 `preventDefault` + 一次 `attach` + 一次 `insertChip`、失败时 setter 被写回原文。

### 3.4 R4 · 胶囊 ✕ ＝解绑 —— **0.5.0 已落地**（含 0.4.x 的历史缺陷与修复，见 §12.4）

- **落点**：`chipPillGroup` 容器内的 `chipRemove` 按钮（§2.4 D1 的结构）。
- **属性**：`type="button"`；`aria-label="移除 @DSH_SECRET_X"`（新增文案键 `chipRemove`，含变量名，**不含值**）；`onMouseDown: e => e.preventDefault()`（不抢焦点、不触发胶囊主体的 hover/click 语义混乱）。
- **onClick（逐字）**：
  ```
  event.stopPropagation()                       // 不冒泡到胶囊主体的「打开详情」
  event.preventDefault()
  state = api.sessionAttachments(sessionId).get(variable)?.state
  if (state === 'staged') → POST /api/secret.release { sessionId, variable, reason:'withdrawn' }
      → 既有 applyRelease 语义（0.3.0「移除即撤销」不动）
  else                    → POST /api/secret.manage { sessionId, action:'unbind', variable }
      → 变量立刻不再注入；凭据库**原样保留**；历史写 `unbound`
  刷新：refreshAttached(sessionId) + refreshHistory(sessionId) + refreshManage(sessionId)
  报告：一句固定文案，且必须区分两条路（staged ⇒「已丢弃尚未发送的登记」；bound ⇒「已从本会话解绑；凭据库未改动」）
  ```
- **失败**：`released:false` 或非 200 ⇒ 如实报「未移除」并保留胶囊（**不**乐观移除）。
- **不做什么**：永不删除凭据库记录（真删只在管理面的危险面，`confirm:true`）。✕ 的 tooltip/复盘文案里禁止出现「删除」二字，避免与真删混淆。
- **焦点与键盘**：✕ 可被 Tab 到达（`focus-within` 会显示它），`aria-label` 走文案；主按钮的既有 `onClick`（打开详情）不变。

---

## 4. 状态机与时序

### 4.1 R1 · 命名状态（每个变量一份，纯内存）

| 状态 | 进入条件 | 界面 | 退出 |
|---|---|---|---|
| `local`（本地命名） | attach 时 `name` 由本地规则生成 | 胶囊显示本地键；`title` 显示人类标题 | 绑定成功后进入 `naming` |
| `naming` | 绑定成功且 `autoName === true` 且拿到 route | 「命名中…」（不阻塞任何操作） | 结果 →`named`；失败/超时 →`unnamed` |
| `named` | 模型返回合法单行且通过白名单校验 | 标题替换为生成名 + 「AI 命名」徽标 | 人类手动改标题 →`local`（人类优先） |
| `unnamed` | 无 llm 服务 / 无 route / 失败 / 超时 / 输出非法 | 保持本地键与人类标题 + 「AI 命名不可用」 | 不重试（除非人类再次 attach） |
| （人类在 attach 时就给了键） | 表单 `name` 非空 | 不做任何命名调用 | — |

**时序三条纪律**：① 命名调用**永不**发生在 attach 提交之前；② 永不阻塞 `attach`/绑定/消息发送；③ 结果只写内存 meta，掉线/刷新即回到 `local`（诚实：不落盘）。

### 4.2 R3 · 粘贴判定

```
paste → looksLikeSecret?
  hit=false → 浏览器默认行为（不做任何事）
  hit=true  → preventDefault → attach → 成功: insertChip + 清空 + 报告
                                   → 失败: setValue(原文) + 报错
```

### 4.3 R4 · ✕ 分流

```
✕ → state?
  staged → release  → withdrawn | discarded（既有历史事件）
  bound  → manage unbind → 不再注入 + 历史 unbound + 凭据库不变
  其它（已撤销/未知） → 不动，只刷新
```

---

## 5. 文件级改动点（实施顺序）——**0.5.0 实际落地情况见 §12.5**

### 5.1 先做（纯逻辑，先绿）

1. `$R/src/privacy.ts`（**新增**）：`looksLikeSecret(text)` + 厂商类别词表 + 熵/长度阈值 + 排除规则。纯函数、无 IO、无明文外发。
2. `$R/src/protocol.ts`：`parseAttach` 允许 `name` 缺省 + 新增 `autoName?: true`（`AttachRequestValue` 同步）。
3. `$R/src/naming.ts`：`provisionalKey({label, value, taken})`（复用 `isCredentialName` / `deriveEnvVar` / `recordKey`）。
4. `$R/src/types.ts`：attached meta 新增 `autoNamed?: { at: number; model: string }`；管理行/胶囊行的新文案键类型不改字段集（不新增 wire 字段）。

### 5.2 Host 执行器

5. `$R/src/service.ts`：attach 侧在 `name` 缺省时调用 `provisionalKey`；绑定成功后按 §3.1.3 触发一次命名（`ctx.get('llm')` 可选注入；`session.requestHeader()?.config` 取 route；HTTP/网络错误最多重试 1 次；成功只写 meta.label）。
6. `$R/src/index.ts`：**不把 `llm` 加进硬依赖**（保持 `inject` 不变），用可选获取；未挂载 `llm` 时命名功能整体降级（`unnamed`）。

### 5.3 Client

7. `$R/src/client/entry.ts`：
   - 填值面字段重排（键移到标题下方、可选、placeholder）+ `key` 空值允许提交；
   - 三个自有输入框旁加「粘贴」按钮（`A.paste` + `onMouseDown` preventDefault + 受控 setter + focus）；
   - 值输入框加 `onPaste`（§3.3.2）；
   - `SecretAttachChipRow` 改为 `chipPillGroup` 两件式并加 ✕（§3.4）；
   - CSS：`A.paste` / `A.chipRemove` / `A.chipPillGroup` + `@media (hover:none)`；
   - 文案键：`paste*` / `chipRemove` / `naming*`（zh/en 各一份，既有键不动）；
   - 输入区右侧座位注册：`ctx.slots.register({ name:'conversation.input.right', id:'secret-paste' })`（在 `apply` 的可选服务段里，缺座位时不得让整页 boot 失败——沿用第三轮 boot 修复的写法）。

### 5.4 测试（只增）

8. `$R/test/unit.test.ts`：`looksLikeSecret` 真值表（正/反例、排除项、冲突裁决）；`provisionalKey` 去重与字符集。
9. `$R/test/register.test.ts`：`attach` 缺省 name（记录键/变量名稳定）、`autoName` 缺省行为不变（回归）、命名调用在**假 llm 端口**下的四种结局（成功/无服务/被拒/超时）与「不写会话」断言（用假 session 断言 `append` 零调用）。
10. `$R/test/client-attach.test.ts`：粘贴按钮的三条路径（支持/不支持/空剪贴板）；`onPaste` 命中→一次 attach + 一次 insertChip + 清空；**失败回填**；✕ 的两条分流（staged→release、bound→manage unbind）与 `stopPropagation`；`conversation.input.right` 注册面（含缺座位时 boot 不炸）。
11. 断言面：`__cordisSecretAttach` 与 `__cordisSecretManage` 的键集**只增**；既有键集断言按「新增一行」披露。

---

## 6. 兜底阶梯

| 场景 | 行为 |
|---|---|
| 没有 `llm` 服务（profile 未挂载） | 命名功能整体不可用：保持本地规则键 + 人类标题，界面显示「AI 命名不可用」；**其余功能不受影响** |
| `session.requestHeader()` 无 route | 退到 `agentDefaultModel.currentSelection()`；仍无 ⇒ 不命名（不猜） |
| 模型返回多行/带引号/含代码/超长 | 单行化 → 去引号/反引号 → 白名单校验（`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`，长度 ≤ 32）→ 不合法则丢弃，保持 `unnamed` |
| 命名超时/被拒/网络错 | 最多重试 1 次，然后 `unnamed`；**不**阻塞、**不**重排 UI |
| 人类在命名返回前手动改标题 | 人类输入优先：以 `label` 的人工编辑版本为准，晚到的模型结果丢弃 |
| 浏览器不支持/拒绝 `readText()` | 提示「请手动粘贴（Ctrl+V）」，不改任何状态 |
| 剪贴板文本为空/全空白 | 不改变输入框内容，提示「剪贴板是空的」 |
| R3 的 attach 失败 | **回填人类原文** + 固定错误文案（不含明文），绝不吞内容 |
| R3 命中但插入阶梯全失败（无编辑器能力） | 保留已登记的暂存项（真登记不撤回），提示「已登记，请手动输入 `@DSH_SECRET_X`」 |
| ✕ 时状态已变（别人已解绑/已撤销） | 只刷新列表 + 如实报告「未移除」 |
| 无 hover 设备 | `@media (hover:none)` 默认显示 ✕（不做长按） |
| 输入区座位不存在（旧版 DSH） | 不注册、不抛错；插件自有输入框的粘贴按钮仍然可用 |

---

## 7. 验证清单 —— **§7.0 已达成、§7.1 仍待真人（0.5.0 实测见 §12.6）**

### 7.0 A 段：可机器证明

**A1 机制复核（静态证据，逐条 grep 到行）**
1. `llm` 服务存在且**无会话写入方法**（第 2.1 A1 的方法清单）；`GenerateOptions.sessionId` 可选、`purpose` 受限（A2）。
2. 第一方先例仍在：`dsh-session-title-llm/lib/index.js:206-229`（`purpose:'session-title'` + `ctx.llm.stream`）、`:216-223`（显式 append）；格式守卫仍在：`dsh-session-format-v3-to-v4/lib/index.js:851`、`dsh-session-format-v0-to-v1/lib/index.js:2569`。
3. `dsh-llm-deepseek/lib/index.js:1694` 的 `'off'` 强制仍在。
4. `conversation.input.right` 座位仍在：`slots.d.ts:234-238`。
5. `navigator.clipboard.readText()` 先例仍在：`client.excel.js:130173`。
6. `release` 仍拒绝已绑定项：`$R/src/service.ts:552`；`unbind` 执行器仍在：`$R/src/service.ts:1180`。
7. `recordKey` / `deriveEnvVar` / `isCredentialName` 仍在：`$R/src/naming.ts:40/55/63/69-70`；attach 写入点仍在：`$R/src/service.ts:480`。

**A2 Host 单元**
1. `looksLikeSecret` 真值表：每条规则至少 2 正 2 反；排除项（URL/路径/邮箱/中文句子/标记串）全为 `hit:false`；规则 8 的冲突裁决有专例。
2. `provisionalKey`：同会话去重（`-2`）、类别命名、非法 label 的降级。
3. `attach` 缺键：`name` 缺省得到稳定的 `envVar` 与 `recordKey`；`attach.name` 显式给定时行为**逐字不变**（回归）。
4. **命名调用不写会话**：用假 session 记录 `append` 调用次数 = 0；假 llm 端口断言收到的 `messages` 里**不含**明文（对测试哨兵 0 命中）且只含 §3.1.3 的词表字段。
5. 命名四结局：成功 → meta.label 变；无服务/被拒/超时 → meta 不变且不留半状态。
6. 人类优先：命名返回前人类改标题 ⇒ 最终标题是人类那份。

**A3 路由/协议**
1. `attach` 请求体白名单：新增 `autoName?` 后，旧字段集合与旧行为不变（缺 `name` 的旧请求仍然 400，只有带 `autoName` 的缺键请求才走本地命名）——**这条要逐字钉住**，避免静默改变旧契约。
2. 其余路由（`release`/`manage`/`history`/`available`/`adopted`/`pending`/`answer`）的路径、方法、请求/响应字段集**不变**。

**A4 Client 单元**
1. 填值面字段顺序：标题在键之前（DOM 顺序断言）。
2. 粘贴按钮：`type='button'`、`aria-label='粘贴'`、`onMouseDown` 的 `defaultPrevented === true`、点击后目标输入框获得焦点（假 ref）；不支持/拒绝/空剪贴板三条路径的文案与「零状态改变」。
3. `onPaste`：命中 ⇒ `preventDefault` 被调用、恰好一次 `attach`、恰好一次插入、输入框清空；**失败 ⇒ 输入框内容 === 原文**（回填）；未命中 ⇒ 不调用 `preventDefault`、不发请求。
4. ✕：`staged` ⇒ 打到 `RELEASE_PATH`；`bound` ⇒ 打到 `MANAGE_PATH` 且体为 `{action:'unbind'}`（无 `confirm`）；`stopPropagation` 生效（详情面不被打开）；`aria-label` 含变量名、不含值。
5. 值不泄漏：管理卡/胶囊/剪贴板路径的 props+可见文本对哨兵 0 命中（本轮**每条检测都带正对照**——沿用第六轮做法：先证明哨兵真的在系统里，再断言它不在界面上）。
6. 座位注册：`conversation.input.right` 恰好一行；缺该座位时 `apply` 不抛（boot 回归门）。

**A5 静态面**
1. `$R/src/client/entry.ts` 无 `import`/`export`；`lib/client/entry.js` 同判据。
2. `$R/src/**` 无新增对 `node:fs` 的引用（命名功能不落盘）。
3. 命名调用的源码里**没有**把 `value` 拼进 prompt 的痕迹（对 `renderNamingPrompt` 的参数集做断言）。
4. `package.json` 的 `version` 未被本任务改动。

**A6 机械三连**

```
npm --prefix projects/cordis-plugin-secret run typecheck   # exit 0
npm --prefix projects/cordis-plugin-secret test            # 全绿且**自然退出**；用例数只增不减
npm --prefix projects/cordis-plugin-secret run build       # exit 0；lib/client/entry.js 无 import/export
```

### 7.1 B 段：需真人确认（或活体 DOM）

| # | 事项 | 判据 |
|---|---|---|
| B1 | 填值面新顺序与「留空则 AI 命名」的观感 | 目视；留空能提交 |
| B2 | 后台命名的活体效果 | 发一条带空键附件的消息 → 数秒后胶囊标题变成模型生成名（或如实显示「AI 命名不可用」）；**对话流里不得出现任何命名请求/结果消息** |
| B3 | 「不进上下文」的活体反证 | 让 Agent 复述本会话上下文：不得出现命名提示词、命名结果或任何值 |
| B4 | 输入区「粘贴」按钮 | 点按钮后剪贴板文本出现在草稿光标处，**输入框焦点不丢**；被浏览器拒绝时看到固定提示 |
| B5 | 自有输入框的「粘贴」按钮 | 点按钮后内容进入控件且焦点在该控件；掩码输入框仍不泄露（`type=password`） |
| B6 | R3 真登记 | 在值输入框粘贴一个真实 token → 输入框清空、草稿出现标记胶囊、shell 里 `$env:DSH_SECRET_X` 可用；粘贴一段普通文本 → 正常落进输入框（不登记） |
| B7 | R3 失败不吞内容 | 断网/制造 500 → 粘贴的内容仍在输入框里 + 固定错误文案 |
| B8 | ✕＝解绑（staged） | 草稿里移除标记 → ~0.6s 后 `GET /api/secret.attached` 不再是 `staged`（沿用 0.3.0 时序） |
| B9 | ✕＝解绑（bound） | 已发送消息的胶囊点 ✕ → shell 里该变量不再注入；**凭据库记录仍在**（只读键名核对，不打印值）；管理列表该行仍在（可再登记） |
| B10 | ✕ 与真删不混淆 | ✕ 的提示与文案里不出现「删除」；真删仍只在管理面危险面 + `confirm:true` |
| B11 | 移动端/无 hover | 触屏模拟下 ✕ 默认可见且可点；桌面下默认隐藏、hover/focus-within 出现 |
| B12 | 无障碍 | Tab 能到达 ✕ 与粘贴按钮；`aria-label` 被读出；主胶囊点击仍打开详情 |
| B13 | 深浅色与窄宽度 | 胶囊行、粘贴按钮、✕ 在两个主题下都清晰；窄宽度不截断 |
| B14 | 降级 | 在没有 `llm` 服务的 profile 下装上本插件：boot 不炸、命名显示「不可用」、其余功能照常 |

---

## 8. 风险与未决 —— **这些未决项已由用户裁定并实施（裁定结果见 §12.7）**

### 8.1 需要用户拍板

| # | 问题 | 推荐 | 若不采纳的后果 |
|---|---|---|---|
| **U1** | **「自动命名」的结果落到哪？** A＝只改**显示标题**（变量名/凭据键由本地规则在 attach 时确定，零持久副作用）；B＝改**凭据键**（需两次持久写 + 人类确认，与「后台静默」冲突）；C＝改**凭据键但命名发生在发送前**（唯一能「键＝模型命名」的合规路径，但与「消息发出后」时序相反） | **A** | 选 B ⇒ 必须新增一次人类确认（`confirm` 或 seam 流程），「后台自动」名不副实；选 C ⇒ 时序与用户原话相反，但实现更简单（键一次成型，无需展示层补丁） |
| **U2** | **「所有输入框」的范围**：是指 ① 输入区 + 本插件自有输入框（推荐，座位系统可达），还是 ② 真的要让**其它插件/宿主的**输入框也出现这个按钮？ | **①** | 选 ② 只能靠 DOM 猴补丁或有偿依赖其它插件改代码；与「不做全局改写」的既有纪律冲突，且会影响别人的无障碍树 |
| **U3** | **R4 的 ✕ 落点确认**：确认是「消息旁胶囊行」（推荐），而不是草稿里的 chip？（后者的 DOM 属编辑器/`projectUserText`，加不了我们的按钮） | 消息旁胶囊行 | 若用户坚持草稿 chip ⇒ 需要另找编辑器扩展点（当前无证据存在） |
| **U4** | **R3 命中后的默认作用域**：`session`（零落盘，推荐）还是 `persistent`（真写库）？ | `session` | 选 `persistent` ⇒ 人类「粘贴一下」就等于写盘，破坏「影响持久状态的动作仍需人类确认」的边界 |
| **U5** | **命名调用的成本与频次**：每个空键附件一次（推荐，≤1 次重试），还是合并批处理？ | 每个附件一次 | 批量 ⇒ 需要一个队列与去重状态机，收益仅省几次小请求 |

### 8.2 风险表

| 项 | 说明 | 处置 |
|---|---|---|
| R1-1 | 借 `purpose:'session-title'` 拿「思考关闭」在语义上是一次「蹭」 | 只蹭参数语义、不蹭服务；prompt 明确是「命名凭据键」；在 README 如实写明「命名调用借用了宿主的 `session-title` 目的位以获得最低推理开销」 |
| R1-2 | 非 DeepSeek 适配器可能没有 `off` | 不显式传 effort ⇒ 最坏只是按模型默认；失败即 `unnamed`，不影响主流程 |
| R1-3 | 模型输出可能含中文/标点 | 白名单校验后丢弃并保持人类标题，**不做**花式清洗 |
| R1-4 | 命名结果进内存 meta，重启即失 | UI 与 README 如实说明（与历史「纯内存」口径一致） |
| R2-1 | `readText()` 被浏览器拒绝 | 固定提示 + 手动粘贴；沿用第一方 try/catch 约定（`client.excel.js:130179`） |
| R2-2 | composer 只能插入、不能写值 | 如实写进 README 与按钮行为（§2.2 B3）；不猴补丁 |
| R3-1 | 误报把普通文本登记成密钥 | 规则 8 的保守裁决 + 人类可一键 ✕（staged 时等价于丢弃）；`Config.pasteAutoAttach=false` 可整体关闭 |
| R3-2 | `preventDefault` 后失败导致内容丢失 | 硬性回填（§3.3.2）+ 专测（A4.3） |
| R4-1 | 嵌套按钮的非法 HTML | 结构改为容器 + 两个按钮（§2.4 D1） |
| R4-2 | ✕ 与详情面点击混淆 | `stopPropagation` + 单测（A4.4）+ 真机确认（B12） |
| R4-3 | 触屏无 hover | `@media (hover:none)` 默认显示（无定时器） |
| N-1 | 命名 prompt 里混入明文 | `renderNamingPrompt(label, shape)` 只接受两个本地量；单测对哨兵 0 命中 + 正对照（A2.4） |
| N-2 | 借 `sessionId` 让服务"顺手"记录 | 定案明令**不传** `sessionId`、**不调用** `session.append`；单测断言 append 零调用（A2.4） |

---

## 9. 由本定案直接决定的实施顺序

1. `privacy.ts` + `provisionalKey` + `parseAttach` 放宽（纯逻辑，A2.1–A2.2 先绿）。
2. Host 命名执行器（假 llm 端口 + 「不写会话」断言，A2.4–A2.6 绿）。
3. Client：字段重排 + 三个粘贴按钮 + `onPaste`（A4.1–A4.3 绿）。
4. Client：胶囊两件式 + ✕ 分流（A4.4 绿）。
5. 输入区右侧座位注册 + 缺座位降级（A4.6 绿）。
6. 文案键与 README 同步（含 U1–U5 的最终裁决）。
7. 三连 + A5 静态判据；B 段交独立验证（B1–B14 逐条人工结论或「未验证」，不得推定）。

---

## 10. 调研：用户按下「发送」这条链路的可挂载点（t25）

> 用户原话：「这个按下后没有 hook 点可挂吗？」（针对输入区那颗 `button aria-label=发送消息`）。
> 本节只读调研：结论 + file:line。下文 `$C = $H/dsh-client-ui-conversation/lib`，`$T = $H/dsh-client-ui-input-trigger/lib`，`$R = projects/cordis-plugin-secret`；行号为 0.4.3 工作树实测。

### 10.1 那颗按钮本身：**没有座位、也没有独立事件**

- 会话座位全集（`$C/lib/types/client/contract/slots.d.ts:122-310`）：`main.conversation`、`conversation.session`、`conversation.header*`、`conversation.view`、`conversation.composer`、`conversation.hero.*`、`conversation.input.{dock,overlay,left,right,activity,attachments,plan,permission,model}`、`conversation.composer.bar`、`conversation.composer.dock`、`conversation.content` —— **没有任何 submit/send 座位**。
- `conversation.composer.bar` 是 `kind:'single'`、owner 是 shell（`slots.d.ts:246-250`）；它的注入面 `ComposerBarInjected` 里**没有** submit 回调，只有 `keyboard`(包内私有)、`addFiles`、`removeAttachment`、`resolveDraftAttachments`、`retryFileUpload`、`toggleCommandMenu`、`stop` 与 `hooks`（`slots.d.ts:447-477`）。
- 键盘/DOM 命令面**包内私有**：`ComposerKeyboard` 注释逐字「Handed to the composer-bar entry through its own inject — **package-internal, never across a plugin boundary**」（`$C/lib/types/client/contract/draft-editor.d.ts:25-27`）。
- **按钮 ≡ Enter（同一 gesture）**：`$C/lib/types/client/input/submission-policy.d.ts:12-16`「Plain Enter and the primary Send button **share the `enter` gesture**, so the button delivers exactly what Enter would.」；实现两处：按钮 `keyboard.submit(primarySubmitMode, "click")`（`$C/lib/client.js:17415`）、Enter `keyboard.submit(resolveSubmitMode(..., "enter"), "enter")`（`:16839`）；两条路径都走 `resolveSubmitMode(…, "enter", …)`（`:17405` / `:16839`），**唯一差别是 `source` 标记 `'click'` / `'enter'`**；`draft-editor.d.ts:37-38` 的分类注释同旨（「Enter gestures and the primary Send button」）。
- **`disabled:true` 时不触发任何东西**：`primaryDisabled = primaryStops ? … : empty || disabled || machineBusy || uploadsPending`（`$C/lib/client.js:17403`），`onPrimary` 自己再 gate 一次（`:17415`）；即使漏过，机器对空草稿也直接 `return []`（`:3913`）。
⇒ **能不能做到**：**不能**在这颗按钮上挂任何东西（无座位、无事件、DOM 属 shell）。**要挂就挂提交管线**（§10.2）。

### 10.2 提交链（客户端）与「能不能改 / 能不能挡」

1. Enter / 按钮 → `keyboard.submit(mode, source)`（`$C/lib/client.js:16839` / `:17415`）。
2. 机器 `onEnter(mode, draft, submission)`（`:3900-3924`）四分支：**已有在飞提交**（`adjudicating|submitting`）→ `return []`；空草稿 → `return []`；**以 `/` 开头** → 发 `adjudicate` 效果（phase=`adjudicating`）；**其余（普通消息，含以 `@` 开头）→ 直接 `detachedEffects(...)`＝`[default-sink, commit-draft]`，完全不做裁决**（`:3912-3923`）。
3. `/` 开头才进裁决：`adjudicate(attempt, draft)` → `inputTriggers.adjudicate(draft.trim(), attempt.signal, { attachments: this.attachmentIds.length })`（`$C/lib/client.js:14068-14078`）⇒ **envelope 只有附件个数**（`SubmitEnvelope{readonly attachments:number}`，`$T/lib/types/types.d.ts:91-94`）。
4. 控制器按**行首字符**挑 roster 并**逐个 await**：`if (src.matchEnter === void 0 || !line.startsWith(src.trigger)) continue; const outcome = await src.matchEnter(projection, line, signal, envelope)`（`$T/lib/client.js:646-654`；注释「Enter last adjudication: polls sources' matchEnter in registration order, first non-undefined wins」）。
5. 源可**拒绝**：`matchEnter` 抛错 ⇒ `adjudication-failed` ⇒ 通知 + 阶段回 `plain` + **本次提交中止**（`$C/lib/client.js:3944-3951`）；类型注释逐字「a source that would consume the line but cannot consume the whole envelope **throws to surface the refusal and leave the submission intact**」（`$T/lib/types/types.d.ts:164-174`）。
6. 源可**改写/吞掉**：`PickOutcome = {claim} | {insert} | {text,continue?} | 'handled' | undefined`（`$C/lib/types/client/contract/input.d.ts:52-59`）；claim → `begin-submit`（`onAdjudicated` `:3928-3937`）；**其它非 undefined 结局 → 提交被消费、不发送**（`:3940`）；`undefined` → 默认发送。
7. 默认发送：`default-sink` + `commit-draft`（`$C/lib/client.js:3889-3898`，注释「Default-send effects capture the sink input **before the editor commit**」）。
8. 真正落地：`session.beginSubmission({mode,text,attachments,onRetire})`（**同步本地回显**）→ `await nextPaint()` → `await serializeAttachments()` → `await session.prompt(content, mode, signal, submission.requestId)`（`$C/lib/client.js:3443-3463`）。
9. **提交前我们自己能跑的最后一个回调**：`codec.serialize`（每个 chip occurrence 一次），逐字「Prompt serialization before the sink: expand each chip occurrence to its owner's **model form** via the session controller's codec routing. **Owner missing or serialization failure rejects the detached send and restores its editor snapshot.** Chip-free drafts skip the async detour.」（`$C/lib/client.js:13943-13954`）；契约「`serialize(ref, signal): Promise<string>` … async, abort rides the attempt signal; **failure blocks the send** — never a silent downgrade to the clipboard text」（`$T/lib/types/types.d.ts:122-127`）。本插件的 codec：`$R/src/client/entry.ts:5082-5083`（`clipboardText`＝草稿/剪贴板投影，`serialize`＝模型形态）。
⇒ **能不能做到**：**`/` 开头的草稿**能（claim/insert/text/handled 改写，或 throw 拒绝）；**普通草稿不能**（机器只对 `/` 进裁决：`:3914`，控制器也只认行首字符：`$T/lib/client.js:650`）。**对本插件尤其重要**：我们的 `@` source **没有实现 `matchEnter`**（`$R/src/client/entry.ts:5034-5083` 只有 `onPick`/`lexicon`/`codec`），而且即使实现了，`@` 开头的草稿也不会被裁决 ⇒ **`matchEnter` 对本插件不是一条可用路**；我们能干预的唯一提交前回调，是「草稿里含我们的 chip」时的 `codec.serialize`。

### 10.3 客户端「发送状态」：发送 vs 手工清空

- `InputState`（`$C/lib/types/client/contract/input.d.ts:236-255`）：`draft / attachmentIds / draftRev / phase:'plain'|'adjudicating'|'claimed'|'submitting' / claim? / occurrences / queue`。**`InputState` 里没有 `pendingSubmission` 字段**——那个名字属于**会话快照**（下一条）。
- **乐观清空草稿的确切位置**：效果 `commit-draft`（类型注释 `input.d.ts:353-363`「Clear the committed draft in the editor and cut undo history. A string snapshot keeps a pure suffix typed during the Host round-trip …」）→ 执行器 `commitDraft(retainSuffixOf)`：`this.draftEditor.clearCommittedDraft(clip => { if (retainSuffixOf !== null && clip !== retainSuffixOf && clip.startsWith(retainSuffixOf)) return retainSuffixOf.length; return null })` + `clearHistory()`（`$C/lib/client.js:13936-13942`）；快照来自 `SubmitAttempt.draftSnapshot`（`mintAttempt` `:3864-3870`；`retainSuffixOf` 赋值 `:3896-3897`）；附件-only 发送用 `null`（`:4006-4007`）。
- **「刚发出」的可判别信号**：`SessionSnapshot.pendingSubmissions: readonly PendingSubmission[]`（`...\dsh-api-session-controller\lib\types\client\contract\snapshot.d.ts:60-61`）；`PendingSubmission` 字段 `requestId / placement:'transcript'|'queued'|'steering' / time / **text** / attachments`（`:38-49`，逐字「inserted synchronously when a submission begins … **Client-memory only**」）。
- **注册与退休时机**：`ISession.beginSubmission(input)` 逐字「Register one local submission echo in `snapshot.pendingSubmissions`, **synchronously, before the caller serializes and sends the prompt**. … Chat echoes persist until durable admission; transcript identities also wait for the Inbox claim watermark … Queued echoes retire on queue acceptance. Identified failures retire submissions that have not already reached durable admission.」（`...\contract\session.d.ts:63-73`）；实现即 `$C/lib/client.js:3443-3451`。
- **时序（谁先谁后）**：`beginSubmission`（同步回显）→ `nextPaint()` → 序列化 → `prompt()`（RPC）→ durable `user/message` → 回显退休；而草稿清空（`commit-draft`）与 `default-sink` 同批效果、**在 RPC 之前**（`:3889-3898`）⇒ 这正是「乐观」的确切含义。
⇒ **能不能做到**：**能**。`pendingSubmissions[].text`（+ `InputState.phase/draft/draftRev`）足以区分「刚发出」与「人手工删空」——本插件 0.3.0 的 `submissionCarries` 判据正是这条。

### 10.4 宿主侧：发送后、进模型前/后的钩子

- **`agent/pre-step`（waterfall）**：`'agent/pre-step'(this: Scoped<Agent>, payload: { agent; messages: UserMessage[]; turn; step; signal }, next) => Promise<PreStepDecision>`；`PreStepDecision = {kind:'reject'} | {kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true}`；描述逐字「**Reject a proposed step or replace the messages that enter it.** Calling `next()` preserves the current messages.」（host Event 目录实测：`cordis_inspect_query(host, Event, listEvents, {event:'agent/pre-step'})`）⇒ **能拿到进入该步的消息、能替换、能拒绝**（作用域 agent）。**但它在发送已被承认之后**，替换出的 `messages` 会成为 durable 内容（本插件第三轮正因此放弃改用户正文）。
- **`session/event`（emit）**：逐字「**Post-commit**, fire-and-forget append feed」（同目录）⇒ **本插件现在就是用它在消息落盘后完成附件绑定**，这是「发出后」最可靠的观测点。
- 其它可用观测：`agent/inbox/inserted` / `agent/inbox/claimed`（emit，带 `message: UserMessage`）、`agent/turn-stopping`（serial）、`agent/status`（idle⇄running）、`session/flush`（awaited parallel）。**不存在 `agent/post-step`**。
- **能否在其中发起会话外模型调用**：**能**。以上都是普通监听器；t24 已证明 `ctx.llm.stream(GenerateOptions)` 是「不写会话」的纯流式调用（§2.1 A1–A6）。在这些钩子里 `void naming(...)` fire-and-forget 即可——**不要 await 阻塞 step**。
⇒ **能不能做到**：能观察，也能在 `agent/pre-step` 里改/拒；但改写会落盘，因此**只用于观察 + 后台任务**。

### 10.5 四种典型用途该挂哪条

| 用途 | 该挂哪条（按优先级） | 能不能 |
|---|---|---|
| (i) 发送时做一次**本地登记** | 若登记对象是**我们自己的 chip**：`codec.serialize`（提交前；可 throw 拒绝并恢复编辑器快照）；若要针对**任意消息**：提交前**没有**钩子（普通草稿不裁决）⇒ 只能退到宿主 `agent/pre-step` / `session/event`（**发送后**） | 部分能（见左） |
| (ii) **发送后触发后台命名** | 本插件**已有的** `session/event` 绑定点（消息落盘后），或 `agent/pre-step` + `ctx.llm.stream`（fire-and-forget）；客户端可另用 `pendingSubmissions` 观察 | **能** |
| (iii) 发送时**改写/附加内容** | `/` 开头草稿：`matchEnter` 的 claim/insert/text/handled（或 throw 拒绝）；**普通草稿没有提交前钩子**；想改内容只能在**提交前**改草稿：`InputActions.setDraft/insertText`（`input.d.ts:216-217`）或 scoped 事件 `slash/input-insert-text` / `slash/input-insert-reference`（`input.d.ts:128-146`）；宿主 `agent/pre-step` 替换 `messages`（**会落盘**，慎用） | 分情况（见左） |
| (iv) **仅观察不干预** | 客户端：`SessionInput.state`（`SnapshotStore<InputState>`，`input.d.ts:192-193`）+ `SessionSnapshot.pendingSubmissions`；宿主：`agent/inbox/inserted` / `session/event` / `agent/pre-step`（调 `next()` 原样放行） | **能** |

### 10.6 对 R1 的直接影响（收敛 t24 §3.1.3 / §8.1 U1 的结论）

1. **「发出后再命名凭据键」依然受约束**——发送后**任何**钩子都改不了变量名。理由链（全链已核）：普通草稿在 `onEnter` 直接进 sink（`$C/lib/client.js:3923`）→ `prompt()` 把文本送进会话（`:3463`）→ 本插件在 `session/event` 上按正文标记绑定 → 记录键/变量名由 `name` 派生（`$R/src/naming.ts:55/63-70`）；正文是 durable 用户消息，事后改名只会留下一个指向不存在变量的标记。
2. **「发送前/发送时命名」确实存在一条技术通路，但不建议**：`codec.serialize` 是 **async**、**每 occurrence 一次**、且**失败会拒绝发送并恢复编辑器快照**（`$C/lib/client.js:13949` + `$T/lib/types/types.d.ts:122-127`）⇒ 理论上可在其中 `await` 一次模型调用再决定 model 文本；代价是把人类的发送**卡在一次网络往返**上（N 个 chip = N 次，除非按变量缓存），与「后台、不阻塞」直接冲突。⇒ **t24 §8.1 U1 的推荐 A 不变**（本地规则定键、模型只改显示标题）；若用户坚持「凭据键＝模型命名」，唯一体面的实现是 **C：在 attach/插入 chip 时就命名**（发送之前），而不是在提交钩子里。
3. **「发送后」的触发点现在有了确切落点**：本插件已有的 `session/event` 绑定点（消息落盘后）⇒ 命名在**绑定成功之后**触发，不阻塞发送、不阻塞 step，与 t24 §3.1.3 一致。
4. **一条实施告诫**：`matchEnter`/`matchSpace` 对本插件**不可用**（未实现 + 非 `/` 草稿不裁决），任何「发送时拦截」的设计都不要再指望触发源钩子。

---

## 11. 调研：输入区选中文本的读取能力与「转为密钥」按钮落点（R5 / t26）

> 用户原话（R5）：「新增一个用户选中输入区的文本后将『附密钥』按钮变为『转为密钥』的功能」——有选中文本时按钮文案与行为变为「转为密钥」（点击把**选中文本**登记为密钥并替换为标记胶囊）；无选中时保持「附密钥」。
> 只读调研。`$C = $H/dsh-client-ui-conversation/lib`，`$R = projects/cordis-plugin-secret`；行号 0.4.3 实测。

### 11.1 能否感知输入区选区：**能，但是 pull 式（只有按需读取，没有推送）**

- 公开的动作面就有「取当前选区」：`InputActions.captureInsertion(): TokenSpan`，类型注释逐字「**@returns a revision-guarded copy of the current editor selection**」（`$C/lib/types/client/contract/input.d.ts:206-208`）。
- `TokenSpan` 的形状（`$C/lib/types/client/contract/draft-editor.d.ts:5-10`）：
  `interface TokenSpan { readonly start: number; readonly end: number; readonly draftRev: number }` —— **半开区间 [start, end) + 编辑器修订号**。
- 实现（两处）：`captureInsertion: () => ({ ...this.caretSpan(), draftRev: this.rev })`（`$C/lib/client.js:13463-13466`）；被展开的 `caretSpan()` 逐字「if (this.projection.selection !== null) return this.projection.selection; const at = this.projection.detectText.length; return { start: at, end: at }」——**有区间选中就返回该区间，没有选中就返回「文档末尾的塌陷 span」**（`$C/lib/client.js:13281-13288`，另一层委派在 `:13718-13720`）。
- **坐标空间（关键）**：`captureInsertion()` 的 `start/end` 是 **detect 投影坐标**（`EditSelection` 逐字「Half-open [start, end) range/selection in **detect-projection coordinates**」，`draft-editor.d.ts:69-73`；`caretSpan` 注释同旨 `:47-52`），而不是 `InputState.draft` 所在的坐标（见 §11.2）。
- `InputActions` 其余成员的确切语义（`input.d.ts:206-226`）：`insertText(text, span)`「Insert asynchronous text without replacing subsequent edits or reference chips … @returns false when the draft changed or submission locked the editor」；`setDraft(text)`「**Replace the whole draft**（persisted-draft seed and programmatic writes）」；`addAttachments/removeAttachment/pruneAttachments`；`submit()`。**没有任何"返回文本"的成员**。
⇒ **能不能做到**：**能拿到"选区在哪"（区间 + 修订号）**，但**拿不到"选中了什么文本"**；后者必须自己做坐标换算（§11.2）。**注意一个陷阱**：`start === end` 既可能是"没选中"也可能是"光标在末尾"——对 R5 而言两者都等于"没有选中文本"，所以判据就写 `start !== end`。

### 11.2 能否读草稿全文与位置：**能，且两个投影空间可以自己换算**

- **草稿全文有公开读面**：`InputState.draft`，逐字「Clipboard-text projection of the editor document (chips expanded to their clipboard form)」（`input.d.ts:237-238`）；插件的 slot 组件本来就拿得到：props 里有 `useInput: SnapshotSelectorHook<InputState>`（`$C/lib/types/client/contract/slots.d.ts:336`，可选版 `:344`），本插件已在用（`$R/src/client/entry.ts:3235-3266` 读 `state.draft` / `state.phase`）。**没有**与 `setDraft` 对称的"读文本"函数——读一律走 `useInput`/`InputState`。
- **位置有公开读面**：`InputState.occurrences`，逐字「Reference occurrence view of the editor's chips, sorted by offset」（`input.d.ts:251-252`）；每个 `Occurrence` 带 `offset`（"Offset in the **clipboard-text projection**"）、`length`（"the occurrence occupies exactly `[offset, offset+length)`"）、`source`、`ref`、`label`、`clipboardText`（"Clipboard / persistence projection, e.g. `/name`"）（`draft-editor.d.ts:82-101`）。
- **两个投影空间的差别（逐字）**：`detectText`「Trigger/TokenSpan coordinate text (**chip = one U+FFFC**)」；`clipboardText`「Persistence/InputState draft text (**chip = clipboardText**)」；`ATOMIC_CHAR = "\uFFFC"`（`$C/lib/types/client/input/editor/projection.d.ts:4-13, 63-70`）。文本段（text/linebreak/gap）在两个空间里**逐字相同**，差别只来自 chip 的展开长度。
- ⇒ **选中文本的算法（只用公开数据）**：令 `occ_i` 按 `offset` 升序排列，`len_i = Occ.clipboardText.length`；第 k 个 chip 的 detect 偏移 = `offset_k − Σ_{j<k}(len_j − 1)`；据此把 detect 区间 `[start,end)` 折回 clipboard 区间，再 `draft.slice(...)`。**特例**：若 span 结束点之前没有任何 chip，两个空间在该前缀上完全一致，直接 slice 即对（这也是最常见的情形：用户刚粘进/键入一段 token）。
- 包内确实有一个现成的折叠函数 `detectOffsetOfClipboardOffset(layout, clipboardOffset)`（`projection.d.ts:53-62`），但它需要内部的 `ComposerLayout`、**不出现在公开 provide 通道里**，且只有 clipboard→detect 一个方向 ⇒ 插件只能按上面的公式自己算。
⇒ **能不能做到**：**能**。读全文用 `useInput(s => s.draft)`，读 chip 位置用 `useInput(s => s.occurrences)`，选区区间用 `captureInsertion()`；换算依赖一条**有文档的不变量**（chip 在 detect 空间恰为 1 个 `U+FFFC`）。

### 11.3 选区变化的通知面：**没有（公开面完全不存在）**

- 公开的 `InputState` 字段只有 `draft / attachmentIds / draftRev / phase / claim? / occurrences / queue`（`input.d.ts:236-255`；实现里 `compose()` 的字段集见 `$C/lib/client.js:14140-14149`）——**没有 selection / caret / selectedText**。
- 内部的投影**是**有选区的：`EditorProjection.selection`（"Range selection in detect coordinates (ordered); null while absent or non-range"）与 `EditorProjection.caret`（`projection.d.ts:71-77`），但它们**只到 shell 为止**，不进 provide 通道。
- 而且**选区变化不会触发任何发布**：`rev += 1` 与 `draft-changed` 派发都被 `projectionContentChanged(...)` 把关（`$C/lib/client.js:13529-13541`），而该函数的注释逐字是「**Whether two projections differ in content (selection and caret excluded)**」，函数体只比 `clipboardText` / `detectText` / occurrences 的 id 与 invalid（`$C/lib/client.js:13433-13442`）。⇒ 用户只是移动光标/拖选，**既不会 bump `draftRev`，也不会 publish `InputState`**。
⇒ **能不能做到**：**不能**用公开面订阅"选区变了"。唯一合规的时点是**动作发生的那一刻**（按下/点击我们的按钮）再 `captureInsertion()` 读取。

### 11.4 替代路径与越界程度（含明确取舍建议）

| 路径 | 可行性 | 越界程度 / 风险 | 建议 |
|---|---|---|---|
| **A. 按下/点击时 `captureInsertion()` 判定**（公开动作面） | 完全可行 | 零越界（`InputActions` 就是给 session-scope 座位组件的公开面，`input.d.ts:200-205`） | **采用（基线）** |
| **B. `onMouseDown` 时读一次并改文案**（仍是 A 的 API，只是提前到按下） | 可行 | 零越界；本插件按钮**已经**在 mousedown 里 `event.preventDefault()`（`$R/src/client/entry.ts:3204-3206`），说明按下时编辑器选区确实还在 ⇒ 加一次 state 更新即可，文案在**按下的瞬间**切换 | **采用（"实时文案"的合规版）** |
| **C. `document.addEventListener('selectionchange')` 并限定在 composer 有焦点时** | 可行但**契约外** | DOM 层监听：DSH 自己内部也在用（`$C/lib/client.js:5340` 给 root 挂 `selectionchange`），但契约把输入区的键盘/DOM 命令面声明为**包内私有**（逐字「The InputBar-exclusive keyboard/DOM keyed face … Handed to the composer-bar entry through its own inject — **package-internal, never across a plugin boundary**」，`draft-editor.d.ts:23-31`）。监听不是禁止，但**读别人 contenteditable 的 DOM 选区**在 Lexical 下可能碰上 NodeSelection/chip 边界，且等于把"是否选中"的事实来源从公开面挪到 DOM | **仅作可选增强**，且必须在实现里标注它是契约外的 DOM 兜底、要 feature-detect + 防抖 |
| **D. 退化：不读选区，按整段草稿/光标处处理** | 可行 | 零越界，但直接丢掉 R5 的语义（"用户选中的那段"变成"整份草稿"） | **不建议**（只有在 A/B 都不可用时才考虑） |
| **E. 退化：只改行为不改文案** | 可行 | 零越界 | 不满足 R5（用户要的是文案变化） |

**明确取舍建议**：走 **A + B**——用公开动作面在**按下时**读 `captureInsertion()` 决定文案、在**点击时**用同一个读取结果决定行为（两次读取同一状态，或按下时缓存下来给 click 用）。**不要**用 `window.getSelection()` 去读别人的 contenteditable；如果用户坚持"不按下也要实时变文案"，就再加 C，并在文档/代码注释里如实写明它是契约外的 DOM 增强。

### 11.5 落点：我们那颗按钮（文案切换纯属我们自己的渲染）

- 座位：`const ATTACH_SLOT = 'conversation.input.left'`（`$R/src/client/entry.ts:1268`），注册 `ctx.slots.inject(ATTACH_SLOT, () => ctx.slots.register({ name: ATTACH_SLOT, id: 'secret-attach-toggle', … }))`（`:5293-5297`）。
- 组件与文案**都是我们的**：按钮 `h('button', { type:'button', 'data-secret-attach-toggle':'true', 'aria-pressed': open, 'aria-label': open ? t('toggleOpen') : t('toggle'), title: t('toggleHint'), onMouseDown: preventDefault, onClick: … })`（`:3195-3219`）；文案键 `toggle: '附密钥'`、`toggleOpen: '收起附密钥'`、`toggleHint: '把一枚密钥附加到这条消息…'`（zh `:1350-1352`，en `:1501` 一带）。
- ⇒ **文案/行为的切换没有任何机制障碍**：它是我们自己的组件、自己的字符串、自己的 onClick；唯一需要"外来信息"的是"当前有没有选中文本"（§11.1）。
- 实现落点（供实施参考）：在既有的 `SessionAttachToggle` 组件里加一个 `const [selected, setSelected] = React.useState(0)`；`onMouseDown` 里 `const span = props.inputActions?.captureInsertion?.()` 后 `setSelected(span && span.start !== span.end ? 1 : 0)`；`onClick` 里若 `selected` 则为 → 走 §3.3 的登记链路（attach + `insertChip` 替换区间）并把标签显示为「转为密钥」，否则保持既有「附密钥」行为。

### 11.6 明确回答

**R5：可做**（行为与文案都能落地，且主路径完全在公开契约内）。
**推荐路线一句话**：在**按下时**用公开动作面 `captureInsertion()` 读选区（`start !== end` ⇒ 文案变「转为密钥」）、在**点击时**用同一读取结果决定行为——选中文本由 `useInput(s => s.draft)` + `useInput(s => s.occurrences)` 按 §11.2 的公式换算得到，再走 R3 的既有登记链路（`attach` 真登记 + `insertChip` 替换该区间）；**不读 DOM 选区**，"不按下就实时变文案"只能作为契约外的可选 DOM 增强（`selectionchange`）并如实标注。

---

## 12. 实施结果（0.5.0）——逐节对照（上文原文保留为历史依据）

> 本节是**事后**补写的事实登记：R1–R5 **已全部实现**（代码随 0.5.0 提交）。上文各节保持定案当时原文不改写；**已落地 / 有差异 / 被取代**逐条列在这里。上文行号是 0.4.3 干净工作树的实测，实施后已漂移，引用时以语义为准。

### 12.1 §3.1 R1 · 密钥键可选 + 后台命名 —— 已落地

- `secret_attach` 的 `name` **可选**：空 / 缺 ⇒ Host 自动命名（旧客户端与直接调用得 200）；**非空但非法**仍走原来的错误分支（`ATTACH_KEY_RE`）。
- 命名是**会话外**调用（`purpose: 'session-title'`、不传 `sessionId`、不传 `tools`、**不 append 任何会话事件**）；deadline **1500ms**；超时 / 答案非法 / 无 llm 一律回落**本地兜底键**（标题 slug → 形态默认 → 冲突加 `-2…-99`）。**发送永不被阻塞**（单测 `elapsed < 500ms` 钉住）。
- llm **可选**（`ctx.get('llm')`，不进硬依赖 `inject`）：没有 llm 的 profile **插件仍激活、attach 仍成功**（有正对照测试）。
- **未实现（明确写成"不做"）**：§3.1 里「**晚到结果润色显示标题**」——键在插入胶囊（报文标记）**之前**已定型，不存在"不改报文"的安全作用点。**这是不做，不是待办。**

### 12.2 §3.2 R2 · 「粘贴」动作 —— 已落地（7 个字段 + composer 座位）

- **落点比定案更全**：定案按"三种落点"写，实际是**我方 7 个可编辑字段**（附加面板的标题 / 凭据键 / 密钥内容、管理面改值、管理确认卡、索要卡片的值 / 「其他指示」多行框）**外加 composer 座位**。
- 统一属性：`type="button"`；`aria-label` 与可见文本同为「粘贴」；`mousedown` `preventDefault`（**不抢焦点**）；点击**最后一步交还焦点**（按所在行的 input/textarea）。
- **写入与校验同路**：`trim()` 后调用**该字段自己 `onChange` 的同一个 setter**（不 `dispatchEvent`、不直接改 DOM）。
- **剪贴板失败**：新增 3 个双语键 `pasteUnavailable` / `pasteDenied` / `pasteEmpty`（无第四套文案），不静默失败、不抛未捕获异常（有 `unhandledRejection` 断言）。
- **composer 半边**：官方座位 `conversation.input.right`（`kind:'list'`, `scope:'session'`；id `secret-paste-composer`，order 40）→ `InputActions.insertText(text, captureInsertion())`。**边界（如实）**：① 只能 `captureInsertion`/`insertText`，**无受控 value 写入能力**；② **第三方插件自建的输入框不在覆盖范围**；③ 无 caret / 编辑器拒绝插入时给手动粘贴提示，不抛错、不抢焦点。

### 12.3 §3.3 R3 · 值输入框粘贴命中 ⇒ 真登记 —— 已落地（仅值输入框）

- **规则集落在新模块 `src/privacy.ts`**：可枚举的 5 条规则（pem / jwt / vendor-prefix / long-concentrated / high-entropy）＋ 10 条排除项 ＋ 8 个阈值，**纯函数、不调模型**。
- 客户端半因「经典 script、产物 0 import/export」**无法 import** 该模块 ⇒ 采用**镜像 + 一致性测试**：规则集 / 排除集 / **全部 8 个阈值**逐值相等，45 条语料逐例同判；漂移实验（单侧改 `longTokenMinLength` 32→33）必红、恢复后绿。
- **命名被取代（如实标注）**：本节原文的 `looksLikeSecret(text) → { hit, category, reason }` **已被实现取代**为 `classifyPastedText(raw) → { secret, rule?, exclusion? }`（语义一致、命名与返回形状不同）。**以实现为准**。
- 两条路径（原生 `onPaste` 与我们自己的按钮）**同一行为**：命中即走该表单**同一条** attach 注册路径（真登记：同一校验、同一 `POST /api/secret.attach`），成功后清空字段并按既有行为切详情面；未命中保留浏览器默认行为（**不吞文本**）；任何失败 `setValue(原文 + 粘贴内容)`。
- **范围**：**只覆盖值输入框**；改值面 / 管理确认卡（`secret_manage`） / 索要卡片（`/api/secret.answer`）**不自动登记**（否则是"假登记"）；`@DSH_SECRET_*` / `[secret …]` / `dsh-resource://` 引用文本在分类器**第一步**排除。

### 12.4 §3.4 R4 · 胶囊 ✕ ＝解绑 —— 已落地

- **语义**：✕ = **本会话解绑**（`staged` → release；`bound` → manage `unbind`），**库中持久记录永不触碰**；文案与 `aria-label` **不含「删除」二字**。
- **会话级后果（诚实结果）**：同一变量的**所有**消息旁胶囊都会消失（由「胶囊状态从实时有效性推导」保证）。
- **bound 的 ✕ 不弹二次确认**：宿主 `src/service.ts:1050-1053` 明写该路由上「人的点击本身就是确认」；只有真删那一档需要 `confirm:true`。
- **显隐**：默认隐藏 / `:hover` / `:focus-within` 显示 / `@media (hover:none)` 常显；`aria-label` 形如 `移除 @DSH_SECRET_X`（**不含明文**）。
- **历史缺陷（0.4.x）与修复（0.5.0）**：0.4.x 的胶囊行在真实页面把**原始 i18n key** 渲染成文案与 `aria-label`（行内翻译绑到 chat namespace，取不到本插件的键）⇒ **那一版该行的可访问名是坏的**。0.5.0 用 `rowT` 探测回落修好（取不到就回落自带字面表）。

### 12.5 §5 文件级改动点 / §6 兜底阶梯 —— 落地情况

- 实际改动：**新增** `src/privacy.ts`；修改 `src/client/entry.ts`、`src/naming.ts`、`src/service.ts`、`src/index.ts`；测试修改 `test/unit.test.ts`、`test/register.test.ts`、`test/client-attach.test.ts`、`test/client-card.test.ts`。**没有**新增路由、**没有**新增 `dsh.client.inject` 项、**没有**新增测试文件（`test/` 仍 8 个）。
- §5.1「先做（纯逻辑，先绿）」与 §5.3「Client」按计划完成；§6 兜底阶梯**未新增层级**：R1 回落本地键 + 去重，R3 未命中/失败回字段，R5 换算不一致退回「附密钥」。

### 12.6 §7 验证清单 —— §7.0 已达成 / §7.1 仍待真人

- **§7.0（可机器证明）已达成**：`npm test` **171/171 通过、自然退出**（本段亲跑，原始输出见 README「开发」与提交说明）；`src` 与 `lib` 产物 `import/export` 均为 **0**；装配自检 `[A]/[B] applied OK`、`[C] scoped sees locale,inputTriggers,sessions`；受保护文件（`.credentials.yaml`、`profiles/web/cordis.patch.yml`）大小与 SHA256 逐字节不变。
- **§7.1（需真人确认）仍未做**：浏览器侧自动填充是否真的不再出现、剪贴板授权提示、以及 §11 的 C（实时文案）——见 §12.7 与 README「已知限制」。
- **测试基础设施两处修正（如实）**：① 渲染器由「所有组件共用一份 state 数组」改为**每组件独立 state**（对齐真实 React 语义）；② 测试 fetch 助手由前缀匹配改为**按 `pathname` 精确路由**——前缀匹配曾把 `/api/secret.attached` 误配到 `/api/secret.attach`。

### 12.7 §8 风险与未决 / §11 R5 调研 —— 裁定与落地

- §8.1「需要用户拍板」的项**已由用户裁定**并全部按裁定实施（含「晚到结果润色显示标题」**不做**、索要卡片**只保留中文**、seam 新增键**仅测试用**）。
- **R5 实现 = §11 的 A + B 基线之上再加 C**：行为以**按下时刻** `captureInsertion()`（`start !== end`）为准；选中文本经 `useInput` 的 `draft` + `occurrences` 换算；**任何不一致退回「附密钥」原行为**；默认作用域 `session`（`DEFAULT_ATTACH_SCOPE` 两处共用）；空键 / 空标题走 §12.1 的自动命名。
- **C 是契约外手段（必须如实读）**：实时文案依赖对 DOM `selectionchange` 的监听。**失效模式**：① 非浏览器环境（无 `document`）**不注册** ⇒ 退回"按下时切换文案"；② 回调抛错被吞掉 ⇒ 同样退回；③ 无可编辑元素聚焦时回答「无信息」（不猜）；④ 选区变化不生成本插件事件 ⇒ 文案可能**滞后一个事件循环**。**注册这一层在本套件里未经执行验证**（测试 React stub 把 `useEffect` 置为 no-op，用例只到 props 层），**也从未在活体 DOM 上验证过** ⇒ **需真人确认**。**行为永不依赖 C**（C 只影响文案实时性）。
- **seam 新增键（全部 test-only，无生产路径读取）**：`ATTACH_CSS`、8 个 privacy 键（`PRIVACY_RULES` / `PRIVACY_EXCLUSIONS` / `PRIVACY_THRESHOLDS` / `classifyPastedText` / `entropyBitsPerChar` / `distinctCharCount` / `isReferenceText` / `hasCjk`）、`ATTACH_EN`、`selectedSpan`、`selectedTextIn`、`liveSelectionCue`、`DEFAULT_ATTACH_SCOPE`；均为常量或纯函数，无状态、不含任何值。

---

## 13. 实施结果（0.6.0）——D1 / D2 / D4b / D5 / t46 / 产物加壳（逐节对照，原文保留）

> 体例同 §12：**上文原文一律不删**；这里只写 0.6.0 的**已落地 / 被取代 / 属用户变更**。版本状态：截至本轮文档段，`package.json` 仍是 **0.5.0**，0.6.0 **尚未 bump、未发布**（发布事实由发布任务在 bump 后写）。
> **证据来源纪律**：凡标「证据来源：t·」的，是**他人**的验证/实现报告，本文件只转述；未标注的条目是本文件作者可自证或直接读代码/亲跑得到的。

### 13.1 §3.2 的 composer 半边 —— **被用户裁定取代（删除按钮）**

- **用户原话（需求变更）**："官方的底部输入区的外置的那个「粘贴」按钮没什么用，按下也是正常粘贴，没有询问是否转为胶囊，直接删掉"。
- **落地**：composer 座位上的「粘贴」按钮**及其剪贴板读取路径**已删除（`SecretComposerPaste` 的 `pasteAction({…})` 与只服务它的 `insert()`）；**座位 `conversation.input.right` 保留**，用途变更为 **§13.3 接管提示的渲染位**。
- **为什么**：它与 Ctrl+V 接管构成**同一意图的两种行为**（按钮＝纯粘贴且会弹剪贴板授权；Ctrl+V＝智能接管）。**这不是实现缺陷，是用户的需求变更**，故 §3.2 中关于"composer 放一个粘贴按钮"的契约部分**自本条起失效**，其余（7 个字段按钮）继续有效。
- **删后现状**：composer 侧**只剩接管路径**——不再读剪贴板、不再弹授权、不再有自己的粘贴按钮；我方 **7 个字段按钮一个都没少**（源级 `pasteAction({` 计数恰 7、composer 区间 0 处，是防回退断言）。

### 13.2 §3.3 的"粘贴命中即真登记" —— **被 D2 取代（先提议、不登记）**

- **现行行为**：在值输入框（胶囊「密钥内容」）粘贴**命中规则**的文本时，**先弹确认条、不做任何登记**——未选择前 **0 请求、不清空、不关面板、不切详情面**；两个显式答案是**「登记为密钥」**（`pasteAskRegister`，走同一 attach 真登记路径）与**「按普通文本粘贴」**（`pasteAskText`，按普通文本写入、0 请求）；确认条带 `data-secret-paste-ask="value"`。
- **取代范围**：§3.3 里"命中即 register"的时序描述由本条取代；§12.3 记录的其它结论（规则集所在模块、只覆盖值输入框、引用文本第一步排除、失败回写原文）**仍然有效**。
- **证据来源：t49 真机四条**（选择前 attach=0、字段未清空、面板未关、未切 detail；两个答案各自的后果）。

### 13.3 composer 粘贴接管（t46）—— 新增事实，0.6.0 起是 composer 侧唯一粘贴行为

- **能力面**：**capture 相位**监听 `paste`（`doc.addEventListener('paste', onPaste, true)`，`entry.ts:3814`），仅对 composer 输入区内、命中隐私规则的文本接管。
- **明文不进草稿**；提示**只含形状名与长度**（`composerAskShape`，如「形状: vendor-prefix · 43」）；两条出路：「转为密钥」（真登记 + 插入引用标记）与「按普通文本粘贴」（原样交给编辑器、0 新增请求）；**不命中即一次性原生放行**；**失败不困住用户内容**。提示挂在**我们自己的座位**里（`data-secret-paste-ask="composer"`，`entry.ts:4026`）。
- **失败文案的渲染位点（方法学，供后人）**：**`p[role="alert"][data-kind="error"]`**（主渲染点约 `entry.ts:4949`，行号会漂移，**用选择器**）；同一个文件里 `role="status"` 还用于提示/不可用类文案（如 `:5127` 的 `manageUnavailable`），**不要用它找错误**。
- **真机判据（方法学）**：**不能用 `ClipboardEvent.defaultPrevented` 判断"是不是我方接管"**——编辑器自身（Lexical）也会 `preventDefault`；可归因判据是**我方提示是否出现** + **草稿内容**（明文有没有进草稿、长度变没变）。

### 13.4 D1（输入行对齐）与 D4/D4b（切换会话收起面板）

- **D1**：`.sra_inputRow` 的 `align-items` 由 `center` 改为 **`flex-end`**（`entry.ts:1836`；真机三行 `dyTop +2 / dyCenter +1`，修复前 `−11 / −12`）。**证据来源：t49 真机**。
- **D4/D4b（本条比结论更值得后人记住的是"为什么"）**：面板开关是**模块级 UI 状态**（`attachMode`），而真实会话切换会让组件**卸载重挂** ⇒ **单实例渲染期的会话比较不足以**覆盖真实切换（残留的模块级状态会跟着新会话被渲染出来）。**修法**：mode 带上会话身份 + `noteActiveSession()` 由三个常驻座位在**渲染期**调用，观测到会话真的变了且残留属旧会话就**静默清理**（只改模块变量、不唤醒监听器 ⇒ 同一次渲染读到的已是清空值，不产生"渲染中更新其它组件状态"的告警/循环）；`setAttachModeFor()` 给"明知会话"的调用点显式绑定，**外来身份永不被继承**；`resetSessionObservation()` 供测试清观测。**为什么不走朴素 `useEffect`**：会在**同会话无关重挂**时误关本该开着的面板，且清理发生在提交后、**会闪现一帧**旧面板；反向保护（同会话重挂后面板保持打开）有专门用例。**证据来源：t53 的 RED→GREEN 真机复现 + t49 真机四信号**。

### 13.5 客户端产物加壳（F1 / t47）—— 新增事实与其**边界**

- **现象**：客户端产物原本是**扁平顶层 classic script**；宿主模块系统**按设计会在同一文档再次求值**同一 bundle（`dsh-client-modules/lib/client.js:451-452` 每次新建 `<script>`）⇒ 第二次求值时顶层 `const`/`class` 声明在**解析期**即冲突，整份新副本**解析期失败** ⇒ **页面停留旧版本、必须整页硬刷新**。**证据来源：t45 的 vm 双求值实验**。
- **修复（构建链变化）**：`npm run build` = `tsc -p tsconfig.build.json && tsc -p tsconfig.client.json && node scripts/wrap-client.mjs`；末步把产物**包进函数作用域**并写入幂等标记 `/*__secret_iife_wrapper__*/`；**顶层声明 242 → 0**（**证据来源：t47 实测**；本仓库门禁 `test/client-artifact.test.ts` 持续断言顶层声明 0、标记恰 1 处、0 import/export、重复加壳幂等、含顶层 import/export 的文件被拒绝）。产物**仍是 classic script**。
  - **量法（后人别量错）**：门禁的 `parseCensus` 用**解析器**数**脚本级词法声明**（`ts.createSourceFile` + `let/const/class/function`），**不是数行首文本**——壳是 `HEAD + 产物 + TAIL` 的 **Buffer 级拼接、不缩进**（`scripts/wrap-client.mjs:50-65`），壳内声明文本上仍顶格，行首统计会得出完全误导的数字。门禁同时断言产物**能干净解析**（`parseDiagnostics` 为 0）与**剥壳后回到扁平脚本**。
- **边界（必须写清）**：加壳**只消除"解析期整份失效"**这一种失败模式。宿主对**"未先 invalidate 就再次注册同一 factory"**仍然抛错——`dsh-client-modules/lib/client.js:575` 逐字：
  `client-modules: duplicate factory registration for "…" (bundle executed twice without invalidate?)`
  这是**宿主契约、客户端不能解除**；**合法 HMR 必须先 invalidate 再求值**（同文件 `:540-542` `invalidateForReplacement → invalidate(id, rev)`；`:541` 替换 bootstrap 模块必须整页刷新）。**证据来源：t47 幂等/HMR 实验 + t49 在真正下发字节里切壳并逐字节比对**（合并包与单插件包里切出的我方段落与本地产物逐字节相同，标记恰 1 处）。
- **跨插件事实**：我们的 client 与其它插件**合并成同一个 classic script 下发** ⇒ 顶层声明污染共享词法作用域是**真实风险**；加壳后我们对该作用域**零贡献**（顶层声明 0）。**证据来源：t45（vm 双求值）+ t49（合并下载 URL 30,600,397B / 单插件 278,353B 的切壳比对）**。

### 13.6 §7.1 / §12.7 的"需真人确认" —— 更新（一律不得写成已验证）

- **0.6.0 新增**：① **D5 删除后的真机观感**（用户需**再重启一次 `dsh web`** 才会加载新产物：确认底部输入区不再有那颗按钮、Ctrl+V 粘贴密钥时提示照旧）；② **剪贴板权限真机表现**（授予/拒绝各一次）——注意 composer 侧已不读剪贴板，**拒绝授权不应再影响 composer 的粘贴**（这本身是要看的行为）；③ **D1 排版**与聚焦/点击手感；④ **D2 两个答案**的真机后果（「登记为密钥」恰 1 请求、「按普通文本粘贴」0 请求）；⑤ **t46 接管**的提示内容（只有形状与长度）与明文不进草稿。
- **仍待真人（0.5.0 遗留）**：自动填充/密码管理器在真实浏览器里的现场行为、**R5 的契约外实时文案**（§12.7 的 C）。
- **未真机重测、只到替身级的细项（如实标注）**：composer 路径的「转为密钥」点击、往我们自己字段粘贴不被拦、cleanup 后监听数 0、一次性原生放行；另 **`mousedown` 的 `preventDefault` 在真机上不能靠 `btn.onmousedown` 读**（React 在根节点委托，该属性恒为空）——它有产物级证据但没有真机读数。**证据来源：t49 的如实标注**。
