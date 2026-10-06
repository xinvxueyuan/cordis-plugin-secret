# cordis-plugin-secret

[![npm version](https://img.shields.io/npm/v/@xinvxueyuan/cordis-plugin-secret)](https://www.npmjs.com/package/@xinvxueyuan/cordis-plugin-secret)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE-MIT)
[![GitHub](https://img.shields.io/github/stars/xinvxueyuan/cordis-plugin-secret)](https://github.com/xinvxueyuan/cordis-plugin-secret)

> Cordis（DeepSeek Harness）插件：**密钥在人与 Agent 之间双向流动——Agent 可以开口索取，人类也可以把一枚密钥主动附加到自己的消息上——而 Agent 永远只拿到一个不透明的变量名（如 `DSH_SECRET_OPENAI`）。插件自身从不把值放进工具结果、错误消息、日志、DOM 或会话记录；值只经 `ctx.shellEnv` 按会话注入到 shell 环境——由 Agent 自己避免回显。**

- Host 半（索取方向）：注册 `secret_request` 工具；用 `ctx.authorization` 的凭据获取流程承载持久授权；用 `ctx.credentials` 落库；用 `ctx.shellEnv` 按会话注入 `DSH_SECRET_*`。
- Host 半（附加方向）：`POST /api/secret.attach` 把人类填的值**暂存**在进程内存（暂存不等于授权：此时不注入任何变量）；携带标记 `@DSH_SECRET_*` 的用户消息一旦落进会话日志，`session/event` 就把它**提升为按该条消息锚定的授权**；`agent/pre-step` 追加一条**只有变量名**的说明消息，其中逐变量写明这枚标记在模型侧写作 `[secret DSH_SECRET_*]`（正文本身不改写——harness 会让改写落盘，见下文）。
- Client 半（索取方向）：在 Agent 输出流里渲染**会话流内一级卡片**（`conversation.chat.node`，`key=secret-request`），**无 `shell.overlay` 遮罩**；卡片带 `type="password"` 输入与显示/隐藏切换，把「同意 / 拒绝 / 忽略 / 其他」四个决定、申请理由、用途说明与**授权范围**摆在人类眼前，并允许人类**改写 Agent 请求的范围**。
- Client 半（附加方向）：在输入区 `conversation.input.left`（紧随「访问模式 / 计划」控件组右侧）加一个**切换式按钮**；按下后在输入框上方（`conversation.input.overlay`）浮起**填值胶囊**；填完点「插入到光标处」，草稿光标处得到**真正的内联 chip**（`data-composer-chip="secret"`，只显示变量名），可在后续 shell 取用；点击该 chip（或刷新后由 lexicon 装饰出的同名引用）会在同一浮层展开**只读详情胶囊**。
- 传输：两个方向的对话框都经本插件自有的、位于 `ctx.connection` 信任栅栏内的 `/api` 路由与 Host 通信。密钥值只出现在 `POST /api/secret.answer` 与 `POST /api/secret.attach` 的请求体里，从不进入 URL / 查询串 / 会话日志 / 响应体。

## 安全不变量与副作用披露

### 安全不变量（实现并测试）

1. **插件自身的输出永不携带明文**：工具结果、错误消息、日志、事件、渲染文本、HTTP 响应体与 DOM 属性中都不含密钥值；`render()` 只输出变量名与元数据。单测对四种 decision 的所有字段做全量字符串扫描，断言值不出现；Client 半另有断言证明填值胶囊的值不越出那个掩码输入框。**边界**：值确实会按会话注入到 shell 环境（这是本插件的功能），因此"明文不进上下文"取决于 Agent 不回显 `$env:DSH_SECRET_*`，而不是插件的输出通道。
2. **Agent 只拿到变量名**：`approved` 返回 `{ decision, variable, scope, ref, source }`，`variable` 形如 `DSH_SECRET_OPENAI`。
3. **值只发给本机 Host**：客户端只向 `/api/secret.answer`（索取方向）与 `/api/secret.attach`（附加方向）发起同源 POST（签名 HttpOnly Cookie + Host/Origin 栅栏），不写 URL、不写 localStorage、不打印 console。附加方向的 `GET /api/secret.attached` 只回传变量名/名称/范围/状态，永不回传值。
4. **会话级密钥不落盘**：`scope: "session"` 的值只存在于进程内存（Host 的暂存表与会话授权表）。落盘只走凭据服务，且只发生在 `persistent`。
5. **持久化只经凭据服务**：`persistent` 经 `ctx.credentials.set(<变量名>, value)` 写入凭据引用空间（provider 管理的可写源）；同时向记录空间提交一条**不含密钥材料**的标记记录（索取方向 `kind: "grant"`，附加方向 `kind: "attachment"`，payload 只有 `envVar/name/scope/authorizedAt`）。绝不写自建文件，绝不在仓库里存明文。
6. **会话边界失败关闭**（见「边界处理」）：锚点离开会话表面即撤销并不再注入。
7. **明文允许存在的全部位置（穷举，仅此六处）**：
   - P1 填值胶囊的本地输入 state（掩码输入框）；
   - P2 一次 `POST /api/secret.attach` 的请求体；
   - P3 Host 进程内存里的暂存记录（已登记但尚未随消息发送）；
   - P4 Host 进程内存里的 `GrantStore` 记录（已绑定到某条消息）；
   - P5 **仅当人类显式选择「持久」**时写入的凭据库；
   - P6 `shellEnv` 在执行期把值注入子进程的环境变量。

   **明文绝不允许出现**：模型上下文（对话文本）、持久会话日志（任何事件字段）、工具结果、DOM 属性与可见文本、**未发送草稿的持久化投影**、URL/查询串、HTTP 响应体、异常与错误消息（一律固定文案，不复述上游）、console、以及除 P5 之外的任何落盘文件。

   这条穷举是刻意的：Host 必须持有值才能在后续 shell 里注入（否则"随消息取用"不可能成立），因此本插件不声称"值不进入内存"——只声称上面这张表，并且用单测钉住它。

### 副作用披露（按真实实现逐条列出）

- **会按会话把明文注入子进程环境**：`ctx.shellEnv.register` 为每个变量名声明一个 contributor，每次 shell 执行都**重新校验该执行的会话是否仍持有有效授权**，有效才注入。这是插件功能本身，也是明文唯一离开本进程的出口——注入给子进程意味着该子进程写下的任何输出都可能带上它，是否回显由 Agent 负责。
- **会在 Host 进程内存里持有明文**：人类填的值先落在暂存表（`attachTtlMs` 到期即丢、每会话 `maxAttachmentsPerSession` 条上限），随消息绑定后进会话授权表；两者都在内存。进程退出即消失。
- **可能写凭据库（仅当人类显式选「持久」）**：经 `ctx.credentials.set(<变量名>, value)` 写入凭据引用空间，并追加一条不含密钥材料的标记记录；`session` 范围不落盘。
- **模型侧的改写由注记承担，且注记会落盘（按 source 去重）**：`agent/pre-step` **不改**用户消息正文（harness 会让改写落盘，见「人类主动附加密钥（反方向）→ 模型侧到底看到什么」），而是追加一条只含变量名的注记，其中**逐变量逐字**写出「正文里的 `@DSH_SECRET_*` 即该变量，模型侧写作 `[secret DSH_SECRET_*]`；它不是文件路径」。注记是 durable 的 `user/message`（因此在对话流里是一行注入说明），且**按自身 source 去重**：模型可见 surface 上已有同一条就不再追加，重复引入同一标记不会堆叠。
- **会在会话日志里留下变量名标记**：人类发送的消息本身（含 `@DSH_SECRET_OPENAI` 这种**变量名**）作为普通 `user/message` 事件持久化。变量名不是密钥材料，但它会长期留在日志里。
- **会挂 5 条 `/api` 路由**：`/api/secret.pending`(GET)、`/api/secret.attached`(GET)、`/api/secret.attach`(POST)、`/api/secret.release`(POST)、`/api/secret.answer`(POST)，全部位于 `ctx.connection` 的信任栅栏内（本机 / 可信 Host、同源标记、签名浏览器 Cookie）。值只出现在后两者的请求体里。
- **会注册客户端座位与一个引用源**：`conversation.chat.node`（key `secret-request`）、`tool.call.toolview`（key `secret_request` 的 `null` 占位）、`conversation.input.left`（id `secret-attach-toggle`）、`conversation.input.overlay`（id `secret-attach-capsule`），外加一个名为 `secret` 的 `InputTriggerSource` 与 locale 命名空间 `secretAttach`。`tool.call.toolview` 只替换本插件自己那次调用的泛型工具行，不触碰别的工具；其余都是增量座位。
- **不做的事**：插件自身不 spawn 子进程、不读写仓库文件、不发起网络请求（除被 Harness 自己的 API 通道承载的那 5 条同源路由外），也没有任何遥测。

## 安装

```sh
# 在已加载的 Harness 中（危险全权限）
plugin_manager action=install_bundle target=<包名 | 本包绝对路径>
```

安装做两件事：

1. 用 pnpm 把本包写进当前 profile 的依赖（本地目录会成为 `link:<绝对路径>`），并把包名追加到 profile `package.json` 的 `dsh.profile.bundles`；
2. 从**已安装包内**的 `dsh.bundle.patch`（即本包的 `cordis.patch.yml`）加载 patch 层，Host 端热加载。

profile 的组合树是「root 空清单 → `dsh.profile.bundles` 里每个 bundle 的 patch → profile 的 `cordis.patch.yml` → `--patch` 覆盖」逐层拼出来的，所以 profile 的 `cordis.patch.yml` 里**看不到** `secret` 行是正常的——那一行来自本包。本包的 `cordis.patch.yml` 是：

```yaml
- insert:
    - id: secret
      name: '@xinvxueyuan/cordis-plugin-secret'
      config:
        requestTimeoutMs: 300000
        maxPendingRequests: 4
```

（`attachTtlMs` 与 `maxAttachmentsPerSession` 未在这里显式写出，取下面配置表的默认值。）

安装结果的 `application` 为 `applied` 表示本次变更已生效；`warnings` 会说明 Client 半是否需要刷新页面。

注意：对**同一个 `link:` 依赖**重复按绝对路径安装是 no-op，此时安装器报 `changed: false` + `application: "failed"` + `error.code: "ambiguous-install"`——它按 profile 依赖的 diff 归属安装目标，而路径 spec 与已存在的同名依赖对不上。这不代表插件没生效（该次调用没有改动任何文件）；用 `cordis_inspect_query` 核对更可靠：host `Tool/listTools` 应出现 `secret_request`，host `Config/listConfigs` 应出现 `include:secret`，client `Slots/listSubTree {root:"conversation.chat.node"}` 的 occupants 应出现 `secret-request`（若同时看 `{root:"shell.overlay"}`，判据是那里**不应再有** `secret.request.dialog`）。

来源构建：`npm install && npm run build`（`lib/` 是 loader 与浏览器实际加载的产物；`src/` 为 TypeScript 源码）。

## 配置（Config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `requestTimeoutMs` | `300000` | 单个 `secret_request` 等待人工确认的上限（也是工具 `timeoutMs` 的基础，工具自身总在上层超时前返回）。 |
| `maxPendingRequests` | `4` | 同时等待人工确认的授权请求数上限，超出返回 `TOO_MANY_PENDING`。 |
| `attachTtlMs` | `1800000` | 人类已填入、但**从未随消息发送**的附加项在内存里保留多久（30 分钟）后被丢弃。暂存从不等于授权：等待期间不注入任何变量，这个上界正是"值不会在长命进程里无限期滞留"的保证。 |
| `maxAttachmentsPerSession` | `8` | 单个会话同时可持有的已登记附加项上限。 |

四个键都必须是正整数：schema 的 `.default()` 之外，`assertConfig` 再手工兜一层（非正整数直接抛错）。

## 工具

### `secret_request`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 凭据键：小写 kebab/snake（`^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$`），如 `openai`、`openai-key`。决定默认变量名 `DSH_SECRET_<UPPER_SNAKE>`。 |
| `label` | ✅ | 对话框中的人类可读标题。 |
| `reason` | ✅ | 你需要它的原因，**原样展示**给要授权的人，也是对方同意的那份理由。 |
| `scope` | ✅ | `session` 或 `persistent`。Agent 显式选择；对话框会突出显示，人类可改。 |
| `description` | ❌ | 补充说明，展示在对话框。 |
| `envVar` | ❌ | 覆盖变量名，必须形如 `DSH_SECRET_OPENAI`，不得占用 `DSH_HOME/DSH_SHELL/DSH_SESSION_ID/DSH_PROFILE/DSH_PROFILE_DIR`。 |

返回（JSON；`decision` 四选一）：

| decision | 形状 |
| --- | --- |
| `approved` | `{ decision:'approved', variable:'DSH_SECRET_X', scope, ref:{space,name}, expiresAt?, source:'store'\|'entered', notice? }` |
| `rejected` | `{ decision:'rejected', reason? }` —— 人类拒绝：**立即停止，不得重试**。 |
| `ignored` | `{ decision:'ignored' }` —— 本次未授权：可稍后再问。 |
| `other` | `{ decision:'other', text }` —— 人类给了自由文本指示：按文本执行。 |

`ref.space` 说明该名字在哪儿可用：`credential-ref` = 可用 `ctx.credentials.resolve(<变量名>)` 解析（`persistent`）；`session-shell-env` = 仅通过 `DSH_*` 注入（`session`）。
`source` = `store`（凭据库里已有的值）或 `entered`（本次人工输入）。`notice` 是附加诊断（例如"上一次授权所锚定的事件已不在当前会话表面上"），永不含密钥。

失败（抛错，作为工具错误结果返回，同样不含密钥）：`BAD_REQUEST`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`、`NO_SESSION`、`NO_ANCHOR`、`TOO_MANY_PENDING`、`TIMEOUT`、`AUTHORIZATION_FAILED`、`AUTHORIZATION_CANCELLED`、`STORE_READ_FAILED`、`STORE_EMPTY`。

其中两条会把上游细节**收敛掉**、只报固定的本插件文案（凭据后端不是本插件能控制的组件，它的错误文本可能引用路径、引用名或其他敏感材料，因此一律不透传）：`STORE_READ_FAILED`（凭据库读取 `describe`/`resolve` 失败 →「凭据库读取失败；细节已省略」）与 `AUTHORIZATION_FAILED`（授权流程失败 →「凭据授权流程失败（上游细节已省略）」）。`AUTHORIZATION_FAILED` 仍会带上本插件自己的二次脱敏层（把该次对话已收集到的值替换掉），措辞本身从不被当作防泄漏的唯一手段。

## 授权卡片（Client 半）

一次 `secret_request` 调用在会话流里只呈现**一个**交互面：它自己的会话流内卡片，渲染在 Agent 的输出流中（`conversation.chat.node`，`key = secret-request`，由本插件的 `ConversationNodeDefinition` 在 `tool/call` 事件上生成节点）。**不再有全视口遮罩**：卡片是普通文档流里的带边框卡片，不 `position: fixed`、不 `inset: 0`、不铺满视口、不劫持整屏 pointer events，也不占用输入区。

卡片在每个"工作步骤展示"档位（简洁 / 标准 / 详细 / 完全展开）都可见：节点**不带 Turn/Step 坐标**（`location = { kind: 'session' }`），因此 Harness 会把它作为流的根条目输出，既不会落进「已调用工具」步骤进程分组，也不会被该分组在任何档位下折叠或隐藏。同一 key 上注册的 `tool.call.toolview` 占位组件返回 `null`，用来替换该工具的泛型工具行，避免同一次调用出现两个面。
（附带说明：步骤进程分组的**标题**仍会把这次调用计入工具计数，并可能显示参数里的 `description`/`name` 文本——这是 Harness 对所有工具共有的既有行为，不是第二个交互面，也不含明文值。）

卡片内容，自上而下（与请求态一致；结算后折叠为摘要，可展开只读回看）：

1. 标题（`label`）+ 右侧状态：「准备中… / 等待你的决定 / 连接宿主失败，重试中… / 已提交… / 已授权 · 变量名 · 范围 / 已拒绝 / 已忽略 / 其他指示 / 出错 · 错误码」，以及「展开 / 收起」；
2. **用途**（`reason`，原样展示，左侧竖线引用块）+ `description`（如有）；
3. **保存方式**：`持久保存到凭据库` / `仅本次会话有效` 两个单选（各带一句含义说明），并用加粗文字写明"Agent 请求的范围："与"当前选择："；若人类改动范围，追加一行"你已把范围改为：…"；
4. 密钥值输入（`type="password"`、可切「显示 / 隐藏」）；**若该凭据已存在于凭据库则不显示输入框**，只显示"已配置，本次仅需决定是否授权本次使用"；
5. 四个决定：**同意 / 拒绝 / 忽略 / 其他**（`其他` 切换出自由文本域 + 提交指示 + 返回）；按钮带 title 说明拒绝与忽略的后果；
6. 页脚说明：密钥明文不会交给模型，代理只会拿到变量名（并列出变量名）。

**假过期缺陷已修复（客户端）**：卡片只把**成功且可解析**的 pending 响应当作事实来源。网络失败、非 2xx、响应体无法解析一律记为"暂时无法连接宿主，正在重试"——表单保持可见，按 1.2s→8s 退避重试，**绝不判定为已失效、绝不关窗**。只有"HTTP 成功且本次调用的 `callId` 确实不在等待列表中"才收束，且**已提交后永不判过期**（转入"已提交，等待 Agent 继续…"，等待工具结果）。未提交时也只降级为卡片内的只读提示，卡片本身保留到这次调用结束。提交得到 HTTP 409 表示宿主已不再等待这份请求，同样只在卡片内说明，不再重复提交。

**兜底**（卡片构建失败 / 状态缺失时请求仍可见且可回答）：

- 调用参数无法解析：仍然生成节点，卡片用 Host 的权威视图渲染完整表单；
- Host 暂不可达：表单可见，按钮禁用并就地提示，连接恢复即可提交；
- 结算载荷缺失（例如旧日志、嵌套调用）：显示"已结束（未记录结算细节）"，保留用途与范围，不回退为空白；
- `tool.call.toolview` 占位未生效：泛型工具行会重新出现（多一个面），卡片仍在且可答。

结算状态来自 `tool/result.meta` 里的值无关载荷（由工具的 `output.presentationMeta` 持久化，模型不可见），因此刷新页面/重放会话后同一张卡片可以从日志重建，不解析任何散文。

样式只用主题 token（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-font-*`），不 import 任何 Harness Client 包，浅色/深色主题都跟随 Host。

诊断面：Client 半在 `globalThis.__cordisSecretClient` 暴露一个**只读**、`Object.freeze` 的测试缝（纯函数、定义与占位组件；不含交互态、不含任何值），供测试与诊断使用。

## 人类主动附加密钥（反方向）

### 0.2.0 的缺陷与本版修复（0.2.1）

**0.2.0 已发布，但这条链路当时不可用。**缺陷有两条，0.2.1 一并修复：

1. **附加秘密后，后续 shell 取不到变量**：标记从未被提升为 grant，`shellEnv` 里因此没有这个变量（`GET /api/secret.attached` 会一直停在 `staged`，不会变成 `bound`）。
2. **对话流里那条消息没有变量名胶囊**：用户气泡显示原始文本，而不是"只显示变量名"的 chip。

**根因一句话**：0.2.0 让 `agent/pre-step` 去改写用户消息**正文**（`@DSH_SECRET_*` → `[secret DSH_SECRET_*]`），并假定"改写只作用于本次模型请求、不落盘"；但这条链路里 `agent/pre-step` 的返回值**就是被原样 append 落盘的那一条**（`dsh-agent-loop/lib/index.js:1061` 直接 append 成 `user/message`，同一步的模型请求由**同一份 surface** 派生，`:1262`），正文被换掉之后 `session/event` 的绑定再也看不到 `@DSH_SECRET_*` 标记（绑定永不发生），气泡也因为正文里没有 `@` 标记而不再渲染胶囊。

**0.2.1 的修复**：不再改写正文——日志、对话流与模型请求里的正文都是人类客户端发出的原始形态 `@DSH_SECRET_*`（`session/event` 因此重新看得见标记：绑定、`anchorSeq`、`shellEnv` contributor 全部成立；`projectUserText` 也重新把它投影成"只显示变量名"的胶囊）。模型侧的对应关系改由一条**值无关**的注记**逐变量逐字**承担（见下「模型侧到底看到什么」）。同时把提升次序固定为「先声明 contributor → 再落 grant → 最后消费暂存项」（见「绑定与失效」第 5 条）。

### 形态

| 部件 | 座位 | 说明 |
|---|---|---|
| 入口按钮 | `conversation.input.left` | 切换式（`aria-pressed` 与 `aria-label` 随状态变化），形状对齐 `dsh-vision-router` 的 `VisionModeToggle`（list 槽 `{name, id, order, inject(sessionId)}` + 模块级 store 承载活状态）。**位置如实记录**：它落在 `[访问模式][计划]` 这一组控件的**右侧**（`.modes` 组之后）。「夹在访问模式与计划之间」用公开座位做不到——那两个座位同在一个由 shell 渲染的 `.modes` div 内，除非整体接管 `conversation.input.permission` 这个 single 座位并自己重绘权限控件，属于脆弱做法，已否决。 |
| 填值胶囊 / 详情胶囊 | `conversation.input.overlay` | 同一座位、同一条目、两态渲染；空闲态 `return null`（槽位常驻）。浮在**输入卡片上方**（`bottom:calc(100% + 4px)`），与 `@` 菜单同一几何，所以不遮挡正在输入的那一行。 |
| 内联胶囊 | 草稿 | **真正的 chip**：`ReferenceChipNode`，DOM 为 `<span data-composer-chip="secret">`，只显示变量名。 |
| 对话框那条消息上的胶囊 | 会话流 | 由 Harness 自己的 `projectUserText` 把文本里的 `@DSH_SECRET_OPENAI` 渲染成只显示变量名的胶囊。 |

参照对照（与 `dsh-vision-router` 的 `VisionModeToggle`）：**相同**——list 槽 + `id` + `order` + `inject(sessionId)` 的注册形状；活状态放模块级 store 而非注册选项；按钮是新插件的**增量**贡献（不替换任何既有座位）。**不同**——座位是 `conversation.input.left`（用户要求紧邻「访问模式」，而参照在尾随侧的 `input.right`）；本插件注册 `locale` 命名空间但有字面量兜底表（参照硬依赖 `ctx.locale`）；本插件同时注册一个 `InputTriggerSource`（参照不需要）。

### 真 chip 是怎么来的（非 hack、非 monkey-patch）

Harness 的公开面 `InputActions` **故意不含**引用插入（`Command-style handles … stay InputBar-private`），但同一份冻结契约里有一个 scoped bail 事件正是为此而设：

- 事件：`slash/input-insert-reference`（`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts`，`@mode bail`），载荷 `{ reference, span }`；
- 会话作用域的监听者由 shell 自己注册（`lib/client.js:14264`：`actx.on('slash/input-insert-reference', (req) => shell.insertReference(req.reference, req.span) ? true : void 0)`）；
- 该契约动词的原文就是 *Replace the trigger span with one reference chip (span-CAS'd)*；
- shipped 的 `@` 菜单自己就走这条路（`dsh-client-ui-input-trigger/lib/client.js:724`）。

插件因此：注册一个 `InputTriggerSource`（`name: 'secret'`，`codec` 决定模型形态，`lexicon` 让刷新后的纯文本标记仍被装饰成引用，`openReference` 接住点击，**不实现** `matchSpace`/`matchEnter`、**不产出**任何候选），再用 `ctx.inject(['sessions'], (scoped) => scoped.sessions.scope(sessionId))` 拿到该会话的 ctx 并发这个事件，`span` 取自公开动作 `inputActions.captureInsertion()`。

客户端半的三个可选协作方（`locale` / `inputTriggers` / `sessions`）一律经 cordis 的可选座位 `ctx.inject([...], cb)` 取得，**不写进 `inject`、也不直接读 `ctx.<name>`**：cordis 的 ctx Proxy 对未声明服务抛 `cannot get property "<name>" without inject`，直接在 `apply()` 里读会让整条 client entry failed、整页 web boot 报 `Failed to load plugins`。缺任何一个时按上述阶梯降级（没有 `sessions` 就从 L3 起步），不抛。`inject` 声明仍是 `['slots', 'uiConversation']`。

**兜底阶梯**（每一级都可被测试观测）：L1 上面的 chip 事件 → L3 `inputActions.insertText('@DSH_SECRET_X', span)`（纯文本，由 `lexicon` 装饰为可点击引用，DOM `data-composer-text-ref`）→ L4 在胶囊里显示变量名请人类手动输入。原定案里的 L2（`toggleSource` + `pick`）**在实施中判定为冗余并移除**：那条 pick 管线的终点就是 L1 这同一个事件、且传的是同一个 span，因此它不可能在 L1 失败的地方成功。只有 L1 成功才在 UI 与文档里说"真 chip"。

### 模型侧到底看到什么（逐字）

| 位置 | 内容 |
|---|---|
| 会话日志（durable） | `user/message` · `请用 @DSH_SECRET_OPENAI 跑测试` |
| 用户气泡 | `请用` + **胶囊（只显示 `DSH_SECRET_OPENAI`）** + `跑测试`，其后一行注入说明（header 标注 producer `secret-attach`） |
| 模型请求（`agent/pre-step`） | `请用 @DSH_SECRET_OPENAI 跑测试`（**与日志逐字相同**），其后追加一条值无关说明：`- DSH_SECRET_OPENAI · 仅本次会话有效`、`正文里的 @DSH_SECRET_OPENAI 即该变量，模型侧写作 [secret DSH_SECRET_OPENAI]；它不是文件路径。`、`取用方式：PowerShell 用 $env:DSH_SECRET_OPENAI，POSIX shell 用 "$DSH_SECRET_OPENAI"`、「不要把该标记当作文件路径读取。」 |

**为什么模型侧不是改写正文，而是由注记逐变量写明对应关系**（这是与早期设计稿不同的一点，原因在 harness 契约，不在取舍）：

- `agent/pre-step` 返回的消息就是**落盘的那条**：loop 把它**原样** append 成 `user/message`（`dsh-agent-loop/lib/index.js:1061`，`surfaceOp: 'append'`），而同一步的模型请求由**同一份 surface** 派生（`:1262`）。所以"改写只作用于本次模型请求、不落盘"在这个接线下不可能成立：改写必然落盘，落盘就必然改变用户气泡。
- 模型输入按契约是**会话日志的纯函数**：loop 构造的请求被 deep-freeze，`llm/stream` 的监听者「read it, never rewrite it」（`dsh-llm/lib/types/index.d.ts:37-45`）。
- 唯一能保留"仅模型可见副本"的机制是 surface replacement / message projection，但它必须 append 在**目标事件之后**，而 loop 的 append（`:1061`）与请求构造（`:1262`）之间没有任何可插入点；由插件自己先 append 目标再替换，会把用户消息挪到本步 `system/message` 提交之前（模型会先读用户消息再读系统提示），代价大于收益。自定义事件类型还需要 `ignorable` 才不被持久化读取拒绝（`dsh-session-persistence/lib/index.js:184`），树外插件拿不到。

因此**日志与用户气泡保留人类客户端发出的原始形态** `@DSH_SECRET_*`（这样 `projectUserText` 才能把它投影成"只显示变量名"的胶囊），模型侧的改写改由注记承担：注记**逐变量逐字**写出「正文里的 `@VAR` 即该变量，模型侧写作 `[secret VAR]`；它不是文件路径。」——`[secret VAR]` 形态因此**逐字**出现在模型可见文本里，且与正文的对应关系是确定的、不依赖启发式。注记是**文本的纯函数**（只认 `@DSH_SECRET_*` 的形状），刷新、重放与 fork 拿到的模型文本一致。

**注记的落盘与去重**：注记本身是一条 durable 的 `user/message`（`source.kind = 'secret-attach'`），所以它在对话流里显示为一行注入说明；同一条注记**按自身 source 去重**（`src/inject.ts` 的 `noteVisible`：模型可见 surface 上已有完全相同的 source 就不再追加），同一步/后续步重复引入同一标记不会堆叠第二份。

### 自己复测（活体，约 3 分钟）

> **先重启。** dsh 在进程启动时加载插件的 `lib/` 构建，所以**发布 0.2.1 之后必须重启 `dsh web`** 才会加载修复后的产物；重启前的活体复测仍会复现 0.2.0 的现象（`staged` 不变 `bound`、shell 里没有变量），那是预期，不是修复失败。

1. 在输入区点「附加密钥」按钮 → 胶囊里填名称（如 `openai`）与值，作用域保持默认「仅本次会话」→ 插入 → 输入框出现 `@DSH_SECRET_OPENAI` 胶囊。
2. **发送前**：在同一浏览器（同源、带签名 cookie）打开 `GET /api/secret.attached?sessionId=$DSH_SESSION_ID` → 该条的 `state` 必须是 `"staged"`，且此刻 shell 里没有这个变量（未发送永不注入）。
3. **发送后立刻**再查同一路由 → 该条的 `state` 变成 `"bound"`（不再停留在 `staged`）。**这是判别"绑定是否真的发生"的最快手段**，也就是这一轮修复的核心判据。
4. 让 Agent 在**后续**执行里只报存在性与长度（绝不回显值），例如 PowerShell：`if ($env:DSH_SECRET_OPENAI) { "present length=$($env:DSH_SECRET_OPENAI.Length)" } else { "absent" }`。看到 `present` 即「附加 → 绑定 → 注入」端到端可用。
5. 回退/编辑重写那条消息后再查：锚点离开 live surface ⇒ 授权撤销、变量重新不可用（`revoked-anchor`）。

### 绑定与失效

1. `POST /api/secret.attach` 只**暂存**（默认 `scope: "session"`，可切 `"persistent"`）。暂存不是授权：`GrantStore` 看不见它，`shellEnv` 里没有这个变量，**未发送就永不注入**。暂存有 TTL（默认 30 分钟）与会话结束两道兜底。
2. 携带标记的用户消息一旦成为 durable 事件，`session/event` 钩子把它提升为授权，`anchorSeq` = **该条 `user/message` 事件的 seq**。该服务的契约原文是 *"Seed events never publish on `session/event`"*（`dsh-session/lib/index.js:1271-1275`），所以重放或恢复一份历史日志**不可能**重新绑定——这比"回头扫日志找锚点"更稳，因为锚点 seq 本来也只有消息落盘之后才可知。
3. 之后 `shellEnv` 才在每次执行时按会话注入。回退/编辑重写掉那条消息 ⇒ 锚点离开 live surface ⇒ 自动 `revoked-anchor`，无需额外记账。
4. `POST /api/secret.release` 只能丢弃**尚未绑定**的暂存项；已绑定项会如实回答 `state:"bound"`（唯一诚实的解除方式是回退那条消息）。
5. 提升的次序是**先向 `shellEnv` 声明 contributor → 再落 grant → 最后消费暂存项**（`src/attach.ts` 的 `bindStaged`）。声明失败时会话原样不变（无 grant、暂存项仍 armed，可在下一次标记到达时重试）；反向顺序会留下「有 grant、无 contributor、暂存未消费」的静默不注入状态。另一方向无害：grant 已落但 contributor 因无关原因缺失时，`resolve` 查不到值 ⇒ 不注入（fail-closed）。
6. Host 重启后暂存与授权都消失（都在内存里），日志里的标记仍在但不会自动重新武装——**故意 fail-closed**：没有人类在场的新进程里静默恢复一次授权，不是本插件愿意做的事。

### 已知限制（如实记录）

- **对话框那条消息上的胶囊是 `data-ref-chip="file"`，点击会尝试 `openFile('DSH_SECRET_OPENAI')`**（打开一个不存在的文件，无害但不正确；不泄露任何东西——变量名本来就在那里可见）。**这是已知限制，不是未做完的功能。**原因：用户气泡的正文由 `dsh-client-ui-primitives` 的 `projectUserText` 独家渲染，它对 `@token` 形状**硬编码**为文件引用并挂 `openFile`；ui-chat 的消息管线没有可注册的引用种类（能接住点击的 `openReference` 只作用于**草稿编辑器**，不作用于转录气泡）。
  - **为什么不存在"既是 chip 又不可点"的 `@` 形态**（已逐行证明）：该函数只认三种 token（`primitives lib/index.js:6724` 的正则：`/名称`、`@"…"`、`@非空白`）；`:6753` 的判定是 `@` 开头**必然**映射为 `'file'`（或 `'folder'`），只有 `/` token 才可能是 `void 0`；而 `/` token 又必须在 caller 传入的 `slashNames` 名单里（`:6731`）。所以 `@DSH_SECRET_*` 一定拿到 `referenceKind:'file'` 并因此挂上 `openFile`，没有任何插件钩子能改变它。
  - 另外两条路都已评估并否决：wire session 形态 `@[label](dsh-session:…)` 虽是**不可点**的 session chip，但会被 `dsh-session-reference` 服务在 `agent/pre-step` 里当作跨会话引用解析（可能让整步失败），风险大于收益；整体接管 `conversation.chat.node` 的 `user` key 并自己重绘用户气泡需要重写附件、图片、markdown 与动作行，脆弱度过高。
  - **交付给下一环节的验证项**：这条点击行为需真人在浏览器里确认（预期现象：点转录里的胶囊会尝试打开同名文件）。
  - **`agent/pre-step` 追加的那条注记行本身也会被投影成 file chip**：注记是一条 durable 的 `user/message`，正文里逐字含 `@DSH_SECRET_*`，所以在转录里它同样由 `projectUserText` 渲染为 `data-ref-chip="file"` 并挂上同一个 `openFile` 行为。**与上面第一条同源**：观感问题、不泄露任何东西（注记里只有变量名与作用域，没有值），也不是未做完的功能——任何出现在消息正文里的 `@` 标记都逃不过这条 shipped 规则。
- 刷新后草稿里的 chip 会变回纯文本 `@DSH_SECRET_OPENAI`（草稿镜像只存文本），由 lexicon 装饰回"引用"观感，点击仍能打开详情胶囊；这与 chip 的原子性不同，是草稿投影的既有语义，不是本插件的取舍。
- **工具结果里的 `@DSH_SECRET_*` 没有注记解释**（**值无关，不是泄漏**）：注记只为**本步引入的、载有标记的用户消息**追加，所以当同一形状的标记出现在**工具结果**（例如某条命令的回显）里时，它会**原样**进入模型上下文，且那一步的注记不会覆盖它——模型可能按系统提示里"`@` 前缀是文件路径"的约定去解读它，例如尝试读取一个同名文件（会失败）。**它不会因此获得任何值**：这条缺口只涉及"标记的解释范围"，与明文无关；变量名本来就在会话日志、用户气泡与注入说明里可见。**准确定性**：这是解释范围的一个已知缺口（不是未做完的功能），既没有把值带进上下文，也没有影响绑定、授权或 shell 注入。
- 视觉与真机点击路径需要人工确认（见「边界与已知限制」）。

## 存储与传播

- `persistent`：值写入凭据**引用空间**（`ctx.credentials.set(<变量名>, value)`）→ 可被其他工具按凭据引用解析；再提交一条 `cordis-plugin-secret/<name>` 的 `grant` 记录作为授权标记（不含值）。
- `session`：值只进 Host 内存中的会话授权表。
- 传播：`ctx.shellEnv.register` 为每个变量名声明一个 contributor，`resolve(execution)` 每次 shell 执行都**重新校验该执行的会话是否仍持有有效授权**，有效才返回该变量的值（`shellEnv` 每次执行重建命名空间，因此天然按会话隔离）。
- 授权表是"派生缓存"：真相在会话日志（锚点事件）与凭据服务；每次读取都从**活的**会话表面重新推导有效性。

## 边界与已知限制

### 边界处理

| 情形 | 行为 |
| --- | --- |
| **会话回退 / 编辑重试（rewind / rewrite）** | 授权锚定在"发起该工具调用的那条 `assistant/message` 事件"的 seq 上（它本身就是会话表面节点）。用户编辑更早的消息并重试会让该事件被 `replace` 遮蔽、离开 `session.surface.nodes`；下一次解析授权（shellEnv 注入或凭据解析路径）发现锚点不在表面上，就**撤销**：不注入值、从会话授权表删除、把失败写进下一次 `secret_request` 的 `notice`。Agent 必须重新调用 `secret_request` 拿新授权。**绝不继续服务一个已被丢弃分支里的授权。** |
| **Fork** | 授权以 `SessionId` 为键。fork 出的子会话是新 id，看不到父会话的授权（`not-found`）；即便有人把父会话的授权表项种进子会话，`session.isOwnSeq(anchorSeq)` 对 fork 继承前缀返回 false，判定 `revoked-not-own` 并删除。子会话要自己重新授权。`persistent` 的值虽在凭据库里，但**"暴露给某会话"仍是逐会话授权**，子会话同样需要重新授权——只是此时值已在库中，无需人类重新输入（同样的"已配置"路径）。 |
| **压缩（compaction）** | 判定只看"锚点事件是否仍在 `session.surface.nodes` 上"，**不看** `replaceGeneration` 数值。压缩导致 `replaceGeneration` 变化、甚至把其他事件折进摘要而锚点仍在表面上，都**不撤销**；只有锚点事件本身被折掉（或被 `replace` 遮蔽）才按失败关闭处理（撤销并要求重新授权）。 |
| **子代理 / 非活跃调用者** | 只有"注册表中活跃的会话根代理"拥有人类回答者。`ctx.agents.get(id)` 找不到该 agent → `CALLER_NOT_LIVE`；找到了但不在 `ctx.agents.roots()` 中（被委派）→ `DELEGATED_CALLER`。两种都在**创建任何对话框之前**抛出结构化失败，绝不挂起等待一个永远不会来的答复。 |
| **会话结束 / 进程退出** | `session/disposed` 时清空该会话的全部授权；插件卸载时中止所有等待中的对话框并撤下全部 `shellEnv` contributor；会话级值只存在于内存，进程退出即消失。 |
| **超时 / 调用被取消** | 超过 `requestTimeoutMs` 未获答复 → `TIMEOUT` 失败，不注入任何变量；调用方的 `AbortSignal` 中止 → 该次等待以中止失败结束。 |
| **同键并发** | 同一凭据键同时只允许一个授权尝试（凭据流程键 = `cordis-plugin-secret/<name>`）；第二个请求得到结构化失败而不是两个对话框。 |
| **凭据库只读 / 写失败** | 卡片内就地显示原因、保持打开，人类可改用 `session` 范围或取消。读取（`describe`/`resolve`）失败一律收敛为本插件自有的 `STORE_READ_FAILED`（固定消息，不透传上游文本）。唯一例外：`409` 表示该请求已不再等待——**卡片保留**，只在卡片内提示"已由别处处理"，不再重复提交（见「授权卡片（Client 半）」）。 |

### 授权何时失效（必须重新调用 `secret_request`）

1. **会话回退 / 编辑重试**：锚点消息被 `replace` 遮蔽，离开 `surface.nodes` → `revoked-anchor`。
2. **压缩把锚点事件本身折掉**：锚点不在表面上 → 一律失败关闭（即便原因只是压缩）。
3. **fork / 新的子会话**：授权以 `SessionId` 为键，子会话从不继承父会话的授权（`not-found` / `revoked-not-own`）。
4. **会话结束**：`session/disposed` 清空该会话的全部授权；进程退出即消失（会话级值只在内存）。
5. **凭据轮换**：会话授权表里存的是授权那一刻的值副本，轮换后需重新调用 `secret_request` 刷新。

反之，以下情况**不会**强制重新授权：`replaceGeneration` 数值变化本身；其他事件被替换/压缩但锚点仍在表面上；同一会话内的后续 shell 执行（每次执行都重新校验，但仍持有同一授权）；`persistent` 且值已在凭据库时，人类只需再次点同意（无需重新输入值）。

### 已知限制（如实记录）

- **转录气泡里的胶囊由 shipped 代码渲染，插件接不了钩子**：`@DSH_SECRET_*` 在用户消息气泡里被 `dsh-client-ui-primitives` 的 `projectUserText` 渲染成 `data-ref-chip="file"`，点击走它硬编码的 `openFile('DSH_SECRET_OPENAI')`（尝试打开一个同名文件，无害、不泄露任何东西，但行为不正确）。**编辑器内（草稿）的胶囊不受影响**：那里是插件自己注册的 `secret` 引用源，点击打开只读详情胶囊。同一条 shipped 规则也适用于 `agent/pre-step` 追加的那行注记（它正文里同样含 `@DSH_SECRET_*`，因此也会显示为 file chip）。逐行证据与"为什么不存在既是 chip 又不可点的 `@` 形态"见「人类主动附加密钥（反方向）→ 已知限制」。
- **工具结果里的 `@DSH_SECRET_*` 没有注记解释**（值无关，不是泄漏）：注记只为**本步引入的、载有标记的用户消息**追加，因此同一形状的标记出现在工具结果里时原样进入模型上下文且无注记覆盖，模型可能按"`@` = 文件路径"去解读它（会失败）。它不会因此获得任何值，也不影响绑定、授权或 shell 注入。详见「人类主动附加密钥（反方向）→ 已知限制」。
- **`ctx.authorization` 只承载 `persistent`**：该 seam 的契约要求"本次尝试期间提交并观察到一条凭据记录"（否则 `NOT_COMMITTED`），而 `session` 授权按定义不得落盘。因此 `session` 请求走同一套对话框、但不进该 seam；`persistent` 请求完整走 `registerFlow` + `begin`。这是 seam 契约决定的取舍，不是省事。
- **O1 / O2（第二轮修复，两条都如实回报）**：
  - **O1**：`persistent` 请求里人类已点"同意"，但 seam 的授权尝试最终 `failed` 时，**不再**声称"已持久化"：人类的选择被保留，但按「仅本次会话有效」降级生效，`notice` 写明的是**"未能完成持久化登记的确认"**——本插件自己的代码路径不会写凭据库，但 seam 可能在提交授权记录**之前**就已把值写入凭据库（`persist` 先于 `commit`），因此这里不做"值一定没进库"的绝对断言；若值已进库，它只是缺少本次授权记录。
  - **O2**：`persistent` 等待本身超时（`requestTimeoutMs`）时，错误码一律是 `TIMEOUT`，不会被 seam 的 `failed` 包装成 `AUTHORIZATION_FAILED`。
- **`shellEnv` 的 resolver 是同步的**，而 `ctx.credentials.resolve` 是异步的：无法在每次 shell 执行时回源凭据库。因此授权通过时把值读入该会话的授权表（并在每次注入前做锚点/会话校验），凭据库仍是持久层的真相。**轮换凭据后请重新调用 `secret_request` 刷新会话内副本。**
- **验证限制**：本插件的安装与注册由 `cordis_inspect_query` 的 Tool/Slots 证据覆盖；卡片的**视觉**（浅色/深色、布局、四档"工作步骤展示"下的实际渲染位置）与附加方向胶囊的**视觉 / 真机点击路径**只有在浏览器里有页面时才可能确认，无浏览器控制时不做渲染器/截图等替代验证。"卡片在四个档位下都位于步骤进程分组之外"由结构证明（节点无 Turn/Step 坐标 ⇒ 根条目、非 process member）加单测（`buildViewNode` 的 `location.kind === 'session'`）覆盖，**未经真人点击/切档验证**。单测覆盖 Host 侧全部纯逻辑、register 级装配与 Client 半的纯逻辑（节点状态机、四态判定、表单控件、明文不越界、以及浏览器产物在真 cordis 上下文里的 boot）；真机点击路径需要人工确认。

## 开发

```sh
npm run typecheck   # tsc：Host 半（Node）+ Client 半（DOM），erasableSyntaxOnly，兼容 Node 原生类型剥离
npm test            # node --test 六个文件：
                    #   test/unit.test.ts         参数校验、变量名推导、decision 映射、session/persistent 路由、
                    #                             四类返回都不含值、锚点撤销、fork 不继承、压缩不误撤销（含真实表面折叠）、
                    #                             子代理失败关闭、超时、O1（已答复但落库失败 ⇒ 降级 session 并如实回报）、
                    #                             O2（persistent 超时 ⇒ TIMEOUT）、presentationMeta 四种决策都不含值、
                    #                             env contributor 注入与撤销、adapters 端口映射
                    #   test/register.test.ts      用真实 apply + 假 Context 走完整链路：工具/路由/session-disposed 注册、
                    #                             Config 校验、tool→卡片→shellEnv 的值交付、回退与会话结束后的取回消失、
                    #                             persistent 经 authorization seam 落库且标记不含值、409 冲突
                    #   test/client-card.test.ts   以 __ModuleLoader__ + 假 React 加载浏览器产物：节点在 tool/call 即存在且
                    #                             无 Turn 坐标、结算态来自 meta、注册面恰好两处（无 shell.overlay/composer）、
                    #                             假过期四态（不可达/未列出/已提交）、表单控件齐备、明文不越出掩码输入
                    #   test/attach.test.ts        附加方向的 Host 侧：暂存 ≠ 授权（未发送不注入）、TTL 丢弃、
                    #                             容量上限、绑定锚点、release 只丢未绑定项、值不出现在任何视图里
                    #   test/attach-wiring.test.ts 接线级回归（0.2.0 缺陷的门）：用真实 dsh-session Session 扮演 loop 的
                    #                             三步（pre-step waterfall → 原样 append decision.messages → 发布
                    #                             session/event），断言 durable 正文逐字保留 `@DSH_SECRET_*`、
                    #                             anchorSeq = 该事件 seq、contributor 已声明、暂存项已消费、
                    #                             真 shellEnv.collect() 能取到值；注记逐字写明模型侧记法
                    #   test/client-attach.test.ts 用真 cordis Context + sibling provide 装载浏览器产物：apply 在
                    #                             **缺少三个可选服务**时也不抛（boot 回归门）、注册面、插入阶梯
                    #                             （L1 chip / L3 文本 / 无 sessions 时降级）、明文不越出掩码输入
npm run build       # 产出 lib/（Host 半 + 浏览器产物 ./client）
```

## 设计要点

- **附加方向的两段式生命周期**：值先在客户端本地 state，再经一次 POST 进 Host 内存的暂存表；只有携带标记的用户消息成为 durable 事件时才提升为 grant，`anchorSeq` 取该事件的 seq。这样"未发送就永不注入"，且锚点不依赖任何"回头扫日志"的启发式。
- **模型侧：不改写正文，改写与解释都由一条按 source 去重的值无关注记承担**：`agent/pre-step` 不再替换用户消息正文（它在真实接线下必然落盘，见上一条），而是追加一条只含变量名 / 作用域 / 取用写法 / **逐变量逐字的模型侧记法 `[secret DSH_SECRET_*]`** 的注记；同一注记在模型可见 surface 上只出现一次。因此刷新、重放与 fork 拿到的模型文本一致，且用户气泡始终渲染为变量名胶囊。
- **可选服务一律走 cordis 的可选座位**：`inject` 只声明真正的硬依赖 `['slots', 'uiConversation']`；`locale` / `inputTriggers` / `sessions` 经 `ctx.inject([...], cb)` 取得。cordis 的 ctx Proxy 对未声明服务取属性即抛，直接在 `apply()` 里读会让整条 client entry failed、整页 web boot 报 `Failed to load plugins`——这正是第三轮修复的发布阻塞缺陷（`lib/client/entry.js` 现在不再出现对这三个服务的直接 `ctx.<name>` 读取）。
- **`ctx.authorization` 只承载持久授权**：见「边界与已知限制」的同名条目——`session` 范围按定义不落盘，不可能满足该 seam 的提交契约，因此走同一套对话框而不进 seam。
- **Harness 不自带 `AuthorizationPrompt` 的 Web 渲染器**（已核验：安装包中没有任何 client 包渲染 `AuthorizationPrompt`），所以本插件自己的对话框就是该 prompt 的界面；流程内 `session.prompt({kind:'secret'})` 的值直接来自对话框已收集的答案。
- **`Grant.replaceGenerationAtApproval` 只用于诊断**：授权记录里保留批准时的 `surface.replaceGeneration`，但撤销判定**只**看锚点事件是否仍在 `surface.nodes` 上（且 `isOwnSeq` 成立），**从不**比较该数值。压缩会重写表面并推进 `replaceGeneration` 而保留锚点，用"数值不等即撤销"会把压缩误判成回退——两条要求互斥，锚点在场性判定同时满足两者。该字段因此是记录性的，不参与任何判定（`src/grants.ts` 的字段注释与「压缩」一行相互印证）。
- **Client 半是"经典脚本"**：client module system 以 `<script>` 加载包的浏览器产物，产物唯一副作用是 `window.__ModuleLoader__.load` 注册工厂，因此 `src/client/entry.ts` 没有 import/export，单独用 `tsconfig.client.json` 编译（DOM lib），Host 半用 `tsconfig.json`（Node types）。
- **客户端文案现状**：可见文案集中在 `src/client/entry.ts` 的 `TEXT` / `ATTACH_ZH` 字面量表中（本 profile 的 UI 语言为中文）；运行时有 locale 面时，附加方向还会注册 `secretAttach` 命名空间词典（zh/en），没有 locale 面时组件回退到自己的字面量表。索取方向卡片尚未注册 locale 命名空间，接入它需要声明 `LocaleNamespaceMap` 并为所有内置语言提供完整词典，作为后续工作。

## npm 发布（@xinvxueyuan/cordis-plugin-secret）

- **仓库**: https://github.com/xinvxueyuan/cordis-plugin-secret
- **npm**: `npm install @xinvxueyuan/cordis-plugin-secret`
- **许可**: MIT OR Apache-2.0（见 LICENSE-MIT / LICENSE-APACHE）

通过 npm 包接入 Harness 时，先安装到 profile：

```sh
dsh plugin add @xinvxueyuan/cordis-plugin-secret
```

再在 `cordis.patch.yml` 中引用包名（替代 file URL）：

```yaml
- insert:
    - id: secret
      name: '@xinvxueyuan/cordis-plugin-secret'
```

### 发布流程（维护者）— staged publishing

> 采用 npm **staged publishing**：CI 用 `npm stage publish`（OIDC 可信发布，无需 token / 2FA）
> 把版本放入 registry 的 **stage 队列**，维护者用 **2FA** 批准后版本才真正上线（proof-of-presence）。

```sh
# 1) 构建 + 本地核对
npm run build
npm pack --dry-run

# 2) 打标签推送 → GitHub Actions 自动跑测试 + npm stage publish（进入 stage 队列）
git tag v0.2.x && git push origin main --tags

# 3) 人工 2FA 批准上线
npm stage list @xinvxueyuan/cordis-plugin-secret   # 取 <stage-id>
npm stage approve <stage-id>                       # 需要 2FA
```

（旧版 `npm publish` 直发流程已被 CI 的 staged 流程取代。）

`publish.yml` 在两个发布 job 前都有幂等守卫：先用 `npm view "<包名>@<package.json 的 version>" version`
判断该版本是否已存在于目标 registry，已存在就跳过发布（并在 Step Summary 写明"该版本已存在，跳过发布"），
因此对已发布版本重推 tag 不会产生必然失败的公开红叉。其它检查错误（网络、鉴权、registry 故障）仍会让 job 失败。

**registry 现状（截至本文）**：npmjs 上有 `0.0.0-stage`、`0.1.0`、`0.2.0`；`0.2.1` 已由 CI 放入 stage 队列，等维护者用 2FA 批准（`npm stage approve`）后才上线。GitHub Packages 上 `0.1.0`/`0.2.0`/`0.2.1` 都在（那里由 CI 直接发布，不经人工批准）。

同一份包也会发布到 **GitHub Packages**（`npm.pkg.github.com`，`github-packages` job，用内置 `GITHUB_TOKEN`），
使包在仓库页面上可见、可被 `@xinvxueyuan:registry=https://npm.pkg.github.com` 的消费者安装。

### GitHub Release 与签名

> **已发生的事实**：`v0.2.1` 的 Release 是 https://github.com/xinvxueyuan/cordis-plugin-secret/releases/tag/v0.2.1
> （2026-10-06 发布，`draft: false`），附件三件：`xinvxueyuan-cordis-plugin-secret-0.2.1.tgz`（sha256 `55076023121254ba1a12c3718d4d2f6c3d03c64eb2667920fc19036e270b7edd`）、`SHA256SUMS`、`SHA256SUMS.asc`；
> tgz 与 SHA256SUMS 各有一份 `gh attestation verify` 可验的构建来源证明，且**证明绑定在 tag 上**（签名证书 SAN = `.../release.yml@refs/tags/v0.2.1`，`resolvedDependencies` = `git+https://github.com/xinvxueyuan/cordis-plugin-secret@refs/tags/v0.2.1@a01dee656eb0d9ec654a79842b9a7064378d02f1`）——即 tag→commit 是证明的一部分，而不是只绑定到 `refs/heads/main`。tag 对象为 annotated + GPG 签名
> （`git cat-file -t v0.2.1` → `tag`；GitHub API 的 `verification.verified` → `true`，`reason` → `valid`）。
> 上一个版本 `v0.2.0` 的 Release（https://github.com/xinvxueyuan/cordis-plugin-secret/releases/tag/v0.2.0 ）同样是同形三附件；
> 它的功能缺陷与 0.2.1 的修复见「人类主动附加密钥（反方向）→ 0.2.0 的缺陷与本版修复（0.2.1）」。
> 下表是**这些版本确实按之执行**的机制，不是"将来会做"的计划。

| 环节 | 机制 |
| --- | --- |
| tag | **annotated 且 GPG 签名**的 tag（`git tag -s`），GitHub 上显示 **Verified** 徽标。tag 由维护者在本机用私钥创建并推送，**私钥永不进入 CI**。 |
| Release 附件 | `.github/workflows/release.yml` 在 tag 推送（或手动 `workflow_dispatch` 指定 tag）时执行 `npm pack`，把产出的 `*.tgz` 与 `SHA256SUMS` 上传为 Release 附件。Release 标题即 tag，正文由 `gh release create --generate-notes` 依据 commit 列表自动生成。 |
| 校验和 | `SHA256SUMS` 记录该 tgz 的 sha256（工作流内以 `sha256sum -c` 自校验）。 |
| 校验和的分离签名 | 维护者在本机用**私钥**对 `SHA256SUMS` 生成分离签名 `SHA256SUMS.asc`（`gpg --armor --detach-sign SHA256SUMS`），再手工把 `.asc` 附到 Release 上。**这一步目前没有自动化**，私钥也不进 CI；校验方用 `gpg --verify` 验签。 |
| 构建来源证明 | `release.yml` 调用 `actions/attest-build-provenance`（pin 到 commit SHA），为 **tgz 与 SHA256SUMS 两者**生成 Sigstore 签名的 SLSA 构建来源证明，可用 `gh attestation verify` 校验。 |
| npm 侧 | `release.yml` **完全不执行任何 npm publish**；npm 发布只由上面的 `publish.yml` staged publishing 负责。 |

维护者操作顺序（`v0.2.0` 与 `v0.2.1` 都已按此执行）：

```sh
# 1) 本机确认工作区干净、package.json 的 version 已就位（版本号由发布者手工提升）
git status --porcelain

# 2) 创建 annotated + GPG 签名 tag（私钥仅在本机使用；本机需能完成 GPG 签名）
git tag -s v0.2.1 -m "v0.2.1"

# 3) 只推 tag —— release.yml 会构建产物、生成来源证明并创建 Release
git push origin v0.2.1

# 4) 对本机生成的 SHA256SUMS 做分离签名并附到 Release（私钥不进 CI）
gpg --armor --detach-sign SHA256SUMS
gh release upload v0.2.1 SHA256SUMS.asc --clobber
```

校验方式：

```sh
# 校验附件未被篡改
sha256sum -c SHA256SUMS

# 校验分离签名（需要维护者的公钥）
gpg --verify SHA256SUMS.asc SHA256SUMS

# 校验构建来源证明（需要 gh CLI）
gh attestation verify xinvxueyuan-cordis-plugin-secret-0.2.0.tgz --repo xinvxueyuan/cordis-plugin-secret
gh attestation verify SHA256SUMS --repo xinvxueyuan/cordis-plugin-secret
```

补充说明：

- `release.yml` 使用 `gh release create --verify-tag`，**要求 tag 已存在、不会自行创建 tag**；重复运行会转为"覆盖上传附件"。
- 所有 workflow 的 `uses:` 都 pin 到完整 40 位 commit SHA（当前：`actions/checkout` v4.4.0、`actions/setup-node` v4.4.0、`actions/attest-build-provenance` v4.2.2），由 `.github/dependabot.yml` 的 `github-actions` 生态负责推进。

## 许可

本仓库采用 **MIT OR Apache-2.0** 双许可（与 `package.json` 的 `license` 字段一致），
许可证原文见 [LICENSE-MIT](LICENSE-MIT) 与 [LICENSE-APACHE](LICENSE-APACHE)。
