# cordis-plugin-secret

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE-MIT)

Cordis（DeepSeek Harness）插件：**让 Agent 向人类索取密钥（secret），批准后只拿到一个不透明的变量名，明文永不进入模型上下文。**

- Host 半：注册 `secret_request` 工具；用 `ctx.authorization` 的凭据获取流程承载持久授权；用 `ctx.credentials` 落库；用 `ctx.shellEnv` 按会话注入 `DSH_SECRET_*`。
- Client 半：在 Web UI 的 `shell.overlay` 槽里渲染一个遮罩式密钥输入对话框（`type="password"` + 显示/隐藏切换），把「同意 / 拒绝 / 忽略 / 其他」四个决定、申请理由、用途说明与**授权范围**摆在人类眼前，并允许人类**改写 Agent 请求的范围**。
- 传输：对话框经本插件自有的、位于 `ctx.connection` 信任栅栏内的两个 `/api` 路由与 Host 通信。密钥值只出现在 `POST /api/secret.answer` 的请求体里，从不进入 URL / 查询串 / 会话日志。

## 安全不变量（实现并测试）

1. **明文永不进入模型上下文**：工具结果、错误消息、日志、事件、渲染文本中都不含密钥值；`render()` 只输出变量名与元数据。单测对四种 decision 的所有字段做全量字符串扫描，断言值不出现。
2. **Agent 只拿到变量名**：`approved` 返回 `{ decision, variable, scope, ref, source }`，`variable` 形如 `DSH_SECRET_OPENAI`。
3. **值只发给本机 Host**：客户端只向 `/api/secret.answer` 发起同源 POST（签名 HttpOnly Cookie + Host/Origin 栅栏），不写 URL、不写 localStorage、不打印 console。
4. **会话级密钥不落盘**：`scope: "session"` 的值只存在于进程内存（Host 的会话授权表）。落盘只走凭据服务，且只发生在 `persistent`。
5. **持久化只经凭据服务**：`persistent` 经 `ctx.credentials.set(<变量名>, value)` 写入凭据引用空间（provider 管理的可写源）；同时向记录空间提交一条**不含密钥材料**的授权标记记录（`kind: "grant"`，payload 只有 `envVar/name/scope/authorizedAt`）。绝不写自建文件，绝不在仓库里存明文。
6. **会话边界失败关闭**（见「边界处理」）：锚点离开会话表面即撤销并不再注入。

## 安装

```sh
# 在已加载的 Harness 中（危险全权限）
plugin_manager action=install_bundle target=<本包绝对路径>
```

`install_bundle` 会把本包装进当前 profile、把 `dsh.bundle.patch`（本包的 `cordis.patch.yml`）里的一行插入 profile 的 `cordis.patch.yml`，并在 Host 端热加载。安装结果里的 `application` 必须为 `applied` 才算生效；`warnings` 会说明客户端半是否需要刷新页面。

插入的行是：

```yaml
- insert:
    - id: secret
      name: '@xinvxueyuan/cordis-plugin-secret'
      config:
        requestTimeoutMs: 300000
        maxPendingRequests: 4
```

来源构建：`npm install && npm run build`（`lib/` 是 loader 与浏览器实际加载的产物；`src/` 为 TypeScript 源码）。

## 工具 `secret_request`

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
`source` = `store`（凭据库里已有的值）或 `entered`（本次人工输入）。`notice` 是附加诊断（例如"上一次授权已随会话回退失效"），永不含密钥。

