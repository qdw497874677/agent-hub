/**
 * 临时诊断：真机上看不到控制台，把布局实测值发回服务器（`POST /api/client-diag`），
 * 同时在 URL 带 `?diag=1` 时画一块浮层。定位完连同服务端那条路由一起删。
 */
interface Snapshot {
  readonly step: string;
  readonly at: number;
  readonly ua: string;
  readonly inner: string;
  readonly vv: string;
  readonly vars: string;
  readonly root: string;
  readonly doc: string;
  readonly composer: string;
  readonly textarea: string;
}

const rectOf = (element: Element | null): string => {
  if (element === null) return 'null';
  const r = element.getBoundingClientRect();
  return `${Math.round(r.top)}..${Math.round(r.bottom)} w${Math.round(r.width)} h${Math.round(r.height)}`;
};

function snapshot(step: string): Snapshot {
  const vv = window.visualViewport;
  const root = document.getElementById('root');
  const textarea = document.querySelector('textarea');
  const composer = textarea?.closest('div.shrink-0') ?? null;
  const vars = getComputedStyle(document.documentElement);
  return {
    step,
    at: Math.round(performance.now()),
    ua: navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''),
    inner: `${window.innerWidth}x${window.innerHeight} dpr${window.devicePixelRatio} scrollY${Math.round(window.scrollY)}`,
    vv: vv ? `h${Math.round(vv.height)} off${Math.round(vv.offsetTop)} scale${vv.scale.toFixed(2)}` : 'none',
    vars: `${vars.getPropertyValue('--app-height')}/${vars.getPropertyValue('--app-offset')}`,
    root: `${rectOf(root)} ${root ? getComputedStyle(root).overflow : ''}`,
    doc: `scrollH${document.documentElement.scrollHeight} bodyOverflow${getComputedStyle(document.body).overflow} clientH${document.documentElement.clientHeight}`,
    composer: composer ? `${rectOf(composer)} ${getComputedStyle(composer).display}/${getComputedStyle(composer).visibility}` : 'null',
    textarea: textarea ? `${rectOf(textarea)} ${getComputedStyle(textarea).display}` : 'null'
  };
}

function report(step: string): void {
  try {
    const data = JSON.stringify(snapshot(step));
    void fetch('/api/client-diag', { method: 'POST', body: data, keepalive: true }).catch(() => {});
  } catch {
    // 诊断本身不该影响页面
  }
}

export function mountDiagnostics(): void {
  for (const [ms, step] of [
    [300, 'boot'],
    [1500, 'settled'],
    [4000, 'later']
  ] as const) {
    setTimeout(() => report(step), ms);
  }

  if (new URLSearchParams(location.search).get('diag') !== '1') return;
  const box = document.createElement('div');
  box.style.cssText = [
    'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
    'max-height:60vh', 'overflow:auto', 'padding:6px 8px',
    'font:11px/1.45 ui-monospace,monospace', 'white-space:pre-wrap',
    'background:#000d', 'color:#7ef', 'pointer-events:none'
  ].join(';');
  document.body.append(box);
  const paint = (): void => {
    const s = snapshot('overlay');
    box.textContent = [
      `bundle ${document.querySelector('script[type=module]')?.getAttribute('src') ?? '?'}`,
      `inner  ${s.inner}`,
      `vv     ${s.vv}`,
      `vars   ${s.vars}`,
      `root   ${s.root}`,
      `doc    ${s.doc}`,
      `compos ${s.composer}`,
      `area   ${s.textarea}`
    ].join('\n');
  };
  paint();
  setInterval(paint, 500);
  window.visualViewport?.addEventListener('resize', paint);
  window.addEventListener('resize', paint);
}
