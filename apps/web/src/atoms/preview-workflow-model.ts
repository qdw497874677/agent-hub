import type { PreviewDiagnostic, PreviewWorkflowTarget } from '../shell/api/preview-types.ts';

/** 只打开服务端明确提供的 http(s) 入口；不补协议、不接受凭据。 */
export function safePreviewUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function workflowTargetUrl(target: PreviewWorkflowTarget): string | null {
  return target.mapping === 'ready' && target.linkId !== null ? safePreviewUrl(target.url) : null;
}

/** 诊断绑定到具体映射；名称变化不改变被检查的目标。 */
export function diagnosticTargetIdentity(target: PreviewWorkflowTarget): string {
  return JSON.stringify([target.linkId, target.workerId, target.port, target.mapping, target.url]);
}

export function transportLimited(pageProtocol: string, url: string): boolean {
  return pageProtocol === 'https:' && new URL(url).protocol === 'http:';
}

export function previewFeedbackPath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const origin = 'https://preview.invalid';
    const parsed = new URL(value, origin);
    return parsed.origin === origin ? parsed.pathname : null;
  } catch { return null; }
}

export function serviceWorkflowTargets(targets: readonly PreviewWorkflowTarget[], port: number, workerId: string): readonly PreviewWorkflowTarget[] {
  return targets.filter((target) => target.port === port && target.workerId === workerId);
}

export function diagnosticText(diagnostic: PreviewDiagnostic): string {
  switch (diagnostic.state) {
    case 'worker_offline': return '机器离线';
    case 'channel_unavailable': return '预览通道未连通';
    case 'listener_unavailable': return '预览入口未就绪';
    case 'refused': return '预览目标拒绝连接';
    case 'response': return diagnostic.status === null ? '页面已响应' : `页面返回 HTTP ${diagnostic.status}`;
    case 'timeout': return '检查超时，未能确认';
    default: return '未能确认';
  }
}