失败（抛错，作为工具错误结果返回，同样不含密钥）：`BAD_REQUEST`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`、`NO_SESSION`、`NO_ANCHOR`、`TOO_MANY_PENDING`、`TIMEOUT`、`AUTHORIZATION_FAILED`、`AUTHORIZATION_CANCELLED`、`STORE_EMPTY`。

## 授权对话框（Client 半）

插槽：`shell.overlay`（root 作用域的 list 槽，可叠加、默认点击穿透，本条目自行开启 pointer events），`id = secret.request.dialog`。

对话框内容，自上而下：

1. 标题 + `label`；
2. **对外暴露的变量名**；
3. **申请理由**（原样展示，带"申请理由（原样展示给你）"标注）；
4. `description`（如有）；
5. **授权范围**：先用加粗文字写明"仅本次会话有效"或"持久保存到凭据库"及各自含义，再显示"Agent 请求的范围：…"，若人类改动则追加一行"你已把范围改为：…"，然后是 `session` / `persistent` 单选；
6. 密钥值输入（`type="password"`、`autoComplete="new-password"`、`spellCheck=false`、自动聚焦）+「显示 / 隐藏」切换；**若该凭据已存在于凭据库则不显示输入框**，只显示"已配置，本次仅需决定是否授权本次使用"；
7. 四个决定：**同意 / 拒绝 / 忽略 / 其他**（`其他` 切换出自由文本域 + 提交按钮 + 返回）；`Esc` = 忽略；按钮带 title 说明拒绝与忽略的后果；
8. 提交失败（如凭据存储只读）就地红字显示并保持对话框打开。

样式只用主题 token（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-shadow-*`、`--dsw-font-*`），不 import 任何 Harness Client 包，浅色/深色主题都跟随 Host。

## 存储与传播

- `persistent`：值写入凭据**引用空间**（`ctx.credentials.set(<变量名>, value)`）→ 可被其他工具按凭据引用解析；再提交一条 `cordis-plugin-secret/<name>` 的 `grant` 记录作为授权标记（不含值）。
- `session`：值只进 Host 内存中的会话授权表。
- 传播：`ctx.shellEnv.register` 为每个变量名声明一个 contributor，`resolve(execution)` 每次 shell 执行都**重新校验该执行的会话是否仍持有有效授权**，有效才返回该变量的值（`shellEnv` 每次执行重建命名空间，因此天然按会话隔离）。
- 授权表是"派生缓存"：真相在会话日志（锚点事件）与凭据服务；每次读取都从**活的**会话表面重新推导有效性。

## 边界处理

| 情形 | 行为 |
| --- | --- |
| **会话回退 / 编辑重试（rewind / rewrite）** | 授权锚定在"发起该工具调用的那条 `assistant/message` 事件"的 seq 上（它本身就是会话表面节点）。用户编辑更早的消息并重试会让该事件被 `replace` 遮蔽、离开 `session.surface.nodes`；下一次解析授权（shellEnv 注入或凭据解析路径）发现锚点不在表面上，就**撤销**：不注入值、从会话授权表删除、把失败写进下一次 `secret_request` 的 `notice`。Agent 必须重新调用 `secret_request` 拿新授权。**绝不继续服务一个已被丢弃分支里的授权。** |
| **Fork** | 授权以 `SessionId` 为键。fork 出的子会话是新 id，看不到父会话的授权（`not-found`）；即便有人把父会话的授权表项种进子会话，`session.isOwnSeq(anchorSeq)` 对 fork 继承前缀返回 false，判定 `revoked-not-own` 并删除。子会话要自己重新授权。`persistent` 的值虽在凭据库里，但**"暴露给某会话"仍是逐会话授权**，子会话同样需要重新授权——只是此时值已在库中，无需人类重新输入（同样的"已配置"路径）。 |
| **压缩（compaction）** | 判定只看"锚点是否仍在当前表面"，不看 `replaceGeneration` 数值。压缩导致的 `replaceGeneration` 变化只要没有遮蔽锚点就**不撤销**；若某次压缩确实把锚点事件替换掉了，则按回退处理（撤销并要求重新授权，失败关闭）。 |
| **子代理 / 非活跃调用者** | 只有"注册表中活跃的会话根代理"拥有人类回答者。`ctx.agents.get(id)` 找不到该 agent → `CALLER_NOT_LIVE`；找到了但不在 `ctx.agents.roots()` 中（被委派）→ `DELEGATED_CALLER`。两种都在**创建任何对话框之前**抛出结构化失败，绝不挂起等待一个永远不会来的答复。 |
| **会话结束 / 进程退出** | `session/disposed` 时清空该会话的全部授权；插件卸载时中止所有等待中的对话框并撤下全部 `shellEnv` contributor；会话级值只存在于内存，进程退出即消失。 |
| **超时 / 调用被取消** | 超过 `requestTimeoutMs` 未获答复 → `TIMEOUT` 失败，不注入任何变量；调用方的 `AbortSignal` 中止 → 该次等待以中止失败结束。 |
| **同键并发** | 同一凭据键同时只允许一个授权尝试（凭据流程键 = `cordis-plugin-secret/<name>`）；第二个请求得到结构化失败而不是两个对话框。 |
| **凭据库只读 / 写失败** | 对话框收到 4xx/5xx 并就地显示原因、保持打开，人类可改用 `session` 范围或取消。 |

