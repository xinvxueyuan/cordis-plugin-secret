import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SecretConfig } from './config.ts'
import type { SecretService } from './service.ts'

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
