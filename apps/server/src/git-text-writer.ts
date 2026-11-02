import { parseGitText, parseHubModel, providerUsableIn, secretKind, type AuditLog, type GitText, type GitTextInput, type GitTextWriter, type MemorySettingsStore, type ProviderRepository } from '@agent-hub/domain';
import { authHeaders, buildRequest, extractText } from './model-distiller.ts';

/**
 * 提交说明 / PR 文案 / 分支名（ADR 0027 D4）：用项目的提炼模型（ADR 0024 同一套挑选和核对），hub 进程直调上游。
 * 没配、不能用、失败都返回 null，调用方用规则模板。diff 里像密钥的整段不送，只送文件清单。
 */
export interface GitTextWriterDeps {
  readonly settings: Pick<MemorySettingsStore, 'distillModel'>;
  readonly providers: Pick<ProviderRepository, 'bySlug' | 'revealKey' | 'addUsage'>;
  readonly projectTeam: (projectId: string) => Promise<string | null>;
  readonly audit: Pick<AuditLog, 'append'>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const SYSTEM = [
  '你给一次代码改动写 git 提交说明和 PR 文案。输入：任务标题、改动文件清单、diff（可能截断）、工作日志摘要。',
  '只输出一个 JSON 对象，不要别的文字：{"message":"…","title":"…","body":"…","branch":"…"}',
  'message：git 提交说明，首行 ≤ 72 字符的概括，空一行后列要点。',
  'title：PR 标题（≤ 72 字符）。body：PR 描述（markdown，讲做了什么、为什么、怎么验证）。',
  'branch：语义分支名，形如 feat/short-kebab-name（前缀只能是 feat fix chore docs refactor test perf）。',
  '语言跟随任务标题和工作日志。绝不输出密码、令牌、密钥等凭据。'
].join('\n');

export function createGitTextWriter(deps: GitTextWriterDeps): GitTextWriter {
  const doFetch = deps.fetch ?? fetch;
  return {
    async write(input: GitTextInput): Promise<GitText | null> {
      const model = await deps.settings.distillModel(input.projectId);
      const parsed = parseHubModel(model ?? undefined);
      if (!model || !parsed) return null;
      const provider = await deps.providers.bySlug(parsed.slug);
      if (!provider || provider.scope === 'personal' || !provider.models.some((m) => m.id === parsed.modelId)) return null;
      const team = await deps.projectTeam(input.projectId);
      if (!providerUsableIn(provider, team, null).ok) return null;
      const apiKey = await deps.providers.revealKey(provider.id);
      if (!apiKey) return null;
      const files = input.files.slice(0, 200).map((f) => `${f.status} ${f.path}`).join('\n');
      const patch = secretKind(input.patch) ? '（diff 里疑似有密钥，没有发送）' : input.patch;
      const log = secretKind(input.workLog) ? '' : input.workLog;
      const user = `任务：${input.taskTitle}\n\n改动文件：\n${files}\n\ndiff：\n${patch}\n\n工作日志：\n${log}`;
      const started = deps.now();
      let failure: string | null = null;
      let out: GitText | null = null;
      let bytesIn = 0;
      let bytesOut = 0;
      try {
        const request = buildRequest(provider, parsed.modelId, SYSTEM, user);
        bytesOut = Buffer.byteLength(request.body);
        const response = await doFetch(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(provider, apiKey) },
          body: request.body,
          signal: AbortSignal.timeout(deps.timeoutMs ?? 45_000)
        });
        const raw = await response.text();
        bytesIn = Buffer.byteLength(raw);
        if (!response.ok) throw new Error(`上游 ${response.status}`);
        out = parseGitText(extractText(provider, raw));
        if (!out) throw new Error('模型没给出可用的 JSON');
        if (secretKind(`${out.message}\n${out.title}\n${out.body}`)) throw new Error('输出疑似含密钥');
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 120) : '调用失败';
        out = null;
      }
      await deps.providers.addUsage(provider.id, { requests: 1, errors: failure ? 1 : 0, bytesIn, bytesOut }, deps.now()).catch(() => undefined);
      await deps.audit
        .append({
          id: crypto.randomUUID(),
          actorId: 'system' as never,
          actorEmail: '',
          action: 'git.text',
          target: `project:${input.projectId}`,
          detail: `${model} · ${failure ? `失败（${failure}），用模板` : '已生成'} · 发 ${bytesOut}B 收 ${bytesIn}B · ${deps.now() - started}ms`,
          at: deps.now(),
          ...(team ? { teamId: team } : {})
        })
        .catch(() => undefined);
      if (failure) deps.log(`提交文案生成失败（${model}：${failure}），用模板`);
      return out;
    }
  };
}