## 配置（Config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `requestTimeoutMs` | `300000` | 单个 `secret_request` 等待人工确认的上限（也是工具 `timeoutMs` 的基础，工具自身总在上层超时前返回）。 |
| `maxPendingRequests` | `4` | 同时等待人工确认的授权请求数上限，超出返回 `TOO_MANY_PENDING`。 |

## 实现细节与已知限制（如实记录）

- **`ctx.authorization` 只承载 `persistent`**：该 seam 的契约要求"本次尝试期间提交并观察到一条凭据记录"（否则 `NOT_COMMITTED`），而 `session` 授权按定义不得落盘。因此 `session` 请求走同一套对话框、但不进该 seam；`persistent` 请求完整走 `registerFlow` + `begin`。这是 seam 契约决定的取舍，不是省事。
- **Harness 不自带 `AuthorizationPrompt` 的 Web 渲染器**（已核验：安装包中没有任何 client 包渲染 `AuthorizationPrompt`），所以本插件自己的对话框就是该 prompt 的界面；流程内 `session.prompt({kind:'secret'})` 的值直接来自对话框已收集的答案。
- **`shellEnv` 的 resolver 是同步的**，而 `ctx.credentials.resolve` 是异步的：无法在每次 shell 执行时回源凭据库。因此授权通过时把值读入该会话的授权表（并在每次注入前做锚点/会话校验），凭据库仍是持久层的真相。轮换凭据后请重新调用 `secret_request` 刷新会话内副本。
- **客户端文案未接入 Client locale 服务**：本插件的可视文案集中在 `src/client/entry.ts` 的 `TEXT` 表里（本 profile 的 UI 语言为中文），未使用 `ctx.locale` 的命名空间注册；接入 locale 需要声明 `LocaleNamespaceMap` 并为所有内置语言提供完整词典，作为后续工作。
- **Client 半是"经典脚本"**：client module system 以 `<script>` 加载包的浏览器产物，产物唯一副作用是 `window.__ModuleLoader__.load` 注册工厂，因此 `src/client/entry.ts` 没有 import/export，单独用 `tsconfig.client.json` 编译（DOM lib），Host 半用 `tsconfig.json`（Node types）。
- **验证限制**：本插件的安装与注册由 `cordis_inspect_query` 的 Tool/Slots 证据覆盖；对话框的**视觉**（浅色/深色、布局、点击行为）只有在浏览器里有页面时才可能确认，无浏览器控制时不做渲染器/截图等替代验证。单测覆盖 Host 侧全部纯逻辑（不依赖 UI）。

## 开发

```sh
npm run typecheck   # tsc：Host 半（Node）+ Client 半（DOM），erasableSyntaxOnly，兼容 Node 原生类型剥离
npm test            # node --test：参数校验、变量名推导、decision 映射、session/persistent 路由、
                    # 四类返回都不含值、锚点撤销、fork 不继承、压缩不误撤销、子代理失败关闭、超时
npm run build       # 产出 lib/（Host 半 + 浏览器产物 ./client）
```

## 许可

MIT OR Apache-2.0（见 `LICENSE-MIT` / `LICENSE-APACHE`）。
