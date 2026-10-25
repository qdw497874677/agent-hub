import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 工作日志正文按 markdown 渲染。安全性：
 * - react-markdown 默认不渲染原始 HTML（没有 rehype-raw），`<script>` 等只会显示成文本；
 * - 链接经它默认的 urlTransform 过滤（javascript: 之类被清空），且一律新窗口 + noopener noreferrer；
 * - 图片不加载（防跟踪像素 / 外链），只留替代文字。
 */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline break-all">
      {children}
    </a>
  ),
  h1: ({ children }) => <p className="mt-2 font-semibold">{children}</p>,
  h2: ({ children }) => <p className="mt-2 font-semibold">{children}</p>,
  h3: ({ children }) => <p className="mt-2 font-semibold">{children}</p>,
  h4: ({ children }) => <p className="mt-2 font-semibold">{children}</p>,
  p: ({ children }) => <p className="my-1">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-current/30 pl-3 opacity-80">{children}</blockquote>,
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-black/10 px-1 font-mono text-[0.9em]">{children}</code>
    ),
  pre: ({ children }) => <pre className="my-1 overflow-x-auto rounded bg-black/10 p-2 font-mono text-[0.9em]">{children}</pre>,
  table: ({ children }) => <div className="my-1 overflow-x-auto"><table className="border-collapse text-left">{children}</table></div>,
  th: ({ children }) => <th className="border border-current/20 px-2 py-0.5 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-current/20 px-2 py-0.5">{children}</td>,
  img: ({ alt }) => <span className="opacity-70">[图片{alt ? `：${alt}` : ''}]</span>
};

export function LogMarkdown({ body, className }: { body: string; className?: string }) {
  return (
    <div className={`break-words ${className ?? ''}`} data-testid="log-body">
      <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {body}
      </Markdown>
    </div>
  );
}
