# 定案：人类主动附加秘密（按钮 + 光标处内联胶囊 + 上方详情盒）

- 任务：`t1`（设计定案）· 轮次：round 3 · 目标版本：`0.2.0`
- 实施：`t2` · 独立验证：`t3` · 质量门：`t4` · 发布：`t6`（发布动作不在本任务范围）
- 基准运行版本：DSH `0.2.0-rc.2`（证据路径两处同版本：`C:\Program Files\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`、`C:\Users\admin\.dsh\profiles\web\node_modules\`）
- 用户定案（2026-10-06 修订版，覆盖并废止此前版本）：形态对齐 `dsh-vision-router` 的 `VisionModeToggle`；**允许改写用户原消息**；填完后在草稿光标处插入内联胶囊；点击内联胶囊 → 输入框上方盒子展开大胶囊；秘密绑定该条消息，Agent 随该轮拿到不透明变量名；默认仅本次会话、可切持久；明文不变量见第 1 节。

本文件是可直接实施的定案：给出**机制结论 + file:line 证据**、**文件级改动点**、**事件/状态机**、**模型侧投递的逐字样例与刷新/重放稳定性**、**兜底阶梯**、以及 **t3 可机械执行的验证清单**（区分「可机器证明」与「需真人确认」）。

> **实施落地（t3，已合并回本文件）** —— 与本文原稿有 5 处经核实后的偏差，均已在对应小节就地改写：
> 1. **座位**改为 `conversation.input.left`（captain 裁定 1），实际落点 `[访问模式][计划][新按钮]`（§3.1）。
> 2. **不变量 7** 按 captain 裁定 2 确认，README 已按穷举口径重写（§1.3）。
> 3. **绑定钩子**由「扫日志找锚点」改为 **`session/event`**（`type==='user/message'`），**captain 已独立复核并采纳为最终做法**：锚点 seq 只在消息 durable 之后才可知，而该服务的契约原文是 *"Seed events never publish on `session/event`"*（`dsh-session/lib/index.js:1271-1275`，captain 复核引用），因此重放/恢复历史**不可能**重新绑定。`agent/pre-step` 只负责**追加值无关注记（按 source 去重）**，**不再改写正文**（t11 更正，见文首修正块），且**与绑定次序无关**（注记取"暂存或已绑定"，两者都算）。
> 4. **L2 移除**为冗余（§7.1）。
> 5. **R3 定案为接受缺陷**，并给出"为什么 (a) 做不到"的契约依据（§9）。
>
> 另：注入的那条 message 不再运行时 import `@deepseek-ai/dsh-llm`（见 §1.4 的实施修正）。
>
> **实施落地修正（t11，2026-10-06，发布阻塞缺陷修复）——本文原稿第 2 节的 D4/§3.2b/§4.2/§4.3 有一处**事实错误**，已在此更正，并在对应小节就地改写：**
>
> 原稿断言「`agent/pre-step` 的改写**不落盘**」。**这是错的**，真实接线是：
> - `agent/pre-step` 返回的消息**就是落盘的那条**：loop 原样 append 成 `user/message`（`dsh-agent-loop/lib/index.js:1061`，`surfaceOp:'append'`），同一步的模型请求由**同一份 surface** 派生（`:1262`）⇒ 「只改模型请求、不改日志」不可能；
> - 模型输入按契约是**会话日志的纯函数**，`llm/stream` 的监听者「read it, never rewrite it」（`dsh-llm/lib/types/index.d.ts:37-45`）；
> - 唯一能保留"仅模型可见副本"的 surface replacement / message projection 必须 append 在目标**之后**，而 `:1061`→`:1262` 之间没有插入点；自定义事件类型还需 `ignorable` 才不被持久化读取拒绝（`dsh-session-persistence/lib/index.js:184`）。
>
> **后果**（这正是 t11 的缺陷）：改写真的落进了持久日志 ⇒ `session/event` 读到的 `user/message` 里已无 `@` 标记 ⇒ `bindStaged` 永不执行（无 Grant、无 `shellEnv` contributor）⇒ 附加的变量在 shell 里取不到；同一根因还使对话框那条消息渲染不出变量名胶囊。
>
> **更正后的机制**：日志与用户气泡**保留** `@DSH_SECRET_*` 原形（胶囊成立、`session/event` 绑定成立），模型侧的改写改由**值无关的注记**承担——注记**逐变量逐字**写明「正文里的 `@DSH_SECRET_VAR` 即该变量，模型侧写作 `[secret DSH_SECRET_VAR]`；它不是文件路径。」注记是 durable 的 `user/message`（`source.kind='secret-attach'`），并**按自身 source 去重**（模型可见 surface 上已有同一条就不再追加）。另：`bindStaged` 的次序改为「先 `envs.ensure` → 再 `grants.put` → 最后消费暂存项」。

---

## 0. 结论摘要（每条都指向第 2 节的证据行）

1. **首要待证问题（真 chip）的结论：可以。** 插件能在草稿里生成**真正的原子 chip 节点**（`ReferenceChipNode`），路径是：注册一个 `InputTriggerSource`（必须，`codec` 是序列化路由键）→ 用 **`slash/input-insert-reference` 这个已公开的 bail 事件**把 `ReferenceInsert` 应用到捕获的 `TokenSpan`。这正是 shipped 触发管线自己执行插入的那条路径（同一事件、同一 `InputTarget.insertReference` 实现）。
2. 模型侧文本**完全由我们的 `codec.serialize(ref)` 决定**：发送前 shell 把每个 chip 的 occurrence 替换成 `serialize` 的返回值再交给 sink（`sinkSerialized`）。因此「模型看到什么」是**我们逐字指定**的，而不是推断的。
3. **日志/草稿里放 chip 形态的标记 `@<VARIABLE>`**（如 `@DSH_SECRET_OPENAI`）：它在对话框里由 shipped 的 `projectUserText` 渲染成**只显示变量名的胶囊**（`data-ref-chip="file"`），在草稿里是真 chip 或 lexicon 装饰引用。
4. **模型请求侧的改写由值无关注记承担**（原稿写的「纯函数改写正文且不落盘」**已被 t11 更正**，见文首修正块）：正文保持 `@DSH_SECRET_OPENAI` 原形，紧随该条用户消息追加一条**值无关**的 context 消息，其中**逐变量逐字**写明「正文里的 `@DSH_SECRET_OPENAI` 即该变量，模型侧写作 `[secret DSH_SECRET_OPENAI]`；它不是文件路径。」，并给出变量名/作用域/shell 取用方式。注记由 `agent/pre-step` 追加、按自身 source 去重，所以刷新/重放看到的日志与模型文本都稳定。
5. 值的三段式生命周期：**客户端胶囊本地 state → 一次 `POST /api/secret.attach` 请求体 → Host 内存 staged 记录**；**只有**当携带标记的用户消息真正进入某一步（`agent/pre-step`）时，staged 记录才被提升为 `Grant`（`anchorSeq` = 该 `user/message` 事件 seq），此后 `shellEnv` 才会注入。没发送 → 永不注入，TTL/会话结束即丢弃。
6. 锚定复用现有 `GrantStore` 语义：消息被回退/重写离开 live surface 时，`resolve()` 自动判 `revoked-anchor`，密钥随之失效——「绑定这条消息」不是口号，是可验证的行为。
7. 不变量 7 需要一处**诚实的收紧措辞**（第 1.3 节，需 captain 确认）：Host 必须持有值（round 2 的 `GrantStore` 已如此），所以「明文只存在于胶囊本地 state 与提交请求体」在任何能让 Agent 后续取用的设计里都不可能字面成立。

---

## 1. 范围与不变量

### 1.1 本轮只做

- Client 半新增：工具栏按钮（`conversation.input.left`，captain 裁定后落位）、一个 `conversation.input.overlay` 条目（填值胶囊 + 详情胶囊两态）、一个 `InputTriggerSource`（name `secret`：codec + lexicon + openReference）。
- Host 半新增：staged attach 存储与 3 条 `/api/secret.*` 路由、`session/event` 绑定 + `agent/pre-step` 追加值无关注记（按 source 去重）、`attach` 相关 config、`Grant.callId` 变可选。
- 既有「Agent 索要」方向（`secret_request` + 流内卡片）**语义与行为一律不变**；只做加法。

### 1.2 不做（明确排除）

- 不做真 chip 的 Harness 侧扩展（不注册新的 reference 种类到 Shell；不碰 Lexical 注册表）。
- 不做「Host 重启/会话重放后自动重新武装已绑定的密钥」（见 5.4，安全性上故意 fail-closed）。
- 不做 URL/查询串/GET 携带值的一切形态；不做 `shell/overlay` 全视口面（round 2 已删，不复活）。
- 不做「删除 chip 即自动 withdraw staged attach」（与发送存在竞态，见 6.5）。

### 1.3 不变量（含必要的一处措辞收紧）

**允许值存在的全部位置（穷举，不多一个）：**

| # | 位置 | 生命周期 |
|---|---|---|
| P1 | 填值胶囊输入框的 React 本地 state（`type="password"`） | 打开胶囊 → 提交 attach 成功/取消 |
| P2 | 一次 `POST /api/secret.attach` 的请求体 | 单次请求 |
| P3 | Host 进程内存里的 staged attach 记录（`AttachStore`） | attach 成功 → 提升为 Grant / release / TTL / 会话结束 |
| P4 | Host 进程内存里的 `GrantStore` 记录（绑定后） | 绑定 → 锚点离开 live surface / 会话结束 |
| P5 | `shellEnv` 按会话注入的执行环境 | 每次 shell 执行 |
| P6 | **仅当人类显式选择「持久」**：凭据库本身（`credentials.set`） | 直到人类在凭据库中删改 |

**明文绝不允许出现的位置（本条是硬判据）：** 模型上下文与对话文本、会话日志（任何事件字段）、console/日志、DOM 属性与可见文本（`<input type=password>` 的 value property 除外，且提交即清空）、未发送草稿的持久化投影（草稿镜像只含 `@VARIABLE`）、URL/查询串、HTTP 响应体、异常与错误消息（错误一律固定文案）、除 P6 之外的任何落盘文件。

**为什么 P3/P4 必须写进不变量（captain 2026-10-06 裁定 2：已确认，按此口径实施并同步 README）：** round 2 的实现已经这样做了——`secret_request` 的人工批准把值放进进程内 `GrantStore`（`src/service.ts:441` `this.grants.put(grant)`，`src/grants.ts:28-30` 注释「durable for `persistent`, memory-only for `session`」），再由 `shellEnv` 每次执行解析（`src/envs.ts:38-44`）。本轮反方向无法例外：Host 必须持有值才能注入。**README 已按上述穷举口径重写，不再出现「值不得存在于内存」这类与本实现矛盾的绝对句。**

### 1.4 版本与兼容

- 版本目标 `0.2.0`（`package.json`；`t6` 负责发布动作）。
- `dsh.client.inject` 追加两个包（见 6.2）。**实施修正**：Host 半**不需要** `@deepseek-ai/dsh-llm` 的运行时依赖——注入的那条 message 由本地 `structuredClone` + `deepFreeze` + `crypto.randomUUID()` 构造（与 `createUserMessage` 的实现等价：`{...input, id: brandString(randomUUID())}` 后 `deepFreeze`），`@deepseek-ai/dsh-llm` 只以 `import type` 与 `declare module` 形式参与类型检查。这样既保住了与 Harness 自身 `MessageSourceMap` 的合并校验，又不给 profile 增加一个可能解析不到的运行时依赖。
- 既有 47 条测试只增不改；`secret_request` 的工具 schema、结果形状、卡片注册形状保持不变。
- 本定案撰写时已复跑基线：`npm --prefix projects/cordis-plugin-secret test` → `tests 47 / pass 47 / fail 0`（t2 完成后再跑一次，用例数只允许增加）。

---

## 2. 机制结论与证据

### 2.1 结论 A：真 chip 可行（file:line 全链）

| # | 事实 | 证据 |
|---|---|---|
| A1 | 草稿里的内联引用是真 Lexical 装饰节点：`ReferenceChipNode`（`__source/__ref/__label/__appearance/__clipboardText/__invalid`），工厂 `$createReferenceChipNode(insert)` | `dsh-client-ui-conversation/lib/types/client/input/editor/chip-node.d.ts:1-9,24-37,99-103` |
| A2 | chip 的 DOM 锚点：`<span data-composer-chip="<source>" contenteditable="false">`（**这是 t3 的机器可判据**） | 同包 `lib/client.js:12465-12471`（`ReferenceChipNode.createDOM` 的 `el.setAttribute("data-composer-chip", this.__source)` 在 `:12469`） |
| A3 | 插入动词是**公开契约里的 scoped bail 事件**：`'slash/input-insert-reference'(request: InsertReferenceRequest): true \| undefined`，`InsertReferenceRequest = { reference: ReferenceInsert; span: TokenSpan }` | `.../contract/input.d.ts:60-69`（请求类型）、`:121-147`（`declare module '@deepseek-ai/cordis'` 的事件表，`@mode bail`） |
| A4 | 「用 chip 替换 span」是 `InputTarget` 的唯一参考插入语义：`insertReference(ref, span): boolean` — *Replace the trigger span with one reference chip (span-CAS'd)* | `.../contract/input.d.ts:156-161` |
| A5 | 该事件的监听者挂在**会话作用域 ctx** 上：`shellFor(binding)` 里 `const { session, ctx: actx } = binding` → `actx.on('slash/input-insert-reference', (req) => shell.insertReference(req.reference, req.span) ? true : void 0)` | 同包 `lib/client.js:14216-14219`、`:14261-14267` |
| A6 | 实现有相位与 CAS 守卫：`phase` 必须 `plain`/`claimed`，`span.draftRev === this.rev`，然后 `insertReference(span, ref, tail)` 以「后续字符已是空格则不加空格」的规则插入 `[chip, ' ']` | `lib/client.js:13762-13768`、`:13323-13329` |
| A7 | `InputActions.captureInsertion()` 给的就是这个 span：`{...caretSpan(), draftRev: this.rev}`；`TokenSpan = {start,end,draftRev}`（detect 坐标，chip 记 1 个 U+FFFC） | `lib/client.js:13463-13466`；`draft-editor.d.ts:6-10`、`:69-73` |
| A8 | 插件能拿到会话作用域 ctx：`ctx.sessions.scope(id): AgentContext \| undefined`（公开 face），`AgentContext` 就是带 remote 的 cordis `Context` | `dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:130-135`；`.../client/scope.d.ts:6-8` |
| A8b | 「同一个作用域」不是推测：shipped 的 `@` 菜单就是这样拿到该会话的 shell 的——`const actx = sessions.scope(sessionId); … const controller = inputTriggers.sessionOf(actx)`（`sessionOf` 用 scope tag 校验归属） | `dsh-client-ui-input-trigger/lib/client.js:1266-1269`、`:1273-1275`；`service.d.ts:30-40` |
| A9 | `bail(filter, name, payload)` 的语义：首个参数作为 dispatch subject 参与 `Context.filter` 过滤，返回首个 bail 值；shipped 触发管线自己就是这么发的 | `@deepseek-ai/cordis/lib/index.js:295-306`、`:258-264`；`dsh-client-ui-input-trigger/lib/client.js:712-728` |
| A10 | **`codec` 是必须的**：模型序列化按 `source` 名字路由，找不到 owner/codec 直接 reject（发送被拒，不静默降级） | `dsh-client-ui-input-trigger/lib/client.js:615-619`；`types.d.ts:122-127` |

**结论：** 真 chip 不需要任何 hack、不需要调私有方法（§2.2 给出一条公开兜底路径）。唯一「非常规」之处是：`InputActions` 面**故意不含** `insertReference`（`input.d.ts:200-215` 注释：*Command-style handles … stay InputBar-private and never ride this face*），所以插件走的是**同一份冻结契约里的 scoped 事件**，而不是 Action 面。残余风险 R1（第 9 节）：未来 rc 版若把该事件收窄为 shell 私有，需要切换到 2.2 的 B2 兜底路径。

### 2.2 结论 B：插件可用的兜底插入路径（公开面；B1 已判冗余移除，仅存 B2）

| 路径 | 机制 | 证据 |
|---|---|---|
| ~~B1~~ | ~~注册的 `InputTriggerSource` 上，`controller.toggleSource(name, syntheticHit)` … → `settle → execute` → 同一个 `slash/input-insert-reference`~~ | **已判冗余移除**（captain 采纳偏差 4）：它发的是 L1 那同一个事件、同一个 span，不可能在 L1 失败处成功。原始证据保留备查：`dsh-client-ui-input-trigger/lib/client.js:456-477`、`:485-495`、`:807-821` |
| B2（无 chip） | `inputActions.insertText('@'+variable, span)` 插入**纯文本**；再由 source 的 `lexicon()` 把该 token 变成**扫描派生的 chip 观感**（`TextRefNode`，DOM `data-composer-text-ref`），点击同样经 `openReference` 路由回本插件 | `.../contract/input.d.ts:206-226`（`insertText(text, span)` 文档明写 plain text）；`dsh-client-ui-conversation/lib/client.js:13798-13801`（insertText 实现，注释：*no chip node; the chip look is a scan-derived decoration, never state*）、`:13168`（注册 text-ref 装饰）、`:13210-13211`（`lexicon.subscribe → rescanTextRefs`）、`scanTextRefs`/`TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g`、`TextRefNode.createDOM` 的 `data-composer-text-ref`（`lib/client.js:12727`）；`dsh-client-ui-input-trigger/lib/types/types.d.ts:181-198`（lexicon 契约） |

**B2 的意义**：即使 L1 不可用，草稿里也会有一个「看起来是胶囊、点击能展开详情盒」的引用（只是可编辑文本），而不需要 chip 事件，也不会让发送被我们的代码阻断。它现在是**唯一的兜底**（原 B1/toggleSource 路径已判冗余移除，见 §7.1 与偏差 4）。**L1/L3（B2）/L4 的阶梯见第 7 节。**

### 2.3 结论 C：chip → 模型文本的替换点（唯一）

`SessionInputShell.sinkSerialized(attempt, draft, mode)`（`dsh-client-ui-conversation/lib/client.js:13949-13991`）：

1. `draft` = 编辑器文档的**剪贴板投影**（chip 展开为 `clipboardText`）；
2. `occurrences` = `this.projection.occurrences`（每个 chip 的 `{offset,length,source,ref,label,clipboardText}`，`draft-editor.d.ts:82-101`）；
3. 对每个 occurrence `await inputTriggers.serializeReference(o.source, o.ref, attempt.signal)`，把 `[offset, offset+length)` 替换成返回值，拼出 `out`，`out.trim()` 交给 `defaultSink`；
4. **序列化失败 → `settleDetachedFailure`**：发送被拒、编辑器快照恢复、错误文案来自 codec/registry（`:13986-13990`）。

⇒ 「模型看到什么」= `clipboardText` 之外的部分 + 我们的 `serialize(ref)` 返回值，逐字可控；也解释了为什么 `clipboardText` 必须是**值无关**的（它会进草稿镜像）。

### 2.4 结论 D：对话框那条消息上的胶囊由 shipped 投影直接给出

| # | 事实 | 证据 |
|---|---|---|
| D1 | 用户气泡正文由 `projectUserText(text, referenceLabels, skillNames, 'skill', references)` 渲染，`references = {openFile, openSkill}` | `dsh-client-ui-chat/lib/client.js:1370-1377`、`:1446-1465` |
| D2 | 三种装饰来源：**wire session 形态** `@[label](dsh-session:...)` → session 图标 chip（**不可点**，保持 label）；**裸 `@token`**（`(^|\s)@[^\s]+`）→ file/folder chip，**可点**（走 `openFile`）；`/name` 只在 caller 点名时装饰 | `dsh-client-ui-primitives/lib/index.js:6700-6790`（wire 正则 `SESSION_WIRE_RE`、裸 token 正则、`referenceKind`/`displayLabel`/`open` 分支） |
| D3 | 裸 token 的 `displayLabel` = 去掉 `@` 后按 `[\\/]` 取最后一段 ⇒ **`@DSH_SECRET_OPENAI` 的显示文本就是变量名**；`title` 是整个 token | 同上 `:6753-6759` |
| D4 | 所以：日志文本里放 `@<VARIABLE>` ⇒ 用户气泡出现「只显示变量名的胶囊」。代价：它是 `data-ref-chip="file"`，点击会尝试 `openFile('DSH_SECRET_OPENAI')`（`projectUserText` 对 file 形必定挂 onClick） | 同上 `:6760-6781`；已知缺陷，见 R3 |
| D5 | 系统提示把 `@` 前缀定义为**文件路径**：*Tokens prefixed with @ are paths the user explicitly referenced…* | `dsh-file-reference/lib/index.js:54`（`FILE_REFERENCE_PROMPT`）|

⇒ D4 + D5 的**原稿解法**（日志保留 `@` 形态、模型请求侧改写掉 `@`）**在真实接线下不可实现**：`agent/pre-step` 的返回值就是落盘的那条（t11 更正，见文首修正块）。正确解法见 3.2：日志与正文保留 `@`，模型侧的 `[secret VAR]` 由**注记逐变量逐字**承担。

### 2.5 结论 E：Host 侧的绑定/改写/注入钩子

| # | 事实 | 证据 |
|---|---|---|
| E1 | `'agent/pre-step'` 是 **waterfall**，payload `{agent, messages: UserMessage[], turn, step, signal}`，`next: () => Promise<PreStepDecision>`；`PreStepDecision = {kind:'enter'; messages} \| {kind:'reject'}` ⇒ **可以替换进入本步的消息** | `dsh-agent/lib/types/runtime-types.d.ts:293-310`、`:92-99` |
| E2 | shipped 包正是这么做「在 `agent/pre-step` 改写用户消息 + 追加值无关 context」：`ctx.on('agent/pre-step', …, {prepend:true})` → `next()` → 替换 `messages`；对每个 `source.kind === 'user'` 的消息改写 `content` 并追加 `additionalContext`。**t11 的关键补充（当时漏掉的事实）**：它的改写**同样落盘**——所以它把 `@[label](uri)` 归一成**仍然可被 `projectUserText` 解析的 `@label`**（`lib/index.js:321-337`），而不是改成非 chip 形态。这正是"日志形态必须保持可解析"的先例 | `dsh-session-reference/lib/index.js:468-475`、`:485-508`、`:321-337` |
| E3 | 追加的 context 消息由 `createUserMessage({source:{kind,form,version,…}, content:[{type:'text',text}]})` 构造；`freezeMessage` 用于改写后的冻结 | 同上 `:629-650`；`dsh-llm/lib/types/message.d.ts:190-216` |
| E4 | `MessageSourceMap` 是**合并可扩展**的源类型表，各生产者声明自己的 `kind` | `dsh-llm/lib/types/message.d.ts:95-108`；合并写法先例（裸包名）：`dsh-skill/lib/types/index.d.ts:128-133`、`dsh-session-reference/lib/types/types.d.ts:32` |
| E5 | 用户消息事件的数据就是 `UserMessage`（`'user/message': UserMessage`，且 `'user/message'` ∈ `SurfaceEventType`）⇒ 扫描 `session.snapshotEvents()` 能取到锚点 seq | `dsh-session/lib/types/types.d.ts:294`、`:442`；扫描先例 `src/anchor.ts:27-42` |
| E6 | 授予与撤销都由 `GrantStore.resolve` 现算：`isOwnSeq(anchorSeq)` + `surface.nodes.includes(anchorSeq)`，离开 live surface 即 `revoked-anchor` 并丢弃 | `src/grants.ts:109-127`、`:130-136`、`:154-162` |
| E7 | 变量注入是 per-execution 的：每个变量一个 `shellEnv` contributor，`resolve` 时按会话取 `grants.valueFor` | `src/envs.ts:29-47` |
| E8 | 路由挂载面：`ctx.connection.fetch.register({path, methods, requestBody:'buffered', fetch})`，与既有两个路由同一信任围栏 | `src/routes.ts:18-48` |
| E9 | 持久化的既有路径与自查口径：`credentials.set(envVar, value)` + `session.commit(...)`；失败时固定文案 + 绝不复述上游错误 | `src/service.ts:320-341`、`:365-380`；`src/redact.ts:5-12` |

### 2.6 结论 F：按钮与浮层座位（对齐 VisionModeToggle）

| # | 事实 | 证据 |
|---|---|---|
| F1 | **参照实现所在的尾随侧座位** `conversation.input.right` = `{kind:'list', scope:'session'}`（list 注册必须给 `id`，可选 `order`/`inject`；同 `id` 同 priority 会抛）——**本插件不落此座位**，落领先侧 `conversation.input.left`（§3.1） | `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:230-238`；`dsh-client-ui-slots/lib/types/index.d.ts:560-583`、`:597-613` |
| F2 | 参照实现的注册形状：`slots.inject('conversation.input.right', function*(){ yield slots.register({name, id:'vision-router-mode-toggle', order:40, locale, inject(sessionId){…}}, VisionModeToggle) })` | `C:\Users\admin\.dsh\profiles\web\node_modules\dsh-vision-router\lib\client-presentation-boundary-main.js:1282-1319`（按钮组件 `:1134-1280`） |
| F3 | **参照所在座位** `conversation.input.right` 的渲染位置（用于与 F4 的另一侧对照）：composer `.row` → `.trailing` → `.standardControls`（在 `conversation.input.model` **之前**） | `dsh-client-ui-conversation/lib/client.js:17526-17533` |
| F4 | 「访问模式」权限控件在**另一侧**：`.tools` → `.modes` 组内的 `conversation.input.permission`（后接 `conversation.input.plan`），紧随其后是 `conversation.input.left` | 同 `:263-268`（slot 声明）、`:17520-17525`（渲染顺序） |
| F5 | 浮层座位 `conversation.input.overlay` = `{kind:'list', scope:'session'}`，父级是 composer card 内的 `.overlayAnchor`（CSS `height:0;position:absolute;inset:0 0 auto`）；`@`/`/` 菜单就住这里，**关闭态渲染 null 但槽位常驻** | 声明 `slots.d.ts:219-223`；渲染 `client.js:17450-17453`；CSS `client.js:17172`（`uV2eYG_overlayAnchor`）；`dsh-client-ui-input-trigger/lib/client.js:1261-1288`、`:1010-1023` |
| F6 | 浮层内容的浮起几何（shipped 先例）：`position:absolute; z-index:100; bottom:calc(100% + 4px); left:0; right:0` ⇒ 盒体悬浮在**输入卡片上方**（`@` 菜单即此位置） | `dsh-client-ui-input-trigger/lib/client.js` 的 `MenuView.module.css` 内联串：`._3e4SsG_menu{…position:absolute;bottom:calc(100% + 4px);left:0;right:0…}` |
| F7 | session 槽位的标准 props 由 `ui-session` + conversation 合并给出：`sessionId`、`useSession`、`useProjection`、`useConversation`、**`useInput`（`InputState`）**、**`inputActions`（`InputActions`）**；`session-maybe` 里这些可为 `undefined` | `dsh-client-ui-slots/lib/types/index.d.ts:191-217`；`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:332-347`；`dsh-client-ui-session/lib/types/client/index.d.ts:77-92` |
| F8 | `InputState = {draft, attachmentIds, draftRev, phase, claim?, occurrences, queue}`；`occurrences` 是 chip 的出现视图 | `.../contract/input.d.ts:236-255`；`draft-editor.d.ts:82-101` |
| F9 | chip 点击 → 我们的 source：`registerReferenceActivation(editor, (source, reference) => deps.openReference(...))`，主键点击原子 chip 时 `open(node.getSource(), {ref, appearance})` | `dsh-client-ui-conversation/lib/client.js:13166`、`registerReferenceActivation` 实现体、`:13518` |
| F10 | controller 的 openReference 路由：按名字找 owner（chip）或按 `ref.startsWith(trigger) && lexicon.includes(ref.slice(1))` 找 owner（可编辑文本）；owner 的 `openReference(session, {ref, appearance})` 返回 true 即接受 | `dsh-client-ui-input-trigger/lib/client.js:626-634`；契约 `types.d.ts:199-205` |

---

## 3. 定案的形态与逐字契约

### 3.1 座位与形态（**captain 已裁定：落 `conversation.input.left`**）

- **按钮座位：`conversation.input.left`**（captain 2026-10-06 裁定 1，已实施），注册形状照 F2 抄：`ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name:'conversation.input.left', id:'secret-attach-toggle', order:30, inject(sessionId){…} }, SecretAttachToggle))`。
  - **裁定理由与必须如实写明的代价**：用户原话是「放在『访问模式』按钮**右侧并列**的按钮」，邻接优先于「和识图按钮同组」，因此从 `input.right` 改为 `input.left`（组件零改动）。**但 `.modes` 这个 div 里同时坐着 `conversation.input.permission` 与 `conversation.input.plan` 两个座位**，所以新按钮的实际落点是 `[访问模式][计划][新按钮]` —— 即「紧邻 modes 组右侧」。**「夹在权限与计划之间」用公开座位做不到**：那需要整体接管 `conversation.input.permission` 这个 single 座位并自己重绘权限控件，属脆弱做法，captain 已否决。
  - 状态可见性（对齐 F2 的 toggle 语义）：按钮是**可按下状态可读**的控件——`aria-pressed`（=胶囊是否展开）与 `aria-label` 随状态变化，展开时按钮高亮，并在本会话存在 staged/bound 附件时显示一个不含值的计数角标。
  - `inject(sessionId)` 返回：`{ open(): void, close(): void }`（形态对齐参照的 `{directory, available, select}`：注册只给身份与动作，**活状态走模块级 store**，组件自己订阅）。
  - `locale`：**该服务经 `ctx.inject(['locale'])` 存在时**才注册本插件的命名空间（不得直读 `ctx.locale`，见 §6.1 的注册行），组件同时持有字面量兜底表；对照参照实现，这是"形状对齐 + 不把渲染风险绑在 locale 服务上"的折中。
- **浮层座位：`conversation.input.overlay`**（F5），一个条目 `id:'secret-attach-capsule'`，两态渲染，空闲态 `return null`：
  - `fill`（按下按钮后）：名称（key）/可选标签/值（`type=password` + 显隐切换）/作用域单选（**默认「仅本次会话有效」**，可切「持久」）/「插入」/「取消」；
  - `detail`（点击内联胶囊后展开的**大胶囊**）：变量名、键名、标签、作用域、状态（`staged`/`bound`）、只读提示「明文不在此显示」、「丢弃」（调 release）、「关闭」。
  - 几何（照 F6）：盒体 `position:absolute; bottom:calc(100% + 4px); left:0; right:0; z-index:100`，即**输入框上方**。`fill` 与 `detail` 共用同一座位与同一条目，保证「同一时刻只有一个我们的面」（P2 备选：`fill` 也可改为 `top:0` 覆盖在输入框上；本定案选 F6 的既有几何，因为它已被 `@` 菜单验证且不遮住正在输入的那一行；这条差异列入 t3「需真人确认」）。
- **内联胶囊：真 chip（L1）**：`ReferenceInsert = { source:'secret', ref:<VARIABLE>, label:<VARIABLE>, appearance:'session', clipboardText:'@'+<VARIABLE> }`。`ref` 直接用变量名（＝Host 返回的 `variable`），于是 chip / 点击 / codec / Host 绑定共用同一个字符串。

### 3.2 逐字契约：标记与模型文本

常量（Client 与 Host 各自持有同一份正则，测试钉住一致性）：

```
VARIABLE  = DSH_SECRET_[A-Z][A-Z0-9_]*        // 复用 src/naming.ts:13 的 ENV_VAR_PATTERN 后半段
MARKER    = "@" + VARIABLE                    // 日志/草稿/chip 的形态，例：@DSH_SECRET_OPENAI
MARKER_RE = /(^|\s)@(DSH_SECRET_[A-Z][A-Z0-9_]*)/gu   // 与 TEXT_REF_RE 同边界纪律（行首或空白后）
MODEL_RE  = /(^|\s)@(DSH_SECRET_[A-Z][A-Z0-9_]*)/gu   // 改写用同一正则
MODEL_FORM = "[secret " + $2 + "]"            // 例：[secret DSH_SECRET_OPENAI]
```

**（a）用户侧看到什么**

| 位置 | 逐字内容 |
|---|---|
| 草稿（insert 后、发送前） | 真 chip：`<span data-composer-chip="secret" contenteditable="false">` 内渲染 `<ReferenceIconRegular kind="session"/>` + `DSH_SECRET_OPENAI` |
| 草稿的剪贴板/持久化投影（草稿镜像、复制） | `请用 @DSH_SECRET_OPENAI 跑测试` |
| 对话框那条消息（发送后） | 气泡正文由 D1/D2 渲染：`请用` + **胶囊（只显示 `DSH_SECRET_OPENAI`，`data-ref-chip="file"`，`title="@DSH_SECRET_OPENAI"`）** + `跑测试`；紧随其后一行注入说明（E2/E3 的 context 行，header 标注 producer `secret-attach`，展开可见说明正文） |
| 点击草稿里的 chip / 消息里被装饰的同一 token | 调用 `openReference(source='secret' \| undefined, {ref:'DSH_SECRET_OPENAI'})` → 浮层切到 `detail` 态展开大胶囊 |
| 复制该条消息（`MessageIconActions` 的 `text`） | `请用 @DSH_SECRET_OPENAI 跑测试`（无值） |

**（b）模型最终看到什么（逐字样例）**

会话日志（durable，值无关）：

```
user/message (seq=42)  content=[{type:'text', text:'请用 @DSH_SECRET_OPENAI 跑测试'}]
```

本步模型请求（`agent/pre-step` **追加注记**；正文与日志逐字相同 —— 原稿的「改写正文且不落盘」已被 t11 更正）：

```
user      : 请用 @DSH_SECRET_OPENAI 跑测试          ← 与 seq=42 的 durable 正文逐字相同
user(注入) : 本条消息附带 1 个由人类主动提供的密钥；明文不进入对话，只能按变量名取用。
            - DSH_SECRET_OPENAI · 仅本次会话有效
            正文里的 @DSH_SECRET_OPENAI 即该变量，模型侧写作 [secret DSH_SECRET_OPENAI]；它不是文件路径。

            取用方式：PowerShell 用 $env:DSH_SECRET_OPENAI，POSIX shell 用 "$DSH_SECRET_OPENAI"。
            不要把该标记当作文件路径读取。
