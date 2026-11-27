export const PROJECT_SETTINGS_SECTIONS = ['general', 'defaults', 'context', 'code', 'cleanup', 'assets'] as const;
const PERSONAL_SETTINGS_SECTIONS = ['account', 'devices', 'tokens', 'theme', 'display'] as const;

export type ProjectSettingsSection = (typeof PROJECT_SETTINGS_SECTIONS)[number];
type PersonalSettingsSection = (typeof PERSONAL_SETTINGS_SECTIONS)[number];

export type SettingsTarget =
  | { readonly scope: 'personal'; readonly section: PersonalSettingsSection }
  | { readonly scope: 'project'; readonly id: string; readonly section: ProjectSettingsSection }
  | { readonly scope: 'team'; readonly id: string; readonly section: 'default-models' | 'manage' }
  | { readonly scope: 'providers' };

export type SettingsRoute = { readonly page: 'settings'; readonly target: SettingsTarget | null };

export const SETTINGS_DIRECTORY: SettingsRoute = { page: 'settings', target: null };

export function parseSettingsRoute(parts: readonly string[]): SettingsRoute {
  const [, scope, part, section] = parts;
  const personal = PERSONAL_SETTINGS_SECTIONS.find((item) => item === part);
  if (scope === 'personal' && personal) return { page: 'settings', target: { scope, section: personal } };
  if (scope === 'project' && part) {
    return { page: 'settings', target: { scope, id: part, section: PROJECT_SETTINGS_SECTIONS.find((item) => item === section) ?? 'general' } };
  }
  if (scope === 'team' && part) {
    return { page: 'settings', target: { scope, id: part, section: section === 'default-models' ? section : 'manage' } };
  }
  if (scope === 'providers') return { page: 'settings', target: { scope } };
  return SETTINGS_DIRECTORY;
}

export function formatSettingsRoute(route: SettingsRoute): string {
  const target = route.target;
  if (!target) return '#/settings';
  if (target.scope === 'providers') return '#/settings/providers';
  if (target.scope === 'personal') return `#/settings/personal/${target.section}`;
  return `#/settings/${target.scope}/${encodeURIComponent(target.id)}/${target.section}`;
}

export function settingsHref(target: SettingsTarget): string {
  return formatSettingsRoute({ page: 'settings', target });
}
