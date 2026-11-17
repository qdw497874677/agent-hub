import { useState } from 'react';
import { mcpGuide, type McpClientKind } from '../atoms/mcp-guide.ts';

const BTN = 'rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-accent hover:text-accent';

/**
 * 外部智能体接入 MCP 的一页说明：端点、各家客户端片段、给 agent 的提示词。
 * 令牌没给时用占位符——别把「ahp_粘贴你的令牌」当真的复制走。
 */
export function McpGuidePanel({ token }: { token?: string | null }) {
  const [tab, setTab] = useState<McpClientKind>('claude');
  const [copied, setCopied] = useState(false);
  const guide = mcpGuide({ origin: window.location.origin, token: token ?? null });
  const snippet = guide.snippets[tab];
  return (
    <section data-testid="mcp-guide" className="mt-4 rounded-sm border border-hair bg-card p-3">
      <p className="text-meta text-primary">外部智能体接入 MCP</p>
      <p className="mt-1 text-[11px] text-tertiary">
        端点 <code className="select-all break-all font-mono text-[11px] text-secondary">{guide.url}</code>
        ，请求头 <code className="select-all font-mono text-[11px] text-secondary">{guide.header}</code>。写工具要服务端开 <code className="font-mono">MCP_WRITE=1</code>
        ，令牌带「改项目和任务」「发起会话」；只读工具只要有「读项目和任务」就够。
      </p>
      <div role="tablist" aria-label="接入方式" className="mt-2 flex flex-wrap gap-1.5">
        {guide.tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            data-testid="mcp-guide-tab"
            data-tab={item.id}
            className={`rounded-sm border px-2 py-1 text-meta ${tab === item.id ? 'border-accent text-accent' : 'border-hair text-secondary hover:text-primary'}`}
            onClick={() => {
              setTab(item.id);
              setCopied(false);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <pre
        data-testid="mcp-guide-snippet"
        data-tab={tab}
        className="mt-2 max-h-[38dvh] overflow-auto rounded-sm bg-panel px-2 py-2 font-mono text-[11px] whitespace-pre-wrap text-primary"
      >
        {snippet}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <button
          data-testid="mcp-guide-copy"
          className={BTN}
          onClick={() => {
            void navigator.clipboard?.writeText(snippet).then(() => setCopied(true));
          }}
        >
          {copied ? '已复制' : '复制这段'}
        </button>
        {tab === 'prompt' && <span className="text-[11px] text-tertiary">贴到外部 agent 的系统提示或 AGENTS.md 里。</span>}
      </div>
    </section>
  );
}
