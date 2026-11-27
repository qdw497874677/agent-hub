import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../atoms/icons.tsx';
import { useModalFocus } from './focus-trap.ts';

export interface SettingsGroup {
  readonly label: string;
  readonly note?: string;
  readonly items: readonly SettingsItem[];
}

export interface SettingsItem {
  readonly label: string;
  readonly href: string;
  readonly description?: string;
  readonly external?: boolean;
}

function SettingsDirectory({ groups, activeHref, onNavigate }: {
  groups: readonly SettingsGroup[];
  activeHref: string | null;
  onNavigate: (href: string) => void;
}) {
  function navigate(event: MouseEvent<HTMLAnchorElement>, item: SettingsItem) {
    if (item.external || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(item.href);
  }

  return (
    <nav aria-label="设置分类" className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <div className="mb-2 px-2">
            <h2 className="text-meta font-medium text-fg-faint">{group.label}</h2>
            {group.note ? <p className="mt-1 text-meta text-fg-muted">{group.note}</p> : null}
          </div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = activeHref === item.href;
              return (
                <li key={item.href}>
                  <a
                    href={item.href}
                    onClick={(event) => navigate(event, item)}
                    aria-label={item.label}
                    aria-current={active ? 'page' : undefined}
                    className={`group flex min-h-[44px] items-center gap-3 rounded-control px-2.5 py-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{item.label}</span>
                      {item.description ? <span className="mt-0.5 block text-meta font-normal text-fg-muted">{item.description}</span> : null}
                    </span>
                    <Icon name={item.external ? 'external' : 'chevron-right'} className="shrink-0 text-fg-faint" />
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

export function SettingsSurface({ groups, activeHref, title, scope, onNavigate, onBack, onClose, children }: {
  groups: readonly SettingsGroup[];
  activeHref: string | null;
  title: string;
  scope?: string;
  onNavigate: (href: string) => void;
  onBack: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const previousHref = useRef(activeHref);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const headingId = useId();
  const isTop = useModalFocus(panelRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isTop()) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [isTop]);

  useEffect(() => {
    if (previousHref.current === activeHref) return;
    previousHref.current = activeHref;
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = 0;
    main.focus({ preventScroll: true });
  }, [activeHref]);

  const directory = activeHref === null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/55 sm:p-4 lg:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        data-testid="settings-surface"
        className="flex h-full w-full max-w-[1440px] overflow-hidden bg-surface-1 text-fg outline-none sm:rounded-overlay sm:border sm:border-border-strong sm:shadow-overlay"
      >
        <aside className="hidden w-[270px] shrink-0 flex-col border-r border-border bg-bg md:flex">
          <div className="px-5 pb-4 pt-6">
            <p className="text-head font-semibold text-fg">设置</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">
            <SettingsDirectory groups={groups} activeHref={activeHref} onNavigate={onNavigate} />
          </div>
          <div className="border-t border-border p-3">
            <button type="button" onClick={onClose} className="flex min-h-[44px] w-full items-center gap-2 rounded-control px-2.5 text-body text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring">
              <Icon name="chevron-left" /> 返回应用
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <header className="flex min-h-[64px] shrink-0 items-center gap-1 border-b border-border px-2 py-2 sm:gap-3 sm:px-6 md:px-8">
            {directory ? null : (
              <button type="button" onClick={onBack} aria-label="返回设置目录" className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring md:hidden">
                <Icon name="chevron-left" />
              </button>
            )}
            <div className="min-w-0 flex-1">
              <h1 id={headingId} className="break-words text-head font-semibold">{directory ? '设置' : title}</h1>
              {scope ? <p className="break-words text-meta text-fg-muted">{scope}</p> : null}
            </div>
            <button type="button" onClick={onClose} className="min-h-[44px] shrink-0 rounded-control px-2 text-body text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring md:hidden">返回应用</button>
          </header>
          <main ref={mainRef} tabIndex={-1} data-testid="settings-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none">
            <div className="mx-auto w-full max-w-[860px] px-4 py-6 sm:px-6 md:px-8 md:py-8">
              {directory ? (
                <>
                  <div className="md:hidden"><SettingsDirectory groups={groups} activeHref={activeHref} onNavigate={onNavigate} /></div>
                  <section className="hidden max-w-2xl md:block" aria-label="设置概览">
                    <p className="text-body text-fg-muted">从左侧选择设置项，查看和修改对应的设置。</p>
                    <div className="mt-8 grid gap-x-10 gap-y-7 lg:grid-cols-2">
                      {groups.filter((group) => group.items.length > 0).map((group) => (
                        <div key={group.label}>
                          <h2 className="text-body font-semibold text-fg">{group.label}</h2>
                          {group.note ? <p className="mt-1 break-words text-meta text-fg-muted">{group.note}</p> : null}
                          <p className="mt-2 text-body leading-relaxed text-fg-muted">{group.items.map((item) => item.label).join(' · ')}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              ) : null}
              <div hidden={directory}>{children}</div>
            </div>
          </main>
        </div>
      </div>
    </div>,
    document.body
  );
}
