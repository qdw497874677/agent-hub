/**
 * 运行时那一行的「状态 → 文案 / 能做什么」判断，纯函数，UI 只负责照单渲染。
 *
 * 一台机器上同一个 agent 可能有两份：机器自己装的（老版本，通常以它为准），
 * hub 装在 `~/.agent-hub/runtimes/<agent>/<版本>` 的那份。`provision.source` 永远是
 * **当前生效**的那份；`machineVersion` / `hubVersion` / `preference` 是新加的可选字段
 * （老 Worker 不报），缺了就退回到「source + version」的老语义。
 */
export type RuntimeSide = 'machine' | 'hub';
export type RuntimeActive = RuntimeSide | 'missing';

export interface RuntimeProvisionView {
  /** 当前生效的来源，后端说了算。 */
  source: RuntimeActive;
  /** 生效那份的版本。 */
  version?: string;
  /** hub 建议装的版本：安装和升级都用它。 */
  recommended?: string;
  /** 这台机器装不了的理由（没有 npm 之类）。 */
  blocker?: string;
  /** 机器自带那份的版本（没生效时也看得到）。 */
  machineVersion?: string;
  /** hub 装的那份的版本（没生效时也看得到）。 */
  hubVersion?: string;
  /** 用户选的那份：切过去之后新建的会话用它。 */
  preference?: RuntimeSide;
}

export interface RuntimeAlternative {
  side: RuntimeSide;
  /** 行内另一份的说明：`机器自带 v1.8.0` / `hub v2.2.2`。 */
  label: string;
  /** 切换按钮：`改用机器自带` / `改用 hub v2.2.2`。 */
  button: string;
}

export interface RuntimeView {
  active: RuntimeActive;
  /** 生效那份的说明：`机器自带 v1.8.0` / `hub 安装 v2.2.2` / `未安装`。 */
  activeLabel: string;
  /** 两份都在，界面上加「生效中」。 */
  both: boolean;
  /** 另一份（能切过去）；只有一份就是 null。 */
  other: RuntimeAlternative | null;
  /** hub 那份的存在与可升级版本；没装就是 null。 */
  hub: { version: string | null; upgradeTo: string | null } | null;
  /** 装 hub 版本的入口；装了、或者这台机器装不了就是 null。 */
  install: { label: string; preset: string | null } | null;
  /** 这台机器装不了的理由（没有 npm 之类）；没有就是 null。 */
  blocker: string | null;
  /** 偏好与生效来源对不上时的一句话；没有就是 null。 */
  notice: string | null;
}

/** 版本号只认 `x.y.z`（后端也这么挡）。 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const machineLabel = (version: string | null): string => (version ? `机器自带 v${version}` : '机器自带');
/** 两份并列时用短的，省地方。 */
const hubShort = (version: string | null): string => (version ? `hub v${version}` : 'hub 版本');
const hubLabel = (version: string | null): string => (version ? `hub 安装 v${version}` : 'hub 安装');

export function runtimeView(provision: RuntimeProvisionView): RuntimeView {
  const active = provision.source;
  // 老 Worker 只给生效那份的 version，新 Worker 两份都给。
  const machineVersion = provision.machineVersion ?? (active === 'machine' ? provision.version ?? null : null);
  const hubVersion = provision.hubVersion ?? (active === 'hub' ? provision.version ?? null : null);
  const hasMachine = active === 'machine' || machineVersion !== null;
  const hasHub = active === 'hub' || hubVersion !== null;

  const activeLabel =
    active === 'hub' ? (hasMachine ? hubShort(hubVersion) : hubLabel(hubVersion)) : active === 'machine' ? machineLabel(machineVersion) : '未安装';

  // 生效的是 hub，能选的只有机器自带；生效的是机器自带（或都没有），能选的只有 hub。
  const other: RuntimeAlternative | null =
    active === 'hub'
      ? hasMachine
        ? { side: 'machine', label: machineLabel(machineVersion), button: '改用机器自带' }
        : null
      : hasHub
        ? { side: 'hub', label: hubShort(hubVersion), button: `改用 ${hubShort(hubVersion)}` }
        : null;

  const hub = hasHub
    ? {
        version: hubVersion,
        upgradeTo: provision.recommended && provision.recommended !== hubVersion ? provision.recommended : null
      }
    : null;

  // 装 hub 那份：只支持能在线装（有推荐版本）的 agent；装不了的时候后端会拒，按钮就别给。
  const install =
    !hasHub && !provision.blocker && provision.recommended
      ? { label: active === 'machine' ? '安装 hub 版本' : '安装', preset: provision.recommended }
      : null;

  const preference = provision.preference && provision.preference !== active ? provision.preference : null;
  const notice =
    preference === 'hub' && !hasHub
      ? '已选 hub 版本，但机器上还没装，先装一份'
      : preference === 'machine' && hasMachine
        ? '已选机器自带，下次新建的会话才换'
        : preference === 'hub' && hasHub
          ? '已选 hub 版本，下次新建的会话才换'
          : null;

  return { active, activeLabel, both: other !== null, other, hub, install, blocker: provision.blocker ?? null, notice };
}

/** 版本输入的就地校验：空着 = 用推荐版本；否则必须是 `x.y.z`。返回错误文案或 null。 */
export function versionError(input: string, preset: string | null): string | null {
  const typed = input.trim();
  if (typed === '') return preset ? null : '版本号要写成 2.2.2 这样';
  return VERSION_PATTERN.test(typed) ? null : '版本号要写成 2.2.2 这样';
}
