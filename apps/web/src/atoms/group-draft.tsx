import { NameDot } from './author.tsx';
import { BUBBLE_MD, LogMarkdown } from './log-markdown.tsx';

/**
 * 闪烁光标：画在 markdown 最后一个子元素的 `::after` 上，所以它紧跟最后一个字，
 * 而不是另起一行。`content-['']` 给空内容，靠背景色当竖条；`motion-safe` 让关掉动效的人看到静止光标。
 */
const CARET =
  "motion-safe:[&>*:last-child]:after:animate-pulse [&>*:last-child]:after:ml-0.5 [&>*:last-child]:after:inline-block [&>*:last-child]:after:h-3 [&>*:last-child]:after:w-[2px] [&>*:last-child]:after:align-[-2px] [&>*:last-child]:after:bg-accent [&>*:last-child]:after:content-['']";

/**
 * 成员还没发出来的话：虚线气泡 + 光标，标题行写谁在写。
 *
 * 只是个投影——正文由外面拼好（`group-live.draftText`）再传进来，这里不判断该不该显示。
 */
export function DraftBubble({ role, body }: { readonly role: string; readonly body: string }) {
  return (
    <li data-testid="group-draft" data-role={role} className="my-1.5 flex items-start gap-2">
      <NameDot name={role} />
      <div className="flex min-w-0 max-w-[85%] flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-meta text-tertiary">
          <span className="max-w-[45vw] truncate">{role}</span>
          <span className="flex items-center gap-1 text-sage">
            <span aria-hidden className="flex gap-0.5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1 w-1 rounded-full bg-current motion-safe:animate-pulse"
                  style={{ animationDelay: `${i * 160}ms` }}
                />
              ))}
            </span>
            正在输入
          </span>
        </span>
        <div className="rounded-md border border-dashed border-hair bg-card px-3 py-1.5">
          <LogMarkdown body={body} className={`${BUBBLE_MD} ${CARET}`} />
        </div>
      </div>
    </li>
  );
}
