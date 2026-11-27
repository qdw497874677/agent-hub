import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DisplaySettingsPanel } from '../atoms/chat-blocks.tsx';
import { useDisplaySettings } from '../atoms/display-preferences.tsx';
import { ProjectSettings } from '../surfaces/workbench/workspaces-dialog.tsx';
import { useAccount } from './account-context.ts';
import { api, teamApi } from './api.ts';
import { DeviceSettings, ProfileSettings, TeamSettings } from './auth.tsx';
import { ProviderSettings } from './providers-dialog.tsx';
import { parseRoute } from './route.ts';
import { backToSettingsDirectory, closeSettings, navigateSettings } from './settings-navigation.tsx';
import { settingsHref, type ProjectSettingsSection, type SettingsRoute } from './settings-route.ts';
import { SettingsSurface, type SettingsGroup } from './settings-surface.tsx';
import { ThemeSwitch } from './theme-switch.tsx';
import { TokenSettings } from './tokens-dialog.tsx';
import { useRoute } from './use-route.ts';

const PROJECT_ITEMS: { section: ProjectSettingsSection; label: string }[] = [
  { section: 'general', label: '项目信息' },
  { section: 'defaults', label: '项目默认 Agent' },
  { section: 'context', label: '上下文' },
  { section: 'code', label: '代码与工作目录' },
  { section: 'cleanup', label: '清理工作目录' },
  { section: 'assets', label: '资产' }
];

export function SettingsHost({ route, projectId }: { route: SettingsRoute; projectId: string | null }) {
  const { target } = route;
  const [, navigate] = useRoute();
  const account = useAccount();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const teamQuery = useQuery({ queryKey: ['team'], queryFn: teamApi.team, enabled: account !== null });
  const team = teamQuery.data;
  const isAdmin = account?.clusterAdmin === true;
  const projectTarget = target?.scope === 'project' ? target : null;
  // 直接打开项目深链也可以去看团队默认后回来，保留原来的项目编辑器。
  const [lastProjectId, setLastProjectId] = useState(projectTarget?.id ?? null);
  if (projectTarget && projectTarget.id !== lastProjectId) setLastProjectId(projectTarget.id);
  const selectedProjectId = projectTarget?.id ?? lastProjectId ?? projectId;
  const project = projects.data?.find((candidate) => candidate.id === selectedProjectId);
  const [display, changeDisplay] = useDisplaySettings();
  const teamDefaultsHref = team ? settingsHref({ scope: 'team', id: team.id, section: 'default-models' }) : undefined;

  function go(href: string) {
    const next = parseRoute(href);
    if (next?.page === 'settings') navigateSettings(navigate, route, next);
  }

  const groups: SettingsGroup[] = [{
    label: '个人',
    items: [
      ...(account ? [
        { label: '账号资料与密码', href: settingsHref({ scope: 'personal', section: 'account' }) },
        { label: '登录设备', href: settingsHref({ scope: 'personal', section: 'devices' }) },
        { label: '访问令牌', href: settingsHref({ scope: 'personal', section: 'tokens' }) },
        { label: '外部接入（MCP）', href: '#/access', external: true }
      ] : []),
      { label: '主题', href: settingsHref({ scope: 'personal', section: 'theme' }) },
      { label: '会话显示', href: settingsHref({ scope: 'personal', section: 'display' }) }
    ]
  }];
  if (project) groups.push({
    label: '当前项目', note: project.name,
    items: PROJECT_ITEMS.filter(({ section }) => section !== 'assets' || isAdmin).map(({ section, label }) => ({
      label, href: settingsHref({ scope: 'project', id: project.id, section })
    }))
  });
  if (team && teamDefaultsHref) groups.push({
    label: '团队', note: team.name,
    items: [
      { label: '团队默认模型', href: teamDefaultsHref },
      { label: '成员与权限', href: settingsHref({ scope: 'team', id: team.id, section: 'manage' }) }
    ]
  });
  if (account) groups.push({
    label: '模型供应商',
    items: [{ label: '模型供应商', href: settingsHref({ scope: 'providers' }) }]
  });
  if (isAdmin) groups.push({
    label: 'Hub',
    items: [{ label: 'Hub 管理', href: '#/admin/settings', external: true }]
  });

  const activeHref = target ? settingsHref(target) : null;
  const title = groups.flatMap((group) => group.items).find((item) => item.href === activeHref)?.label
    ?? (projectTarget ? PROJECT_ITEMS.find((item) => item.section === projectTarget.section)?.label : undefined)
    ?? '设置';
  const scope = projectTarget && project ? `当前项目 · ${project.name}`
    : target?.scope === 'team' && team?.id === target.id ? `团队 · ${team.name}`
    : target?.scope === 'personal' ? '个人' : undefined;
  const panelSection = projectTarget?.section ?? 'general';
  const projectVisible = !!projectTarget && !!project && (panelSection !== 'assets' || isAdmin);

  let content;
  if (projectTarget && !projectVisible) {
    content = projects.isPending ? <Notice>正在读取项目…</Notice> : <Notice>找不到这个项目，或你没有权限查看此设置。</Notice>;
  } else if (target?.scope === 'team') {
    content = team?.id === target.id
      ? <TeamSettings key={`${team.id}/${target.section}`} modelsOnly={target.section === 'default-models'} hideDefaults={target.section === 'manage'} />
      : <Notice>{account && teamQuery.isPending ? '正在读取团队…' : '这不是当前团队，或你没有权限查看此设置。'}</Notice>;
  } else if (target?.scope === 'providers') {
    content = account ? <ProviderSettings me={account} /> : <Notice>登录后可管理模型供应商。</Notice>;
  } else if (target?.scope === 'personal') {
    if (target.section === 'theme') content = <><Notice>仅在当前浏览器生效。</Notice><ThemeSwitch /></>;
    else if (target.section === 'display') content = <><Notice>仅在此浏览器的当前账号下生效。</Notice><DisplaySettingsPanel settings={display} onChange={changeDisplay} showTheme={false} /></>;
    else if (!account) content = <Notice>登录后可查看此设置。</Notice>;
    else if (target.section === 'account') content = <ProfileSettings />;
    else if (target.section === 'devices') content = <DeviceSettings />;
    else content = <TokenSettings me={account} />;
  }

  return (
    <SettingsSurface groups={groups} activeHref={activeHref} title={title} scope={scope}
      onNavigate={go} onBack={() => backToSettingsDirectory(navigate, route)} onClose={() => closeSettings(navigate)}>
      {project && lastProjectId === project.id ? (
        <div hidden={!projectVisible}>
          <ProjectSettings key={project.id} project={project} section={projectVisible ? panelSection : 'general'}
            teamDefaultsHref={teamDefaultsHref} onTeamDefaults={teamDefaultsHref ? () => go(teamDefaultsHref) : undefined} />
        </div>
      ) : null}
      {content}
    </SettingsSurface>
  );
}

function Notice({ children }: { children: string }) {
  return <p className="mb-4 text-body text-fg-muted">{children}</p>;
}
