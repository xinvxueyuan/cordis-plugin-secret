import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SecretConfig } from './config.ts'
import type { SecretService } from './service.ts'
import type { SecretDecisionKind, SecretManageDecision, SecretManageMeta, SecretPresentationMeta } from './types.ts'

/** Model-facing rendering of one result. Never contains a secret value. */
function renderResult(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return JSON.stringify(value)
  }
  const result = value as Record<string, unknown>
  switch (result.decision) {
    case 'approved': {
      const scope = result.scope === 'persistent' ? '持久保存到凭据库' : '仅本次会话有效'
      const source = result.source === 'store' ? '凭据库中已有的值' : '本次人工输入'
      const notice = typeof result.notice === 'string' ? `\n注意：${result.notice}` : ''
      return [
        `已获授权。请把变量名 \`${String(result.variable)}\` 传给下游使用：`,
        `- 后续 shell 执行中该变量已自动注入（取值即密钥明文）；`,
        `- 授权范围：${scope}；来源：${source}。`,
        '- 你只会拿到变量名，永远不要尝试打印或回显它的值。',
      ].join('\n') + notice
    }
    case 'rejected':
      return `人工拒绝：${typeof result.reason === 'string' && result.reason.length > 0 ? result.reason : '未说明原因'}。请立即停止该目标，不要重试 secret_request。`
    case 'ignored':
      return '本次未获授权（既非同意也非拒绝）。可以稍后再试，或改用其他方案。'
    case 'other':
      return `人工给出了其他指示：${String(result.text)}`
    default:
      return JSON.stringify(value)
  }
}

/**
 * The value-free settlement payload persisted on `tool/result.meta`.
 *
 * The in-stream card reads it back on the live and replay paths alike, so a
 * refreshed page still renders the settled card without parsing prose. It
 * carries exactly what the agent is told and never any secret material.
 */
function presentationMeta(value: unknown): SecretPresentationMeta {
  const result = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  const decision: SecretDecisionKind =
    result.decision === 'approved' || result.decision === 'rejected' || result.decision === 'ignored' || result.decision === 'other'
      ? result.decision
      : 'other'
  const meta: SecretPresentationMeta = { v: 1, kind: 'secret-request', decision }
  if (decision === 'rejected') {
    return {
      ...meta,
      ...(typeof result.reason === 'string' && result.reason.length > 0 ? { reason: result.reason } : {}),
    }
  }
  if (decision === 'other') {
    return {
      ...meta,
      ...(typeof result.text === 'string' && result.text.length > 0 ? { text: result.text } : {}),
    }
  }
  if (decision !== 'approved') return meta
  const scope = result.scope === 'persistent' ? 'persistent' : result.scope === 'session' ? 'session' : undefined
  const source = result.source === 'store' ? 'store' : result.source === 'entered' ? 'entered' : undefined
  return {
    ...meta,
    ...(typeof result.variable === 'string' && result.variable.length > 0 ? { variable: result.variable } : {}),
    ...(scope === undefined ? {} : { scope }),
    ...(source === undefined ? {} : { source }),
    ...(typeof result.notice === 'string' && result.notice.length > 0 ? { notice: result.notice } : {}),
  }
}

/** The agent-facing `secret_request` tool. */
export function defineSecretRequestTool(service: SecretService, config: SecretConfig) {
  return defineTool({
    name: 'secret_request',
    description:
      '向人类索取一个密钥（secret）并由人类当面授权：返回的永远只是不透明的变量名（如 DSH_SECRET_OPENAI），明文不会进入你的上下文。批准后把变量名传给下游使用——后续 shell 执行会按会话注入该变量，persistent 时它同时可被当作凭据引用解析。decision 取值：approved（附 variable/scope/ref/source）、rejected（人类拒绝，必须停止且不得重试）、ignored（本次未授权，可稍后再试）、other（人类的自由文本指示，按其执行）。只有活跃的会话根代理拥有可回答的人类；被委派的子代理调用会得到结构化失败而不会挂起。',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description:
          '凭据键：小写 kebab/snake，如 "openai"、"openai-key"、"openai_key"。决定对外暴露的变量名 DSH_SECRET_<UPPER_SNAKE>，除非用 envVar 覆盖。',
      },
      label: {
        type: 'string',
        required: true,
        description: '展示在授权对话框中的人类可读标题，例如 "OpenAI API Key"。',
      },
      reason: {
        type: 'string',
        required: true,
        description:
          '你需要它的原因。会原样展示给要授权的人，也是对方同意的那份理由；请具体说明用途与范围（例如"用于调用 OpenAI 兼容接口补全 /v1/chat/completions 测试"）。',
      },
      scope: {
        type: 'string',
        enum: ['session', 'persistent'],
        required: true,
        description:
          '由你显式选择：session=仅在本次会话内存中持有、会话结束即失效（一次性/临时密钥用这个）；persistent=写入凭据库、之后可复用（长期凭据用这个）。对话框会突出显示该选择，且人类可以改成另一个。',
      },
      description: {
        type: 'string',
        description: '可选的补充说明，展示在对话框里帮助人类判断。',
      },
      envVar: {
        type: 'string',
        description:
          '可选：覆盖对外暴露的变量名，必须形如 DSH_SECRET_OPENAI 且不得使用 DSH_HOME/DSH_SHELL/DSH_SESSION_ID/DSH_PROFILE/DSH_PROFILE_DIR。默认 DSH_SECRET_<UPPER_SNAKE(name)>。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      // Persisted on tool/result.meta: the durable, model-invisible source of a
      // settled card's state. The visible rendering above is unchanged.
      presentationMeta: (_args, value) => presentationMeta(value),
    },
    // One human answers one dialog at a time: never join a parallel group.
    isConcurrencySafe: () => false,
    // The tool's own human timeout must fire before any cooperative call timeout.
    timeoutMs: config.requestTimeoutMs + 30000,
    async execute(args, exec) {
      return await service.request(args, {
        agent: exec.agent,
        callId: String(exec.callId),
        signal: exec.signal,
      })
    },
  })
}

