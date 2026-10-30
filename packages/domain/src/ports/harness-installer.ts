/**
 * 运行时安装适配器（Worker 侧，ADR 0010）：一个 harness 一个，只知道「怎么把它装进一个空目录」。
 * 目录布局、原子切换、超时、日志回传都在 node-gateway 的 runtime store / job runner 里。
 */
export interface InstallRun {
  /** 空的暂存目录：装在这里面，成功后整个目录被原子地挪成正式版本。 */
  readonly dir: string;
  readonly signal: AbortSignal;
  log(line: string): void;
  /** 跑一条命令（不经 shell），输出逐行进日志；非 0 退出抛错。 */
  run(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string | undefined>> }): Promise<void>;
}

export interface InstalledEntry {
  /** 可执行入口，相对 dir。 */
  readonly path: string;
  /** node-script：用 Worker 自己的 node 跑（不依赖 PATH 里有 node）；binary：直接 exec。 */
  readonly kind: 'node-script' | 'binary';
}

export interface HarnessInstaller {
  readonly agentId: string;
  /** 装好后对外的命令名（pi / opencode / grok）。 */
  readonly command: string;
  /** 钉死的推荐版本：升级 = 改这里、发版。 */
  readonly recommendedVersion: string;
  /** 这台机器装不了的原因（平台、缺 npm / curl）；能装返回 null。 */
  blocker(): Promise<string | null>;
  install(version: string, run: InstallRun): Promise<InstalledEntry>;
}
