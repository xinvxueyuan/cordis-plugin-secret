# cordis-plugin-secret

[![npm version](https://img.shields.io/npm/v/@xinvxueyuan/cordis-plugin-secret)](https://www.npmjs.com/package/@xinvxueyuan/cordis-plugin-secret)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE-MIT)
[![GitHub](https://img.shields.io/github/stars/xinvxueyuan/cordis-plugin-secret)](https://github.com/xinvxueyuan/cordis-plugin-secret)

> Cordis（DeepSeek Harness）插件：**密钥在人与 Agent 之间双向流动——Agent 可以开口索取，人类也可以把一枚密钥主动附加到自己的消息上——而 Agent 永远只拿到一个不透明的变量名（如 `DSH_SECRET_OPENAI`）。插件自身从不把值放进工具结果、错误消息、日志、DOM 或会话记录；值只经 `ctx.shellEnv` 按会话注入到 shell 环境——由 Agent 自己避免回显。**

- Host 半（索取方向）：注册 `secret_request` 工具；用 `ctx.authorization` 的凭据获取流程承载持久授权；用 `ctx.credentials` 落库；用 `ctx.shellEnv` 按会话注入 `DSH_SECRET_*`。
- Host 半（附加方向）：`POST /api/secret.attach` 把人类填的值**暂存**在进程内存（暂存不等于授权：此时不注入任何变量）；携带标记 `@DSH_SECRET_*` 的用户消息一旦落进会话日志，`session/event` 就把它**提升为按该条消息锚定的授权**；`agent/pre-step` 追加一条**只有变量名**的说明消息，其中逐变量写明这枚标记在模型侧写作 `[secret DSH_SECRET_*]`（正文本身不改写——harness 会让改写落盘，见下文）。
- Client 半（索取方向）：在 Agent 输出流里渲染**会话流内一级卡片**（`conversation.chat.node`，`key=secret-request`），**无 `shell.overlay` 遮罩**；卡片带 `type="password"` 输入与显示/隐藏切换，把「同意 / 拒绝 / 忽略 / 其他」四个决定、申请理由、用途说明与**授权范围**摆在人类眼前，并允许人类**改写 Agent 请求的范围**。
- Client 半（附加方向）：在输入区 `conversation.input.left`（紧随「访问模式 / 计划」控件组右侧）加一个**切换式按钮**；按下后在输入框上方（`conversation.input.overlay`）浮起**填值胶囊**；填完点「插入到光标处」，草稿光标处得到**真正的内联 chip**（`data-composer-chip="secret"`，只显示变量名），可在后续 shell 取用；点击该 chip（或刷新后由 lexicon 装饰出的同名引用）会在同一浮层展开**只读详情胶囊**。0.3.0 起，消息旁的**旁挂胶囊**与（被接管后的）**原胶囊**都能打开详情——前者开输入框上方的信息框、后者开右侧栏详情页；信息框内另有**历史记录**区，`@` 菜单会列出可用密钥（详见「人类主动附加密钥（反方向）→ 0.3.0 的四项增强」）。
- 管理方向（0.4.0）：注册第二个工具 **`secret_manage`**（列举 / 解绑 / 真删 / 改作用域 / 请人类改值）与 `/api/secret.manage`（GET 列举、POST 执行）；**参数集里没有 `value`，Agent 没有任何提交值的通道**——值只能由人类在掩码输入框里键入。人类侧信息框新增「管理 / 改值 / 危险确认」三个面（详见「秘密的完整 CRUD（0.4.0）」）。
- 传输：两个方向的对话框都经本插件自有的、位于 `ctx.connection` 信任栅栏内的 `/api` 路由与 Host 通信。密钥值只出现在 `POST /api/secret.answer`、`POST /api/secret.attach` 与（仅 `action:"value"` 时）`POST /api/secret.manage` 的请求体里，从不进入 URL / 查询串 / 会话日志 / 响应体。

## 安全不变量与副作用披露

### 安全不变量（实现并测试）

1. **插件自身的输出永不携带明文**：工具结果、错误消息、日志、事件、渲染文本、HTTP 响应体与 DOM 属性中都不含密钥值；`render()` 只输出变量名与元数据。单测对四种 decision 的所有字段做全量字符串扫描，断言值不出现；Client 半另有断言证明填值胶囊的值不越出那个掩码输入框。**边界**：值确实会按会话注入到 shell 环境（这是本插件的功能），因此"明文不进上下文"取决于 Agent 不回显 `$env:DSH_SECRET_*`，而不是插件的输出通道。
2. **Agent 只拿到变量名**：`approved` 返回 `{ decision, variable, scope, ref, source }`，`variable` 形如 `DSH_SECRET_OPENAI`。
3. **值只发给本机 Host**：客户端只向 `/api/secret.answer`（索取方向）与 `/api/secret.attach`（附加方向）发起同源 POST（签名 HttpOnly Cookie + Host/Origin 栅栏），不写 URL、不写 localStorage、不打印 console。附加方向的 `GET /api/secret.attached` 只回传变量名/名称/范围/状态，永不回传值；0.3.0 的 `POST /api/secret.adopt` 同样**不携带值**（由宿主自己从凭据库解析），`GET /api/secret.history` 与 `GET /api/secret.available` 也只回传值无关字段。0.4.0 的 `GET /api/secret.manage` 只回传变量名与元数据（**无值字段**），`POST /api/secret.manage` 只在 `action:"value"` 时携带人类在掩码框里键入的值——它由人类提交，不经模型。
4. **会话级密钥不落盘**：`scope: "session"` 的值只存在于进程内存（Host 的暂存表与会话授权表）。落盘只走凭据服务，且只发生在 `persistent`。
5. **持久化只经凭据服务**：`persistent` 经 `ctx.credentials.set(<变量名>, value)` 写入凭据引用空间（provider 管理的可写源）；同时向记录空间提交一条**不含密钥材料**的标记记录（索取方向 `kind: "grant"`，附加方向 `kind: "attachment"`，payload 只有 `envVar/name/scope/authorizedAt`）。绝不写自建文件，绝不在仓库里存明文。
6. **会话边界失败关闭**（见「边界处理」）：锚点离开会话表面即撤销并不再注入。
7. **人类输入密钥的控件既不可自动填充，也不可被密码管理器捕获**（用户实机报出的缺陷的修复）：**现象**：真实浏览器会在这四个密钥输入面上给出自动填充建议，已装的密码管理器扩展也会捕获它们。**根因**：修复前这四个字段只有 `autoComplete:'off'`（现代浏览器对登录类凭据字段基本忽略这个值）、**没有任何厂商忽略标记、也没有别的退出开关**，而掩码用的又是原生 `type="password"`，浏览器正是据此把它当作密码域。**修复**：本插件渲染的**文本/密码**输入都带一套抑制属性——`autocomplete="new-password"`、`autocorrect="off"`、`autocapitalize="off"`、`spellcheck=false`，以及厂商忽略标记 `data-1p-ignore`（1Password 官方文档逐字给出）、`data-lpignore`（LastPass：**只有其支持页的标题级引用**——本环境抓取失败、其公开仓库 0 命中，如实标注为证据最弱的一条）、`data-bwignore`（Bitwarden：**opt-in**，只有用户在该扩展的设置里打开对应选项后才生效）、`data-form-type="other"`（Dashlane）、`data-protonpass-ignore`（Proton Pass：依据是**厂商源码**——`WebClients` 里 `PASSWORD_MANAGER_IGNORE_PROPS` 收录的正是这同一套属性，见 `packages/pass/…/Field.tsx` 与 `applications/wallet/…/attribute.ts`）。按面分层（**不是"每一个 input 都一样"**）：**4 个能持密钥明文的字段**（索要卡片的值输入、附加胶囊的密钥内容、管理面「改值」、管理确认卡片的「新密钥内容」）带齐 9 键袋**且**另加**只读直到聚焦**的守卫——字段先以 `readOnly` 渲染（自动填充只在加载时预填，而只读字段不在候选里），聚焦时由 `onFocus` 释放；**2 个标识符输入**（凭据键、标题）带 `autocomplete="off"` 的同一套袋**且**同样带**只读直到聚焦**的守卫，并且**自 0.4.3 起不再带 `id`/`name`**、改用**隐式 label 关联**（`<label>` 包住可见标题与控件，见下）。**依据要分清归属（t21 纠偏，勿混读）**：真正有文档支撑的是 **(a) 浏览器侧的键控行为**——Chrome 团队 web.dev《Learn Forms: Autofill》逐字写明浏览器**按 `name`（某些浏览器还看 `id`）记录与回填字段**，并对"值每次都不同、不可能复用"的字段（该页给的例子是一次性验证码，凭据键与标题同属此类）**推荐 `autocomplete="off"`**；同页还写明 `off` 对**密码字段无效**（"即使使用 `autocomplete="off"`，浏览器仍会提供密码自动填充选项"），这正是那四个密钥字段必须留着 `new-password` 而不能改用 `off` 的原因，而 `new-password` 用在纯文本字段上只会招来"生成强密码"的建议；以及 **(b) 五个厂商忽略标记**（1Password 官方文档逐字给出 `data-1p-ignore`；Bitwarden / Dashlane / Proton Pass 是**厂商自家源码**；LastPass 只到支持页标题级）。**而"去掉 `id`/`name`"是本次的设计选择，不是厂商文档的推荐做法**：1Password 官方文档的原意恰好相反——它建议给字段加**唯一的 `id`/`name`**，好让 1Password 能识别该字段；我们只在这两个**不持密钥**的标识符字段上反向操作，唯一目的是让浏览器不再把历史值当作可复用项、从而不再弹下拉，代价是放弃显式关联（见下面的可访问性口径）。不要把这一条读成"厂商推荐去 id"；**1 个不持值的掩码展示**（`disabled`）也带袋、不带守卫；**自由文本 `textarea`** 只带 4 键卫生子集（`autocomplete`/`autocorrect`/`autocapitalize`/`spellcheck`）；**2 个 scope radio** 不持值、不带袋、**且带 `name`**。所有文本/密码输入都没有 `name`，整个 UI **没有 `<form>`、没有 submit 按钮**（每个按钮都是 `type="button"`）。**可访问性口径（0.4.3，如实记录取舍）**：两个标识符字段改成隐式关联后，MDN 把嵌套与 `for`/`id` 记为"等价"，但同时提醒"并非所有辅助技术都实现隐式关联"，并**一般推荐**用显式 `for`；因此这两个控件同时带**与可见标题逐字相同的 `aria-label`**，把可访问名固定成显式提供的那一份（可见文本与可访问名一致，满足 Label-in-Name），点击标题仍会聚焦控件（嵌套 label 的原生行为）。**代价如实写明**：这两个字段失去了"显式关联"这一 MDN 推荐形态，换来的是去掉浏览器与扩展据以识别字段的稳定 `id`；`tabIndex` 未改、字段仍可聚焦、可用性未牺牲其它属性（正对照与机械断言见测试）。四个密钥字段**保留**显式 `for`/`id`：它们靠 `new-password` + 厂商忽略标记 + 守卫关闭浏览器侧凭据路径，而 MDN 推荐的显式关联在这里更值得留。掩码**仍用 `type="password"`**：替代方案 `-webkit-text-security` 是非标准属性（MDN 明写"不建议在生产使用、浏览器支持有限"），一旦被忽略就会把密钥显示成明文，比自动填充更糟。机械断言：两个 Client 测试逐一渲染这些面并断言上述属性与守卫，修复前的形态下它们**全部失败**（正对照见测试注释）。**需真人**：具体浏览器是否还弹自动填充建议/是否还提示保存密码、各管理器扩展是否仍捕获、以及只读守卫的代价（见下一条与「已知限制」），只能在真机浏览器里确认。
8. **明文允许存在的全部位置（穷举，仅此六处）**：
   - P1 填值胶囊 / 管理面「改值」面的本地输入 state（掩码输入框）；
   - P2 一次 `POST /api/secret.attach`（附加方向）或一次 `action:"value"` 的 `POST /api/secret.manage`（改值方向）的请求体；
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
- **会挂 10 条 `/api` 路由**（**9 个精确路径**：`/api/secret.manage` 一条路径两种方法，**单次注册**、按 `request.method` 分派——真实注册表按精确路径建键、与 `methods` 无关，所以同一条路径注册两次会在装配时抛 `exact Fetch route ... is already registered` 并让整个插件条目不激活；0.4.0 正是这样在实机上不激活，0.4.1 修掉）：`/api/secret.pending`(GET)、`/api/secret.attached`(GET)、`/api/secret.attach`(POST)、`/api/secret.release`(POST)、`/api/secret.answer`(POST)，以及 0.3.0 新增的三条——`/api/secret.history`(GET，本会话历史流水)、`/api/secret.available`(GET，`@` 菜单的可用密钥)、`/api/secret.adopt`(POST，把凭据库里的持久记录登记到本会话)，以及 0.4.0 新增的 `manage`(GET 管理面列表 / POST 执行一个管理动作)。全部位于 `ctx.connection` 的信任栅栏内（本机 / 可信 Host、同源标记、签名浏览器 Cookie）。值只出现在 `attach`、`answer` 与（仅 `action:"value"` 时）`manage` 的请求体里；其余路由都**不回传值**，`adopt` 的取值也由宿主自己经 `credentials.resolve` 完成，值不跨线。
- **会注册客户端座位与一个引用源**：`conversation.chat.node`（key `secret-request`）、`tool.call.toolview`（key `secret_request` 的 `null` 占位）、`conversation.input.left`（id `secret-attach-toggle`）、`conversation.input.overlay`（id `secret-attach-capsule`），外加一个名为 `secret` 的 `InputTriggerSource` 与 locale 命名空间 `secretAttach`。0.3.0 起再增加三处**增量**注册：`conversation.chat.node`（key `sr-chip`，消息旁的旁挂胶囊）、`sidebarRightTabs` 的 `secret-attach-detail` 类型，以及它的**正文座位** `sidebar.right.pane.tab`（key `@xinvxueyuan/cordis-plugin-secret/secret-attach-detail`）。该页签的**标题不另注册座位**：注册表走 fallback 取类型自己声明的 `title(address)`，即**变量名**（`src/client/entry.ts:3555`），所以用户看到的结果是对的。`tool.call.toolview` 只替换本插件自己那次调用的泛型工具行，不触碰别的工具；其余都是增量座位。0.4.0 再增加两处**增量**注册：`conversation.chat.node`（key `sr-manage`，Agent 侧的管理确认卡）与 `tool.call.toolview`（key `secret_manage` 的 `null` 占位）；同样只影响本插件自己那次调用，且管理面的三个新面都在**既有胶囊组件**里，不新增座位、不新增引用源，`dsh.client.inject` 也不变。
- **不做的事**：插件自身不 spawn 子进程、不读写仓库文件、不发起网络请求（除被 Harness 自己的 API 通道承载的上面列出的 10 条同源路由外），也没有任何遥测。

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

（`attachTtlMs`、`maxAttachmentsPerSession`、`maxHistoryPerSession`、`maxAvailableEntries` 未在这里显式写出，取下面配置表的默认值。）

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
| `maxHistoryPerSession` | `32` | 单个会话保留的历史记录条数上限（**内存态**，超出丢最旧）。 |
| `maxAvailableEntries` | `32` | `@` 菜单里「凭据库（持久）」一类最多列出的条目数（每项都要回读一次记录，因此有上限）。 |

六个键都必须是正整数：schema 的 `.default()` 之外，`assertConfig` 再手工兜一层（非正整数直接抛错）。

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

> **先重启。** dsh 在进程启动时加载插件的 `lib/` 构建，所以**发布 0.2.1 之后必须重启 `dsh web`** 才会加载修复后的产物；重启前的活体复测仍会复现 0.2.0 的现象（`staged` 不变 `bound`、shell 里没有变量），那是预期，不是修复失败。同理，**发布 0.3.0 之后也必须重启 `dsh web`** 才会加载四项增强的产物——重启前看不到消息旁的旁挂胶囊、信息框里的「历史记录」区、草稿移除后的自动撤销，`@` 菜单也不会有新分组，这些都属预期（下面是这四项各自的复测方式）。**发布 0.4.0 之后同样必须重启 `dsh web`** 才会加载管理面——重启前 `secret_manage` 工具不会出现在工具列表里，信息框里也没有五条管理路径，历史里不会有 `updated`/`scope-changed`/`unbound`/`deleted` 四类事件；活体上仍是 `0.3.0` 的四个方向，这属预期，不是发布失败。**0.4.0 是个例外**：它虽然在 GitHub Release 与 GitHub Packages 上发了，但在真实运行时**整个插件条目不激活**（`dsh: warning: 1 entry did not activate`，见下面「0.4.0 的发布级缺陷与 0.4.1 修复」），所以重启也换不来可用的管理面；**必须重启到 0.4.1**。**发布 0.4.2 之后同样必须重启 `dsh web`** 才会加载密钥输入的抑制属性——重启前浏览器仍会照旧给那四个字段自动填充建议、密码管理器扩展仍会捕获（这就是 0.4.2 修的那件事），这属预期，不是修复失败。

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

### 0.3.0 的四项增强（历史胶囊点击 / 历史聚合 / 移除即撤销 / `@` 菜单）

四项增强各一句：

| 增强 | 一句话 |
|---|---|
| **历史胶囊点击** | 插件在**每条带标记的消息旁**新增一行胶囊（旁挂节点），点击打开**输入框上方**的信息框；同时注册一个右侧栏文档查看器，**接管 harness 渲染的原胶囊**，点它时在**右侧栏**打开详情页。 |
| **信息框历史聚合** | 信息框内新增「历史记录」区，集中列出本会话的附加/授权流水（变量名、来源、作用域、状态、时间、锚点），**默认全部展示**（含已失效/已回退），用状态文案区分。 |
| **移除标记即撤销** | 草稿里的标记消失约 0.6s 后，对应的**暂存**记录被撤销：`GET /api/secret.attached` 不再把它报为 `staged`，**会话级的值随即不可找回**（重插须重填）。已绑定的记录不受本机制影响。 |
| **`@` 引用菜单** | 输入 `@` 列出**本会话当前可用**与**凭据库已持久化**的密钥，条目上用 `section` 标来源、`description` 标作用域；本会话可用的条目直接插入，凭据库条目**先确认再登记**（值由宿主自己从凭据库读取，不经过对话）。 |

#### 两个入口的区别（同一份信息，两处入口）

| 你点的东西 | 它是什么 | 打开哪里 |
|---|---|---|
| **旁挂胶囊**（插件在你的消息旁新增的那一行） | 本插件自己的 `ConversationNodeDefinition` 节点（`conversation.chat.node`，`key = sr-chip`），锚在**同一条消息的 seq** 上、`location = { kind: 'session' }`，因此排在用户气泡**之后**、且永不折进「已调用工具」分组 | **输入框上方**的信息框（与草稿 chip 的点击是同一个面） |
| **原胶囊**（harness 渲染在你消息正文里的那个） | `dsh-client-ui-primitives` 的 `projectUserText` 产物，`data-ref-chip="file"`，点击被硬编码为 `openFile('DSH_SECRET_X')` | **右侧栏**的详情页（由本插件注册的 `secret-attach-detail` 类型接管），内容与信息框同源 |

旁挂胶囊的落位不是"大概齐"：节点 key 形如 `${kind.length}:${kind}${id}`，同锚点、同 rank 时由 `key.localeCompare` 定序（`dsh-client-ui-chat/lib/client.js:8273-8281`）。人类消息的 definition kind 是 `input-message`（13 字符 ⇒ 键前缀 `13:`；`chat:9264`），而 `sr-chip` 是 7 字符（⇒ `7:`）；字典序下 `7:` 排在 `13:` **之后**。实测（`node -e`，与 `localeCompare` 同语义）：长度 10/11/12 的 kind 会排到 `13:input-message…` **之前**；而该键是**整体字典序**比较，**长度前缀与 kind 文本共同决定顺序**，因此「某几个长度区间一律排在后面」并不成立（实测反例：长度 1 的 kind、以及长度 13 且文本排在 `input-message` 之前的 kind，都排到气泡**之前**）——kind 的位置**必须逐个实测**。本插件实际采用的 `sr-chip`（7 字符）已机器证明排在气泡**之后**。（早前版本里"长度 4 到 9 与 13 及以上一律排在之后"的说法不成立，特此更正。）

#### 原胶囊的接管是「长度竞争」，不是契约（如实披露）

原胶囊的点击最终走到右栏的 tab 注册表：`openFile` → `fileAddressFor` → `ctx.sidebarRight.openResource('dsh-resource://file/session/<id>/DSH_SECRET_X')` → `claim(address)`。该注册表按 **priority 档 → 命中的 pattern 长度 → 注册顺序** 排序（`dsh-client-ui-sidebar-right/lib/client.js:8782-8798`）。

- 本插件声明 `priority: 'extension'`、`patterns: ['dsh-resource://file/**/DSH_SECRET_*']`（**实测长度 35**），并用 `canOpen` 只接受最后一段形如 `DSH_SECRET_*` 的地址（不是我们的地址一律让给对方）；
- 本机已装的 `dsh-better-sidebar` 0.24.1 在**同一档**声明兜底 `dsh-resource://file/**`（**实测长度 22**）：同档时更长的 pattern 胜出，因此这次打开归我们。

**可争用性（机制固有，不是缺陷）**：任何**后来者**只要在同一 `extension` 档声明**更长**的 pattern（例如 `dsh-resource://file/**/DSH_SECRET_*/**`），就会**静默抢走**这次打开——用户会落到那个查看器，而不是我们的详情页，且我们收不到任何通知。这一点无法用契约保证，只能靠"我们当前最长"这一事实。**若某天发现点原胶囊又开出别的东西（甚至退回"文件不存在"），原因就在这里。**

#### 历史记录的保留语义（如实）

| 维度 | 事实 |
|---|---|
| 存储 | Host 侧 `HistoryStore` 是**纯进程内存**，按会话隔离，有容量上限（`maxHistoryPerSession`，默认 32），读出时**最新在前** |
| 刷新页面 | **仍在**（Host 进程没变） |
| 宿主重启 / 插件重载 | **清空**（历史不在磁盘上） |
| 重放 / 分叉会话 | **不重建**：Host **不读** session log 还原历史；fork 出来的子会话从空历史开始 |
| 条目来源 | `staged`（附加登记，可含"取代了同变量的上一条"）/ `bound`（提升为授权，带锚点 seq）/ `discarded` / `withdrawn`（草稿移除撤销）/ `revoked`（锚点消失，**读取时懒观测**）/ `expired`（TTL 到期）/ `authorized`（`secret_request` 索取方向的授权），并同时标 `attach` / `request` |
| 锚点 | 已绑定的条目带 `anchorSeq`（即那条 `user/message` 的 seq）；未绑定或未落盘的条目没有锚点，UI 不编造 |

客户端的四种诚实状态（都出现过，都不编造）：**未读**（「正在读取本会话的记录…」）／**读失败**（「历史暂不可用」，并**保留上一次的答案**，不清空）／**本进程无记录**（「本进程内暂无记录。」）／**该变量无记录**（「该变量在本进程内没有记录。」）。

「默认全部展示」的落地：已失效/已回退/已丢弃/已过期都列出，并用状态文案区分——`已登记` / `已绑定到消息` / `已丢弃` / `已随草稿移除撤销` / `已随消息回退失效` / `已过期` / `经授权生效`。其中 `revoked`（已随消息回退失效）只在**有人读过该变量状态之后**才出现（懒观测）：没观测到就不写进流水，宁缺勿假。

#### 从草稿移除标记即撤销（含边界）

只看"草稿里没有标记"是不够的，因为**发送也会清空草稿**（乐观清空）：普通发送的提交相位**全程是 `plain`**（不走 `submitting`），但 `pendingSubmission` 回显会**同步先行**出现，且它的文本就是将要发送的文本。因此撤销要在**全部**条件成立时才触发：

1. 草稿里没有该标记（`InputState.draft` + `MARKER_RE`）；
2. **没有任何** `pendingSubmission` 的文本携带该标记（⇒ 发送中不撤销）；
3. 提交相位是 `plain`；
4. 该变量**曾在草稿里出现过**（否则刚 attach 完还没插进去就会被立刻误撤销）；
5. 本地状态是 `staged`。

满足后**去抖 600ms**，再做一次同样的判定，然后调 `POST /api/secret.release`（带 `reason: "withdrawn"`，与人类手点「丢弃」的 `discarded` 在历史里区分开）。

| 边界 | 行为 |
|---|---|
| 删掉后 600ms 内又插回（含剪切/粘贴） | **不撤销**，记录保留 |
| 删掉后隔一会儿再插回 | 记录**已撤销**，`@` 菜单不再列出该变量；重新附加**必须重新填值**（会话级的值不可找回；`persistent` 作用域的可以从凭据库条目重新登记） |
| 发送（Enter / 发送按钮） | **不撤销**：回显携带标记 ⇒ 判定中止；消息落盘后该记录提升为 `bound` |
| 发送失败（草稿被恢复） | 标记回到草稿 ⇒ 不撤销，记录保持 `staged` |
| 发送中又手动删掉标记 | 同样不撤销（人类删的是草稿，不是那条已经发出的消息） |
| 已 `bound` / 已 Grant 的记录 | **本机制不碰**：只有回退/改写那条消息才会让它失效（`revoked-anchor`，与既有一致） |
| 宿主未提供草稿观测能力 | 胶囊里显示「宿主未提供草稿观测能力，自动撤销不可用（可手动丢弃或等 TTL 过期）。」——**宁可不撤销，也不误撤销** |
| 刷新页面 | 草稿恢复为纯文本 `@VAR`，`MARKER_RE` 仍命中 ⇒ 不撤销 |
| 撤销后重新附加同一凭据键 | 新记录带新的代次；任何在途的旧计时器因代次不匹配而作废，不会杀掉新记录 |

#### `@` 菜单的两类来源

| 来源（`section`） | 含义 | 条目 `description` | 选中后的行为 |
|---|---|---|---|
| `本会话可用` | 本会话已登记（`staged`）或已绑定（`bound`）的变量 | `本会话 · <作用域> · <状态>` | **直接插入**引用标记：与既有 `codec` / `serializeReference` 完全一致（插入的就是 `@DSH_SECRET_X`），发送后照常绑定与注入 |
| `凭据库（持久）` | 本插件在凭据库里留过持久记录的变量，且本会话当前没有 | `凭据库 · 持久保存到凭据库 · 尚未用于本会话` | **不直接插入**：先弹一步确认（变量名 + 来源 + 作用域），确认后调 `POST /api/secret.adopt`，由宿主自己 `credentials.resolve` 取值并登记到本会话，**成功之后**才插入标记；失败则不插入任何东西，只显示固定文案 |

条目形态用足菜单的呈现能力：**`label` 是主显示文本，但不总是变量名**——「凭据库（持久）」一类是**变量名**（`src/service.ts:664-668`，记录里没有人类标题，变量名是唯一诚实的标签），「本会话可用」一类是**人类标题**（在胶囊里填的标题；留空即回退为凭据键，`src/client/entry.ts:2808`，attach 请求缺省 `label ?? name`）⇒ **带标题的本会话条目上不会显示变量名**（变量名出现在插入后的草稿标记与胶囊详情里，那两处都按变量名显示；菜单条目的 `description` 只写来源/作用域/状态）。`name` = 凭据键（灰色别名 + 搜索键）、`description` = 来源·作用域·状态、`section` = 来源分组（**不把来源塞进名字里**）。菜单**不渲染** `hint` 字段，所以来源/作用域不放在 `hint`。「凭据库」一类只列**本插件提交过记录**的密钥：凭据服务的 reference 半边**没有枚举面**，别处写进去的环境变量/`.env` 条目无法被发现，这一点如实说明而不是猜。

#### 怎么复测这四项（先重启 `dsh web`）

下表左列是**已在代码与 0.3.0 产物层面机器验证过的机制**（`lib/` 里可机械复核），右列是**仍未验证、必须真人在浏览器/真实凭据库里确认**的部分。两者不要混读。

| 增强 | 机制（机器已验证的判据） | 仍需真人现场确认 |
|---|---|---|
| 历史胶囊点击 | 旁挂节点 `sr-chip`：`uiConversation.events.register` + `conversation.chat.node` 座位（键 `sr-chip`）都在 `lib/client/entry.js` 里；点击 → `setAttachMode({kind:'detail'})`，与草稿胶囊共用同一个信息框。右栏 `secret-attach-detail` 类型以 `priority: 'extension'` + `dsh-resource://file/**/DSH_SECRET_*` 注册，`canOpen` 只收末段形如 `DSH_SECRET_*` 的地址 | 旁挂行在气泡**之后**的视觉位置与四档展示；点旁挂行是否真在输入框上方开出信息框；点转录里的原胶囊是否真开出右栏详情页（而不是「文件不存在」），以及有没有被别的插件抢走这次打开 |
| 信息框历史聚合 | 信息框头部「历史记录」链接 → `history` 面；行有 `data-secret-history-count` / `data-secret-history-row[data-status]`；Host 侧 `GET /api/secret.history?sessionId=$DSH_SESSION_ID` → `{ok:true, entries}`，逐字段重建、**无 value** | 视觉排版与长流水是否截断；四种诚实状态（未读/读失败/本进程无记录/该变量无记录）在现场是否可读 |
| 移除即撤销 | 插入标记 → 从草稿删掉标记 → 约 0.6s 后 `POST /api/secret.release`（`reason:"withdrawn"`）⇒ `GET /api/secret.attached` 不再报 `staged`，`/api/secret.history` 多一条 `withdrawn`；重新插入**不会**把值找回来 | 真实编辑器里的时序（删掉→插回是否在 600ms 内、Enter 发送是否**不**触发撤销、发送失败恢复草稿是否仍为 `staged`） |
| `@` 菜单 | 输入 `@` → `GET /api/secret.available?sessionId=…`；两类条目用 `section` 分组（`本会话可用` / `凭据库（持久）`）、`description` 写作用域与状态；凭据库条目选中后先确认，确认才 `POST /api/secret.adopt`（body 只有 `{sessionId, variable}`），成功之后才插入 `@VAR` | 菜单宽度是否截断条目；带自定义标题时条目显示标题（不是变量名）在现场是否可接受 |

Shell 侧的可执行判据（只报存在性与长度，绝不回显值）：

```powershell
# 先重启 dsh web，再重跑一遍「自己复测」五步；下面是四项增强各自的检查点：
Invoke-RestMethod "http://127.0.0.1:<port>/api/secret.history?sessionId=$env:DSH_SESSION_ID"   # 历史聚合
Invoke-RestMethod "http://127.0.0.1:<port>/api/secret.attached?sessionId=$env:DSH_SESSION_ID"  # 移除标记后不再有 staged
Invoke-RestMethod "http://127.0.0.1:<port>/api/secret.available?sessionId=$env:DSH_SESSION_ID" # @ 菜单的两类来源
if ($env:DSH_SECRET_OPENAI) { "present length=$($env:DSH_SECRET_OPENAI.Length)" } else { "absent" }
```

### 已知限制（如实记录）

- **对话框那条消息上的胶囊是 `data-ref-chip="file"`**，`openFile('DSH_SECRET_OPENAI')` 仍是它唯一的点击路径。**0.3.0 起的现状**：插件已注册 `sidebarRightTabs` 的 `secret-attach-detail` 类型**接管这次打开**，所以点它会开出**右侧栏的详情页**（见「0.3.0 的四项增强 → 原胶囊的接管是长度竞争」）；0.2.x 的行为是打开一个不存在的文件（无害但不正确；不泄露任何东西——变量名本来就在那里可见），该行为作为历史如实保留。**注意这条接管是"当前 pattern 最长"的长度竞争结果，不是契约。**原因（点击目标为何无法从插件侧直接改写）：用户气泡的正文由 `dsh-client-ui-primitives` 的 `projectUserText` 独家渲染，它对 `@token` 形状**硬编码**为文件引用并挂 `openFile`；ui-chat 的消息管线没有可注册的引用种类（能接住点击的 `openReference` 只作用于**草稿编辑器**，不作用于转录气泡）。
  - **为什么不存在"既是 chip 又不可点"的 `@` 形态**（已逐行证明）：该函数只认三种 token（`primitives lib/index.js:6724` 的正则：`/名称`、`@"…"`、`@非空白`）；`:6753` 的判定是 `@` 开头**必然**映射为 `'file'`（或 `'folder'`），只有 `/` token 才可能是 `void 0`；而 `/` token 又必须在 caller 传入的 `slashNames` 名单里（`:6731`）。所以 `@DSH_SECRET_*` 一定拿到 `referenceKind:'file'` 并因此挂上 `openFile`，没有任何插件钩子能改变它。
  - 另外两条路都已评估并否决：wire session 形态 `@[label](dsh-session:…)` 虽是**不可点**的 session chip，但会被 `dsh-session-reference` 服务在 `agent/pre-step` 里当作跨会话引用解析（可能让整步失败），风险大于收益；整体接管 `conversation.chat.node` 的 `user` key 并自己重绘用户气泡需要重写附件、图片、markdown 与动作行，脆弱度过高。
  - **交付给下一环节的验证项**：这条点击行为需真人在浏览器里确认。**预期现象已随 0.3.0 改变**：点转录里的胶囊应打开**右侧栏的详情页**（0.2.x 的预期现象才是"尝试打开同名文件"）；该打开归谁，取决于「0.3.0 的四项增强 → 原胶囊的接管是长度竞争」里那条长度竞争，因此现场还需确认没有被别的插件抢走。
  - **`agent/pre-step` 追加的那条注记行本身也会被投影成 file chip**：注记是一条 durable 的 `user/message`，正文里逐字含 `@DSH_SECRET_*`，所以在转录里它同样由 `projectUserText` 渲染为 `data-ref-chip="file"` 并挂上同一个 `openFile` 行为（0.3.0 起这个 `openFile` 也被我们的右栏查看器接管，因此点它同样打开我们的详情页）。**与上面第一条同源**：观感问题、不泄露任何东西（注记里只有变量名与作用域，没有值），也不是未做完的功能——任何出现在消息正文里的 `@` 标记都逃不过这条 shipped 规则。
- 刷新后草稿里的 chip 会变回纯文本 `@DSH_SECRET_OPENAI`（草稿镜像只存文本），由 lexicon 装饰回"引用"观感，点击仍能打开详情胶囊；这与 chip 的原子性不同，是草稿投影的既有语义，不是本插件的取舍。
- **工具结果里的 `@DSH_SECRET_*` 没有注记解释**（**值无关，不是泄漏**）：注记只为**本步引入的、载有标记的用户消息**追加，所以当同一形状的标记出现在**工具结果**（例如某条命令的回显）里时，它会**原样**进入模型上下文，且那一步的注记不会覆盖它——模型可能按系统提示里"`@` 前缀是文件路径"的约定去解读它，例如尝试读取一个同名文件（会失败）。**它不会因此获得任何值**：这条缺口只涉及"标记的解释范围"，与明文无关；变量名本来就在会话日志、用户气泡与注入说明里可见。**准确定性**：这是解释范围的一个已知缺口（不是未做完的功能），既没有把值带进上下文，也没有影响绑定、授权或 shell 注入。
- 视觉与真机点击路径需要人工确认（见「边界与已知限制」）。

## 秘密的完整 CRUD（0.4.0）

0.3.0 之前，这个插件只有「要一枚密钥」与「人类附加一枚密钥」两个方向；0.4.0 补上**管理**：Agent 可以在获得人类确认后**列举 / 解绑 / 真删 / 改作用域 / 请人类改值**，人类可以在信息框里做同样的事。核心边界不但没变，还被进一步钉死：**值只能由人类输入，Agent 既拿不到、也提交不了值。**

### Agent 侧工具 `secret_manage`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `action` | ✅ | `list` / `unbind` / `delete` / `scope` / `value`。 |
| `variable` | 除 `list` 外 ✅ | 目标变量名，形如 `DSH_SECRET_OPENAI`。 |
| `to` | 仅 `scope` ✅ | `session` 或 `persistent`。 |
| `target` | 仅 `value` ✅ | `session`（本会话这份值）或 `store`（凭据库那份值）。 |
| `reason` | ✅ | 原样展示给要确认的人，也是对方同意的那份理由。 |

**参数集里没有 `value`，也没有任何别名**：`validateManage` 对带 `value` 的调用直接拒绝（「this tool never carries a value; a human types it into the confirmation surface」），而工具 schema 的属性名集合被单测逐字断言为 `{action, reason, target, to, variable}`。

| action | 语义 | 需要人类确认 |
| --- | --- | --- |
| `list` | 只读列举：变量名 + 凭据键 + 标签 + 有效作用域 + 状态 + 来源（`session`/`store`/`both` 两个半区）+ 方向（`origin`：`attach`/`request`，仅会话侧的行有）+ Host 亲算的 `can.*`（**这一行支持什么**，不是"你能执行什么"） | 不需要（**委派子代理也可调用**；其渲染会明说写动作只对活跃的会话根代理开放） |
| `unbind` | 从**本会话**移除：凭据库不动，零持久写 | 需要（主 Agent；一次确认） |
| `delete` | 从**凭据库真删**：先删引用空间的值，再删记录空间的标记 | 需要（主 Agent；**危险确认**） |
| `scope` | 改本会话这份的作用域；`to:"persistent"` 会把**本会话已持有的那份值**写入凭据库 | 需要（主 Agent） |
| `value` | 请人类改值（`target` 决定改哪一份） | 需要（主 Agent）；**值由人类在掩码框键入** |

返回 `{ decision: 'listed' | 'applied' | 'rejected' | 'ignored' | 'other', … }`；失败码：`BAD_REQUEST`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`、`NO_SESSION`、`NOT_FOUND`、`STORE_EMPTY`、`STORE_SHADOWED`、`STORE_DELETE_FAILED`、`TOO_MANY_PENDING`、`TIMEOUT`、`MANAGE_FAILED`。结算载荷 `presentationMeta` 是 `{v:1, kind:'secret-manage', decision, action?, variable?, scope?, notice?}`，值无关且模型不可见。

### 权限边界（可用单测核查）

- **`list` 是唯一对子代理开放的动作**：它只读且值无关。子代理拿到的永远是**它自己会话**的事实——凭据库那一侧的**全局名字行**（`source:'store'`，`can.unbind`/`can.scope` 均为 `false`）+ 它自己会话的附加/授权记录；父会话自己的变量不会出现。返回里的 `can` 仍然是**这一行支持什么**（与人类信息框读到的是同一事实），因此子代理的列表结果另附一句 value-free 的注意：`unbind`/`delete`/`scope`/`value` 只对活跃的会话根代理开放，子代理调用会得到 `DELEGATED_CALLER`，不会有对话框出现——渲染会原样引用这句话，不把它读成"你可以执行"。
- **四个写动作只对「活跃的会话根代理」开放**：被委派的子代理得到结构化 `DELEGATED_CALLER`，陈旧 id 得到 `CALLER_NOT_LIVE`，两者都在**创建任何对话框之前**失败，绝不挂起——子代理没有可靠的人类确认通道，就不问。
- **没有任何 Agent 可达的提交值路径**：工具参数集里**没有 `value`**（schema 不声明这个参数，因此它也不会出现在属性名集合断言里），而**承重的参数层拒绝在服务侧** `validateManage`——任何带 `value` 的调用都会被它直接拒绝（「this tool never carries a value; a human types it into the confirmation surface」）。工具参数根是隐式开放对象（`additionalProperties` 未声明 `false`），所以「拒绝」这件事由服务侧承担，不写成「schema 自身拒绝」。`POST /api/secret.manage` 的请求体只接受 `{sessionId, action, variable, to?, target?, value?, confirm?}`，其中 `value` **仅**在 `action:"value"` 时被接受（其余动作带上它一律 400），且这条路由是**人类界面**的路，不是模型的路。
- **未确认时零持久副作用**：`delete` 缺 `confirm:true` 直接 400；`unbind` 不接受 `confirm`（它没有不可逆性）；被拒绝 / 忽略 / 超时的确认不写凭据库、不写历史。

### 人类侧信息框（五条路径）

胶囊头部的「管理」链接（以及详情面的「管理」按钮）打开管理面，分两个分区：**本会话可用**（人工附加的 `staged` / `bound` 行 **与** Agent 经 `secret_request` 获得的本会话授权行 `authorized`；每行以 `origin`=`attach`/`request` 与 `state` 如实区分）与**凭据库（持久）**，每行显示变量名 + 凭据键 + 作用域 + 方向 + 来源 + 状态；动作按钮**按 Host 亲算的 `can.*` 渲染**——不可用的动作根本不出现，所以界面不会提供一个注定失败的动作。五条路径：

1. **列表**：两类来源可区分（分区标题与 `source` 都写明「本会话可用」/「凭据库（持久）」）；读不到时用固定文案，不猜。
2. **改值**：掩码输入（`type=password` + 显示/隐藏），目标写清「改本会话这份值」或「改凭据库里的值」；值只在这个组件的 state 与这一次 POST 体里，提交后清空、取消即丢弃。**Agent 无法替人类做这一步。**
3. **改作用域**：升为持久 / 降级（见下表）。
4. **解绑**：只影响本会话，凭据库不动。
5. **真删**：从凭据库删除记录，危险面上必须**第二次显式点击**（确认按钮文案是「不再持久，并从库中删除」，不是含糊的「确定」）。

**降级给两个明确按钮，各有各的后果**：

| 按钮 | 线上动作 | 后果 |
| --- | --- | --- |
| 仅改为本会话（保留库中记录） | `{action:'scope', to:'session'}` | 本会话这份降为 session；**凭据库的值与记录原样保留**，之后仍可升回持久或再登记 |
| 不再持久，并从库中删除 | `{action:'delete', confirm:true}` | 真正删除凭据库里的值与标记，**不可恢复** |

**解绑 ≠ 真删**：解绑只撤掉本会话的暴露（可逆，库里的记录还在，之后还能再登记）；真删抹掉盘上那份（不可逆，谁都找不回）。两者在动作名、请求体字段、确认强度与历史事件上都分开，不是同一个动作的两个措辞。

**升为持久不要求重新输入值**：`scope → persistent` 用的是**本会话当前持有的那份值**，确认面上逐字写明「将把本会话当前持有的值写入凭据库，并把这份记录改为持久保存」——人类在知情的前提下点同意，不构成"偷偷写库"。

**真删之后**：本会话内存里的那一份**继续可用**（删库不等于撤权），但它的作用域**如实降级为 session**，并在管理列表（`scope: session`）与历史（一条 `deleted`）里如实呈现；该授权照旧随锚点失效、会话结束即消失。

**新增历史事件**：`updated`（人类改值）、`scope-changed`（改作用域）、`unbound`（解绑）、`deleted`（真删），来源均为 `manage`。历史仍是**纯进程内存**：刷新页面还在，宿主重启或插件重载后为空，重放 / 分叉的会话不会重建它——`deleted` 这种"盘上确实变了"的事实也只在历史里留一条内存记录，不落盘。

**需真人确认（本 README 不把它们写成已验证）**：管理入口可达且两个分区读得清；不可用的动作确实不出现；改值链路在活体 shell 里真的换成了新值；升为持久真的写库；真删的现场效果（该行从库侧分区消失、会话侧作用域变「仅本次会话」、历史多一条、**其它三条外来记录一字未动**）；以及用子代理调 `list` 不挂起、调四个写动作得到结构化 `DELEGATED_CALLER`。

### 删除一条遗留测试凭据（现场动作，需人类在场）

发布后若要把早期测试写进凭据库的那条记录清掉，**走信息框的真删路径，不要手改 YAML**（手改会绕过"谁写的、谁确认的、删了什么"三件事）。前置只读核对（**只看键名，不打印任何值**）：

1. `Select-String -Path C:\Users\admin\.dsh\.credentials.yaml -Pattern 'cordis-plugin-secret/dsh-selftest-persist' -Quiet` → 期望 `True`（已是 `False` 说明删过了，到此为止）。
2. 键前缀必须是 `cordis-plugin-secret/`；同一个文件里 `client-connection/…`、`deepseek-account-platform/…` 这些**别人的记录永不可碰**。
3. 进程环境里 `DSH_SECRET_DSH_SELFTEST_PERSIST` 必须**未设置**（被启动环境遮蔽时删除会返回 `STORE_SHADOWED` 且不进行第二步；先在自己启动 dsh 的 shell 里 `unset`）。

执行（**两次显式点击**）：打开 Harness Web 本会话 → 输入框左侧「附密钥」按钮 → 胶囊头部「管理」→ 分区「凭据库（持久）」里找到 `DSH_SECRET_DSH_SELFTEST_PERSIST`（同时显示凭据键 `dsh-selftest-persist`）→ 点该行的「不再持久，并从库中删除」→ 读完危险面文案后点带「真删」语义的确认按钮。

**不可恢复性与副作用（逐字告知）**：引用空间的值被原子重写掉（`writeFileAtomic` + 0600），**没有任何副本**，也无法从会话日志反推（日志里只有变量名）；记录空间的标记一并删除，因此**其它会话再也 adopt 不到它**。想再用同一变量，只能重新走 `secret_request` 或重新附加，**重新输入新值**。删除后刷新页面，「管理」面（每次都向 Host 现问）里该行消失，历史里多一条 `deleted`（仅本进程内可见）。若某个会话此前已把它绑到某条消息上，那个会话的内存副本仍在，直到消息回退或会话结束。

### 怎么复测 0.4.2（先重启 `dsh web`）

0. **重启后先看启动日志**（这是 0.4.0 缺陷的判据，也是本版修复的判据）：`dsh` 的启动输出里**不应再有** `warning: 1 entry did not activate`，也不应再出现 `secret (@xinvxueyuan/cordis-plugin-secret): Error: connection: exact Fetch route "/api/secret.manage" is already registered`；工具列表里应当有 `secret_manage`，管理面可用。（0.4.0 在实机上正是这条 warning；`lib/routes.js` 里 `/api/secret.manage` 现在只注册一次、`methods` 是 `['GET','POST']`，可以离线核对。）

1. **自动化（不需要浏览器，约 6 秒，自然退出，无需清场）**：
   ```sh
   npm run typecheck && npm test
   ```
   共 8 个测试文件 / 128 个用例。管理面在 `test/register.test.ts`：两个工具的参数集（逐字断言没有 `value`）、`list`/`unbind`/`delete`/`scope`/`value` 五个动作、五条人类侧路径、降级两个按钮（文案与线上动作都不同）、真删两档（缺 `confirm` 零副作用）、列表两个方向的 `origin` 与委派子代理的可达性注意（含根代理的正对照）；**0.4.1 起还有实施真实注册表规则的严格注册表**——它断言 9 条精确路径各注册一次、`/api/secret.manage` 一行两方法，并在修复前的形态上以**同一条** `already registered` 错误失败（这就是 0.4.0 漏网的那个门）；**0.4.2 起新增两条密钥输入抑制用例**（`test/client-card.test.ts` / `test/client-attach.test.ts`）——它们逐面枚举渲染出的字段并断言那一套抑制属性与只读守卫，在修复前的形态上逐条列出缺口（正对照）。四类新历史事件在 `test/history.test.ts`。`npm test` 若挂住，按仓库红线处理：**先查泄漏**（本插件自己的 teardown/定时器），临时排障才用 `node --test --test-force-exit`，**不得按进程名清场**。
2. **活体（需真人；管理面每次都向 Host 现问，改完刷新即可再核对）**：按上面「人类侧信息框（五条路径）」逐条点一遍——列举（两个分区读得清）、改值（掩码框）、改作用域（两个降级按钮各点一次，核对其后果不同）、解绑（凭据库不动）、真删（两次点击）。断言点是上面「需真人确认」列出的那些：不可用的动作不出现；改值后活体 shell 里真的是新值；`scope → persistent` 真的写库；真删后该行从库侧分区消失、会话侧作用域如实变「仅本次会话」、历史多一条 `deleted`、其它三条外来记录一字未动；子代理调 `list` 不挂起、调四个写动作得到结构化 `DELEGATED_CALLER`（无对话框）。
3. **浏览器侧（0.4.2 起，只能真人做）**：在真实浏览器里打开四个密钥输入面**与两个标识符输入（凭据键、标题）**，逐条核「需真人确认」里那几项——是否还弹自动填充建议（标识符字段尤其要看历史值下拉是否消失）、Chromium 是否还给"生成强密码"建议、是否还弹"保存密码？"、已装的密码管理器扩展是否仍捕获、以及**聚焦之后能否正常键入**（只读守卫的代价）。
4. **旧版对照**：`git stash` 或 checkout `v0.3.0` 后 `git diff v0.3.0 -- src test` 可看到本轮的全部改动面；`.credentials.yaml` 的基线（大小与 SHA256）应在复测前后逐字节不变。

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

- **转录气泡里的胶囊由 shipped 代码渲染，插件改不了那次点击的目标**：`@DSH_SECRET_*` 在用户消息气泡里被 `dsh-client-ui-primitives` 的 `projectUserText` 渲染成 `data-ref-chip="file"`，点击走它硬编码的 `openFile('DSH_SECRET_OPENAI')`。**0.3.0 起**：该 `openFile` 解析出的地址（`dsh-resource://file/session/<id>/DSH_SECRET_X`）已被本插件的右栏查看器接管，因此点击打开的是**我们的详情页**；0.2.x 的行为（打开一个同名文件）作为历史如实保留，且**接管随时可能被同档更长的 pattern 抢走**（见「0.3.0 的四项增强 → 原胶囊的接管是长度竞争」）。**编辑器内（草稿）的胶囊不受影响**：那里是插件自己注册的 `secret` 引用源，点击打开只读详情胶囊。同一条 shipped 规则也适用于 `agent/pre-step` 追加的那行注记（它正文里同样含 `@DSH_SECRET_*`，因此也会显示为 file chip）。逐行证据与"为什么不存在既是 chip 又不可点的 `@` 形态"见「人类主动附加密钥（反方向）→ 已知限制」。
- **工具结果里的 `@DSH_SECRET_*` 没有注记解释**（值无关，不是泄漏）：注记只为**本步引入的、载有标记的用户消息**追加，因此同一形状的标记出现在工具结果里时原样进入模型上下文且无注记覆盖，模型可能按"`@` = 文件路径"去解读它（会失败）。它不会因此获得任何值，也不影响绑定、授权或 shell 注入。详见「人类主动附加密钥（反方向）→ 已知限制」。
- **`ctx.authorization` 只承载 `persistent`**：该 seam 的契约要求"本次尝试期间提交并观察到一条凭据记录"（否则 `NOT_COMMITTED`），而 `session` 授权按定义不得落盘。因此 `session` 请求走同一套对话框、但不进该 seam；`persistent` 请求完整走 `registerFlow` + `begin`。这是 seam 契约决定的取舍，不是省事。
- **O1 / O2（第二轮修复，两条都如实回报）**：
  - **O1**：`persistent` 请求里人类已点"同意"，但 seam 的授权尝试最终 `failed` 时，**不再**声称"已持久化"：人类的选择被保留，但按「仅本次会话有效」降级生效，`notice` 写明的是**"未能完成持久化登记的确认"**——本插件自己的代码路径不会写凭据库，但 seam 可能在提交授权记录**之前**就已把值写入凭据库（`persist` 先于 `commit`），因此这里不做"值一定没进库"的绝对断言；若值已进库，它只是缺少本次授权记录。
  - **O2**：`persistent` 等待本身超时（`requestTimeoutMs`）时，错误码一律是 `TIMEOUT`，不会被 seam 的 `failed` 包装成 `AUTHORIZATION_FAILED`。
- **`shellEnv` 的 resolver 是同步的**，而 `ctx.credentials.resolve` 是异步的：无法在每次 shell 执行时回源凭据库。因此授权通过时把值读入该会话的授权表（并在每次注入前做锚点/会话校验），凭据库仍是持久层的真相。**轮换凭据后请重新调用 `secret_request` 刷新会话内副本。**
- **验证限制**：本插件的安装与注册由 `cordis_inspect_query` 的 Tool/Slots 证据覆盖；卡片的**视觉**（浅色/深色、布局、四档"工作步骤展示"下的实际渲染位置）与附加方向胶囊的**视觉 / 真机点击路径**只有在浏览器里有页面时才可能确认，无浏览器控制时不做渲染器/截图等替代验证。"卡片在四个档位下都位于步骤进程分组之外"由结构证明（节点无 Turn/Step 坐标 ⇒ 根条目、非 process member）加单测（`buildViewNode` 的 `location.kind === 'session'`）覆盖，**未经真人点击/切档验证**。单测覆盖 Host 侧全部纯逻辑、register 级装配与 Client 半的纯逻辑（节点状态机、四态判定、表单控件、明文不越界、以及浏览器产物在真 cordis 上下文里的 boot）；真机点击路径需要人工确认。
- **0.4.0 的四条已知限制（如实记录）**：
  - **管理列表里一个变量只占一行，「本会话可用」分区同时覆盖两个方向**：人工附加（`staged` / `bound`）**与** Agent 经 `secret_request` 获得的本会话授权（`authorized`）都在这个分区里，每行以 `origin`（`attach` / `request`）与 `state` 如实区分，`can` 仍是 Host 亲算的**行能力**。若**同一变量**同时存在两个方向的会话侧记录（例如已有一条会话内授权，又用 `@` 菜单把同一变量登记了一次），列表仍只给一行——以附加方向那一行为准（后果见下一条 R5）。
  - **R5（质量门 r2 报出，0.4.0 已知限制：重叠场景会低估可用性）**：列表的既定边界是**一个变量只占一行**；当同一变量**既有一条人工附加记录（`staged` / `bound`）又有一份经 `secret_request` 的活跃会话授权**时（复现两步：先把某变量附上但不发送 → 再对同名变量 `secret_request` 并批准），附加行先入行、`requestViews` 随即跳过该变量，于是列表只回 `{state:'staged', origin:'attach', source:'session'}` 这一行——**这枚变量其实已被授权、也可注入**，而问方向的授权只在本会话**历史**（`authorized` / 来源 `request`）里可见。影响范围**仅**是人类管理列表在重叠场景下**低估可用性、方向不完整**：它**不泄漏任何值**、**不误报可执行动作**（该行的 `can.*` 仍为真，`unbind` 仍能撤掉本会话的暴露），**安全不变量与权限边界未受影响**（口径由 `manageList` 的 `seen` 去重决定，发布后如需让一行同时承载两个方向，单独立项再改，0.4.0 不返工）。
  - **记录键可能撞名**：记录键由 name 推导，`recordKeyId` 把 `_` 换成 `-`，所以 `a_b` 与 `a-b` 指向同一条记录键；真删按记录键寻址，撞键时删掉的是同一条。
  - **历史里 `deleted` 行的 `scope` 字段记的是「被删掉那条的作用域」**（`persistent`），不是"现在还剩什么"；会话里那份的当前作用域以管理列表为准（`session`）。
- **0.4.3 修的两个标识符字段：机械断言已就位，浏览器侧仍需真人确认**（如实标注）：凭据键与标题自 0.4.3 起改用 `autocomplete="off"`（Chrome 团队文档给出的"值每次都不同、不可复用"字段的取值）、去掉稳定 `id`/`name`、改成隐式 label 关联 + 同文本 `aria-label`，并同样带只读直到聚焦的守卫；机械断言钉住这一整套（正对照证明修复前形态下必然失败）。**未经真人浏览器验证**的部分：① Chrome/Edge/Firefox/Safari 在这两个字段上是否**真的不再**给历史值/自动填充下拉（`autocomplete="off"` 与"去掉 `id`"都是**提示级**手段，MDN 明写"该属性是给浏览器的提示；有些浏览器可能不遵守"）；② 已装的 1Password / LastPass / Bitwarden（opt-in）/ Dashlane / Proton Pass 是否确实不再捕获这两个字段；③ 隐式 label 关联在现场的辅助技术（屏幕阅读器、语音控制）下是否与原先的显式 `for`/`id` 等效（MDN 提醒并非所有辅助技术都实现隐式关联；`aria-label` 是为此准备的显式可访问名）。以上 3 项在无浏览器控制与未安装这些扩展时均为**需真人确认**，本 README 不把它们写成已验证。**依据归属（勿混读）**：有文档支撑的是**浏览器键控行为**（web.dev 逐字：浏览器按 `name`，有些还看 `id`，对一次性/不可复用值推荐 `autocomplete="off"`）与**五个厂商忽略标记**（1Password 官方；Bitwarden / Dashlane / Proton 自家源码；LastPass 支持页级）；而**"去掉稳定 `id`"是本插件自己的设计选择，不是厂商文档的推荐做法**——1Password 官方文档的原意相反，它建议给字段加唯一 `id`/`name` 以便识别。
- **密钥输入控件不会被自动填充/被密码管理器捕获，但"现场是否还弹提示"只能真人确认**（0.4.2 修复，如实标注）：代码层面已加齐抑制属性与只读守卫（见「安全不变量」第 7 条）并由两个 Client 测试机械钉住，**未经真人浏览器验证**的部分是：① Chrome/Edge/Firefox/Safari 在四个密钥字段上是否**完全不再**给自动填充建议；② Chromium 在 `autocomplete="new-password"` 字段上可能出现的"生成强密码"建议是否出现、是否可忽略（它不会回填已保存的凭据，也不读取字段）；③ 是否还会弹"保存密码？"气泡；④ 1Password / LastPass / Bitwarden / Dashlane / Proton Pass 扩展在现场是否确实**不再**捕获或提供保存（各厂商忽略标记的实际效力只能在其真实扩展上验；其中 Bitwarden 的忽略还是 **opt-in**，LastPass 那条只有支持页标题级引用）；⑤ **只读直到聚焦的守卫在现场是否有代价**——辅助技术可能把 `readOnly` 字段读成"只读"、iOS 上 `readOnly` 可能压住软键盘（需要二次点按）、`disabled` 的字段永不释放、以及守卫目前只在 props 层被断言（真实 DOM 重渲染下是否稳定释放未验），因此"**聚焦之后能正常键入**"必须由真人确认。以上 5 项在无浏览器控制与未安装这些扩展时均为**需真人确认**，本 README 不把它们写成已验证。
- **只读直到聚焦的守卫自身有代价（0.4.2 新增；0.4.3 起也覆盖两个标识符字段）**：四个密钥字段与两个标识符字段默认以 `readOnly` 渲染，聚焦时才由 `onFocus` 释放。已知代价：① 辅助技术（屏幕阅读器）可能把它读成只读字段；② iOS Safari 等平台上 `readOnly` 可能阻止软键盘自动弹出，需要用户二次点按；③ 若字段处于 `disabled` 状态则永不释放（本插件在不应输入的场合才这么做）；④ 该守卫目前只有 props 层断言（正对照证明修复前缺失），**真实 DOM 重渲染下是否每次都释放未验证**——属需真人确认项（见上一条 ⑤）。这是为防自动填充付出的可用性代价，如实记录，不粉饰。
- **0.3.0 新增的"需真人确认"清单（如实标注，未验证即写"未验证"）**：① **旁挂胶囊确实渲染在用户气泡之后**（含四档"工作步骤展示"下的实际位置与视觉贴合）；② **点旁挂胶囊**打开的是输入框上方的信息框；③ **点原胶囊**打开的是右侧栏详情页（且**不再是**"文件不存在"），以及页面顶栏右栏行为符合预期；④ **原胶囊接管的可争用性**在现场的表现（装/卸 `dsh-better-sidebar`，或临时注册一个更长的同档 pattern，观察是否被静默抢走）；⑤ **移除即撤销**的真实时序（删掉 → 约 0.6s 后 `GET /api/secret.attached` 不再是 `staged`；删掉后 600ms 内插回 ⇒ 记录仍在；**发送不得触发撤销**）；⑥ **历史区**在刷新后仍在、宿主重启/插件重载后清空、重放/分叉会话不重建；⑦ **`@` 菜单**两类来源的 `section`/`description` 文案在实际宽度下不被截断，且凭据库条目的确认→登记→插入链路真的能取到值。以上 7 项在无浏览器控制时均为**需真人确认**，本 README 不把它们写成已验证。

## 开发

```sh
npm run typecheck   # tsc：Host 半（Node）+ Client 半（DOM），erasableSyntaxOnly，兼容 Node 原生类型剥离
npm test            # node --test 八个文件：
                    #   test/unit.test.ts         参数校验、变量名推导、decision 映射、session/persistent 路由、
                    #                             四类返回都不含值、锚点撤销、fork 不继承、压缩不误撤销（含真实表面折叠）、
                    #                             子代理失败关闭、超时、O1（已答复但落库失败 ⇒ 降级 session 并如实回报）、
                    #                             O2（persistent 超时 ⇒ TIMEOUT）、presentationMeta 四种决策都不含值、
                    #                             env contributor 注入与撤销、adapters 端口映射
                    #   test/register.test.ts      用真实 apply + 假 Context 走完整链路：工具/路由/session-disposed 注册、
                    #                             Config 校验、tool→卡片→shellEnv 的值交付、回退与会话结束后的取回消失、
                    #                             persistent 经 authorization seam 落库且标记不含值、409 冲突、
                    #                             0.4.0 管理面（一个工具/一条路由两种方法/五条路径/降级两按钮/真删两档）、
                    #                             管理列表两个方向（`origin`：人工附加 + Agent 索要）与委派子代理的可达性注意
                    #   test/real-connection.test.ts 挂**真实** `@deepseek-ai/dsh-client-connection` 的
                    #                             `HostConnectionService` + 真实 cordis Context + 真实 `apply()`：
                    #                             断言 fiber `ACTIVE`（不是 `FAILED`）、真实注册表的 9 条精确路径各注册
                    #                             一次、`/api/secret.manage` 单次注册同时拥有 GET+POST、两个工具的
                    #                             schema 都在；并带正对照——同一精确路径二次注册时真实注册表抛出
                    #                             现场同一条 `exact Fetch route ... is already registered`。
                    #                             （0.4.0 的发布级缺陷正是从这里漏过去的：其余用例用的是假注册表，
                    #                             它不实施「精确路径唯一」，而且曾把两次注册钉成期望值。）
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
                    #                             （L1 chip / L3 文本 / 无 sessions 时降级）、明文不越出掩码输入；
                    #                             0.3.0 起还覆盖：旁挂节点定义的 match/buildViewNode 与其 key 的
                    #                             排序性质、`@` 菜单候选的两类来源与描述、凭据库条目的确认分支、
                    #                             历史读取器的防御式校验、撤销判定 `decideWithdraw` 的真值表；
                    #                             Host 侧的历史存储/三条新路由/release 的 reason 由上述 Host 用例覆盖；
                    #                             0.4.0 第二轮补：管理列表两方向的读取器/渲染与 `origin` 文案
                    #   test/history.test.ts       0.4.0 补上的关键缺口：**没有任何 Host 侧测试断言 HistoryStore 的写入点**
                    #                             之前是真的。四类新事件（updated / scope-changed / unbound / deleted）
                    #                             各由驱动它的 service 方法产生，再断言事件、来源（manage）、作用域与有界环形缓冲；
                    #                             并断言每条记录都值无关（细节扫描 0 命中）
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

**registry 现状（截至本文）**：npmjs 上已上线 `0.0.0-stage`、`0.1.0`、`0.2.0`、`0.2.1`、`0.3.0`、`0.4.1`、`0.4.2`（`dist-tags.latest = 0.4.2`，2026-10-08T12:09:17Z 上线）。三个 0.4.x 的 stage 队列历史与**现状**逐个写清，避免批错版本：`0.4.0` 的 stage id `dd9ef8e8-866b-498d-a8f5-8ee33e32f62f`（shasum `22dfadfc613695018adfd5ee09eb8b71b1ba9edc`）**从未被批准、从未上线**（该制品有启动缺陷，见「0.4.0 的发布级缺陷与 0.4.1 修复」），建议显式丢弃：`npm stage reject dd9ef8e8-866b-498d-a8f5-8ee33e32f62f`；`0.4.1` 的 stage id `22abf7a3-606b-4ee4-a1f9-5e84b557d6d0`（shasum `9b64a832abad45123ec96b3c2eec398c4b7377dd`，provenance `logIndex=3142251804`）**已由用户 2FA 批准上线**（2026-10-08T09:30:00Z），现已被 0.4.2 取代；`0.4.2` 的 stage id `a4056fb7-0a1a-4740-91d3-856665498b5e`（shasum `60e61cc5395e2f279a8b9a0a769165ecf4b3c403`、integrity `sha512-S34f977fgdNiR…HDV7DobbX5K8A==`、provenance `logIndex=3146400254`；由 tag `v0.4.2` 推送触发：Release run `37764853236` / Publish run `37764853223`，tag 对象 `b5a20422edde9b3951ba433945c72c9a430c3e0f`（GitHub 显示 verified），Release <https://github.com/xinvxueyuan/cordis-plugin-secret/releases/tag/v0.4.2>）**已由用户 2FA 批准上线**（2026-10-08T12:09:17Z），即当前的 `dist-tags.latest`——**此刻队列里没有任何待批准的版本**（已上线的版本不能再 `npm stage reject`）。本机 npm CLI 12.2.0 的 `npm stage` 确实有 `reject` 子命令，帮助文本：「Reject a staged package, removing it from the registry」，可用 `--otp <otp>`——**批准与丢弃都需要登录 + 2FA，只能由人来做**；本发布流程不登录 npm、不读取或处理任何用户令牌、不代做任何需要 2FA 的动作。GitHub Packages 上 `0.1.0`/`0.2.0`/`0.2.1`/`0.3.0`/`0.4.1`/`0.4.2` 都在（`0.4.2` 的包版本 id `1355352850`；`0.4.1` 的是 `1354170442`；上一个可用版本 `0.3.0` 的是 `1346087280`），另有**不可用**的 `0.4.0`（包版本 id `1351737947`）——GitHub Packages 由 CI 直接发布、不经人工批准，所以撤不回，只能靠 Release notes 的警告与本文说明。

同一份包也会发布到 **GitHub Packages**（`npm.pkg.github.com`，`github-packages` job，用内置 `GITHUB_TOKEN`），
使包在仓库页面上可见、可被 `@xinvxueyuan:registry=https://npm.pkg.github.com` 的消费者安装。

`publish.yml` 的两个发布 job 在日志里都打印了同一份包的 `shasum`（sha1）与 `integrity`（sha512）；
对 Release 的 tgz 逐字节计算，得到的正是同一对值，所以 npm stage 队列里与 GitHub Packages 上的那份，就是 Release 的那份字节
（未做的一步是：从 `npm.pkg.github.com` 下载回来再逐字节比对——那需要认证，本文没有做，如实标注）：

- `0.4.0`：`shasum 22dfadfc613695018adfd5ee09eb8b71b1ba9edc`、`integrity sha512-N2aBH5qpKPZPl…==` ↔ Release tgz 260287 B、sha256 `4612be9c…`；
- `0.4.1`：`shasum 9b64a832abad45123ec96b3c2eec398c4b7377dd`、`integrity sha512-yyBWKC1zH6vHZ…==` ↔ Release tgz 262988 B、sha256 `46286a2e…`。

### 0.4.0 的发布级缺陷与 0.4.1 修复（如实）

**缺陷（0.4.0 在真实运行时不可用）**：`/api/secret.manage` 被**注册了两次**（GET 一次、POST 一次），而真实的 connection 注册表按**精确路径**建名、与 `methods` 无关（`@deepseek-ai/dsh-client-connection/lib/index.js:625-639`，抛错在 `:633`）。第二次注册在**装配时**抛
`connection: exact Fetch route "/api/secret.manage" is already registered`；失败的 fiber 连同它的 effects 一起被回滚，于是**整个插件条目不激活**（`dsh: warning: 1 entry did not activate`）：两个工具都不注册、九条路由都不在，管理面在实机上完全不可用。**根因一句话**：把设计文档里「两条新路由（GET/POST 同路径）」按字面实现成了两次 `register()`。

**为什么三道质量门没抓到**：它们的 harness 用的是自造 connection 假注册表，假表**不实施「精确路径唯一」规则**；`test/register.test.ts` 里那条 `assert.deepEqual(registered, …)` 甚至把「两次注册」当作期望值钉住了。

**修复（0.4.1）**：`src/routes.ts` 合并为**一次注册**（`methods:['GET','POST']`，按 `request.method` 分派；GET/POST 两个分支的行为逐字不变），并新增**实施真实注册表规则的严格注册表**与两条回归用例——它在修复前的形态上以**同一条错误**失败（实测留存），修复后通过；那条钉住重复注册的断言按事实更新为 9 条精确路径（只有 manage 两行合并成一行）。产物层的对照：0.4.0 的 `lib/routes.js` 里 `fetch.register(` 10 次、`path: MANAGE_PATH` 2 次、manage 分别是 `methods:['GET']` 与 `methods:['POST']`；0.4.1 是 9 次、1 次、`methods:['GET','POST']` 一行。

**已发布但不可用的制品范围（如实）**：

- **GitHub Release 上 `v0.4.0` 存在**：tag 对象 `05942e0bba94b717b61cb0896ddf74eb2025dc9f` → commit `26bd420`，三附件（tgz 260287 B sha256 `4612be9c…`、`SHA256SUMS`、`SHA256SUMS.asc`）**保持原样未动**；Release notes 顶部已加警告并指向 0.4.1（未改 tag、未改附件）。
- **GitHub Packages 上 `0.4.0` 存在**（包版本 id `1351737947`），且**撤不回**——那里由 CI 直接发布、不经人工批准。
- **npmjs 上 0.4.0 从未上线**：它只进过 stage 队列（`dd9ef8e8-…`）且未经 2FA 批准；建议显式 `npm stage reject`（见上一节），或至少不要批准它。
- 因此任何消费者都应使用 **0.4.1**；已经在跑 0.4.0 的环境（插件条目不激活、管理面不可用）**重启 `dsh web` 到 0.4.1** 即恢复。

### GitHub Release 与签名

> **已发生的事实**：`v0.4.1` 的 Release 是 https://github.com/xinvxueyuan/cordis-plugin-secret/releases/tag/v0.4.1
> （2026-10-08 发布，`draft: false`；`release.yml` 运行 `37735146290` 成功，`publish.yml` 运行 `37735146256` 成功），附件三件：`xinvxueyuan-cordis-plugin-secret-0.4.1.tgz`（262988 B，sha256 `46286a2eefebb0809696377ebfecf7569c8aa723287cbe7a8e2c7bee979a76f8`，与 `SHA256SUMS` 里记的一致，也与本机 `core.autocrlf=false` 干净克隆里 `npm pack` 的产物逐字节一致）、`SHA256SUMS`（109 B，sha256 `ddd3b78232803958fefd699bf7488d208db97462a8985eef891a766598f643dd`）、`SHA256SUMS.asc`（887 B，sha256 `3ded718895f81d5b03b8b6a1037f2b1138d87d10dd9f58523b88a67bc3934ec1`；RSA 4096 `6C6FD9B2…72B7B35A` 对 **CI 那份 `SHA256SUMS`** 的分离签名，本机 `gpg --verify` 通过）；
> tgz 与 SHA256SUMS 都由 `gh attestation verify` 可验（一份 attestation，subject 同时列出两者），且**证明绑定在 tag 上**（builder id / 签名证书 SAN = `.../release.yml@refs/tags/v0.4.1`，`externalParameters.workflow.ref` = `refs/tags/v0.4.1`，`resolvedDependencies` = `git+https://github.com/xinvxueyuan/cordis-plugin-secret@refs/tags/v0.4.1` @ commit `744f5a675d3641cbf6a7dd0121e88b5fa333f4bf`）——即 tag→commit 是证明的一部分，而不是只绑定到 `refs/heads/main`（`--format json` 全文对 `refs/heads/` **零命中**）。tag 对象为 annotated + GPG 签名
> （`git cat-file -t v0.4.1` → `tag`，tag 对象 sha `43da6f8a85797be40356691db38079de50fa0844`；GitHub API 的 `verification.verified` → `true`，`reason` → `valid`，`verified_at` → `2026-10-08T06:00:40Z`）。
> 上一个版本 `v0.4.0` 的 Release 是 https://github.com/xinvxueyuan/cordis-plugin-secret/releases/tag/v0.4.0 **（该版本在真实运行时不可用，Release notes 顶部已加警告，见上一节；tag 与附件未动）**
> （2026-10-07 发布，`draft: false`；`release.yml` 运行 `37661019203` 成功，`publish.yml` 运行 `37661018704` 成功），附件三件：`xinvxueyuan-cordis-plugin-secret-0.4.0.tgz`（260287 B，sha256 `4612be9c9c8ed9475d236693c32d3d473bad2803aeea2ff55f027da9f677c7e8`，与 `SHA256SUMS` 里记的一致）、`SHA256SUMS`（109 B，sha256 `f54b947346dd196ed6aa48dead4721c828b81d611b073f82548132d311d3e3be`）、`SHA256SUMS.asc`（887 B，sha256 `239251f88159500f6af917c41138b4a83e6aa42c307e98e6e8cbdc86dba4bb13`；RSA 4096 `6C6FD9B2…72B7B35A` 对 **CI 那份 `SHA256SUMS`** 的分离签名，本机 `gpg --verify` 通过）；
> tgz 与 SHA256SUMS 都由 `gh attestation verify` 可验（一份 attestation，subject 同时列出两者），且**证明绑定在 tag 上**（builder id / 签名证书 SAN = `.../release.yml@refs/tags/v0.4.0`，`externalParameters.workflow.ref` = `refs/tags/v0.4.0`，`resolvedDependencies` = `git+https://github.com/xinvxueyuan/cordis-plugin-secret@refs/tags/v0.4.0` @ commit `26bd420e40bd242d6096478fce50ff0fbdb84655`）——即 tag→commit 是证明的一部分，而不是只绑定到 `refs/heads/main`（`--format json` 全文对 `refs/heads/` **零命中**）。tag 对象为 annotated + GPG 签名
> （`git cat-file -t v0.4.0` → `tag`，tag 对象 sha `05942e0bba94b717b61cb0896ddf74eb2025dc9f`；GitHub API 的 `verification.verified` → `true`，`reason` → `valid`，`verified_at` → `2026-10-07T17:42:58Z`）。
> 上一个版本 `v0.3.0` 的 Release 是 https://github.com/xinvxueyuan/cordis-plugin-secret/releases/tag/v0.3.0
> （2026-10-06 发布，`draft: false`），附件三件：`xinvxueyuan-cordis-plugin-secret-0.3.0.tgz`（196451 B，sha256 `1dc16de16dfd9e75cacc90330b78c4ba9f56973a970fb5cef9f4695f0cbb844e`）、`SHA256SUMS`、`SHA256SUMS.asc`；
> tgz 与 SHA256SUMS 都由 `gh attestation verify` 可验（一份 attestation，subject 同时列出两者），且**证明绑定在 tag 上**（builder id / 签名证书 SAN = `.../release.yml@refs/tags/v0.3.0`，`externalParameters.workflow.ref` = `refs/tags/v0.3.0`，`resolvedDependencies` = `git+https://github.com/xinvxueyuan/cordis-plugin-secret@refs/tags/v0.3.0` @ commit `7df8c048f678d163a26ee44c52133f8b458c0f7b`）——即 tag→commit 是证明的一部分，而不是只绑定到 `refs/heads/main`（`--format json` 全文对 `refs/heads/` **零命中**）。tag 对象为 annotated + GPG 签名
> （`git cat-file -t v0.3.0` → `tag`，tag 对象 sha `fc7bf1b89b21caca70a8be514203e9f3bb5fe50e`；GitHub API 的 `verification.verified` → `true`，`reason` → `valid`）。
> 上一个版本 `v0.2.1` 的 Release（https://github.com/xinvxueyuan/cordis-plugin-secret/releases/tag/v0.2.1 ）同样是同形三附件（tgz sha256 `55076023121254ba1a12c3718d4d2f6c3d03c64eb2667920fc19036e270b7edd`，tag 对象 `bf43e3f76e905f9adfaa904383b8c24ca2d589a0`），再上一个 `v0.2.0`（https://github.com/xinvxueyuan/cordis-plugin-secret/releases/tag/v0.2.0 ）亦然；
> `v0.2.0` 的功能缺陷与 `v0.2.1` 的修复见「人类主动附加密钥（反方向）→ 0.2.0 的缺陷与本版修复（0.2.1）」，`v0.3.0` 的四项增强见「0.3.0 的四项增强」。
> 下表是**这些版本确实按之执行**的机制，不是"将来会做"的计划。

| 环节 | 机制 |
| --- | --- |
| tag | **annotated 且 GPG 签名**的 tag（`git tag -s`），GitHub 上显示 **Verified** 徽标。tag 由维护者在本机用私钥创建并推送，**私钥永不进入 CI**。 |
| Release 附件 | `.github/workflows/release.yml` 在 tag 推送（或手动 `workflow_dispatch` 指定 tag）时执行 `npm pack`，把产出的 `*.tgz` 与 `SHA256SUMS` 上传为 Release 附件。Release 标题即 tag，正文由 `gh release create --generate-notes` 依据 commit 列表自动生成。 |
| 校验和 | `SHA256SUMS` 记录该 tgz 的 sha256（工作流内以 `sha256sum -c` 自校验）。 |
| 校验和的分离签名 | 维护者在本机用**私钥**对 `SHA256SUMS` 生成分离签名 `SHA256SUMS.asc`（`gpg --armor --detach-sign SHA256SUMS`），再手工把 `.asc` 附到 Release 上。**这一步目前没有自动化**，私钥也不进 CI；校验方用 `gpg --verify` 验签。 |
| 构建来源证明 | `release.yml` 调用 `actions/attest-build-provenance`（pin 到 commit SHA），为 **tgz 与 SHA256SUMS 两者**生成 Sigstore 签名的 SLSA 构建来源证明，可用 `gh attestation verify` 校验。 |
| npm 侧 | `release.yml` **完全不执行任何 npm publish**；npm 发布只由上面的 `publish.yml` staged publishing 负责。 |

维护者操作顺序（`v0.2.0`、`v0.2.1`、`v0.3.0`、`v0.4.0` 与 `v0.4.1` 都已按此执行）：

```sh
# 1) 本机确认工作区干净、package.json 的 version 已就位（版本号由发布者手工提升）
git status --porcelain

# 2) 创建 annotated + GPG 签名 tag（私钥仅在本机使用；本机需能完成 GPG 签名）
git tag -s v0.4.1 -m "v0.4.1"

# 3) 只推 tag —— release.yml 会构建产物、生成来源证明并创建 Release（不要用 workflow_dispatch：那样证明会绑到 refs/heads/main）
git push origin v0.4.1

# 4) 取 Release 上 CI 生成的那份 SHA256SUMS，做分离签名并附回 Release（私钥不进 CI）
gh release download v0.4.1 --pattern SHA256SUMS --clobber
gpg --armor --detach-sign SHA256SUMS          # 生成 SHA256SUMS.asc
gh release upload v0.4.1 SHA256SUMS.asc --clobber
```

> **为什么第 4 步要下 CI 的 `SHA256SUMS` 而不是签本机 `npm pack` 那份**：本机是 Windows 且 `core.autocrlf=true`，工作树里 `LICENSE-MIT`/`LICENSE-APACHE` 被 checkout 成 CRLF，本机打出的 tgz 与 CI（Linux checkout，LF）打出的只差这两个文件的行尾——`0.4.0`：本机 260311 B / `0a6fd66c…` 对 CI 260287 B / `4612be9c…`；`0.4.1`：本机 263015 B / `4b3c3a7d…` 对 CI 262988 B / `46286a2e…`。在 `core.autocrlf=false` 的干净克隆里本机 `npm pack` 复现出的正是 CI 的那份（`docs/` 之类不进包，`lib/**` 与 `src/**` 逐字节相同）。签错那份会让 `gpg --verify SHA256SUMS.asc SHA256SUMS` 在下载来的附件上对不上。

校验方式：

```sh
# 校验附件未被篡改
sha256sum -c SHA256SUMS

# 校验分离签名（需要维护者的公钥）
gpg --verify SHA256SUMS.asc SHA256SUMS

# 校验构建来源证明（需要 gh CLI）
gh attestation verify xinvxueyuan-cordis-plugin-secret-0.4.1.tgz --repo xinvxueyuan/cordis-plugin-secret
gh attestation verify SHA256SUMS --repo xinvxueyuan/cordis-plugin-secret
gh attestation verify xinvxueyuan-cordis-plugin-secret-0.4.1.tgz --repo xinvxueyuan/cordis-plugin-secret --format json   # 查 externalParameters.workflow.ref 是否为 refs/tags/v0.4.1
```

补充说明：

- `release.yml` 使用 `gh release create --verify-tag`，**要求 tag 已存在、不会自行创建 tag**；重复运行会转为"覆盖上传附件"。
- 所有 workflow 的 `uses:` 都 pin 到完整 40 位 commit SHA（当前：`actions/checkout` v4.4.0、`actions/setup-node` v4.4.0、`actions/attest-build-provenance` v4.2.2），由 `.github/dependabot.yml` 的 `github-actions` 生态负责推进。

## 许可

本仓库采用 **MIT OR Apache-2.0** 双许可（与 `package.json` 的 `license` 字段一致），
许可证原文见 [LICENSE-MIT](LICENSE-MIT) 与 [LICENSE-APACHE](LICENSE-APACHE)。
