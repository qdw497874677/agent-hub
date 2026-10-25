import type { SessionDto } from './api.ts';
import { api } from './api.ts';
import { IMAGE_TYPES, nextId, type Draft, type SlashCommand } from './attachments.ts';

/** `/` 命令：都是界面上已有的动作，只是给键盘一条近路。 */
export function sessionCommands(session: SessionDto, extra: readonly SlashCommand[] = []): SlashCommand[] {
  const commands: SlashCommand[] = [
    { name: 'interrupt', hint: '中断这一轮', run: () => api.interrupt(session.id) },
    {
      name: 'new',
      hint: '同一任务、同一 agent 再开一条会话',
      run: () => api.derive({ taskId: session.taskId, agentId: session.agentId, model: session.model })
    }
  ];
  if (session.lastSeq > 0) {
    commands.push({
      name: 'fork',
      hint: `从最新一条（#${session.lastSeq}）分叉`,
      run: () => api.fork({ sessionId: session.id, atSeq: session.lastSeq, agentId: session.agentId, model: session.model })
    });
  }
  return [...commands, ...extra];
}


/** 浏览器 File → Draft。粘贴的截图没有名字，给它一个。 */
export async function readDraft(file: File): Promise<Draft> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读不出文件'));
    reader.readAsDataURL(file);
  });
  const data = url.slice(url.indexOf(',') + 1);
  const image = IMAGE_TYPES.includes(file.type);
  const name = file.name === '' || file.name === 'image.png' ? `paste-${Date.now()}.${file.type.split('/')[1] ?? 'bin'}` : file.name;
  return {
    kind: image ? 'image' : 'file',
    id: nextId(),
    name,
    mimeType: file.type === '' ? 'application/octet-stream' : file.type,
    data,
    bytes: file.size,
    ...(image ? { preview: url } : {})
  };
}