/** How many variable names one `list` rendering spells out before eliding. */
const MANAGE_RENDER_LIMIT = 24

/**
 * Model-facing rendering of one management result.
 *
 * The listing spells out variable names and what each one is, and nothing else:
 * there is no field here a value could ride in, and the count of rows is what
 * tells the model whether the list was truncated.
 */
function renderManageResult(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return JSON.stringify(value)
  }
  const result = value as Record<string, unknown>
  switch (result.decision) {
    case 'listed': {
      const entries = Array.isArray(result.entries) ? result.entries : []
      if (entries.length === 0) {
        return '本会话与凭据库里目前都没有你可用/可管理的密钥变量。密钥要由人类提供（在会话里附加，或由人类确认你的一次 secret_request）。'
      }
      const shown = entries.slice(0, MANAGE_RENDER_LIMIT).map((raw) => {
        const entry = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
        const scope = entry.scope === 'persistent' ? '持久' : '仅本会话'
        const state =
          entry.state === 'bound'
            ? '已绑定到消息'
            : entry.state === 'staged'
              ? '已登记未发送'
              : entry.state === 'authorized'
                ? '已授权（Agent 经 secret_request 获得）'
                : '仅在凭据库'
        const source = entry.source === 'both' ? '本会话+凭据库' : entry.source === 'store' ? '凭据库' : '本会话'
        const can = typeof entry.can === 'object' && entry.can !== null ? (entry.can as Record<string, unknown>) : {}
        const actions = [
          can.unbind === true ? 'unbind' : undefined,
          can.delete === true ? 'delete' : undefined,
          can.scope === true ? 'scope' : undefined,
          can.value === true ? 'value' : undefined,
        ].filter((action): action is string => action !== undefined)
        return `- \`${String(entry.variable)}\`（${source} · ${scope} · ${state}；该行支持的动作：${actions.join('/') || '无'}）`
      })
      const more = entries.length > shown.length ? `\n（共 ${String(entries.length)} 条，只列出前 ${String(shown.length)} 条。）` : ''
      // A row's `can` describes the row, not the caller. Whenever the Host
      // proved this caller cannot run those actions, its own notice says so, and
      // it is echoed verbatim rather than paraphrased.
      const notice = typeof result.notice === 'string' && result.notice.length > 0 ? `\n注意：${result.notice}` : ''
      return [
        `你当前可用/可管理的密钥变量共 ${String(entries.length)} 条（只给变量名，永远不会有值）：`,
        ...shown,
        more,
        notice,
      ].filter((line) => line.length > 0).join('\n')
    }
    case 'applied': {
      const scope = result.scope === 'persistent' ? '持久保存到凭据库' : '仅本次会话有效'
      const notice = typeof result.notice === 'string' && result.notice.length > 0 ? `\n注意：${result.notice}` : ''
      return `已完成 ${String(result.action)}：变量 \`${String(result.variable)}\` 现在的范围是「${scope}」。你仍然只会拿到变量名。` + notice
    }
    case 'rejected':
      return `人工拒绝：${typeof result.reason === 'string' && result.reason.length > 0 ? result.reason : '未说明原因'}。请立即停止该目标，不要重试 secret_manage。`
    case 'ignored':
      return '本次未获人工确认（既非同意也非拒绝）。可以稍后再试，或改用其他方案。'
    case 'other':
      return `人工给出了其他指示：${String(result.text)}`
    default:
      return JSON.stringify(value)
  }
}

