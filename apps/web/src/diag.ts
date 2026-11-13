/**
 * 临时诊断浮层：URL 带 `?diag=1` 时打开，把布局实测值直接画在页面顶部。
 * 真机上没法开控制台，靠这张卡片看 `visualViewport` / `--app-height` / 输入框到底在哪。
 * 定位完就删。
 */
export function mountDiagnostics(): void {
  const params = new URLSearchParams(location.search);
  if (params.get('diag') !== '1') return;

  const box = document.createElement('div');
  box.style.cssText = [
    'position:fixed',
    'left:0',
    'right:0',
    'top:0',
    'z-index:2147483647',
    'max-height:60vh',
    'overflow:auto',
    'padding:6px 8px',
    'font:11px/1.45 ui-monospace,monospace',
    'white-space:pre-wrap',
    'background:#000d',
    'color:#7ef',
    'pointer-events:none'
  ].join(';');
  document.body.append(box);

  const rect = (element: Element | null): string => {
    if (element === null) return 'null';
    const r = element.getBoundingClientRect();
    return `${Math.round(r.top)}..${Math.round(r.bottom)} (h${Math.round(r.height)})`;
  };

  const tick = (): void => {
    const root = document.getElementById('root');
    const vv = window.visualViewport;
    const textarea = document.querySelector('textarea');
    const composer = textarea?.closest('div.shrink-0') ?? null;
    box.textContent = [
      `bundle  ${document.querySelector('script[type=module]')?.getAttribute('src') ?? '?'}`,
      `inner   ${window.innerHeight}×${window.innerWidth} scrollY=${Math.round(window.scrollY)}`,
      `vv      ${vv ? `${Math.round(vv.height)} off${Math.round(vv.offsetTop)} scale${vv.scale.toFixed(2)}` : 'none'}`,
      `vars    ${getComputedStyle(document.documentElement).getPropertyValue('--app-height')} / ${getComputedStyle(document.documentElement).getPropertyValue('--app-offset')}`,
      `root    ${rect(root)} ${root ? getComputedStyle(root).overflow : ''}`,
      `doc     scrollH=${document.documentElement.scrollHeight} bodyOverflow=${getComputedStyle(document.body).overflow}`,
      `composer${composer ? ` ${rect(composer)} display=${getComputedStyle(composer).display}` : ' null'}`,
      `textarea${textarea ? ` ${rect(textarea)} display=${getComputedStyle(textarea).display} h=${getComputedStyle(textarea).height}` : ' null'}`
    ].join('\n');
  };

  tick();
  setInterval(tick, 500);
  window.visualViewport?.addEventListener('resize', tick);
  window.addEventListener('resize', tick);
}
