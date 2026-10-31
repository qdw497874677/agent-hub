import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../api.ts';
import type { SettingsDto } from '../api.ts';
import { errorText, Section, Panel, Empty, useAdminAction } from './shared.tsx';

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 border-b border-hair px-3 py-3 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block text-body text-primary">{label}</span>
        <span className="block text-meta text-tertiary">{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function Settings() {
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: adminApi.settings });
  const save = useAdminAction((patch: Partial<SettingsDto>) => adminApi.saveSettings(patch));
  const data = settings.data;
  return (
    <Section title="设置">
      {save.error ? (
        <p role="alert" className="mb-2 text-meta text-rust">
          {errorText(save.error)}
        </p>
      ) : null}
      <Panel>
        {data ? (
          <>
            <Toggle
              label="开放注册"
              hint="默认关闭。打开后任何人都能自助注册：验证邮箱后得到一个自己的空团队（仍受 HUB_MAX_USERS 限制），看不到别的团队，也用不了 hub 本机。"
              checked={data.openRegistration}
              disabled={save.isPending}
              onChange={(openRegistration) => save.mutate({ openRegistration })}
            />
            <Toggle
              label="成员可以加机器"
              hint="关掉后只有主人能看到接入新 Worker 的说明。"
              checked={data.membersCanAddMachines}
              disabled={save.isPending}
              onChange={(membersCanAddMachines) => save.mutate({ membersCanAddMachines })}
            />
            <Toggle
              label="禁止安装脚本"
              hint="打开后所有组件都用 --ignore-scripts 安装（ADR 0021 §8 的总开关）。依赖安装脚本才能用的组件可能装上了却跑不起来。"
              checked={data.disableInstallScripts === true}
              disabled={save.isPending}
              onChange={(disableInstallScripts) => save.mutate({ disableInstallScripts })}
            />
          </>
        ) : (
          <Empty text="载入中…" />
        )}
      </Panel>
    </Section>
  );
}