/** The value-free settlement payload persisted for `secret_manage`. */
function managePresentationMeta(value: unknown): SecretManageMeta {
  const result = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  const decision: SecretManageDecision =
    result.decision === 'listed'
    || result.decision === 'applied'
    || result.decision === 'approved'
    || result.decision === 'rejected'
    || result.decision === 'ignored'
    || result.decision === 'other'
      ? result.decision
      : 'other'
  const meta: SecretManageMeta = { v: 1, kind: 'secret-manage', decision }
  if (decision === 'rejected') {
    return {
      ...meta,
      ...(typeof result.reason === 'string' && result.reason.length > 0 ? { reason: result.reason } : {}),
    }
  }
  if (decision === 'other') {
    return {
      ...meta,
      ...(typeof result.text === 'string' && result.text.length > 0 ? { text: result.text } : {}),
    }
  }
  if (decision === 'listed') {
    return { ...meta, ...(Array.isArray(result.entries) ? { count: result.entries.length } : {}) }
  }
  if (decision !== 'applied') return meta
  const action = result.action
  const scope = result.scope === 'persistent' ? 'persistent' : result.scope === 'session' ? 'session' : undefined
  return {
    ...meta,
    ...(action === 'unbind' || action === 'delete' || action === 'scope' || action === 'value' ? { action } : {}),
    ...(typeof result.variable === 'string' && result.variable.length > 0 ? { variable: result.variable } : {}),
    ...(scope === undefined ? {} : { scope }),
    ...(typeof result.notice === 'string' && result.notice.length > 0 ? { notice: result.notice } : {}),
  }
}

/**
 * The agent-facing `secret_manage` tool.
 *
 * It is a second tool rather than a mode of `secret_request` on purpose: the
 * request tool's schema, result, in-stream card and persisted meta are a frozen
 * contract from round 3, and a management action asks a *different* question
 * (confirm this change) whose answers are not a new secret request.
 *
 * The one promise the schema itself carries: **there is no way to pass a
 * value**. A human types it into the confirmation surface if an action needs
 * one, and the agent never sees it.
 */
export function defineSecretManageTool(service: SecretService, config: SecretConfig) {
  return defineTool({
    name: 'secret_manage',
    description:
      '管理你已经拿到（或人类已存入凭据库）的密钥变量的**元数据**：列出可用变量、解绑（只影响本会话）、从凭据库删除记录、改作用域、请人类改值。' +
      '任何动作都拿不到、也提交不了密钥明文——需要值时由人类在确认界面里输入，你只会继续拿到变量名。' +
      'action 取值：list（只读列举，立即返回，不需要人类，返回每条 variable/name/label/scope/state/source/origin/can；origin 说明本会话这份是人工附加的还是你经 secret_request 获得的；can 是该行支持什么，不是你能执行什么）；' +
      'unbind（从**本会话**移除该变量，凭据库不动，立即生效，人只被知会不需要确认——但仍会经过一次确认卡片以免误触）；' +
      'delete（从**凭据库**删除这条记录，不可恢复，必须经人类在卡片上确认）；' +
      'scope（改本会话这份记录的作用域：to:"persistent" 会把本会话已持有的值写入凭据库并必须经人类确认；to:"session" 只把本会话这份改成仅本次会话，凭据库里的记录**保留**，不删除任何东西）；' +
      'value（请人类改值，target:"session" 改本会话这份，target:"store" 改凭据库里的那份；值只能由人类输入）。' +
      'delete 与 unbind 是两件不同的事，不要混用：unbind 只影响你自己的会话，delete 会让所有会话都用不到它。' +
      '拒绝（rejected）时必须停止该目标且不得重试；未确认（ignored）可稍后再试。只有活跃的会话根代理有可回答的人类；list 之外的动作被委派子代理调用会得到结构化失败而不会挂起。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'unbind', 'delete', 'scope', 'value'],
        required: true,
        description:
          '要做的管理动作。list=只读列举；unbind=从本会话移除；delete=从凭据库真删（需人类确认，不可恢复）；scope=改作用域；value=请人类改值。',
      },
      variable: {
        type: 'string',
        description:
          '目标变量名，形如 DSH_SECRET_OPENAI（必须与现有条目完全一致；可先用 action:"list" 列出）。除 list 外必填。',
      },
      to: {
        type: 'string',
        enum: ['session', 'persistent'],
        description:
          '仅 action:"scope" 使用：把本会话这份记录改成哪个作用域。persistent 会把本会话已持有的值写入凭据库（需人类确认）；session 只把本会话这份改成仅本次会话，凭据库里的记录保留——要连记录一起删请用 action:"delete"。',
      },
      target: {
        type: 'string',
        enum: ['session', 'store'],
        description:
          '仅 action:"value" 使用：改本会话这份值（session），还是改凭据库里的那份（store）。值由人类输入，你不提供也不接收值。',
      },
      reason: {
        type: 'string',
        required: true,
        description:
          '你为什么要做这个动作。会原样展示给要确认的人，也是对方同意的那份理由；请具体说明用途与范围。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderManageResult(value) }],
      presentationMeta: (_args, value) => managePresentationMeta(value),
    },
    // One human answers one confirmation at a time: never join a parallel group.
    isConcurrencySafe: () => false,
    timeoutMs: config.requestTimeoutMs + 30000,
    async execute(args, exec) {
      return await service.manageRequest(args, {
        agent: exec.agent,
        callId: String(exec.callId),
        signal: exec.signal,
      })
    },
  })
}
