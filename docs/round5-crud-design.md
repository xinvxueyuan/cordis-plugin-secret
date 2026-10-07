# 定案：秘密的完整 CRUD（Agent 侧列举/解绑/改作用域 + 用户侧信息框管理）

- 任务：`t1`（设计定案）· 轮次：round 5 · 目标版本：`0.4.0`（`package.json` 的 version 由发布任务负责，本任务**不改**）
- 前置：`docs/round4-attach-enhancements-design.md`（0.3.0 附加方向四项增强）、`docs/round3-attach-secret-design.md`（0.2.0 附加方向）、`docs/round2-inline-card-design.md`（索要方向卡片）
- 基准运行版本：DSH `0.2.0-rc.2`（**本定案复核实测，唯一权威证据根** = `C:\Program Files\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`；下称 `$H`）。第四个证据根是本机凭据库文件 `C:\Users\admin\.dsh\.credentials.yaml`（下称 `$C`）。
- 本任务基线（**本轮实测，2026-10-07**）：`npm test` → `tests 90 / pass 90 / fail 0`；`npm run typecheck` → exit 0；`git status --porcelain` → 空；`git log -1` = `49c00b8 docs: record the v0.3.0 release facts in the README`。
- 安装现状（本轮实测）：profile `web` 以 `link:C:/dev/dsh/projects/cordis-plugin-secret` 指向本工作区（`C:\Users\admin\.dsh\profiles\web\package.json:9`、`:32`），所以 t2 改完 `src/` 后 `npm run build` + 重启 `dsh web` 即可生效，无需重新安装。
- 本文件是**只新增的文档**：不改任何 `src/` 代码、不改 `lib/`、不改 `test/`、不改 `package.json`。第 5 节给出 t2 的文件级改动点，第 9 节给出实施顺序，第 3.6 节给出遗留凭据的删除步骤。
- 取证口径：`src/*.ts` 逐个读；`src/client/entry.ts`（3906 行）**按题面要求只做定向 grep + 区间读**，本文所有客户端行号均为区间读所得。

> 体例沿用第三/四轮定案：**机制结论 + file:line 证据** → **定案形态与逐字契约** → **事件/状态机** → **文件级改动点** → **兜底阶梯** → **验证清单（区分「可机器证明」与「需真人确认」）** → **风险与未决（含需用户拍板项）**。

---

## 0. 结论摘要（每条指向第 2 节的证据行）