```

注入消息的 durable source（决定对话框那行的 chrome，F/证据见 5.3）：

```json
{ "kind": "secret-attach", "form": "instructions", "version": 1,
  "variables": [ { "variable": "DSH_SECRET_OPENAI", "name": "openai", "scope": "session" } ] }
```

`form: 'instructions'` 取自 chat 的 `KNOWN_FORMS`（`['instructions','catalog','snapshot','notice','relay','recall']`，常量在 `dsh-client-ui-chat/lib/client.js:7248-7256`；`contextProducer` 的 default 分支 `:7291-7294` 把未知 `kind` 投影成 `{role:'inject', label:kind}`；`contextForm` 对未知 `form` 退化为 opaque `:7262-7265`）。

**（c）Agent 如何真正取到值**

绑定发生在 5.2；绑定后 `GrantStore.valueFor(session, envVar)` 有值 ⇒ `EnvContributorRegistry.resolve` 在**后续每次 shell 执行**里注入该变量（E7）。模型拿到的只是变量名（3.2b），值从不出现。

### 3.3 新路由契约（值无关）

| 路由 | 请求体 | 成功响应 | 失败（固定文案纪律） |
|---|---|---|---|
| `POST /api/secret.attach` | `{sessionId, name, label?, scope, value, envVar?}` | `200 {"ok":true,"variable":"DSH_SECRET_OPENAI","scope":"session","replaced":false}` | `400 {"ok":false,"error":"attach.value is required"}` / `attach.name must be lowercase kebab/snake` / `attach.scope must be "session" or "persistent"` / `attach.envVar must match …` / `404 {"ok":false,"error":"attach.session not found"}` / `500 {"ok":false,"error":"credential store write failed"}`（**绝不复述上游文本**，且第二层 `redactSecrets(..., [value])`） |
| `POST /api/secret.release` | `{sessionId, variable}` | `200 {"ok":true,"released":true\|false}` | `400 attach.sessionId is required` / `attach.variable must match …` |
| `GET /api/secret.attached?sessionId=…` | — | `200 {"ok":true,"attachments":[{"variable":"DSH_SECRET_OPENAI","name":"openai","label":"OpenAI","scope":"session","state":"staged"\|"bound","createdAt":1696…}]}` | `400 attach.sessionId is required` |

- 响应体永不回显值；`state` 由 `AttachStore` + `GrantStore.validNames(session)` 现算（E6）。
- 全部路由都在 Connection 的信任围栏内（同源 + 签名 cookie），与既有两路由同一处置（`src/routes.ts:10-17`）。

---

## 4. 事件 / 状态机

### 4.1 客户端（module store + 组件本地 state，值与状态严格分离）

```
type AttachUiState =
  | { mode:'idle' }
  | { mode:'fill';   span:TokenSpan | null; busy:boolean; error:string | null }
  | { mode:'detail'; variable:string; scope?:Scope; name?:string; label?:string;
                     state?:'staged'|'bound'; busy:boolean; error:string | null }
