import { useState } from 'react';
import { mcpGuide, type McpClientKind } from '../atoms/mcp-guide.ts';
import { CopyButton, ManualCopy, useCopy } from '../atoms/copy.tsx';

const BTN = 'rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-strong hover:text-primary';

/**
 * 外部智能体接入 MCP 的一页说明：端点、各家客户端片段、给 agent 的提示词。
 * 片段里只引用环境变量 AGENT_HUB_TOKEN，明文令牌不会出现在这里。
 */
export function McpGuidePanel() {
  const [tab, setTab] = useState<McpClientKind>('claude');
  const guide = mcpGuide({ origin: window.location.origin });
  const snippet = guide.snippets[tab];
  const copies = useCopy(snippet);
  return (
    <section data-testid="mcp-guide" className="mt-4 rounded-sm border border-hair bg-card p-3">
      <p className="text-meta text-primary">外部智能体接入 MCP</p>
      <p className="mt-1 text-[11px] text-tertiary">
        端点 <code className="select-all break-all font-mono text-[11px] text-secondary">{guide.url}</code>
      </p>
      <p className="mt-1 text-[11px] text-tertiary">
        先把令牌放进环境变量 <code className="select-all font-mono text-[11px] text-secondary">{guide.envVar}</code>，下面的配置只引用它，不写明文。
      </p>
      <p className="mt-1 text-[11px] text-tertiary">外部智能体只会看到令牌权限内的工具；建任务、发起会话这类写操作还要管理员开启。</p>
      <div role="tablist" aria-label="接入方式" className="mt-2 flex flex-wrap gap-1.5">
        {guide.tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            data-testid="mcp-guide-tab"
            data-tab={item.id}
            className={`rounded-sm border px-2 py-1 text-meta ${tab === item.id ? 'border-fg/40 bg-selected text-primary' : 'border-hair text-secondary hover:text-primary'}`}
            onClick={() => setTab(item.id)}
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
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <CopyButton action={copies} label="复制这段" testId="mcp-guide-copy" className={BTN} />
        <a
          data-testid="skill-download"
          className={BTN}
          href={guide.skillUrl}
          download="agent-hub-workbench.zip"
        >
          下载 agent-hub-workbench skill
        </a>
        <span className="text-[11px] text-tertiary">
          zip 里是 SKILL.md 和 references/，也可 GET {guide.skillUrl}?format=json，或在 MCP 里 resources/read。
        </span>
        {tab === 'prompt' && <span className="text-[11px] text-tertiary">把提示词贴到外部 agent 的系统提示或 AGENTS.md 里。</span>}
      </div>
      {copies.manual ? (
        <ManualCopy text={snippet} attempt={copies.attempts} testId="mcp-guide-manual" className="mt-2" />
      ) : null}
    </section>
  );
}