1. **（a）凭据库的删除能力：官方 API 存在，而且是两条，必须成对使用。** `@deepseek-ai/dsh-credentials` 的 `CredentialProvider` 抽象面共 9 个方法（`resolve`/`describe`/`set`/`unset`/`readRecord`/`describeRecord`/`listRecords`/`modifyRecord`/**`deleteRecord`**），删除能力落在**两个互不相交的键空间**上：`unset(ref)` 删「值」（`CredentialRef` = `DSH_SECRET_*` 环境变量名），`deleteRecord(key)` 删「记录」（`CredentialKey` = `cordis-plugin-secret/<id>`）。本插件现在只用了 5 个（`describe`/`resolve`/`set`/`commitRecord`→`modifyRecord`/`listRecords`/`readRecord`），**`unset`、`deleteRecord`、`describeRecord` 三个从未使用**（`src/adapters.ts:67-97`）。因此 0.4.0 的「真删」= `unset` + `deleteRecord` **各一次**，缺一个就留下半状态（§2.1）。
2. **（b）确认面：`persistent` 写值继续复用 `ctx.authorization` seam；而「解绑 / 真删 / 降级为仅本会话」**不可能**复用该 seam。** seam 的成功判据是「本次尝试期间提交过一条记录 **且** 该记录此刻仍存在」（`$H\dsh-authorization\lib\index.js:254-255`，原文含 *"deleted its credential record instead of committing one"*），删除动作必然撞上第二个判据。定案：新增一条**插件自己的管理确认面**（复用既有 `PENDING_PATH`/`ANSWER_PATH` 与 `PendingStore`，新增一个**管理卡** kind `sr-manage`），并对「需值」的动作继续走 seam（§2.2、§3.3）。
3. **（c）Agent 侧：新增工具 `secret_manage`，不扩 `secret_request`。** 决定性的机制理由有三条：①既有卡片定义 `secretRequestDefinition.match` 用 `data.name !== TOOL_NAME`（`'secret_request'`）做闸门（`src/client/entry.ts:667-669`），换名字就得不到卡片，本来就必须新增一个卡片定义；②卡片自己的只读 seam 键集被两条测试**逐字冻结**（`test/client-attach.test.ts:706-723`、`test/client-card.test.ts:467`），扩 `secret_request` 会逼着改冻结面；③`readOutcome` 只认 `meta.kind === 'secret-request'` 且必须带 `decision`（`src/client/entry.ts:392-414`），给同一次调用塞第二种语义会让这张卡的「已结算」判定失真。动作集合 = `list` / `unbind` / `delete` / `scope` / `value`，**参数里没有 `value` 这个字段**（Agent 没有任何提交值的通道：参数集不声明它，带 `value` 的调用由服务侧 `validateManage` 在参数层直接拒绝——工具参数根是隐式开放对象，**不能**把承重拒绝写成"schema 自身拒绝"，见 §8.3 的 F2 裁定），返回值只含变量名与元数据（§2.3、§3.2）。
4. **（d）改值的语义：按「目标」分两种，确认强度不同。** `target:'session'` 只改本会话内存里的那份值（不落盘、不进 seam）；`target:'store'` 改凭据库里的值并**重提标记记录**，因此必须走 seam（提交被观察到才算成功）。两者都不改变量名、不改锚点：`@DSH_SECRET_X` 在既发消息里仍然指同一个变量，会话回退仍照旧撤销该授权；历史追加一条 `updated`（追加式，过去那一行不删）（§2.4）。
5. **（e）信息框：在既有四态胶囊（idle/fill/confirm/detail/history）之上加三态，仍是**同一个**胶囊座位、同一套 `A.*` 类名与 `ATTACH_ZH/ATTACH_EN` 字典。** 新增 `manage`（管理列表：本会话可用 + 凭据库）、`edit`（掩码改值：`type='password'` + 显示/隐藏，沿用 `:3041-3072` 的手法）、`danger`（解绑/真删/降级的二次确认）。列表数据由**新的只读路由** `GET /api/secret.manage` 给出（每条带 Host 亲算的 `can.*`，客户端不自己推导「能不能删」）；`GET /api/secret.available` 的响应形状**逐字段冻结**，不动它（§2.5）。
6. **（f）历史：新增 4 类事件 + 1 个来源，**不**加宽历史条目的线上形状。** 新事件 `updated`/`scope-changed`/`unbound`/`deleted`，新来源 `'manage'`；方向（升/降级）由条目自身的 `scope` 字段（= 变更**之后**的有效作用域）如实表达，因此 `SecretHistoryEntry` 的字段集合一字不加（`test/client-attach.test.ts:964` 的逐键断言仍然成立）。保留语义照旧：纯进程内存，Host 重启 / 重放 / fork 都不重建（`src/history.ts:9-23`、`src/config.ts:22,32`），UI 用既有 `historyNotice` 字面说明（§2.6）。
7. **（g）遗留凭据的实名与两把钥匙（本轮实测，只读键名、未打印任何值）：** 条目**不叫** `selftest-persist`，实名是 `dsh-selftest-persist`：引用空间键 `DSH_SECRET_DSH_SELFTEST_PERSIST`（`$C:5`），记录空间键 `cordis-plugin-secret/dsh-selftest-persist`（`$C:22`），`kind: grant`，payload = `{version:1, envVar:DSH_SECRET_DSH_SELFTEST_PERSIST, name:dsh-selftest-persist, scope:persistent, authorizedAt:1791227618926}`（`$C:23-29`）。同文件里另有 3 条**别人的**记录（`client-connection/browser-session` `$C:7`、`deepseek-account-platform/device` `$C:12`、`deepseek-account-platform/default` `$C:16`），本插件的删除路径**永远只寻址自己的 `cordis-plugin-secret/` 前缀**。删除步骤与不可恢复性见 §3.6。
8. **不动的东西（回归护栏）**：附加链路（日志保留 `@` 形态 + 注记承担模型侧映射 + 绑定钩子）、`secret_request` 的工具 schema / 结果形状 / 卡片形状 / `presentationMeta`、`GET /api/secret.attached` 与 `GET /api/secret.history` 与 `GET /api/secret.available` 的响应字段集、作用域语义（`session` 不落盘）、值不变量 P1–P6 与「明文绝不允许出现」清单（README §安全不变量）、客户端 classic script（无 import/export）与 ambient `declare module` 手法、既有三处 slot 注册 + 一处右栏类型注册 + 一个引用源。

---

## 1. 范围与不变量

### 1.1 本轮只做（全部是加法）

1. **Agent 侧 Read**：新工具 `secret_manage` 的 `action:'list'` —— 列出调用者本会话可用的变量（本会话的人工附加 `staged`/`bound` **与 Agent 经 `secret_request` 获得的本会话授权 `authorized`**，两者以 `origin` 区分 + 凭据库持久条目），只给变量名与元数据。
2. **Agent 侧 Delete（两档）**：`action:'unbind'`（从本会话移除，仅影响本会话）与 `action:'delete'`（从凭据库删除记录，需人类确认），两者是**两个动作名**，没有 `delete` 加开关的写法。
3. **Agent 侧 Update（改作用域 / 改值）**：`action:'scope'`（`to:'persistent'|'session'`）与 `action:'value'`（`target:'session'|'store'`）；`value` 的值**只由人类在确认面输入**，工具 schema 里根本没有该字段。
4. **用户侧**：信息框内新增「管理」面（列表 = 本会话可用 + 凭据库）、「改值」面（掩码 + 显示/隐藏）、「危险确认」面（解绑 / 真删 / 降级），四类动作齐备，且都在**同一个胶囊**里完成。
5. **Host 侧支撑**：`CredentialsPort` 增 `unset`/`deleteRecord`/`describeRecord`；`GrantStore` 增「按变量解除单个授权」；`AttachStore` 增「原地改作用域」；`HistoryStore` 增 4 类事件与 1 个来源；新增只读路由 `GET /api/secret.manage` 与写路由 `POST /api/secret.manage`。

### 1.2 不做（明确排除）

- 不做「Agent 直接改值」的任何形态：工具参数没有 `value`，也不接受「把值放在 description/reason 里」这种变通（§3.2 用 schema 属性集与单测钉住）。
- 不做「一次性删除整个凭据库」「按前缀批量删除」「删除别人的 scope 记录」：删除只寻址本插件自己枚举出来的 `cordis-plugin-secret/<id>`（证据 `src/service.ts:650`、`src/naming.ts:7`）。
- 不做「凭据库值的迁移/导出/回显」：任何响应体、DOM、日志都不含值（P1–P6 不变）。
- 不改 `src/client/entry.ts` 的既有注册面（三处 slot + 一处右栏类型 + 一个引用源 + locale 命名空间 `secretAttach`），管理面复用同一胶囊。
- 不做「跨会话管理另一个会话的变量」：所有动作都以调用者/提交者自己的 `sessionId` 为范围。
- 不做 Host 重启后的历史重建；不做进程外（直接改 YAML）的删除路径（§3.6 里作为**人类手动兜底**如实写明，不是插件功能）。
- 不改 `package.json` 的 version，不改 `dsh.client.inject`（本轮不需要新客户端服务）。

### 1.3 不变量（第三/四轮口径继续有效，本轮增补 5 条）

**允许值存在的全部位置（穷举，仍是那 6 处，不多一个）：** P1 填值胶囊本地 state / P2 一次 `POST /api/secret.attach` **或本轮新增的 `POST /api/secret.manage`（`action:'value'`）** 请求体 / P3 Host `AttachStore` / P4 Host `GrantStore` / P5 仅当人类显式选择「持久」时写入的凭据库 / P6 `shellEnv` 在执行期注入子进程。

| # | 约束 | 判据 |
|---|---|---|
| N1 | **管理列表、Agent `list` 结果、管理卡的 pending 视图、`presentationMeta` 全部值无关** | 对每个新响应/新 SEAM 做 `JSON.stringify` 哨兵扫描，0 命中 |
| N2 | **Agent 任何路径都只拿到变量名**：`secret_manage` 的参数集与结果集里都没有值字段 | 断言工具 schema 的属性名集合 = `{action, variable, to, target, reason}`，结果对象键集白名单 |
| N3 | **改值只由人类输入**：值只出现在管理卡/信息框的掩码控件本地 state 与该次 `POST /api/secret.manage` 请求体 | 静态扫描：`value` 变量只出现在既有 P1/P2 位置；Host 侧 `SecretManageInput` 是唯一携带值的入参 |
| N4 | **影响持久状态的动作必须有明确的人类确认**：`unbind`/`delete`/`scope`/`value` 四个动作在 Host 侧都必须先经过「人类提交了该动作」的证据（Agent 路径 = 卡片的 approved 答复；用户路径 = 信息框的显式提交 + 危险动作的二次点击） | Host 侧单测：无 pending 答复 / 无 `confirm:true` 时，四个动作一律拒绝且**不发生任何持久写** |
| N5 | **两档删除不得混同**：`unbind` 永不触碰凭据库；`delete` 删除记录后必须如实降级会话侧作用域 | 单测断言 `unbind` 前后 `credentials.set/unset/deleteRecord` 调用次数为 0；`delete` 前后会话侧 grant 的 `scope` 变为 `session` |

### 1.4 版本与兼容

- 目标 `0.4.0`（由发布任务改 `package.json`；本任务不改）。
- **只加不改**：既有 90 条测试只增不减；`secret_request` 的一切（schema/description/结果/卡片/meta）不变；`GET /api/secret.available`、`GET /api/secret.attached`、`GET /api/secret.history` 的响应字段集冻结（因此列表用**新路由**而不是往既有路由挂字段）。
- `GET /api/secret.pending` 的响应**新增可选字段**（`action`/`target`/`expectValue`/`can`），旧客户端逐字段读、不认识的字段直接忽略（`src/client/entry.ts:436-463`），因此对 0.3.0 客户端仍兼容；新客户端对旧 Host 则看不到这些字段 → 管理卡退回「请求材料不可读」的诚实态（§6 C1）。
- 客户端仍是 classic script（无 import/export）。新面的纯函数与定义放进**第三个只读 seam** `globalThis.__cordisSecretManage`，两个既有 seam 的键集一字不改。

---

## 2. 机制结论与证据

### 2.1 （a）凭据库的读写能力边界：9 个方法，两个键空间

`$H\dsh-credentials\lib\types\index.d.ts` 的 `CredentialProvider`（抽象类，即 `ctx.credentials`）逐条：

| # | 方法 | 签名位置 | 语义（契约原文要点） |
|---|---|---|---|
| 1 | `resolve(ref)` | `:129` | 值 + 来源层，或 `undefined`；按次解析、不得跨操作缓存 |
| 2 | `describe(ref)` | `:136` | `{configured, source?, writable}`，**无值槽** |
| 3 | `set(ref, value)` | `:145` | 写入 provider 管理的可写源；**被只读源遮蔽时拒绝**；空值拒绝（改用 `unset`） |
| 4 | **`unset(ref)`** | `:152` | 从可写源移除一个引用；**移除不存在的引用是 no-op**；与 `set` 同样会被只读源遮蔽而拒绝 |
| 5 | `readRecord(key)` | `:159` | 读回整条记录（`GrantRecord.payload` 原样返回，seam 不解释） |
| 6 | `describeRecord(key)` | `:165` | `{configured, kind?, writable}`，无值槽 |
| 7 | `listRecords()` | `:174` | 枚举每条记录的**地址 + 判别式**，永不带 payload |
| 8 | `modifyRecord(key, mutate)` | `:186` | 唯一写记录路径；`mutate` 返回 `undefined` = **保持原样**（因此它**删不掉**记录） |
| 9 | **`deleteRecord(key)`** | `:191` | 移除一条记录；**移除不存在的记录是 no-op** |

两个键空间的定义与「为什么它们不能互相替代」：`$H\dsh-credentials\lib\types\types.d.ts:11-12`（`CredentialRef` = POSIX 环境变量名）、`:18-26`（`CredentialKey` = `<scope>/<id>`，`/` 让两个文法永不相交）；类的总述 `$H\dsh-credentials\lib\types\index.d.ts:103-118`：「ref 半边回答『这个环境变量名背后是什么』（可叠层：进程环境 / 托管存储 / `.env`）；key 半边回答『这个插件为这个 id 持有什么凭据』，**记录的存在本身就是全部事实**，`modifyRecord` 是唯一写路径」。

本机在用的实现是 `dsh-credentials-local`（文档 `$H\dsh-credentials-local\lib\index.js`）：

| # | 事实 | 证据 |
|---|---|---|
| L1 | 文档路径默认 `$DSH_HOME/.credentials.yaml` | `:49`（`CREDENTIALS_FILENAME`）、`:58`（`join(resolveDshHome(config.dshHome), '.credentials.yaml')`） |
| L2 | 启动与每次写入前都校验「只有属主可读」 | `:92-104`（`assertOwnerOnly`，非 600 直接拒绝启动并给出 `chmod 600` 提示） |
| L3 | `resolve` 的层序：启动环境（`source:'env'`）> 托管文档（`'file'`）> `.env`（`'project-env'`/`'user-env'`） | `:473-490` |
| L4 | `describe` 在层序命中的是启动环境时给 `writable:false` | `:491-511` |
| L5 | `set(ref,v)` → `write(ref,v)`；**空值抛错并提示改用 `unset`** | `:513-516` |
| L6 | `unset(ref)` → `write(ref, undefined)` | `:517-519` |
| L7 | `deleteRecord(key)`：锁内 reconcile → `renderRecord(text, key, undefined)` → 原子重写（0600）→ 从内存快照删除 → **`notifyRecordUpdated(key)`** | `:568-589`（`:578` 键不存在时直接 return，`:586` 发事件） |
| L8 | `modifyRecord(key, mutate)`：`mutate` 返回 `undefined` 时 `return current`（什么都不写） | `:541-566`（`:553`） |
| L9 | `write()` 在入口与排队后又各判一次「是否被启动环境遮蔽」，被遮蔽则抛错，文案是「由启动环境只读提供，请在你启动 dsh 的 shell 里 unset」 | `:604-629`、`:636-638`（`assertUnshadowed`） |
| L10 | 记录枚举只给 `{key, kind}` | `:535-539` |

本插件当前用法（**这是删除能力的现状缺口**）：`src/adapters.ts:67-97` 把 `ctx.credentials` 收窄成 `CredentialsPort`，只暴露 `describe`(`:70`)、`resolve`(`:71`)、`set`(`:72-74`)、`commitRecord`(`:75-78`，内部走 `modifyRecord`)、`listRecords`(`:84-85`)、`readRecord`(`:86-95`)；**`unset`、`deleteRecord`、`describeRecord` 一个都没接**。而「谁写进去的」在 `src/service.ts` 只有两处：附加方向 `:341-360`（`set` + `commitRecord`）与索要方向 `:854-875`（seam 内 `persist` → `set`，`commit` → `modifyRecord`）。

**结论（可机器证明）：**「从凭据库删除一条持久条目」不是一条 API 调用，而是**两条各一次**：

```
credentials.unset(envVar)            // 删「值」（refs 段，$C:5）
credentials.deleteRecord(recordKey)  // 删「记录」（records 段，$C:22）
```

顺序与半状态处置见 §3.4 R4。**风险（必须写清）**：`unset` 会被启动环境遮蔽而失败（L4/L9），此时**值仍在**（`describe().source==='env'`、`writable:false`）；而 `deleteRecord` 不受遮蔽影响（记录空间没有叠层，L7）。两者的失败模式不对称，所以定案选择 **先 `unset` 后 `deleteRecord`**，并且**在 `unset` 失败时不动记录**：宁可「一条都没删」，也不要留下「值在、记录没了」的孤儿。

### 2.2 （b）人类确认面：seam 能做什么、不能做什么

**seam 的契约（决定性问题）：**

| # | 事实 | 证据 |
|---|---|---|
| A1 | 一个 flow 必须声明 `key: CredentialKey`，`run()` 解析成功**意味着该 key 的记录已在本次 run 内提交** | `$H\dsh-authorization\lib\types\index.d.ts:104-122`（`:114` `key` 必填，文档「The flow owns the write」） |
| A2 | `begin()` 的失败码含 `NOT_COMMITTED`：「flow 解析完成却**没有在本次尝试内提交记录**」 | `$H\dsh-authorization\lib\index.d.ts:212`（文档 `:208-210`） |
| A3 | 实现：观察 `credentials/record-updated`，`key === flow.key` 时置 `committed` | `$H\dsh-authorization\lib\index.js:213-215` |
| A4 | 实现：`commit(record)` = `ctx.credentials.modifyRecord(flow.key, () => record)` | `$H\dsh-authorization\lib\index.js:220-226` |
| A5 | **实现：`!observed.committed` → `NOT_COMMITTED`；`!(await describeRecord(key)).configured` → 也 `NOT_COMMITTED`，文案逐字含 “deleted its credential record instead of committing one”** | `$H\dsh-authorization\lib\index.js:254-255` |
| A6 | prompt 的种类只有 `text` / `secret` / `select`；`secret` 与 `text` 只差呈现（surface 掩码、不入日志） | `$H\dsh-authorization\lib\types\types.d.ts:38-57` |
| A7 | 一次尝试的三种终态：`authorized` / `cancelled`（人类说「不」或调用方撤回）/ 失败以抛错形式给调用者 | `:59-71` |

**本插件对 seam 的现有用法（复用面）：** `src/adapters.ts:107-157`：注册 flow（`key` = 记录键、`methods:[{id:'confirm'}]`）→ `begin` → `run` 里 `input.answer()` 向人类取决策（`:116-118`）→ 只接受 `approved` 且 `scope==='persistent'`（`:118-119`）→ 需要值时 `session.prompt({kind:'secret'})` 收值并 `input.persist(value)`（`:120-127`）→ `session.commit({kind:'grant', payload: input.marker()})`（`:128`）；interaction.prompt 只接受 `kind==='secret'`（`:140-144`）。服务侧：`session` 分支**不进 seam**（`src/service.ts:849-852`），`persistent` 分支进 seam（`:854-875`），seam 失败时按「仅本次会话」降级并如实告知（`:878-898`）。

**结论（可机器证明）：**

| 动作 | 能复用 seam 吗 | 依据 |
|---|---|---|
| 改值（`target:'store'`）/ 升为持久（`scope to:'persistent'`） | **能**，且应该 | A1+A4：动作的终点是「提交一条记录并观察到」，正是 seam 的判据 |
| 改值（`target:'session'`） | **不能也不该**：seam 只承载 `persistent`（`src/service.ts:849-852` 的决定，README「已知限制」第 3 条） | A1+A2 |
| 解绑（本会话移除） | **不能**：什么都不提交 | A5 |
| 真删（删记录）/ 降级为仅本会话 | **不能**：终点是「记录不存在」，必然 `NOT_COMMITTED` | A5（逐字） |

因此本轮的人类确认面 = **两段式**：

1. **要值的动作**（`value target='store'`、`scope → persistent`）：人类在管理卡/信息框的掩码框里输入值 → 走 seam（`registerFlow` + `begin` + `commit`），seam 的提交观察就是「持久写真的发生了」的证明。为了支持「值已在内存（不必重输）」的 `scope → persistent`，`AuthorizationAttemptInput` 增设可选 `preloaded?: string`：`adapters.ts` 的 `run` 在该点用 `input.persist(preloaded)` 代替 `session.prompt`，**写值仍在 `run` 内、仍在 `commit` 之前**，与今天的次序（`:865-874`）完全一致，从而保留既有 O1 的措辞与语义（`src/service.ts:878-898`）。
2. **不提交记录的动作**（`unbind`、`delete`、`scope → session`）：走**插件自己的确认面** —— 复用既有 `POST /api/secret.answer` 与 `PendingStore`，新增一个 `action` 字段与一个**管理卡**（`conversation.chat.node` key `sr-manage`，`tool.call.toolview` key `secret_manage` → `null`）。人类在卡上点「确认」即构成确认证据（即既有 `ModalAnswer` 的 `approved`）。

**为什么不是「新开一个确认卡片体系」：** 既有 pending/answer/卡片这条链已经在三轮里被测试钉死（`test/register.test.ts` 路由捕获、`test/client-card.test.ts` 卡片状态机），复用它只需给 pending 记录**加可选字段**（`src/protocol.ts:94-120` 的 `pendingView` 逐字段重建，加字段是加法）；旧客户端读到不可字段会忽略（`src/client/entry.ts:436-463`），不会误判。新链则要重做轮询、超时、去重、卡上「已由别处处理」的 409 语义。

### 2.3 （c）Agent 工具形态：新增 `secret_manage`

| # | 事实 | 证据 |
|---|---|---|
| T1 | 卡片与 `tool/call` 的绑定闸门是**工具名**：`data.name !== TOOL_NAME` 直接 `return null`，而 `TOOL_NAME = 'secret_request'` | `src/client/entry.ts:667-669`、`:147` |
| T2 | 卡片的自有 SEAM 键集被逐字断言（两条测试） | `test/client-attach.test.ts:706-723`、`test/client-card.test.ts:467` |
| T3 | 结算载荷只认 `meta.kind === 'secret-request'` 且必须带四值之一的 `decision` | `src/client/entry.ts:392-414`；Host 侧 `src/tool.ts:42-73` |
| T4 | 既有工具已经因为「本插件自己那次调用」注册了 `tool.call.toolview` 的 `null` 占位，新工具照抄一处即可 | `src/client/entry.ts:736-738`（组件）、`:3809-3811`（注册） |
| T5 | 工具注册面支持多个工具：`ctx.tools.register(definition)` 返回精确 disposer | `$H\dsh-tools\lib\types\index.d.ts:631-636`；本插件 `src/index.ts:116` |
| T6 | 工具的 `presentationMeta` 是 durable 且**模型不可见**的结算载荷（新工具可以用自己的 kind） | `src/tool.ts:116-122`；`$H\dsh-tools\lib\types\index.d.ts:154-162` |

**结论：新增 `secret_manage`。** 代价是三个新面（工具、卡片定义、第三个只读 seam），收益是 `secret_request` 的一切**零改动**（它自己的 schema / 结果 / 卡片 / meta / 测试断言全部不动），而 `secret_request` 那条链正是第三轮验收与回归护栏的核心。

### 2.4 （d）改值的语义：按目标分，锚点与变量名不变

| # | 事实 | 证据 |
|---|---|---|
| V1 | 授权记录里存的是**值的一份副本** + 锚点 seq + 会话 id + 变量名 + 作用域 | `src/grants.ts:23-53` |
| V2 | 同一个 `(sessionId, name)` 的再次写入会替换旧记录，并在变量名变化时维护 `envVar → names` 反向索引 | `src/grants.ts:97-109`、`:101-103` |
| V3 | 有效性只由「锚点事件是否仍是本会话自己的、且仍在活表面上」推导，与值无关 | `src/grants.ts:115-133` |
| V4 | 注入时按 `envVar` 反查名字 → 逐个 `resolve` → 命中才给值 | `src/envs.ts:38-44`、`src/grants.ts:136-142` |
| V5 | 暂存项的作用域在绑定那一刻被写进授权 | `src/attach.ts:234-244`（`scope: staged.scope`） |
| V6 | 记录空间的「持久」判别只看 payload 的 `scope === 'persistent'` | `src/service.ts:201-208`（`:204`） |
| V7 | 历史是追加式、按会话、新最前；`note()` 缺省从该变量的上一条继承 name/label/scope | `src/history.ts:38-52`、`src/service.ts:683-712` |

**结论：**

- **`target:'session'`（改本会话那份值）**：把暂存项的值（`AttachStore`）或仍在有效期内的授权值（`GrantStore`）换成人类刚输入的值；**不写库、不进 seam**。变量名、作用域、锚点全不变；历史追加 `updated`。
- **`target:'store'`（改凭据库里的值）**：要求该变量在凭据库**已有**记录（否则 404：请改用「升为持久」或重走 `secret_request`）；Host 自己 `set(envVar, 人类输入的新值)` + 重提标记记录（payload 形状与 `:868-874` 一致），**并同步本会话授权/暂存里的那份副本**（否则会话里注入的仍是旧值，V4）。走 seam。
- **锚点不变**（V3 只问锚点是否存活）：所以「回退消息即失效」的老语义一字不变；「同一变量名」也一字不变（V1/V2），所以既有消息里的 `@DSH_SECRET_X` 仍然指向它。
- **暂存项的作用域**（V5）也允许被 `scope` 动作原地改写（见 §3.2），因此升级后绑定的授权就是 `persistent`。
- **改值不改记录键**：`cordis-plugin-secret/<id>` 由 name 推导（`src/naming.ts:63-71`），name 不变则键不变，`listRecords` 里的地址稳定。

### 2.5 （e）用户侧信息框的信息架构

座位事实（决定「新面不必新增注册」）：

| # | 事实 | 证据 |
|---|---|---|
| S1 | 胶囊座位是**会话作用域**的列表座位，因此 `sessionId` 由座位本身注入，新面不必新增 `inject`：`conversation.input.overlay` 声明为 `{kind:'list', scope:'session'}` | `$H\dsh-client-ui-conversation\lib\client.js:18301-18304`（overlay）、`:18309-18312`（`conversation.input.left`）、`:18334`（`inject: (sessionId) => …`） |
| S2 | 组件就是靠这个标准 prop 读会话的（本轮新增面照抄同一读法） | `src/client/entry.ts:2719`（`props.sessionId`）、`:2662`（按钮侧同款） |

现状（区间读所得）：一个胶囊组件（`src/client/entry.ts:2708-3364`）承载 5 个面，由模块级 `AttachMode` 单例驱动（`:1680-1690`、`:1719-1727`）；头部一行标题 + 一个「历史记录」链接 + 关闭（`:2914-2980`）；填值面的掩码手法是 `type: reveal ? 'text' : 'password'` + 一个「显示/隐藏」按钮（`:3041-3072`）；`confirm` 面是「一个问句 + 两个答案 + 不插任何东西」（`:3134-3203`）；`history` 面是「保留声明 + 列表 + 空态/读不到态」（`:3230-3268`）；`detail` 面是「行式事实 + 动作」（`:3290-3363`）。样式集中在 `A`（`:1401-1443`）与 `ATTACH_CSS`（`:1443-1500`），文案在 `ATTACH_ZH`/`ATTACH_EN`（`:1198-1383`，测试与实现都读这张表）。列表数据来源现状：`refreshAvailable` 打 `GET /api/secret.available`（`:2492-2515`），`readAvailableEntry` 只认 `staged|bound|stored` 与 `session|store`（`:2361-2375`）。

**结论：加三个面（`manage` / `edit` / `danger`），不加座位、不改既有面。** 头部那一个链接位置改成「两个链接」（历史记录 · 管理）；`detail` 面加一个「管理」按钮。列表用**新路由**：因为既有 `available` 会把「本会话 + 凭据库都有」的变量**去重成一条会话行**（`src/service.ts:538-555`），而管理面恰恰要同时看见两侧并分别给出动作。新路由的每条带 Host 亲算的 `can.*`（见 §3.4 R1），客户端不自己推导 —— 这既是「不得虚报」，也让「一键删掉不存在的记录」在 UI 层就不可能发生。

### 2.6 （f）历史/审计

| # | 事实 | 证据 |
|---|---|---|
| H1 | 事件集合现在是 7 类；来源 2 种 | `src/types.ts:193-210`；客户端镜像 `src/client/entry.ts:1616-1624` |
| H2 | 条目字段：`at/event/variable/name/label/scope/anchorSeq?/source/replaced?`，客户端逐键重建，并有**精确键集**断言 | `src/types.ts:218-230`；`src/client/entry.ts:2320-2345`；`test/client-attach.test.ts:964` |
| H3 | 客户端只渲染自己认识的事件（白名单），不认识的丢弃 | `src/client/entry.ts:2331`、`:1958-1971` |
| H4 | 两条列表必须同键集（测试断言 `HISTORY_EVENTS` 与 `HISTORY_LABEL` 排序后相等） | `test/client-attach.test.ts:972` |
| H5 | 历史是纯内存、按会话、有上限、进程重启即空，且不重建 | `src/history.ts:9-23`、`src/config.ts:22,32` |
| H6 | 「保留语义」已有逐字文案并在 UI 里显式展示 | `src/client/entry.ts:1244`、`:3231` |

**结论：** 新事件 `updated` / `scope-changed` / `unbound` / `deleted`，新来源 `'manage'`；**方向由条目自身的 `scope` 字段表达**（`scope` = 变更之后的有效作用域），因此 H2 的字段集一字不加，`:964` 的逐键断言仍成立；但要同步 4 处镜像（`HISTORY_EVENTS`、`HISTORY_LABEL`、`ATTACH_ZH`、`ATTACH_EN`）+ 2 处读取（`readHistoryEntry` 的 source 白名单 `:2326`、`historyEventKey` `:1969-1971`），并让 H4 的测试自动覆盖同键集。保留语义照旧（H5/H6）：`deleted` 这种「盘上确实变了」的事实，只在本进程内存里留一条记录，Host 重启后会话历史为空 —— 这一点必须继续用 `historyNotice` 的字面说清，不得暗示它落盘。

### 2.7 （g）遗留凭据的现状（本轮实测，只读键名）

`$C = C:\Users\admin\.dsh\.credentials.yaml`（919 字节；`version:` / `refs:` / `records:` 三段齐全）：

| # | 事实 | 证据（行号，**未打印任何值**） |
|---|---|---|
| G1 | refs 段有 1 个本插件的引用键：`DSH_SECRET_DSH_SELFTEST_PERSIST` | `$C:5` |
| G2 | records 段有 1 条本插件的记录：`cordis-plugin-secret/dsh-selftest-persist` | `$C:22` |
| G3 | 该记录 `kind: grant`，payload = `{version:1, envVar:DSH_SECRET_DSH_SELFTEST_PERSIST, name:dsh-selftest-persist, scope:persistent, authorizedAt:1791227618926}`（**值无关**，正是 `markerFacts` 能读的形状） | `$C:23-29`；形状依据 `src/service.ts:201-208` |
| G4 | 同文件另有 3 条**别人**的记录：`client-connection/browser-session`、`deepseek-account-platform/device`、`deepseek-account-platform/default` | `$C:7`、`:12`、`:16` |
| G5 | 任务书里写的名字 `selftest-persist` 与实际键名不一致：实名是 `dsh-selftest-persist`（推导出的变量名因此是 `DSH_SECRET_DSH_SELFTEST_PERSIST`）。**如实归因：命名按 `deriveEnvVar` 规则唯一确定，不存在第二条同源条目。** | `src/naming.ts:55-57`、`:63-71` |
| G6 | 本进程环境里该变量**未设置**（`UNSET`），因此 `unset` 不会被启动环境遮蔽（L9） | 实测 `[Environment]::GetEnvironmentVariable(...,'Process')` = null |
| G7 | 该条目**今天没有任何入口能删**：本插件的删除能力缺口就是 §2.1 的三条未接方法 | `src/adapters.ts:67-97` |

步骤见 §3.6。

---

## 3. 定案（形态与逐字契约）

### 3.1 两档删除的语义（**不得混为一谈**）

| | **解绑（从本会话移除）** | **真删（从凭据库删除记录）** |
|---|---|---|
| 动作名 | `unbind` | `delete` |
| 影响面 | 只影响**调用者/提交者自己的会话**：变量在本会话立刻不再注入（`shellEnv` resolver 拿不到值 → 注入空，证据 `src/envs.ts:38-44` + `src/grants.ts:136-142`） | 影响**凭据库**：引用空间的值与记录空间的标记各删一次（§2.1），其它会话再也 adopt 不到它 |
| 落盘 | **零持久写**（单测断言 `set/unset/deleteRecord` 调用次数 = 0） | 两次持久写（`unset` + `deleteRecord`） |
| 会话侧遗留 | 授权记录被移除，并留一条 `revoked-unbound` 撤销注记（好让下次 `secret_request` 说得清为什么又问一遍，沿用 `src/grants.ts:71-77`、`src/service.ts:962,987-991`） | 会话侧那份**值仍在内存**（它本来就在 P4），只是**作用域如实降级为 `session`**（因为盘上的持久依据没了）；该授权照旧随锚点失效 |
| 可逆性 | 可逆：持久条目可再 adopt/重登一次（证据：`src/service.ts:568-625`），session 条目需要重新输入值 | **不可逆**：值已从盘上抹掉，任何人都无法找回；会话内那一份只活到该授权失效为止 |
| 确认强度 | 一次确认（人类点了该动作） | 危险确认：必须**点名**「删除凭据库里的这条记录」+ 不可恢复，且信息框路径要求**二次显式点击**（`confirm:true`） |
| 历史事件 | `unbound`（staged 走既有 `discarded`，见下） | `deleted` |
| 对 staged 记录 | 委托既有 `POST /api/secret.release`（`discarded`/`withdrawn`），语义一字不改 | 允许：删库的同时把该暂存项的作用域降为 `session`（否则它会带着一个假的 `persistent` 承诺去绑定，V5） |

### 3.2 Agent 工具 `secret_manage`（逐字契约）

**工具定义**（新增第 2 个工具，注册点 `src/index.ts`；形状照抄 `src/tool.ts:76-134`）：

| 参数 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `action` | ✅ | `'list' \| 'unbind' \| 'delete' \| 'scope' \| 'value'` | 五个动作。**`delete` 与 `unbind` 是不同动作，没有共用参数、没有默认值**。 |
| `variable` | `list` 时 ❌，其余 ✅ | `DSH_SECRET_*`（复用 `isExposedEnvVar`，`src/naming.ts:45-47`） | 目标变量名。 |
| `to` | 仅 `scope` ✅ | `'persistent' \| 'session'` | 目标作用域。 |
| `target` | 仅 `value` ✅ | `'session' \| 'store'` | 改本会话那份值，还是改凭据库里的值。 |
| `reason` | ✅ | 非空字符串 | 原样展示给要确认的人（与 `secret_request` 同一纪律，`src/tool.ts:93-98`）。 |

**参数里没有 `value`，也没有任何别名**（N2 钉住：schema 属性名集合必须恰好等于上表）。

**动作语义与返回（全部值无关）：**

```
list                                                // 只读，不需要人类；root 与委派子代理都可调用
 → { decision:'listed', entries:[ SecretManageEntry ], notice? }

unbind  { variable }                                // 需人类确认（root）
delete  { variable }                                // 需人类确认（root）；危险确认
scope   { variable, to }                            // 需人类确认（root）；to='persistent' 要落盘
value   { variable, target }                        // 需人类确认（root）；值由人类在确认面输入
 → { decision:'applied',   action, variable, scope?, notice? }
 → { decision:'rejected',  reason? }   // 人类拒绝：立即停止，不得重试（与 secret_request 同措辞）
 → { decision:'ignored' }              // 本次未确认：可稍后再试
 → { decision:'other',     text }      // 人类给了自由文本指示：照做
```

`SecretManageEntry`（`list` 的每行；字段集是白名单，N1 钉住）：

| 字段 | 含义 |
|---|---|
| `variable` | 变量名，如 `DSH_SECRET_DSH_SELFTEST_PERSIST` |
| `name` | 凭据键（如 `dsh-selftest-persist`） |
| `label` | 人类可读标题；只有会话侧自己知道时才给得出来，凭据库只读侧一律回变量名（沿用 `src/service.ts:664-666` 的诚实做法） |
| `scope` | 有效作用域（`session` / `persistent`） |
| `state` | 会话侧状态 `staged` / `bound`，或 `authorized`（Agent 经 `secret_request` 拿到的会话内授权，第二轮用户裁定 ① 补入）；仅有库侧时 `stored`（沿用 `src/types.ts:244-250` 的词汇） |
| `source` | `'session' \| 'store' \| 'both'`（两个半区各是否存在；`both` 是本轮新增，因为管理面要同时看见两侧） |
| `origin` | `'attach' \| 'request'`，**第二轮新增**：本会话这份是人工附加的，还是 Agent 经 `secret_request` 索要来的。仅在会话侧存在时出现（纯库侧行没有会话侧记录，因此没有方向）。两个方向不得混为一谈（用户裁定 ①） |
| `can` | `{ unbind, delete, scope, value }` 四个布尔，**由 Host 亲算**（规则见 §3.4 R1）。它是**行能力**，不是「调用者能执行什么」：委派子代理看到的仍是同一份行能力，另由 `listed` 结果的 `notice` 明说写动作只对活跃的会话根代理开放 |

**失败（结构化、值无关，沿用 `SecretFailure` 与固定文案的纪律 `src/service.ts:130-139, 222-249`）：**

| code | 触发 |
|---|---|
| `BAD_REQUEST` | 参数不合法（含：`list` 带了 `variable`、`scope` 缺 `to`、`value` 缺 `target`） |
| `CALLER_NOT_LIVE` / `DELEGATED_CALLER` | 需要人类确认的动作被非会话根代理调用（复用 `src/service.ts:1000-1011` 现有两段文案） |
| `NO_SESSION` | 找不到活跃会话 |
| `TOO_MANY_PENDING` | 与 `secret_request` 共用队列上限（`src/service.ts:771`），满时同一段文案 |
| `TIMEOUT` | 等待人类确认超时（复用 `requestTimeoutMs`） |
| `NOT_FOUND` | 目标变量在本会话与凭据库里都不存在（**不虚报动作已发生**） |
| `STORE_EMPTY` | `value target='store'` 时凭据库里没有这个变量的记录 |
| `STORE_SHADOWED` | `unset` 被启动环境遮蔽（L9）：**本条新增**，文案 =「值由启动 dsh 的环境只读提供，本插件无法删除；请在启动 shell 里 unset 后重试。本次未删除任何东西。」 |
| `STORE_DELETE_FAILED` | 先 `unset` 成功、后 `deleteRecord` 失败：如实说明「值已删除，标记记录仍在，可再次执行真删」 |

**结算载荷**（`presentationMeta`，模型不可见、值无关，新 kind）：

```
{ v:1, kind:'secret-manage', decision, action, variable?, scope?, can?, notice? }
```

**并发与时序**：`isConcurrencySafe: () => false`（同 `src/tool.ts:124`）；`timeoutMs = requestTimeoutMs + 30000`（同 `src/tool.ts:126`）；`list` 虽只读也跟随同一工具设置 —— 简单优先，且只读调用不会撞上「一次一个人」的瓶颈（它不创建 pending）。

**待确认项（§8.1 U1）**：`list` 是否允许委派子代理调用。**推荐「允许」**，因为它是只读且值无关；但子代理的授权表按 `SessionId` 隔离（README「边界处理 → 子代理」「Fork」），所以子代理若不在父会话的 session 里，`list` 会诚实地返回空（不是把父会话的变量列给它）。

### 3.3 两个确认面的分工（Agent 路径）

```
secret_manage(action='unbind'|'delete'|'scope'|'value')
  ├─ 校验参数 + classifyCaller('live-root') + 找活跃会话           // 复用 src/service.ts:728-750 的次序
  ├─ Host 自算目标现状（凭据库枚举 + 会话侧），客户端/模型输入一律不信任
  ├─ PendingStore.add({ id, callId, sessionId, action, variable, label, scope,
  │                     can, expectValue, reason, createdAt }, maxPendingRequests)
  │     expectValue = (action === 'value')            // 只有「改值」需要人类键入
  │     // scope→persistent 用本会话已持有的那份值（§8.1 U2 推荐），因此不需要键入；
  │     // 若 U2 改为「必须重输」，这一行改成 (action==='value' || action==='scope') 即可。
  ├─ 人类在管理卡上作答（Approved / Rejected / Ignored / Other）    // 复用 POST /api/secret.answer
  └─ 执行：
       value(target='store') | scope(to='persistent')  → ctx.authorization.begin(...)  [落盘 → seam]
       value(target='session') | unbind | delete | scope(to='session') → 插件自有路径（不提交记录）
```

**逐字契约的两处关键**：
1. `expectValue` 由 Host 算（不是客户端猜），`service.answer()` 里把 `parseAnswer(raw, !request.alreadyConfigured)`（`src/service.ts:305`）改成 `parseAnswer(raw, request.expectValue)`；字段缺省时退回旧行为，因此 `secret_request` 一字不变。
2. **管理卡不显示任何值，也不把值回传 Host 之外的任何地方**：卡上的掩码输入框把值放进 `POST /api/secret.answer` 的请求体（P2 的一次提交），Host 收下后：`target='session'` 直接更新内存；`target='store'` 交给 seam 的 `persist`（`src/adapters.ts:120-127` 的手法）。

### 3.4 路由契约

**新增两条**（`src/routes.ts` 的路径常量表扩容；全部落在既有 `ctx.connection.fetch` 信任栅栏内，同源 + 签名 Cookie，值只走 POST 体，证据 `src/routes.ts:22-31`）：

| 路径 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `/api/secret.manage` | GET | `?sessionId=` | `{ ok:true, entries:[ SecretManageEntry ] }`（与工具 `list` 同一形状，**同一实现**，避免两套说法） |
| `/api/secret.manage` | POST | `{ sessionId, action:'unbind'\|'delete'\|'scope'\|'value', variable, to?, target?, value?, confirm? }` | `{ ok:true, action, variable, scope, changed:{store:boolean,session:boolean}, notice? }` 或 `{ ok:false, error }` + 4xx/5xx |

**R1 `can.*` 的计算规则（唯一实现，工具与两条路由共用）：** 由一次「枚举 + 会话侧事实」得出，客户端不推导。

| 字段 | true 当且仅当 |
|---|---|
| `can.unbind` | 会话侧存在该项（`staged` 或仍在有效期内的 `bound` 授权） |
| `can.delete` | 凭据库里存在本插件自己的记录（`record.key.startsWith('cordis-plugin-secret/')` 且 `markerFacts` 读得出来，证据 `src/service.ts:650-671`） |
| `can.scope` | 会话侧存在该项（升/降都要先有会话侧的一份） |
| `can.value` | 会话侧或库侧任意一侧存在 |

**R2 两档的入参差别（结构性防混同）：** `unbind` **不接受** `confirm` 之外的任何字段，且其实现路径里**不出现** `unset`/`deleteRecord`（N5 用调用计数钉住）；`delete` 必须 `confirm === true`，否则 400。

**R3 `value` 的落点：** 请求体里的 `value` 是 P2 的又一次出现（与 `attach` 同级），长度上限沿用 `MAX_VALUE = 65536`（`src/protocol.ts:16`），除此以外**只做长度检查**，不比较、不记录、不回显（同 `src/protocol.ts:140-201` 的纪律）。

**R4 真删的两步与半状态（逐字处置）：**

```
1) credentials.unset(variable)          // 可能抛：被启动环境遮蔽 → STORE_SHADOWED，且不进行第 2 步
2) credentials.deleteRecord(recordKey)  // no-op 安全（L7 的 :578）；失败 → STORE_DELETE_FAILED（如实说明半状态）
3) 会话侧（若存在该项）作用域降级为 'session'；写一条 deleted 历史
4) 重提/刷新前端列表（GET /api/secret.manage）
```

**R5 不改的路由**：`pending`/`answer`/`attached`/`attach`/`release`/`history`/`available`/`adopt` 的路径、方法、请求体形状与响应字段集**全部不变**；`pending` 只**增可选字段**（`action`/`target`/`expectValue`/`can`），`answer` 只**多认**一个 `expectValue` 驱动的值必填规则。

### 3.5 用户侧信息框的三个新面

`AttachMode`（`src/client/entry.ts:1680-1690`）增三态，全部仍在同一个胶囊组件里：

| 面 | 内容 | 交互要点 |
|---|---|---|
| `manage` | 两个分区：**本会话可用**（人工附加的 `staged`/`bound` 行 **与** Agent 经 `secret_request` 获得的 `authorized` 行；每行以 `origin`=`attach`/`request` 区分）、**凭据库（持久）**（`store`/`both` 的库侧）。每行：变量名 + 凭据键 + 作用域 + 方向 + 来源 + 状态 + 动作按钮（**按 `can.*` 显示**，不可用的动作不渲染） | 头部标题「管理密钥」+ 「历史记录」链接；行内动作按钮带 `data-action`（沿用 `:2941`、`:3351` 的可测手法）；读不到时用固定文案（沿用 `historyUnavailable` 的诚实做法 `:1911-1927`） |
| `edit` | 掩码输入（`type: reveal ? 'text':'password'` + 「显示/隐藏」，照抄 `:3041-3072`）+ 目标说明（「改本会话这份值」/「改凭据库里的值」）+ 一句后果说明 + 「写入」/「取消」 | 值只在本组件 state 与本次 POST 体里（P1/P2）；取消即清空（照抄 `:3106-3120`）；提交后清空 `setValue('')`（照抄 `:2802`） |
| `danger` | 三种危险动作各自的逐字确认：`unbind`=「从本会话移除（只影响本会话，凭据库不动）」；`delete`=「从凭据库删除这条记录（**不可恢复**；其它会话将再也用不到它）」；`scope→session`=「降级为仅本会话（**会删除凭据库里的记录**，不可恢复）」 | 与既有 `confirm` 面同形（`:3134-3203`：一个问句 + 两个答案 + 不做任何事的那个答案）；真删路径必须**第二次显式点击**（按钮文案里含「真删」二字，不写成「确定」） |

**入口**：① 头部链接行（历史记录 · 管理）；② `detail` 面的「管理」按钮（`:3331-3358` 的动作行里加一个）。**不加**新座位、新 slot、新引用源，`dsh.client.inject` 也不变。

**文案**：`ATTACH_ZH`/`ATTACH_EN` 各增一组键（`manage*`/`edit*`/`danger*`/`evUpdated`/`evScopeChanged`/`evUnbound`/`evDeleted`/`sourceManage`），**既有键一字不改**（`:1198-1383`）。

### 3.6 遗留凭据 `dsh-selftest-persist` 的安全删除步骤

**结论：等 0.4.0 的真删落地后，用信息框路径删（人类动作、可复核）；不要现在手改 YAML。** 理由：手改会绕过三条不变量（谁写的、谁确认的、删了什么），而真删路径本身正好是这次要交付的能力。

**前置核对（只读，任何一步都不打印值）：**

1. 确认条目仍在（**只看键名**）：`Select-String -Path $C -Pattern 'cordis-plugin-secret/dsh-selftest-persist' -Quiet` → `True`（若 `False`，说明已被删，到此为止）。
2. 确认它**不是**别人的记录：键前缀必须是 `cordis-plugin-secret/`（`$C:22`），同文件的 `client-connection/...`、`deepseek-account-platform/...`（`$C:7,12,16`）**永远不许碰**。
3. 确认不会被遮蔽：进程环境里 `DSH_SECRET_DSH_SELFTEST_PERSIST` 必须未设置（本轮实测 = `UNSET`，G6）；若已设置，先在自己启动 dsh 的 shell 里 `unset`，否则真删会返回 `STORE_SHADOWED`（L9）。

**执行（需要人，且需要两次点击）：**

4. 在 Harness Web 里打开本会话 → 点输入框左侧「附密钥」按钮 → 胶囊头部点「**管理**」→ 分区「**凭据库（持久）**」里找到 `DSH_SECRET_DSH_SELFTEST_PERSIST`（名字与凭据键 `dsh-selftest-persist` 同时显示）。
5. 点该行的「**真删**」→ 危险面逐字确认读一遍（不可恢复 / 其它会话将再也用不到它）→ 点带「真删」字样的按钮（**第二次显式点击**）。
6. Host 执行 §3.4 R4 的两步；返回后列表刷新，该行从「凭据库（持久）」分区消失；本会话若从未绑定过它，`本会话可用` 分区本来就没有它。
7. 刷新页面再打开「管理」面复核一次（列表来自 Host 每次现算，不是本地缓存）。

**删除后核对（只读）：**

8. `Select-String -Path $C -Pattern 'DSH_SECRET_DSH_SELFTEST_PERSIST|dsh-selftest-persist' -Quiet` → 期望 `False`（**只看布尔与键名，不打印行内容**）。
9. `cordis_inspect_query`（host）确认工具面出现 `secret_manage`；用 `action:'list'` 再确认 `entries` 里不再有该变量。
10. 会话历史里应有一条 `deleted` 行（**仅本进程内可见**；Host 重启后历史为空是设计如此，H5/H6）。

**不可恢复性与副作用（逐字告知）：**

- 引用空间的值被原子重写掉（L7：`writeFileAtomic` + 0600），**没有任何副本**，也无法从会话日志反推（日志里只有变量名，README §安全不变量 P1–P6）。想再用同一变量，只能重新走 `secret_request` 或附加一次，**重新输入新值**。
- 记录空间的标记一并删除，因此**其它会话**不再能 adopt 它（`src/service.ts:586-589` 会找不到条目 → 404）。
- 若在此之前有人把它绑到了某条消息上，那个会话的内存副本仍在（P4），直到消息回退或会话结束；此后它的作用域如实显示为「仅本次会话」（§3.1）。
- 该文件的属主权限必须保持 600（L2）；插件自己的写入会保持 0600。

---

## 4. 事件 / 状态机

### 4.1 Host 状态与转移表

三个存储各自持有事实（`AttachStore` / `GrantStore` / 凭据库），「一个变量的状态」是它们的组合：

| 状态 | 含义 | 归属 |
|---|---|---|
| `S0` | 什么都不存在 | — |
| `S1` | 暂存项（已登记、未随消息发送） | `AttachStore`（P3） |
| `S2` | 授权（已绑定到某条消息、锚点存活） | `GrantStore`（P4） |
| `S3` | 凭据库条目（值 + 标记记录） | 凭据库（P5） |

组合是允许的：`S1+S3`（选了持久但还没发送）、`S2+S3`（已绑定的持久授权）、`S3` 单独存在（库里有、本会话没用过）。

| 动作 | 前提 | 转移 | 落盘 | 历史事件 |
|---|---|---|---|---|
| `bind`（既有） | `S1` | `S1`→`S2`（若该变量在库中则同时 `S2+S3`） | 否（值来自暂存项；库侧早在暂存时就写过） | `bound`（不变） |
| `release`（既有） | `S1` | `S1`→`S0`（`S3` 不动） | 否 | `discarded`/`withdrawn`（不变） |
| `unbind`（新） | `S1` 或 `S2` | `S2`→`S0`（`S3` 不动）；`S1` 时委托 `release` | **否** | `unbound`（`S1` 时是 `discarded`） |
| `value target='session'`（新） | `S1` 或 `S2` | `S1.value` / `S2.value` := 新值；状态不变 | 否 | `updated` |
| `value target='store'`（新） | `S3` 存在 | `S3.value` := 新值 + 重提标记；同步 `S1`/`S2` 的副本 | **是**（`set` + `commitRecord`，经 seam） | `updated` |
| `scope to='persistent'`（新） | `S1` 或 `S2`，且当前 `scope==='session'` | 该项 `scope`→`persistent`；写入 `S3` | **是**（`set` + `commitRecord`，经 seam） | `scope-changed`（`scope` 字段 = `persistent`） |
| `scope to='session'`（新） | `S1` 或 `S2`，且当前 `scope==='persistent'` 且 `S3` 存在 | 该项 `scope`→`session`；删除 `S3`（同 R4） | **是**（删除） | `scope-changed`（`scope` 字段 = `session`）+ `deleted` |
| `delete`（新） | `S3` 存在 | 删除 `S3`；若 `S1`/`S2` 该项 `scope==='persistent'` 则降级为 `session` | **是**（删除） | `deleted` |
| `session/disposed`（既有） | — | 该会话的 `S1`/`S2` 全清；`S3` 不动 | 否 | 历史随会话丢弃（不变） |

**in-flight 期间不变量**：任何动作执行期间，`S1`/`S2` 的读路径（`attachedViews`、`liveGrant`、`valueFor`）与写路径都在同一个事件循环回合内完成，不引入异步窗口（`GrantStore` 全是同步方法，`src/grants.ts:92-200`）；唯一异步窗口是 seam 的写值/提交（§4.4）。

### 4.2 人类确认矩阵

| 动作 | 载体 | 值从哪来 | 经 seam？ | 证据强度 |
|---|---|---|---|---|
| `list` | 无（只读） | — | 否 | — |
| `unbind` | Agent 路径：管理卡 approved；用户路径：信息框 `confirm:true` 的一次点击 | — | 否 | 一次显式人类动作 |
| `delete` | Agent 路径：管理卡 approved（卡面逐字写「不可恢复」）；用户路径：信息框危险面**二次点击** | — | 否 | 一次显式人类动作 + 危险文案 |
| `scope → persistent` | 同上 | **已有**（P3/P4 里那份，不重输；见 §8.1 U2 备选） | **是** | seam 的提交观察（A3/A5） |
| `scope → session` | 同 `delete` | — | 否 | 同 `delete` |
| `value target='session'` | 人类在掩码框输入 | 人类输入（P1 → P2） | 否 | 人类的输入动作本身 |
| `value target='store'` | 同上 | 人类输入（P1 → P2） | **是** | seam 的提交观察 |

### 4.3 Client 面与状态

```
toggle(附密钥) ──┬─→ fill ──(提交)──→ detail
                 │                        │
                 │             ┌──────────┴───────────┐
                 │             ↓                      ↓
                 │        history(可带 variable)   manage ──┬─→ edit ──(提交/取消)──→ manage
                 │             ↑                            └─→ danger ──(确认/取消)──→ manage
                 └─→ idle（关闭任意面；关闭即放弃未决确认，同 :2971-2976）
```

模块级状态（沿用既有单例手法 `:1692-1716`）：`manageBySession: Map<string, readonly ManageEntry[]>`、`manageFailed: Set<string>`（读不到时用固定文案，不虚报空）、`manageInFlight`（防重复提交）。`AttachMode` 增 `{kind:'manage'}`、`{kind:'edit';variable;target}`、`{kind:'danger';variable;act}`。

### 4.4 时序窗口（必须写清的三个）

1. **seam 的写值与提交之间有窗口**：`persist` 先于 `commit`（`src/adapters.ts:120-128`、`src/service.ts:865-874`），因此 `scope→persistent` / `value target='store'` 在 seam 最终 `failed` 时，**可能值已进库但授权记录未提交**。处置：完全复用既有 O1 的措辞（`src/service.ts:888-898`），**不得**声称「值一定没进库」；历史里也不写 `scope-changed`/`updated`（没观察到提交就不算改变），改为在结果里给 `notice`。
2. **真删的两步之间**：`unset` 成功、`deleteRecord` 失败 → 半状态（值没了、标记还在）。处置：返回 `STORE_DELETE_FAILED` + 逐字说明；不再重试第 1 步（`unset` 对不存在的引用是 no-op，L6 语义，重跑安全），并在历史里**只**记 `deleted` 之前先不记 —— 定案：**只有两步都返回后才写 `deleted`**，半状态用 `notice` 说明，避免历史替一次失败的删除背书。
3. **同键并发**：`secret_manage` 与 `secret_request` 共用 `PendingStore` 与 `maxPendingRequests`；`ctx.authorization` 自身按 `CredentialKey` 串行（`$H\dsh-authorization\lib\index.js:144`，`ALREADY_IN_FLIGHT`）。因此「同一凭据同时两个确认」在 seam 层被拒（既有行为，`src/service.ts:917-920` 的既有措辞覆盖），管理面沿用该措辞，不新增竞争路径。

---

## 5. 文件级改动点

### 5.1 Host 半

| 文件 | 改动（全部为加法） |
|---|---|
| `src/adapters.ts` | `credentialsPort` 增 3 个方法：`unset(ref)`、`deleteRecord(key)`、`describeRecord(key)`（都做 `as CredentialRef`/`as CredentialKey` 断言，同 `:70-95` 手法）；`AuthorizationAttemptInput` 增可选 `preloaded?: string`，`authorizationPort` 的 `run` 在该点用它代替 prompt（`:120-127` 的分支） |
| `src/service.ts` | `CredentialsPort` 接口增 3 个方法（`:70-90`）；`answer()` 的值必填判据改成 `request.expectValue`（`:305`）；新增 `manageList(sessionId)`（与工具 `list` 共用一个实现，内部复用 `attachedViews`/`storedEntries`，新增 `can.*` 计算）、`manage(raw)`（用户侧 POST：校验 → 人类确认证据 → 执行）、`manageAction(...)`（Agent 侧：建 pending → 等答复 → 执行）、`applyUnbind` / `applyDelete` / `applyScope` / `applyValue` 四个执行器；`note()` 增一个 `source:'manage'` 的调用点（`:683-712` 不变，只多用） |
| `src/grants.ts` | 新增公开方法 `unbind(session, envVar)`（按变量解除一个会话的授权，内部走既有 `dropKey`，形态同 `forget` `:160-168`）；`GrantVerdictCode` 增 `'revoked-unbound'`（`:56-63`）；`Grant` 增可选 `valueUpdatedAt?`（诊断用，可选） |
| `src/attach.ts` | 新增公开方法 `reScope(sessionId, envVar, scope)`（原地改暂存项的作用域，不动值、不动 TTL；`StagedAttach` 的 `scope` 是 `readonly`，实现上用整条替换，同 `:96-112` 的 `{...input}` 手法） |
| `src/history.ts` | 不改（`push`/`latest` 已够用） |
| `src/types.ts` | `SecretHistoryEvent` 增 4 个成员；`SecretHistorySource` 增 `'manage'`；新增 `SecretManageAction`/`SecretManageEntry`/`SecretManageCan`/`SecretManageResult`/`SecretManageMeta`（沿用「对象类型别名而非 interface」的手法让结果结构上是 JSON 值，`:38-61` 的注释）；`PendingView` 增可选 `action`/`target`/`expectValue`/`can` |
| `src/protocol.ts` | `pendingView` 透传 4 个新字段（`:94-120`）；新增 `parseManage`（用户侧 POST 的逐字段校验，含 `confirm:true` 与 `MAX_VALUE` 复用）与 `manageView(entry)`（白名单重建，同 `historyView`/`availableView` `:260-284`）；`parseAnswer` 不改 |
| `src/tool.ts` | 新增 `defineSecretManageTool(service, config)`（`renderResult` 自己的措辞 + 自己的 `presentationMeta` kind `secret-manage`）；`defineSecretRequestTool` **一字不改** |
| `src/routes.ts` | 两条新路由（GET/POST 同路径）；既有 8 条不动 |
| `src/index.ts` | 注册第二个工具（`:116` 旁）；其余装配不变 |
| `src/config.ts` | **不改**（复用 `requestTimeoutMs`/`maxPendingRequests`/`maxAvailableEntries`） |
| `src/naming.ts` | **不改**（`recordKey`/`isExposedEnvVar`/`isCredentialName` 全部复用） |

### 5.2 Client 半（`src/client/entry.ts`，仍是单文件 classic script，无 import/export）

| 区域 | 改动 |
|---|---|
| 常量 | 增 `MANAGE_PATH = '/api/secret.manage'`、`MANAGE_TOOL_NAME = 'secret_manage'`、`MANAGE_CARD_KIND = 'sr-manage'`、`MANAGE_META_KIND = 'secret-manage'` |
| 字典 | `ATTACH_ZH`/`ATTACH_EN` 增一组键（管理面/改值面/危险面的全部文案 + 4 个新事件名 + 新来源名）；既有键**不动** |
| 纯函数 | `readManageList(payload)`、`readManageEntry(raw)`、`manageCan(entry)`（若响应缺字段则全部 false，不猜）、`describeManage(entry)`（与 `describeAvailable` 同款，复用同一张表）；`readHistoryEntry` 的 source 白名单增 `'manage'`（`:2326`）；`HISTORY_EVENTS`/`HISTORY_LABEL` 各增 4 项（`:1616-1624`、`:1958-1966`） |
| 取数 | `refreshManage(sessionId)`（照抄 `refreshAvailable` 的 in-flight 去重 `:2492-2515`）、`postManage(body)`（照抄 `postRelease` `:2091-2109` 的返回值解析纪律：读不懂就当失败，不虚报成功） |
| 组件 | 胶囊增三个面（同一组件、同一 `A.*` 类名）；头部链接行改成两个链接 |
| 卡片 | 新增 `secretManageDefinition`（`match` 闸门 `data.name === 'secret_manage'`，形状照抄 `:663-733`）+ `SecretManageCard`（manage/edit/danger 三种卡内形态）+ `HiddenSecretManageToolRow`；注册 `conversation.chat.node`（key `sr-manage`）与 `tool.call.toolview`（key `secret_manage`）各一处（`:3844-3847`、`:3809-3811` 旁） |
| SEAM | **新增** `globalThis.__cordisSecretManage`（version 1：管理面的常量 + 纯函数 + 两个组件 + 定义）；`__cordisSecretClient` 与 `__cordisSecretAttach` 的键集**不动** |

### 5.3 测试文件（只增，不改既有断言）

| 文件 | 新增覆盖 |
|---|---|
| `test/unit.test.ts` | `parseManage` 的逐字段真值表（缺 `confirm` → 400；`delete` 带值 → 400 或忽略；`value` 超长 → 400）；`GrantStore.unbind` 只影响目标变量且留下 `revoked-unbound`；`AttachStore.reScope` 不改值/不改 TTL |
| `test/register.test.ts` | 两条新路由被捕获（路径/方法/`requestBody:'buffered'`）——沿用既有捕获点 `:140-153`（`tools.register` `:141`、`connection.fetch.register` `:148`）；`secret_manage` 出现在 `tools` 里且 schema 属性名集合 = `{action, variable, to, target, reason}`；**四个动作在无人类答复时一律不产生持久写**（N4）；`unbind` 前后 `credentials` 的写调用计数 = 0（N5，可复用 `:175-190` 的事件计数手法）；`delete` 的调用序列恰好是 `unset` → `deleteRecord`；`unset` 抛错时 `deleteRecord` **未被调用**（R4）；`scope→persistent` 经真 seam 并产生 `set` + `modifyRecord` |
| `test/attach.test.ts` | 历史 4 类新事件的写入点（`updated`/`scope-changed`/`unbound`/`deleted`）与 `source:'manage'`；`deleted` 之后会话侧 `scope` 变 `session`。**注意（本轮实测的覆盖缺口）**：现在**没有任何 Host 侧测试断言历史事件的写入点** —— `test/register.test.ts` 只到路由注册（`:341`）与一句注释（`:333-335`），`:482` 就是文件末尾；`test/attach.test.ts`/`test/unit.test.ts` 只在配置里出现 `maxHistoryPerSession`。因此 t2 必须**新建** `test/history.test.ts` 承载新事件，并把既有 7 类事件也补上（这是「A 段可机器证明」的一部分，不是可选） |
| `test/client-card.test.ts` | 管理卡的 `match`/`start`/`update`/`buildViewNode` 与既有卡互不干扰（同名 `tool/call` 只归一张卡） |
| `test/client-attach.test.ts` | 管理面三个纯函数/字典/新事件的同键集断言（沿用 `:972` 的手法）；`__cordisSecretClient` 键集**仍然不变**（回归护栏）；`__cordisSecretManage` 键集白名单；管理列表与卡片 data 的哨兵扫描（N1）；掩码输入在取消/提交后本地 state 为空 |

### 5.4 明确不改的东西（t2 的自查清单）

`src/client/entry.ts` 的 `:663-733`（卡定义）、`:3684-3787`（两个 SEAM 的键集）、`:3816-3892`（既有注册）；`src/service.ts` 的 `request`/`converse`/`complete` 主链（除 `answer()` 一行）；`src/tool.ts` 的 `secret_request`；`src/routes.ts` 的既有 8 条；`src/config.ts`；`package.json`；README 的 P1–P6 与「明文绝不允许出现」清单（README 的**路由条数与工具表**要在发布任务里同步，见 §9）。

---

## 6. 兜底阶梯

| # | 情形 | 兜底 |
|---|---|---|
| C1 | Host 是旧版（pending 里没有 `action`/`can`） | 管理卡把条目当作「不是我的」→ 显示「请求材料不可读」，**不提供任何动作按钮**；信息框管理面若拿不到 `can.*` 则全部动作不渲染（宁可少给，不给错） |
| C2 | `GET /api/secret.manage` 不可达/读不懂 | 保留上一次的列表；从未读到过则显示固定文案「暂时无法读取管理列表」，**不显示空列表**（「读不到」≠「没有」，同 `:1911-1927` 的既有纪律） |
| C3 | `credentials.listRecords` 缺失或抛错 | 库侧贡献 0 条（既有：`src/service.ts:639-645`），会话侧照常；管理面因此只显示本会话项，并不显示「凭据库为空」这种断言 |
| C4 | 某个 record 读不回（`readRecord` 抛错） | 跳过该条（既有：`:652-656`），不影响其余 |
| C5 | `unset` 被遮蔽（`STORE_SHADOWED`） | 不进行 `deleteRecord`；文案点明「请在启动 dsh 的 shell 里 unset」；列表不变 |
| C6 | `deleteRecord` 失败（半状态） | `STORE_DELETE_FAILED` + 逐字说明「值已删除，标记记录仍在，可再次执行真删」；**不写 `deleted` 历史** |
| C7 | seam 失败（`scope→persistent` / `value target='store'`） | 复用既有 O1 措辞（`:888-898`）：人类的选择保留、按「仅本次会话」降级生效、如实说明「未能完成持久化登记的确认」 |
| C8 | 人类超时 | `TIMEOUT`，**不执行任何动作**（`PendingStore.wait` 的超时路径 `src/pending.ts:123-125`） |
| C9 | 目标变量在执行前被别人删掉 | 执行器先重新枚举一次现状；`NOT_FOUND` 且不虚报（与 `release` 返回真实 `state:'none'` 的既有纪律同源，`:417-419`） |
| C10 | 客户端没有 `inputTriggers`/`locale`/`sidebarRightTabs` | 管理面不依赖这三者（它在胶囊里），因此这些缺省不影响本轮功能；既有降级行为不变 |

---

## 7. 验证清单

> 约定：`$R = projects/cordis-plugin-secret`；`$H = C:\Program Files\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`；`$C = C:\Users\admin\.dsh\.credentials.yaml`。带「活体」的条目需要浏览器/真实会话；无法执行时**必须标注「未验证」**，不得推定通过。

### 7.0 A 段：可机器证明

**A1 机制复核（静态证据，逐条 grep 到行）**
1. `$H\dsh-credentials\lib\types\index.d.ts:152`（`unset`）与 `:191`（`deleteRecord`）仍在，且后者文档仍是「移除一条记录；移除不存在的记录是 no-op」。
2. `$H\dsh-credentials-local\lib\index.js:517-519`、`:568-589`、`:636-638` 的实现与遮蔽规则未变。
3. `$H\dsh-authorization\lib\index.js:254-255` 的两条 `NOT_COMMITTED` 判据未变（这是「真删不能走 seam」的唯一依据）。
4. `$H\dsh-authorization\lib\types\index.d.ts:104-122`（flow 的 `key` 必填与「flow owns the write」）与 `:212`（`begin` 的 `NOT_COMMITTED` 文档）未变；prompt 三种 kind 仍是 `text`/`secret`/`select`（`$H\dsh-authorization\lib\types\types.d.ts:38-57`）。
5. `src/adapters.ts:67-97` 仍是唯一把 `ctx.credentials` 收窄的地方；本轮新增的 3 个方法只能出现在这里。
6. `src/client/entry.ts:667-669` 的 `data.name !== TOOL_NAME` 闸门未变（新工具必须自带新卡片）。
7. `test/client-attach.test.ts:706-723` 与 `test/client-card.test.ts:467` 两处键集断言仍在（本轮**不得**靠改它们过关）。
   任一条消失 ⇒ 对应定案须重审（不是测试失败，而是假设失效）。

**A2 Host 单元**
1. `parseManage` 真值表：四个动作 × 缺字段/错类型/超长/未知值；`delete` 无 `confirm` → 400；`value` 无值 → 400；`value` 超 `MAX_VALUE` → 400；任何拒绝都**不写历史、不动存储**。
2. `can.*` 真值表：库侧独有 → `{delete:true, value:true, unbind:false, scope:false}`；`staged` → `{unbind:true, scope:true, value:true, delete:<库里有则为 true>}`；`bound` → 同上；**`authorized`（第二轮新增：带 `callId` 的活跃授权，即问方向）→ 同 `bound`**；两侧都没有 → 不出现在列表里。第二轮另加：同一变量同时有附加方向与会话内授权时**仍只一行**，且行的 `origin`/`state` 如实说明是哪一类。
3. `unbind`：仅目标变量消失（同会话另一个变量的授权不受影响）；`revoked-unbound` 注记可被下一次 `secret_request` 用来解释；`credentials` 的 `set/unset/deleteRecord` 调用计数为 0。
4. `delete`：调用序列恰好 `unset` → `deleteRecord`；`unset` 抛错 → `deleteRecord` **零调用**、历史**零写入**、返回 `STORE_SHADOWED`；`deleteRecord` 抛错 → 返回 `STORE_DELETE_FAILED` 且**无** `deleted` 历史；两步都成功 → 一条 `deleted`，且会话侧 `scope` 变 `session`。
5. `scope → persistent`：经真 seam；断言 `credentials.set` 被调用一次，且写入值 = **该会话当前持有的那份**（来自 P3 `AttachStore` 或 P4 `GrantStore`，不是新键入的）；`modifyRecord` 被调用一次；返回 `applied`；`scope → session`：断言 `unset`+`deleteRecord` 各一次、无 seam 调用。
6. `value target='session'`：`GrantStore` 里该变量的值变了，**锚点、变量名、作用域不变**，`credentials` 写调用为 0；`value target='store'`：`set` + `modifyRecord` 各一次，会话内副本也更新。
7. 历史：四类新事件各写一条，`source === 'manage'`；上限 32 丢最旧；已有事件与来源不变（回归）。
8. 不变量扫描：`list` 结果、管理列表、管理卡 data、`presentationMeta` 四处的 `JSON.stringify` 对哨兵值 0 命中（N1）。
9. `secret_request` 全量回归：工具 schema、四态结果、卡片 `meta.kind`、`alreadyConfigured` 驱动的值必填规则**全不变**（跑既有 90 条 + 新增，用例数只增不减）。

**A3 路由/协议**
1. 捕获 `registerSecretRoutes` 的注册表：路径集合 = 既有 8 条 + `manage`(GET) + `manage`(POST)；方法与 `requestBody:'buffered'` 正确。
2. 两个新响应的字段集合被断言为白名单（无 `value`、无未知字段）。
3. `GET /api/secret.attached`、`GET /api/secret.history`、`GET /api/secret.available` 的响应字段集**逐字段冻结断言**。
4. `GET /api/secret.pending` 只是**多**了 4 个可选字段；旧形状的请求仍能被旧读取器读懂（模拟一份不含新字段的 payload）。

**A4 客户端单元（扩 `test/client-attach.test.ts` / `test/client-card.test.ts`）**
1. `readManageList`/`readManageEntry`：字段缺失/类型错/未知 `state`/未知 `source` 一律丢弃该条；整体畸形 → `null`；缺 `can` → 全部 false。
2. `secretManageDefinition.match`：`tool/call` 的 `name === 'secret_manage'` → `{id:callId, role:'start'}`；`name === 'secret_request'` → `null`（两张卡互不串）；`tool/result` 的 `source.kind === 'tool'` → `update`。
3. `buildViewNode`：`location = {kind:'session'}`、`visibility === 'visible'`、`anchorSeq` = `tool/call` 的 seq、`data` 里**没有**值。
4. 胶囊：`manage` 面按 `can.*` 渲染动作（不可用的不渲染）；`edit` 面 `type` 随显示/隐藏切换、取消后本地值为空；`danger` 面两种文案不同且真删按钮文案含「真删」。
5. 掩码面与 N1/N2：管理面的所有 props/DOM 文本对哨兵值 0 命中；`postManage` 的请求体字段集合被断言（`value` 只在 `action:'value'` 时出现）。
6. `HISTORY_EVENTS` 与 `HISTORY_LABEL` 仍同键集（沿用 `:972`）；4 个新事件都能渲染出文案；未知事件仍被丢弃。
7. `__cordisSecretClient` 键集**不变**；`__cordisSecretAttach` 键集**不变**；`__cordisSecretManage` 是新的冻结对象。

**A5 静态面**
1. `Select-String $R/src/client/entry.ts -Pattern '^\s*(import|export)\s'` → 0 命中；`lib/client/entry.js` 同判据。
2. `Select-String $R/src -Pattern "deleteRecord|unset\("` → 只出现在 `src/adapters.ts` 与 `src/service.ts` 的删除执行器里（不得出现在 `release`/`unbind`/`attach`/`request` 路径里）。
3. `secret_manage` 的 schema 属性名集合 = `{action, variable, to, target, reason}`（N2），且源码里**没有** `value` 作为工具参数的任何痕迹。
4. `Select-String $R/src/client/entry.ts -Pattern 'position:fixed|inset:0'` → 0（不复活全视口面）。
5. `$C` 只以**布尔/键名**方式出现在验证脚本里：任何验证命令都不得打印 `$C` 的行内容（人工复核脚本本身）。

**A6 机械三连**

```
npm --prefix projects/cordis-plugin-secret run typecheck   # exit 0
npm --prefix projects/cordis-plugin-secret test            # 全绿，用例数只增不减（当前基线 90）
npm --prefix projects/cordis-plugin-secret run build       # exit 0；lib/client/entry.js 无 import/export
npm --prefix projects/cordis-plugin-secret run build 后 git status 只允许出现 lib/ 的构建产物差异
```

### 7.1 B 段：需真人确认（或活体 DOM）

| # | 事项 | 判据（人工/活体） |
|---|---|---|
| B1 | 「管理」入口可达：胶囊头部有「管理」，`detail` 面有「管理」按钮，点开看到两个分区 | 目视；`data-secret-attach-capsule="manage"` 存在 |
| B2 | 管理列表读得清：变量名 + 凭据键 + 作用域 + 来源 + 状态，窄宽度下不被截断 | 目视截图；至少含一条库侧条目（`DSH_SECRET_DSH_SELFTEST_PERSIST` 若还没删） |
| B3 | 不可用的动作确实不出现（库侧独有行没有「解绑」；会话侧独有行没有「真删」） | 目视 + DOM 查询 |
| B4 | 改值（本会话）：掩码框 + 显示/隐藏可用；提交后后续 shell 里 `$env:DSH_SECRET_X` 是新值 | 活体：改前打印一次、改后再打印一次（值不进对话）；`GET /api/secret.manage` 里该行作用域不变 |
| B5 | 改值（凭据库）：危险文案先说清「写库」；提交后 `$C` 里该 ref 变了（**只比对键存在性/长度**，不打印值）；会话内副本也变了 | 活体 + 只读键名核对 |
| B6 | 升为持久：确认面**不要求重输值**，提交后 `$C` 出现该 ref 与 `cordis-plugin-secret/<id>` 记录，`GET /api/secret.manage` 里该行 `scope=persistent`、`can.delete=true` | 活体 + 只读键名核对 |
| B7 | **解绑与真删在界面上不可能被混淆**：解绑的确认只提「本会话」，真删的确认逐字含「不可恢复 / 其它会话」且按钮文案含「真删」 | 目视两条确认面截图对比 |
| B8 | 真删的现场效果：删除后该行从库侧分区消失、会话侧（若存在）作用域变「仅本次会话」、历史多一条「已从凭据库删除」；**其它三条外来记录一字未动** | 活体 + `$C` 键名核对（`client-connection/`、`deepseek-account-platform/` 仍在） |
| B9 | Agent 路径：让 Agent 调 `secret_manage(action:'list')` → 它只报变量名；调 `unbind`/`delete` → 卡上出现确认，点「拒绝」后**什么都没发生**，点「同意」后动作生效 | 活体对话两条各一次 |
| B10 | Agent 拿不到值：让它总结 `list` 结果与自己的上下文 —— 不得出现任何值；`action:'value'` 时工具**不接受**值参数（让它试着传，看服务侧 `validateManage` 的参数校验是否拒绝） | 活体对话 + 工具 schema 复核 |
| B11 | 子代理调用：`action:'list'` 不挂起（返回空或本报文会话的变量）；四个写动作得到 `DELEGATED_CALLER` 结构化失败而**不挂起** | 活体：用子代理试一次 |
| B12 | 超时：故意不回答任何确认 → `TIMEOUT`，且没有任何持久变化 | 活体，至少一次 |
| B13 | 刷新与重启：刷新后管理面列表仍在（来自 Host 现算）；Host 重启后历史为空但库侧条目仍在（管理面仍列出它） | 活体（重启由人类手动执行） |
| B14 | 四种会话形态都不炸：无会话 / `session-maybe` / 无 `locale` / 无 `inputTriggers` | 目视：**不得**出现整页 boot 失败（第三轮 t7 的缺陷类型） |
| B15 | 遗留凭据删除走一遍 §3.6 的 1–10 步 | 活体 + `$C` 只读核对；删后 `Select-String -Quiet` = `False` |

---

## 8. 风险与未决

### 8.1 需要用户拍板（4 条，均已给出推荐）

| # | 问题 | 推荐 | 若不采纳的后果 |
|---|---|---|---|
| U1 | Agent 的 `list` 是否允许委派子代理调用（只读、值无关）？ | **允许**：只读且不给值；返回的是**调用者自己会话**的事实，子代理拿不到父会话的变量（诚实空列表 + 说明） | 不允许 ⇒ 子代理仍然「不知道自己能用什么」，本轮 Read 缺口在子代理侧留着 |
| U2 | `scope → persistent` 时，值用**本会话已持有的那份**（不重输），还是要求人类在掩码框**重新输入**一遍？ | **用已持有的那份**（人类已在危险/确认面上被告知「将把本会话当前持有的值写入凭据库」，构成知情同意；重输只是摩擦） | 要求重输 ⇒ 更保守但多一步；此时只需把 `expectValue` 改成 `action==='value' \|\| action==='scope'`（§3.3 已标注该开关），状态机与路由都不改 |
| U3 | `scope → session`（降级）允许「顺带删库」吗？（它必然要删库，否则作用域是假的） | **允许，并按危险确认处理**（文案逐字写「会删除凭据库里的记录」） | 不允许 ⇒ 用户想降级只能先真删再重新附加一次，多两步且中途会话里没有该变量 |
| U4 | 真删之后，会话里那份仍在内存的值是否**立即**也不可用（更保守），还是**继续可用直到锚点失效**（更如实）？ | **继续可用**（它是 P4 的既有事实，删库不等于撤权；作用域如实降为 `session`） | 立即不可用 ⇒ 等于偷偷替用户做了一次撤权，且「解绑」与「真删」的差别被抹平，违反第 2 条边界 |

### 8.2 风险表

| 项 | 说明 | 处置 |
|---|---|---|
| R1 | `unset` 被启动环境遮蔽（L4/L9）导致「删不掉」 | `STORE_SHADOWED` + 逐字指引（C5）；`deleteRecord` 不执行，绝不制造半状态 |
| R2 | 真删两步之间的半状态 | `STORE_DELETE_FAILED` + 逐字说明 + **不写历史**（C6、§4.4-2） |
| R3 | 管理卡与授权卡共用 `PendingStore` 与轮询 | 两张卡按 `callId` 各自认领（`:482-493`）；新字段是可选加字段，旧客户端忽略（§1.4） |
| R4 | 历史新增事件与客户端白名单不同步 → 新事件被静默丢弃 | 四处镜像 + `HISTORY_EVENTS`/`HISTORY_LABEL` 同键集测试（A4.6）；Host 先写、客户端后认，版本偏斜时丢弃优于误渲染 |
| R5 | 「改值」后会话内副本与凭据库不一致 | `value target='store'` 必须**同时**写库与更新会话内副本（A2.6 断言两处都变）；`target='session'` 明确**不**动库（并在 UI 上写明） |
| R6 | `recordKeyId` 把 `_` 换成 `-`，因此 `a_b` 与 `a-b` 会撞同一条记录键 | 既有事实，不在本轮修；真删按记录键寻址，撞键时删的是同一条（会在文档与 README 的已知限制里如实写明） |
| R7 | `list` 把库侧条目也列给 Agent（名字而已） | 值无关、且与人类 `@` 菜单同源；若用户认为过宽，U1 的对偶问题可在实现前收紧为「只列本会话可用」，改动集中在 `manageList` 一处 |
| R8 | 新路由扩大攻击面（删除能力上线） | 全部落在既有信任栅栏（同源 + 签名 Cookie + 本机）；`delete` 必须 `confirm:true`；只寻址自己 scope 的记录；N4/N5 单测 |
| R9 | 历史是纯内存态，`deleted` 这种盘上事实在重启后无迹 | 明确写进 UI（既有 `historyNotice`）与 README；不谎称落盘 |
| R10 | `scope→persistent` / `value target='store'` 在 seam 失败时的「值可能已进库」 | 复用既有 O1 措辞，禁止绝对断言（C7） |

### 8.3 用户裁定（定案之后拍板；实施与验收以本节为准）

四条裁定与 §8.1 的推荐基本一致，**只有 U3 被改严**：

| # | 用户裁定 | 与 §8.1 推荐的差别 |
|---|---|---|
| U1 | `list` 允许委派子代理调用（只读、值无关）；**删除与改作用域仅限主 Agent** | 一致 |
| U2 | 升为持久**不要求重新输入值**，用会话已持有的那份；确认面必须写明「将把本会话当前持有的值写入凭据库」 | 一致 |
| U3 | **降级不删库**：降级给**两个明确按钮**——「仅改为本会话（保留库中记录）」与「不再持久，并从库中删除」（后者就是真删动作） | **与推荐相反**。§8.1 曾允许 `scope→session` 顺带删库；用户裁定禁止隐藏的破坏性副作用，因此 `scope→session` 零持久写，破坏性方向由 `delete` 承担。§3.5 危险面里「`scope→session`＝会删除凭据库里的记录」一句随之作废（危险面只剩 `unbind` 与 `delete` 两个问句） |
| U4 | 真删后会话内副本**继续可用**，作用域如实降为 `session`，并在 UI 与历史标注 | 一致 |
| U5（第二轮追加，用户裁定 ①） | **管理列表的「本会话可用」分区必须同时列出两个方向**：人工附加（`staged`/`bound`）**与** Agent 经 `secret_request` 获得的本会话授权（`authorized`）；来源与作用域仍可区分、状态如实，两者不得混为一谈 | **与本定案原先的口径相反**。本节原先写明「沿用 0.3.0 的附加方向口径，`secret_request` 拿到的会话内授权不出现在该列表里，本轮不改」，并把该缺口写进 README 的「0.4.0 三条已知限制」。用户裁定后改为**补进列表**：`manageList` 新增 `requestViews`（按 `Grant.callId` 区分「问方向」的授权与「附加方向」绑定时建的授权），行上新增 `origin` 与 `state:'authorized'`，一个变量仍只占一行。原来的「已知限制」条目随之改写为「一个变量只占一行」的如实说明 |

**F2 裁定（t3 质量门，收录原文要点）：** 「工具参数 JSON schema 的根是**开放**的（`additionalProperties` 未声明 `false`），承重门槛是服务侧 `validateManage`……若文档声称"schema 自身拒绝 value"则不准确」；t3 的处置建议是「**只改措辞、不要动代码**」（收紧 schema 在 dsh-tools 的契约里对工具参数根不可表达，且属模型面契约变更，收益与代价不成比例）。本轮据此只改 README 措辞（§3.2 的属性名集合断言与 README:352 被 t3 判定为**准确**，不动）。

另：管理列表的「本会话可用」分区在第二轮已补上另一个方向（见 U5）；`available()`（`@` 菜单）**不变**——菜单的职责是"把一枚密钥登记到某条消息"，与会话内已注入的授权是两件事，本裁定只针对管理列表。

**R5 已知限制（质量门 r2／t7 报出；0.4.0 已发布，本轮只做文档记录、不返工）：** `manageList`（`src/service.ts:848` 起）在两方向重叠时会把「问方向」的事实藏起来——同一变量若**既有一条人工附加记录（`staged`/`bound`）又有一份经 `secret_request` 的活跃会话授权**，附加行先入行，`requestViews` 的 `seen`（`:889-896`）随即跳过该变量，于是列表只回一行 `{state:'staged', origin:'attach', source:'session'}`，而这枚变量其实**已被授权、可注入**；问方向的授权只在本会话**历史**（`authorized` / 来源 `request`）里可见。**复现两步**：附上某变量但不发送 → 再对同名变量 `secret_request` 并批准（此时历史里 `authorized:request` 与 `staged:attach` 并存，列表只报附加那一面）。口径如上 U5：列表的既定边界是**一个变量只占一行**，重叠时该行报**人工附加那一面**（`origin='attach'`）。影响范围**仅**人类管理列表在重叠场景下**低估可用性、方向不完整**：**不泄漏任何值**、**不误报可执行动作**（该行 `can.*` 仍为真、`unbind` 仍能撤掉本会话暴露），**安全不变量与权限边界未受影响**。t7 的处置建议是 low、非阻塞、**不让 0.4.0 发布返工**，故仅记入 README 的「0.4.0 四条已知限制」，代码留待发布后单独立项。

---

## 9. 由本定案直接决定的 t2 实施顺序

1. **Host 地基（先绿纯逻辑）**：`src/adapters.ts` 的 3 个新方法 + `preloaded`；`src/types.ts` 的新类型与两个联合扩容；`src/protocol.ts` 的 `parseManage`/`manageView`/`pendingView` 透传；`GrantStore.unbind` + `revoked-unbound`；`AttachStore.reScope`。→ A1/A2 的纯逻辑部分先绿。
2. **Host 执行器与路由**：`SecretService.manageList` / `manage` / `manageAction` + 四个执行器 + `answer()` 的一行改动；`src/routes.ts` 两条新路由；`src/index.ts` 注册第二个工具。→ A2（尤其 N4/N5 与两步删除）/A3 全绿。
3. **Client 纯函数与字典**：`readManageList`/`readManageEntry`/`manageCan`/`describeManage`、`postManage`/`refreshManage`、`HISTORY_EVENTS`/`HISTORY_LABEL`/两本字典、新常量。→ A4 的纯函数部分先绿。
4. **Client 三个面**：`manage`/`edit`/`danger` + 头部第二个链接 + `detail` 面的「管理」按钮。→ A4.4 绿。
5. **Client 管理卡**：`secretManageDefinition` + `SecretManageCard` + `HiddenSecretManageToolRow` + 两处注册。→ A4.2/A4.3 绿。
6. **第三个 SEAM** + 键集断言；两个既有 SEAM 键集**改为回归断言**（证明它们没动）。
7. **三连**（typecheck / test / build）+ A5 静态判据 + A1 机制复核打印（贴原始输出）。
8. **发布任务（不在本任务范围）**：改 `package.json` version → `0.4.0`；README 同步 5 处（路由条数 8 → 10、工具表加 `secret_manage`、安全不变量里 P2 的枚举加 `manage`、副作用披露的座位/路由清单、已知限制加 R6 撞键与「历史是内存态」的复述）。
9. 把 §7.1 的 B1–B15 交给独立验证：**A 段全绿** + **B 段逐条给出人工结论或「未验证」**，不得推定。§3.6 的遗留凭据删除（B15）属于发布后的现场动作，**由用户执行或用户在场时执行**，不作为 t2/t3 的通过条件。