```

| 事件 | 迁移 | 说明 |
|---|---|---|
| 点按钮 | `idle → fill`，同时 `span = inputActions.captureInsertion()` | 按钮 `onMouseDown` 阻止默认以保留编辑器选区（shipped 的 `keepFocus` 同法，`client.js:17507`）；`captureInsertion` 读的是编辑器**已存**选区（F7/A7） |
| 胶囊里输入 | `fill` 内部本地 state | 值只存在组件本地 `useState`；不写 store、不写 `__cordisSecretClient`、不进草稿 |
| 点「取消」/ `Escape` | `fill → idle`，丢弃本地值 | 无网络请求（此时尚无 staged attach） |
| 点「插入」 | `fill(busy)` →（`POST /api/secret.attach` 成功）→ 插入 → `idle` | 顺序严格：**先 attach 成功、再插 chip**。attach 失败 → 留在 `fill`，显示固定文案，不插 chip、不落任何值 |
| `POST attach` 成功 | 清空本地值 `setValue('')`，然后按 L1→L3→L4 插标记 | 插入成功后 `lexicon` 需刷新（`subscribeLexicon` → 控制器 `refreshLexicon` → 编辑器 rescan，B2 证据链），使 L3 插入的纯文本 token 与刷新后恢复的纯文本 token 都能渲染成胶囊 |
| 点内联胶囊 | `→ detail` | chip：来源 `openReference(session, {ref})`（F9/F10）；被装饰文本：来源 `openReference(undefined, {ref:'@'+variable})` 后按 `ref.slice(1)` 解析 |
| 打开 detail | 若本地无该变量的记录，则 `GET /api/secret.attached` 取权威 scope/state | 刷新后仍能显示真相；请求失败 → 只显示变量名 + 「状态未知」 |
| 点「丢弃」 | `POST /api/secret.release` → `idle` | 只在 `state === 'staged'` 时可丢弃；`bound` 态提示「已绑定到消息，需回退该消息才会失效」 |
| 发送（Enter/Send） | 不经过我们的代码作决定；我们的 `codec.serialize(ref)` 被调用一次/occurrence | 返回 `'@'+ref`（与 `clipboardText` 同形，替换是恒等操作） |
| **发送失败** | `sinkSerialized` 的 reject 路径（`:13986-13990`） | 发送被拒、编辑器快照恢复、草稿保留 chip；胶囊不自动重开（`idle`）；staged attach 仍在（值未被丢弃） |
| 刷新 / 会话切换 | `fill`/`detail` 的组件本地 state 丢失 ⇒ 值不可能残留；`idle` 起 | 草稿镜像恢复的是**纯文本** `@VARIABLE`（`setDraft` 只写文本），由 lexicon 装饰回胶囊观感（B2）；Host 侧 staged/bound 记录仍在，`GET attached` 可查 |
| 会话结束 / TTL | Host 侧 `session/disposed` / `attachTtlMs` 到期 → staged 记录丢弃 | 客户端无需感知；下次 `GET attached` 自然查不到 |

### 4.2 Host（staged → bound 的两段式）

```
stage(sessionId, name, scope, value, envVar?)
  → 校验（naming 规则 + value 非空 ≤ MAX_VALUE）
  → scope==='persistent' 时：credentials.set(envVar, value) + commitRecord(recordKey(name), marker)
  → AttachStore.put({ref: envVar, sessionId, name, envVar, scope, value, createdAt, ttlTimer})
  → 响应 {ok, variable, scope, replaced}

agent/pre-step({agent, messages, signal}, next)
  → decision = await next(); 若 decision.kind !== 'enter' 原样返回
  → 对每个 source.kind === 'user' 的消息：
       markers = MARKER_RE 匹配其 text 块（去重、保序）
       for each marker：
         known = describeVariable(...)   // 暂存项或已绑定的 grant，都算
         if (known) → 收进 notes（按变量去重）
  → 若 notes 为空 → 原样返回 decision（连一条消息都不动）
  → source = attachSource(notes)；若 noteVisible(source) → 原样返回（**按自身 source 去重**）
  → 返回值：decision.messages **原样**（正文不做任何替换）+ 一条注记消息（3.2b 的逐字映射行）

绑定不在这里发生：它由 `session/event` 在消息 durable 之后执行（下节）：
  session/event(session, event) 且 event.type === 'user/message'
    → seq = event.seq（锚点）
    → for each marker in messageMarkers(event.data)：
         staged = AttachStore.get(sessionId, variable); if (!staged) continue
         envs.ensure(variable) → grants.put({...staged, anchorSeq: seq}) → AttachStore.remove(...)
```

| 事件 | 判定 |
|---|---|
| `POST attach` 成功但用户永不发送 | staged 记录留在内存，**永不被提升为 Grant** ⇒ `shellEnv` 里没有这个变量；TTL（默认 30 min）或 `session/disposed` 丢弃 |
| 同会话重复 attach 同一 `variable` | `AttachStore` 按 `(sessionId, variable)` 覆盖（`replaced:true`）；已 bound 的 `Grant` 在下次绑定时被覆盖（`GrantStore.put` 按 `(sessionId,name)` 替换，`grants.ts:92-103`） |
| 同一消息里两次同一标记 | 只绑定一次（按变量去重） |
| 消息被回退/重写（edit-and-retry） | `resolve()` 现算 `surface.nodes.includes(anchorSeq)` 失败 ⇒ `revoked-anchor` ⇒ 不再注入（E6） |
| 会话分叉 | 子会话 id 不同 ⇒ 父会话的 grant/staged 一律不可见（`grants.ts:77-85` 注释与实现） |
| 已绑定变量出现在**后续**消息里 | 只是文本；grant 早已有效，无需再次绑定；注记按 source 去重（模型可见 surface 上已有同一条就不再追加），且因为不再有 staged 记录可消费，**不产生新的绑定事件** |
| Host 重启 | staged 与 grants 都丢（内存态）；日志里的标记仍在，模型可能提到一个不再注入的变量名（第 5.4 节，已定案为 fail-closed） |

### 4.3 注记的确定性（为什么刷新/重放稳定；原稿的"改写正文"已被 t11 更正）

注记是**文本的纯函数**：同一段文本 + 同一份「该会话当前有 staged/bound attach 的变量集合」⇒ 同一条注记。为了重放更稳，本定案收紧为：**只要出现了合法 `@DSH_SECRET_*` 标记，就把它逐变量写进注记的映射行**（不依赖“是否刚好在本步绑定”），而**绑定/授权**只对真的有暂存记录的变量发生（`session/event` 只消费暂存项）。这样：

- 刷新、重放、fork 后重新组请求，日志文本恒定、注记文本恒定（按 source 去重），两者的对应关系也恒定；
- 不存在「同一条日志消息在不同重放里得到不同模型文本」的危险（正文从不被改写）；
- 代价：人手打的 `@DSH_SECRET_X` 也会在注记里被写明 `[secret DSH_SECRET_X]`（无害：它不会被绑定，因为没有暂存记录），且比让模型去 read 一个文件更接近真相。

---

## 5. 模型侧投递与刷新/重放

### 5.1 模型侧的三个来源，逐条定案

| 来源 | 内容 | 稳定性 |
|---|---|---|
| 用户消息正文 | **与日志逐字相同**（`@DSH_SECRET_VAR`），不做替换 | 无改写 ⇒ 天然稳定 |
| 追加注记消息 | 变量名/作用域/**逐变量的 `[secret VAR]` 映射行**/取用方式/「不要当文件路径」 | durable（`user/message`，`source.kind='secret-attach'`），按 source 去重 ⇒ 重放时从日志复现同一行 |
| `shellEnv` 注入 | 变量本身 | **不**durable：Host 重启后丢失（5.4） |

### 5.2 ~~锚点定位算法（可单测的纯函数）~~ **已作废（t11）**

原稿打算在 `agent/pre-step` 里"回头扫日志找锚点"：

```
findUserMessageSeq(events, variable, exclude) → …            ← 不再存在
```

**作废理由（t3 采纳、t11 再次确认）**：`agent/pre-step` 里的消息**还没有 seq**（seq 只在 append 之后才可知），而锚点必须是真实 seq。现在锚点直接来自 `session/event` 的 `event.seq`（该事件只在 durable 之后发布，且 seed 事件不发布 ⇒ 重放不可能重绑）：见 4.2 的绑定伪码。`src/anchor.ts` 的 `findAnchorSeq` 只服务 round 2 的「Agent 索要」方向（它锚定的是 assistant 消息），与本方向无关。

### 5.3 注入 context 的形状

```ts
createUserMessage({
  source: {
    kind: 'secret-attach',          // 需 declare module '@deepseek-ai/dsh-llm' 合并（E4）
    form: 'instructions',           // 取自 chat 的 KNOWN_FORMS
    version: 1,
    variables: [{ variable, name, scope }],  // 值无关，可进日志
  },
  content: [{ type: 'text', text: NOTE }],
})
```

`NOTE` 为固定模板（3.2b），与 round 2 的固定文案纪律一致：不拼接任何上游文本。

### 5.4 刷新 / 重放 / 重启的明确结论

| 场景 | 结果 |
|---|---|
| 页面刷新（Host 未重启） | 草稿：chip 变纯文本 `@VAR`，由 lexicon 装饰回胶囊观感；对话框：气泡胶囊与注入说明行由日志复现；模型侧：正文逐字不变、注记按 source 去重后仍是同一行；值仍可注入 |
| 会话重放（回看历史） | 与刷新相同；已结算/已绑定的历史不再产生任何新绑定（staged 记录已被消费） |
| Host 重启 | staged 与 grants 丢失 ⇒ 变量不再注入；日志与对话框不变（标记/说明行仍在）；模型若仍引用该变量，shell 里取不到值（工具会如实报错）。**定案：不做自动重新武装**（见下） |
| 会话 fork | 子会话不可见父的 staged/grant（E6）；日志前缀里的标记照旧保留 `@` 形态，但子会话没有该变量 ⇒ 其 `agent/pre-step` 不生成注记行、也不绑定——**t3 需按此断言**（可机器证明：注记只对暂存/已绑定变量生成 + AttachStore 会话隔离） |

**为什么不做自动重新武装（`persistent` 也一样）：** 重启后凭据库里确实还有值，但把它静默地重新变成“本会话可用的环境变量”，等于在**没有人类在场的新进程里重新武装一次授权**；同时锚点需要重扫日志（可能面对被压缩/改写过的历史）。本定案选择 fail-closed，把这条列为 P2/未决（第 9 节 R6）。

---

## 6. 文件级改动点

### 6.1 Client 半（`src/client/entry.ts`，仍是**单文件 classic script**，无 import/export）

| 区块 | 改动 |
|---|---|
| 头注释 | 增补「本轮新增反方向入口」的说明（值不变量、两态胶囊、真 chip + 兜底阶梯） |
| 类型 | 全部用**本地结构类型**（照 round 2 的 `ReactLike`/`ClientContextLike` 手法）；`ClientContextLike` 只增加 cordis 的**可选依赖座位** `inject(names, cb)`，可选服务另立 `OptionalServicesLike`（`locale?` / `inputTriggers?` / `sessions?` / `effect?`）**且只在 `ctx.inject([...], cb)` 的回调形参上使用**——**不得**把 `sessions?`/`inputTriggers?`/`locale?` 声明成 `ClientContextLike` 上的字段：那既是 t7 修掉的直读缺陷写法，也会让 tsc 失去对 inject 契约的检查；新增 `TokenSpanLike`/`ReferenceInsertLike`/`OccurrenceLike`/`InputActionsLike`/`InputStateLike` |
| 常量 | `ATTACH_PATH='/api/secret.attach'`、`RELEASE_PATH='/api/secret.release'`、`ATTACHED_PATH='/api/secret.attached'`、`SOURCE_NAME='secret'`、`MARKER_RE`、`MODEL_FORM`、`TEXT`（新增全部中文文案：按钮 `附密钥`/`已展开`、胶囊标题/字段标签/作用域两选项与提示/插入/取消/丢弃/关闭/状态行/失败文案） |
| 纯函数 | `deriveMarker(variable)`、`parseMarkers(text)`、`rewriteModelText(text)`（可选，客户端只用于自测一致性）、`parseAttachResponse(payload)`、`readAttachedList(payload)`、`readOccurrences(input)` |
| store | 模块级 `attachUi`（`SnapshotStore` 风格的手写 subscribe/getSnapshot，照 round 2 的 poller 写法）+ `staged: Map<variable, {scope,name,label}>`（**只存值无关字段**） |
| 组件 | `SecretAttachToggle`（按钮，F2 形状 + F7 标准 props）；`SecretAttachCapsule`（overlay 条目，两态）；两者共享 store |
| source | `secretSource = { trigger:'@', name:'secret', showGroupTitle:false, candidates: async()=>[], lexicon:(session)=>[...variables], subscribeLexicon:(session,fn)=>{...}, openReference(session, {ref}) {…return true}, codec:{ clipboardText:(ref)=>'@'+ref, serialize:(ref)=>Promise.resolve('@'+ref) } }` |
| 插入器 | `insertChip(sessionId, variable, span, actions)`：L1 `sessionsScope.bail(sessionsScope,'slash/input-insert-reference',{reference,span})` → L3 `inputActions.insertText('@'+variable, span)` → L4 手动提示（**L2 已判冗余移除**，见 §7.1）；返回实际使用的梯级 `'chip' \| 'text' \| 'manual'`，经 `ATTACH_SEAM.insertChip` 与胶囊详情面观测（**实施后不再写进 DOM 属性**，见 B3） |
| 注册 | **座位：`conversation.input.left`**（captain 裁定 1，原稿的 `input.right` 已废止，见 §3.1）：`apply(ctx)` 新增 `ctx.slots.inject('conversation.input.left', …)` 与 `ctx.slots.inject('conversation.input.overlay', …)` 两处 slot 条目；**既有三处注册一行不改**。**三个可选服务（`locale` / `inputTriggers` / `sessions`）既不写进 `inject`、也不直接读 `ctx.<name>`**，一律走 cordis 公开的可选座位 `ctx.inject([...], cb)`（实际写法：`ctx.inject(['inputTriggers'], (scoped) => scoped.inputTriggers.registerSource(secretSource))`、`ctx.inject(['sessions'], (scoped) => { sessionsScope = (id) => scoped.sessions.scope(id) })`、`ctx.inject(['locale'], …)`），`inject` 声明保持 `['slots','uiConversation']` 不变。**理由**：直读未注入的服务会被 cordis ctx Proxy 抛 `cannot get property "<name>" without inject`，导致 `apply()` 抛出、该 entry failed、**整页 boot 失败**——这正是 t7 修掉的发布阻塞缺陷（README 已如实记录）。 |
| 测试缝 | `SEAM` 升到 `version: 2`，追加 `ATTACH_PATH/RELEASE_PATH/ATTACHED_PATH/SOURCE_NAME/MARKER_RE/deriveMarker/parseMarkers/parseAttachResponse/readAttachedList/secretSource/ATTACH_TEXT`；**不得**导出任何持有值的对象（store 只含值无关字段） |
| 样式 | 沿用 `ensureCardStyle` 手法注入第二条 stylesheet（`data-plugin-css` 复用同一 id 或新增 `…/secret-attach.css`）；只使用 theme token；无 `position:fixed`、无全视口 |

**tsconfig 约束**：`tsconfig.client.json` 是 `types: []` + `moduleDetection: legacy` + `include: ['src/client']`，因此新代码**不能** import 任何 `@deepseek-ai/*`；所有跨包类型只能用本地结构类型或 ambient `declare module`。已有的 `declare module '@deepseek-ai/dsh-client-ui-chat/client'` 保留，不改。

### 6.2 Host 半

| 文件 | 改动 |
|---|---|
| `src/naming.ts` | 新增 `MARKER_RE`/`markerFor(envVar)`/`parseMarkers(text)`、`validateAttach(raw)`（复用 `NAME_PATTERN`/`ENV_VAR_PATTERN`/`RESERVED_ENV_VARS`/`deriveEnvVar`）；既有函数不改 |
| `src/types.ts` | 新增 `SecretAttachInput`、`StagedAttachView`、`SecretAttachOutcome`、`SecretAttachedView`、`SecretAttachSource`（值无关） |
| `src/attachments.ts`（**新**） | `StagedAttach`（含 `value`）+ `AttachStore`：`put/get/list/remove/release/forget/sweep(now)`、`(sessionId, envVar)` 键、容量上限、TTL 计时器（注入 `schedule` 接缝，便于单测） |
| `src/protocol.ts` | 新增 `parseAttach(raw)`、`parseRelease(raw)`、`parseSessionId(raw)`、`attachedView(...)`；`MAX_VALUE` 复用 |
| `src/routes.ts` | 新增 3 条路由（6.3），沿用 `jsonResponse` 与 `requestBody:'buffered'` |
| `src/service.ts` | 新增 `attach(raw)`、`release(raw)`、`attached(sessionId)`、`bindFromMessages(session, messages, signal)`（返回 `{rewritten, bound, unbound}`，只做绑定与值无关载荷；不动既有 `request/answer/converse/complete`） |
| `src/inject.ts`（**新**） | `installAttachBinding(ctx, deps)`：注册 `session/event`（`type==='user/message'` 时绑定，锚点 = 该事件 seq）+ `agent/pre-step`（追加值无关注记，**不改正文**；按自身 source 去重，见文首 t11 修正块）；导出 `noteSourcesOn(session)` 供去重读取 |
| `src/grants.ts` | `Grant.callId` 改 `readonly callId?: string`（可选，加法；现有调用方传值照旧） |
| `src/config.ts` | 新增 `attachTtlMs: 1800000`、`maxAttachmentsPerSession: 8`；`assertConfig` 增加对应正整数校验 |
| `src/index.ts` | 组装 `AttachStore`；`registerSecretRoutes` 传 service；`installAttachBinding`；`session/disposed` 同时 `attachments.forget(sessionId)` |
| `package.json` | `version: 0.2.0`；`dsh.client.inject` += `@deepseek-ai/dsh-client-ui-input-trigger`（提供 `ctx.inputTriggers`）与 `@deepseek-ai/dsh-api-session-controller`（提供 `sessions`）；`peerDependencies` += `@deepseek-ai/dsh-llm`（`createUserMessage`/`freezeMessage`）；`devDependencies` 已有 `@deepseek-ai/dsh-llm` |
| `README.md` | 新增「人类主动附加秘密」章节：形态、座位、真 chip 机制与兜底阶梯、模型侧逐字样例、值不变量（含 1.3 的收紧措辞）、刷新/重启行为 |

### 6.3 路由归属

| 路由 | 方法 | 处理 |
|---|---|---|
| `/api/secret.attach` | POST | `parseAttach` → `service.attach` |
| `/api/secret.release` | POST | `parseRelease` → `service.release` |
| `/api/secret.attached` | GET | query `sessionId` → `service.attached` |

### 6.4 测试文件

| 文件 | 内容 |
|---|---|
| `test/attach.test.ts`（新） | `AttachStore`（TTL/容量/覆盖/隔离/forget）、`validateAttach`、`parseAttach`、`attachedView`、`findUserMessageSeq`、`bindFromMessages`（含 anchor 缺失 → 不绑定）、`renderAttachNote`、`Grant.callId` 可选后既有路径不回归 |
| `test/client-attach.test.ts`（新） | 照 round 2 的 `T0` 引导（`__ModuleLoader__` + 桩 React + **真 cordis 上下文**：`new Context()` + sibling `provide` + 工厂自己的 `inject` 作 fiber 门；手写「假 ctx」已弃用，见 A2.1）驱动新 SEAM（`__cordisSecretAttach`）：注册形状（既有 3 处注册动作不动 + 新 2 个 slot 条目）、`MARKER_RE`、`deriveMarker`、`parseAttachResponse`、`readAttachedList`、`secretSource.codec.serialize`、`lexicon`、`openReference` |
| `test/unit.test.ts` / `test/register.test.ts` | 只追加，既有断言一条不删（47 条 → 只增） |

---

## 7. 兜底阶梯

### 7.1 插入阶梯（客户端，按序尝试，每级都可被 t3 观测）

| 级别 | 机制 | 失败判据 | 后果 |
|---|---|---|---|
| **L1** | `sessionCtx.bail(actx,'slash/input-insert-reference',{reference, span})` 返回 `true` | 返回非 true（相位/`draftRev` CAS 失败、无监听者） | → L3 |
| ~~L2~~ | ~~`inputTriggers.sessionOf(actx).toggleSource('secret', syntheticHit)` → 等分组 `ready` → `.pick('secret', 0)`~~ | — | **实施中判定为冗余并移除**：该 pick 管线的终点（`settle → execute`）就是 L1 这同一个 `slash/input-insert-reference` 事件、且传的是同一个 `span`，所以它不可能在 L1 失败的地方成功。保留它只会增加一条无法验证成功率的路径。 |
| **L3** | `inputActions.insertText('@'+variable, span)` + source `lexicon()` 让该 token 装饰成引用 | `insertText` 返回 false（编辑器锁/相位） | → L4 |
| **L4** | 胶囊内显示变量名与「请手动输入 `@DSH_SECRET_X`」，保留 staged attach | — | 值已登记，人工可补救；绝不谎报已插入 |

判据纪律：只有 L1 成功才允许在 UI/文档里说「内联胶囊（真 chip）」；L3 必须说「装饰型内联引用」；L4 必须说「纯文本」。客户端 `insertChip()` 返回实际使用的梯级，测试对三级分别断言（含"chip 成功时绝不重复插入纯文本"）。

### 7.2 运行期兜底（Host / 绑定 / 展示）

| 编号 | 失效场景 | 设计行为 |
|---|---|---|
| F1 | `POST attach` 时凭据库写入失败（persistent） | 400/500 固定文案；**不**产生 staged 记录、**不**插 chip、值不保留 |
| F2 | attach 成功后用户从不发送 | 永不提升为 Grant ⇒ 永不注入；TTL / 会话结束丢弃 |
| F3 | 标记出现在消息里但无 staged attach（人手打 / 别的客户端） | **不绑定**；注记里仍按 4.3 逐变量写明 `正文里的 @… 即该变量，模型侧写作 [secret …]`（纯函数，避免模型去 read 一个文件）；因为它从未绑定，`describeVariable` 只对**暂存或已绑定**的变量生成注记行 ⇒ 人手标记**不会**生成注记行，模型侧不会宣称该变量可用 |
| F4 | 暂存项存在但注记无法生成（会话不可读等边界） | 不绑定；正文与日志原样（fail-closed）；变量不可用，人类可从胶囊看到 staged 状态 |
| F5 | `agent/pre-step` 监听缺席（插件未加载/被禁） | 无注记、无绑定、无注入 ⇒ 日志里的 `@VAR` 只是文本；Agent 拿不到变量（fail-closed），人类可从胶囊看到 staged 状态 |
| F6 | 客户端 `sessions` 或 `inputTriggers`（或 `locale`）缺失 | **不抛、不阻断启动**（t7 定案）：按钮/胶囊照常注册并渲染（它们只依赖已声明的 `slots`/`uiConversation`）；缺 `sessions` 时插入阶梯从 L3 起步，缺 `inputTriggers` 时不注册引用源（无 `@` 菜单集成、刷新后无 lexicon 装饰），缺 `locale` 时只用字面量文案；既有「Agent 索要」卡片不受影响 |
| F7 | `bail` 事件未来被收窄（R1） | 自动降级到 L3（纯文本 + `lexicon` 装饰引用），再不行 L4（手动提示）——同一 `insertChip` 函数内的顺序尝试 |
| F8 | `GET attached` 不可达 | `detail` 只显示本地已知信息 + 「状态未知」，不阻塞任何操作 |
| F9 | 变量名冲突/覆盖 | attach 响应 `replaced:true`；胶囊明确提示「已覆盖本会话先前登记的变量」 |
| F10 | 明文误入错误路径（上游异常文本含值） | 固定文案 + `redactSecrets(...,[value])` 双层；`readStore` 同法（`src/service.ts:126-141`） |

---

## 8. t3 可机械执行的验证清单

> 约定：`$R = projects/cordis-plugin-secret`。每条给出**命令/断言**与**判据**；判据不成立即 fail。带「活体」的条目需要浏览器/真实会话，无法执行时**必须标注“未验证”**，不得推定通过。

### 8.0 A 段：可机器证明

**A1 机制复核（静态证据，逐条 grep 到行）**
1. `chip-node.d.ts` 存在 `ReferenceChipNode`/`$createReferenceChipNode`，且 `createDOM` 设置 `data-composer-chip`（A1/A2）。
2. `contract/input.d.ts` 里 `'slash/input-insert-reference'` 仍为 bail 事件、`InsertReferenceRequest = {reference, span}`、`InputTarget.insertReference` 仍在（A3/A4）。
3. `dsh-client-ui-input-trigger/lib/client.js` 仍在会话作用域 `actx.on('slash/input-insert-reference', …)`，且 `execute()` 用它（A5/A9）。
4. `sinkSerialized` 仍逐 occurrence 调 `serializeReference`，失败即 `settleDetachedFailure`（2.3）。
5. `findUserMessageSeq` 依赖的 `'user/message': UserMessage` 仍在 `SessionEventMap`（E5）。
   任一条消失 ⇒ R1 触发，本定案须重审（不是“测试失败”而是“假设失效”）。

**A2 客户端单元（新 SEAM，`test/client-attach.test.ts`）**
1. `mod.apply(ctx)`（**必须挂进真 cordis 上下文**：`new Context()` + sibling `provide` + 用工厂自己的 `inject` 作 fiber 门；手写「假 ctx」没有「读未声明服务即抛」语义，会漏掉 boot 缺陷，t7 已弃用）捕获注册：`uiConversation.events.register` 恰 1 次（既有定义不动）；`slots.register` 捕获到的 `name` 集合 = `{conversation.chat.node, tool.call.toolview, conversation.input.left, conversation.input.overlay}`，其中 `input.left.id === 'secret-attach-toggle'`、`input.overlay.id === 'secret-attach-capsule'`。
2. `api.SOURCE_NAME === 'secret'`；`api.secretSource.trigger === '@'`；`await api.secretSource.candidates({sessionId:'s'},{query:'',position:'inline',drilled:false,signal:new AbortController().signal})` → `[]`（不得往 `@` 菜单塞候选）。
3. `api.secretSource.codec.serialize('DSH_SECRET_X', new AbortController().signal)` → `'@DSH_SECRET_X'`；`clipboardText('DSH_SECRET_X')` → `'@DSH_SECRET_X'`。
4. `api.MARKER_RE` 行为表：命中 `'@DSH_SECRET_OPENAI'`（行首/空白后）、`'a @DSH_SECRET_X'`；不命中 `'x@DSH_SECRET_X'`（无边界）、`'@DSH_SECRET_'`（缺后缀）、`'@DSH_SECRET_X.'` 须命中 `DSH_SECRET_X` 部分且不吞标点。
5. `api.parseAttachResponse({ok:true,variable:'DSH_SECRET_X',scope:'session',replaced:false})` → 结构正确且**无 value 字段**；畸形输入一律 `null`（防御式）。
6. `api.readAttachedList({ok:true,attachments:[…]})` 逐字段类型校验；未知字段丢弃。
7. 值面：`JSON.stringify(api)`（整个 SEAM）**不含**任何测试哨兵值；`api.secretSource` 的对象图上没有任何字段可承载值（`Object.keys` 断言集合）。

**A3 Host 单元（`test/attach.test.ts`）**
1. `validateAttach`：拒绝缺 `name`/非法 name/非法 scope/空 value/超长 value/保留 `envVar`/非法 `envVar`；接受合法最小体。
2. `AttachStore`：`put` 同 `(session,envVar)` 覆盖并 `replaced=true`；不同会话互不可见；`maxAttachmentsPerSession` 触顶拒绝；TTL 到期（用注入的假 `schedule` 触发）后 `get` → undefined；`forget(sessionId)` 只清该会话。
3. `bindFromMessages`：给定含 `@DSH_SECRET_X` 的 `user/message` 事件日志 + staged 记录 → 返回 `bound:[{variable:'DSH_SECRET_X',scope:'session',anchorSeq:<seq>}]`，且 `grants.resolve(session,'x').code === 'ok'`；staged 记录被消费（再调一次 → `bound: []`，不重复绑定）。**关键：调用前 `grants.valueFor(session,'DSH_SECRET_X') === undefined`**（证明 attach 阶段不注入）。
4. 锚点缺失：日志里没有该标记 → `bound: []`、`unbound:[variable]`、`grants.size()` 不变。
5. 撤销：绑定后把该 seq 从 `surface.nodes` 移除（或让 `isOwnSeq` 为 false）→ `grants.resolve` 返回 `revoked-anchor`/`revoked-not-own`，`valueFor` → undefined。
6. 注记映射行与去重：`renderAttachNote([{variable:'DSH_SECRET_X',…}])` 逐字含 `正文里的 @DSH_SECRET_X 即该变量，模型侧写作 [secret DSH_SECRET_X]；它不是文件路径。`；`rewriteMarkers('请用 @DSH_SECRET_X 跑')` → `'请用 [secret DSH_SECRET_X] 跑'`（纯函数，重复调用同结果）；**正文不被替换**（`agent/pre-step` 返回的 `decision.messages` 与入参同一对象/同一文本）。
7. `renderAttachNote(bound)` 逐字等于模板（含变量名、作用域中文、shell 取用提示、「不要把该标记当作文件路径读取」），且**不含**任何值。
8. `Grant.callId` 可选后：既有 `service.request`/`complete` 路径的单测全绿（回归）。

**A4 路由/协议（无真实浏览器）**
1. 直接构造 `SecretService`（假 ports）+ 假 `ctx.connection.fetch.register` 捕获三条路由的 `path/methods`，断言注册形状与 `requestBody:'buffered'`。
2. `POST attach` 的响应体 JSON **不含** `value` 字段（对成功与失败两种响应都断言）。
3. 错误收敛：让 `credentials.set` 抛一个包含哨兵值的 Error → 响应 `error` 字段**不含**哨兵值，且等于固定文案。
4. `GET attached` 的 `state` 字段在 staged/bound 两种情形下分别正确。

**A5 静态面（无明文外泄面）**
1. `Select-String $R/src/client/entry.ts -Pattern 'console\.|document\.title|location\.href|history\.|localStorage|sessionStorage'` → 只允许出现在**不含值**的既有路径（判据同 round 2 T5.3）。
2. `Select-String $R/src -Pattern 'value'` 人工复核一次：值只出现在 `service.attach`、`AttachStore`、`credentials.set`、`redactSecrets` 的入参位置，且**从不**进入 `presentationMeta`/`PendingView`/`attachedView`/context source。
3. `Select-String $R/src/client/entry.ts -Pattern "position:fixed|inset:0"` → 0 命中（不复活全视口面）。
4. `grep -c "conversation.input.left"` = 1、`grep -c "conversation.input.overlay"` = 1（按实测写在 `src/client/entry.ts`：两者各恰 1 行，即 `ATTACH_SLOT` / `CAPSULE_SLOT` 两个常量）、`grep -c "conversation.input.right"` = 0（本插件不落该座位，它只属于参照实现 F2/F3）、`"slash/input-insert-reference"` ≤ 1（插入器里唯一一处）。

**A6 机械三连（沿用 t2 verify，不新增未验证命令）**

```
npm --prefix projects/cordis-plugin-secret run typecheck   # exit 0
npm --prefix projects/cordis-plugin-secret test            # 全绿，用例数只增不减（≥47）
npm --prefix projects/cordis-plugin-secret run build       # exit 0；lib/client/entry.js 无 import/export
```
附加静态判据：`Select-String $R/lib/client/entry.js -Pattern '^\s*(import|export)\s'` → 0 命中。

### 8.1 B 段：需真人确认（或活体 DOM）

| 编号 | 事项 | 判据（人工/活体） |
|---|---|---|
| B1 | 按钮真的出现在工具栏，且**与 VisionModeToggle / 「访问模式」权限控件的相对位置**符合预期：实际落点 `[访问模式][计划][新按钮]`（紧邻 `.modes` 组右侧；座位已由 captain 裁定 1 定为 `conversation.input.left`，见 §3.1）；**「是否接受不夹在权限与计划之间」仍是待人工确认项** | 截图 + 一句确认；「夹在权限与计划之间」用公开座位做不到（§3.1 已写明代价并否决），若人类坚持则需另立方案 |
| B2 | 按下按钮 → 输入框上方出现填值胶囊，几何不遮挡正在输入的文本 | 目视；`document.querySelector('[data-secret-attach-capsule]')` 的 `getBoundingClientRect().bottom <= card.top`（可机器测，但“好看与否”仍需人确认） |
| B3 | 填入值 + 选作用域 + 点插入 → 草稿光标处出现内联胶囊 | 活体：断言 `document.querySelectorAll('[data-composer-chip="secret"]').length === 1` 且其文本包含变量名；**同时**记录实际梯级——实施后梯级不再写进 DOM 属性，而是由 `insertChip()` 返回值经胶囊详情面显示（`已在光标处插入胶囊` / `宿主未提供真 chip…` / `请在草稿中手动输入 …`），故这一条需人眼读胶囊文本；机器侧由 `test/client-attach.test.ts` 对 `insertChip` 的三种返回值直接断言 |
| B4 | 点击内联胶囊 → 大胶囊在输入框上方展开，显示变量名/作用域/状态，无值 | 目视 + 断言 detail 态 DOM 存在且其 `textContent` 不含输入的值 |
| B5 | 发送后，对话框那条消息上出现只显示变量名的胶囊 | 活体：`[...document.querySelectorAll('[data-ref-chip]')]` 至少一个 `textContent === 'DSH_SECRET_X'` |
| B6 | 模型侧：Agent 真的拿到了变量名（而非值） | 让 Agent 复述它看到的标记（应含 `[secret DSH_SECRET_X]` 与注入说明），并**断言它没有输出任何值** |
| B7 | 后续 shell 能取到值 | 在同一会话让 Agent 执行 `$env:DSH_SECRET_X`（PowerShell）比对；人工确认值正确且未被打印进对话（Agent 只允许回显布尔/长度） |
| B8 | 回退/编辑该消息后变量失效 | 用「编辑并重试」改写该消息 → 再让 Agent 取用，应取不到；`GET attached` 显示该变量消失 |
| B9 | 取消/关闭/刷新不残留 | 打开胶囊填入值后取消；刷新页面；检查草稿与 DOM 均无值（`Get-ChildItem $env:DSH_HOME/sessions -Recurse` 里 grep 哨兵值 → 0 命中，人工执行） |
| B10 | 默认作用域为「仅本次会话有效」，可切「持久」 | 目视 + 切持久后 `credentials.describe(envVar).configured === true`（活体） |

---

## 9. 风险与未决项

| 项 | 说明 | 处置 |
|---|---|---|
| R1 | 我们依赖 `slash/input-insert-reference` 这一 scoped bail 事件（虽在冻结契约里，但 `InputActions` 面被刻意排除） | 已定 **L3（纯文本 + lexicon 装饰引用）一级自动降级**；L2 已判冗余并移除（§7.1，captain 采纳偏差 4）。A1 的第 2/3 条是看门狗；若未来 rc 收窄，重审定案 |
| R2 | 「允许改写原消息」的边界 | 用户定案确实允许改写原消息，但**真实接线不允许只改模型请求侧**（t11 实证：`agent/pre-step` 的返回值就是落盘的那条）。因此本定案**不改写任何正文**：日志与用户气泡保留 `@DSH_SECRET_*`，模型侧的 `[secret …]` 形态由**注记逐变量逐字**给出。这样两者都成立，且不存在"日志与模型文本不一致"的重放风险 |
| R3 | 对话框胶囊是 `data-ref-chip="file"`，点击会尝试 `openFile('DSH_SECRET_X')` | **captain 定案并采纳 (b)：接受该缺陷，写成「已知限制」并说明点击行为**（README 与本节均已写明：点转录里的胶囊会尝试打开同名文件；无害、不泄露，但行为不正确，需真人现场确认）。**「为什么 (a) 做不到」的完整证明（captain 补齐）**：`projectUserText` 只认三种 token（primitives `lib/index.js:6724` 的正则：`/名称`、`@"…"`、`@非空白`）；`:6753` 的判定是 `@` 开头**必然**映射为 `'file'`（或 `'folder'`），只有 `/` token 才可能是 `void 0`；而 `/` token 又必须在 caller 传入的 `slashNames` 名单里（`:6731`）。因此**不存在"是 chip 又不可点"的 `@` 形态**。定案原稿的 (a) 写法（"让其 `openReference` 返回 false/惰性"）也一并证伪：`openReference` 只在**草稿编辑器**被调用（conversation `lib/client.js:13166`/`:13518`），转录气泡的胶囊点击分支在 primitives 里**硬编码** `references.openFile(...)`（`:6760-6781`），**完全不经过 input-trigger 注册面**，没有任何插件钩子。另两条路均否决：wire session 形态 `@[label](dsh-session:…)` 虽无 onClick（`:6753-6764`），但会被 `dsh-session-reference` 当跨会话引用解析（`lib/index.js:485-508`）、可能让整步失败；整体接管 `conversation.chat.node` 的 `user` key 需重写附件/图片/markdown/动作行，脆弱度过高。 |
| R4 | 输入框上方几何是复用 `@` 菜单的既有位置 | B1/B2 人工确认；若不满意，`fill` 态可改为 `top:0` 覆盖输入框（一行 CSS），代价是遮挡首行文本 |
| R5 | 不变量措辞收紧（1.3） | **需 captain 确认**并同步 README |
| R6 | Host 重启后不自动重新武装 | 明确为 fail-closed；`persistent` 值仍在凭据库，人类可重新附加。若要 P2，需新增“重扫日志 + 凭据解析”路径并重审安全姿态 |
| R7 | 会话切换时 staged 记录仍在 Host（属于该会话） | 视为正确（会话级），并有 TTL/`session/disposed` 兜底；`GET attached` 按会话隔离（A3.2 覆盖） |
| R8 | `MAX_VALUE` 沿用 65536 字符 | 与既有 `parseAnswer` 一致；如需更大值单独立项 |
| R9 | 客户端 `lexicon` 必须保持热（否则刷新后 token 不装饰） | `subscribeLexicon` + `refreshLexicon` 触发编辑器 rescan（B2 证据链）；A2.2 钉住 `candidates` 为空 |

---

## 10. 由本定案直接决定的 t2 实施顺序

1. Host 侧地基：`naming.validateAttach`/`MARKER_RE` → `attachments.ts`（AttachStore）→ `protocol` 的 `parseAttach`/`attachedView` → `grants.callId?` → `config` 两键；先让 `test/attach.test.ts` 绿。
2. Host 侧绑定：`inject.ts`（`findUserMessageSeq` + `bindFromMessages` + `renderAttachNote`）→ `index.ts` 组装 + `session/disposed`；A3 全绿。
3. Host 侧路由：`routes.ts` 三条 + `service.attach/release/attached`；A4 全绿（尤其“响应无 value”与固定文案）。
4. Client 半：常量/纯函数/store → `SecretAttachToggle` → `SecretAttachCapsule` → `secretSource` → `insertChip` 阶梯 → `apply` 三处新注册 → SEAM v2；`test/client-attach.test.ts` 绿。
5. `package.json`（version 0.2.0 + 两个 client.inject + peerDeps）与 `README.md`。
6. 三连（typecheck / test / build）+ 无 import/export 静态判据，并在报告里贴原始输出。
7. 把 8.1 的 B1–B10 交给 t3：**可机器证明的 8.0 全绿** + **B 段逐条给出人工结论或“未验证”**，不得推定。
