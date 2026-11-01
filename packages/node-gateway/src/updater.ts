import { execFile } from 'node:child_process';
import type { WorkerUpdateState } from '@agent-hub/domain';

/** 跑一条命令：程序名 + 参数数组，不经过 shell。 */
export type CommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<{ code: number; output: string }>;

export interface UpdateReport {
  readonly state: WorkerUpdateState;
  readonly message: string;
  readonly logTail: string;
}

export interface UpdateOptions {
  readonly repoDir: string;
  /** 目标提交：40 位十六进制，别的一概不收。 */
  readonly commit: string;
  readonly report: (status: UpdateReport) => void;
  readonly run?: CommandRunner;
  /** 装依赖的命令参数；默认 `npm ci --omit=dev`，与 install-worker.sh 一致。 */
  readonly installArgs?: readonly string[];
  /** git fetch 失败后的重试间隔（毫秒）；默认 [2000, 5000]，即最多试 3 次。测试里传 [0, 0]。 */
  readonly fetchRetryDelaysMs?: readonly number[];
  /**
   * 先从 hub 下这个提交的 git bundle（GET /install/worker-<提交>.bundle，sha256 已校验），返回本地文件路径；
   * 拿不到返回 null，再退回 git fetch origin（GitHub）。这样连不上 GitHub 的机器也能更新。
   */
  readonly fetchBundle?: (commit: string) => Promise<string | null>;
}

/** hub 发的 bundle 里带的引用名（apps/server/src/install-artifacts.ts）。 */
export const HUB_BUNDLE_REF = 'refs/agent-hub/install';

/**
 * 把 git fetch 的报错归成一句人话（不带 URL / 输出原文，避免把凭据或路径带进状态消息；原文在日志尾巴里）。
 * 真实案例：omarchy 到 github.com 的 TLS 握手约 1/6 概率被掐断（`TLS connect error` / `SSL_ERROR_SYSCALL`），偶发而非配置问题。
 */
export function fetchFailureReason(output: string): string {
  const text = output.toLowerCase();
  if (/could not resolve host|name or service not known|temporary failure in name resolution/.test(text)) return '域名解析失败（DNS）';
  if (/tls|ssl|gnutls|handshake/.test(text)) return 'TLS 连接被中断（网络不稳或被干扰）';
  if (/timed out|timeout/.test(text)) return '连接超时';
  if (/connection refused|failed to connect|couldn't connect|network is unreachable|connection reset|early eof|unexpected disconnect/.test(text)) return '连不上远端（网络）';
  if (/proxy/.test(text)) return '代理出错';
  if (/authentication failed|could not read username|permission denied|403|401|repository not found/.test(text)) return '没有权限（认证失败或仓库不可见）';
  return '原因见日志';
}

const LOG_LIMIT = 4000;

export const execRunner: CommandRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (!error) return resolve({ code: 0, output });
      const code = typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1;
      resolve({ code, output: output || error.message });
    });
  });

/**
 * Worker 的安全自更新。只做固定的几步，参数全由这里拼，外面只能给一个提交号：
 *   1. 工作区有未提交改动 → 拒绝（不替人丢改动）；
 *   2. 已经是目标提交 → 回「无需更新」，不重启（也就是演练）；
 *   3. git fetch → 只允许快进到目标提交 → npm ci；
 *   4. 任何一步失败 → 回滚到原提交并重装依赖，报失败带日志尾巴。
 * 返回 true 表示代码换了，调用方该退出让 systemd（或 hub）重启它。
 */
export async function runSelfUpdate(options: UpdateOptions): Promise<boolean> {
  const run = options.run ?? execRunner;
  const cwd = options.repoDir;
  let log = '';
  const tail = (): string => log.slice(-LOG_LIMIT);
  const step = async (command: string, args: readonly string[]): Promise<{ code: number; output: string }> => {
    log += `$ ${command} ${args.join(' ')}\n`;
    const result = await run(command, args, cwd);
    log += result.output.endsWith('\n') || result.output === '' ? result.output : `${result.output}\n`;
    return result;
  };
  const report = (state: WorkerUpdateState, message: string): void => options.report({ state, message, logTail: tail() });

  if (!/^[0-9a-f]{40}$/.test(options.commit)) {
    report('refused', '目标提交号不合法');
    return false;
  }
  const target = options.commit;
  const head = await step('git', ['rev-parse', 'HEAD']);
  const previous = head.output.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(previous)) {
    report('refused', '这台 Worker 不是从 git 仓库运行的（没有 git 时用 hub 的 tar 包装的）：请装上 git 后重跑「添加机器」的安装命令');
    return false;
  }
  if (previous === target) {
    report('succeeded', `已是目标版本 ${target.slice(0, 7)}，无需更新`);
    return false;
  }
  const status = await step('git', ['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0 || status.output.trim() !== '') {
    report('refused', '工作区有未提交的改动，拒绝更新（先提交或 stash 掉）');
    return false;
  }

  report('updating', `拉取代码 ${previous.slice(0, 7)} → ${target.slice(0, 7)}`);
  const rollback = async (why: string): Promise<false> => {
    report('updating', `${why}，回滚到 ${previous.slice(0, 7)}`);
    const reset = await step('git', ['reset', '--hard', previous]);
    const reinstall = reset.code === 0 ? await step('npm', options.installArgs ?? ['ci', '--omit=dev', '--no-audit', '--no-fund']) : reset;
    report('failed', `${why}；${reset.code === 0 && reinstall.code === 0 ? '已回滚到原版本' : '回滚也失败了，请手动处理'}`);
    return false;
  };
  // 网络偶发失败很常见（见 fetchFailureReason 注释），fetch 不改工作区，重试是安全的
  const fetchOrigin = async (): Promise<boolean> => {
    const delays = options.fetchRetryDelaysMs ?? [2000, 5000];
    let fetched = await step('git', ['fetch', '--quiet', 'origin']);
    for (let attempt = 0; fetched.code !== 0 && attempt < delays.length; attempt += 1) {
      report('updating', `git fetch 失败（${fetchFailureReason(fetched.output)}），正在第 ${attempt + 2} 次尝试`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      fetched = await step('git', ['fetch', '--quiet', 'origin']);
    }
    if (fetched.code !== 0) {
      report('failed', `git fetch 失败 ${delays.length + 1} 次（${fetchFailureReason(fetched.output)}），没有改动任何东西`);
      return false;
    }
    if ((await step('git', ['cat-file', '-e', `${target}^{commit}`])).code !== 0) {
      report('failed', `远端没有提交 ${target.slice(0, 7)}（hub 的提交可能还没推送），没有改动任何东西`);
      return false;
    }
    return true;
  };
  // 先走 hub：bundle 里就是目标提交，不碰 GitHub
  let fromHub = false;
  const bundle = options.fetchBundle ? await options.fetchBundle(target).catch(() => null) : null;
  if (bundle) {
    const fetchedBundle = await step('git', ['fetch', '--quiet', bundle, `+${HUB_BUNDLE_REF}:${HUB_BUNDLE_REF}`]);
    fromHub = fetchedBundle.code === 0 && (await step('git', ['cat-file', '-e', `${target}^{commit}`])).code === 0;
    if (!fromHub) report('updating', '从 hub 取代码失败，改从 git 远端拉取');
  }
  if (!fromHub) {
    const fetchedOk = await fetchOrigin();
    if (!fetchedOk) return false;
  }
  if ((await step('git', ['merge', '--ff-only', target])).code !== 0) {
    // ff-only 失败时 git 不会动工作区，不需要回滚
    report('failed', '不能快进到目标提交（本地分支分叉或在别的分支上），没有改动任何东西');
    return false;
  }
  report('updating', '安装依赖（npm ci）');
  if ((await step('npm', options.installArgs ?? ['ci', '--omit=dev', '--no-audit', '--no-fund'])).code !== 0) {
    return rollback('npm ci 失败');
  }
  report('succeeded', `已更新到 ${target.slice(0, 7)}，正在重启`);
  return true;
}

/** ws(s)://host/worker → http(s)://host：hub 的 HTTP 地址。 */
export function hubHttpFrom(hubUrl: string): string | null {
  try {
    const url = new URL(hubUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = url.pathname.replace(/\/worker\/?$/, '') || '/';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * 从 hub 下目标提交的 bundle 到 dir，sha256 对不上就当没拿到。
 * 只收 40 位提交号；URL 是固定格式，不拼任何外部字符串。
 */
export async function downloadHubBundle(options: {
  hubHttp: string;
  commit: string;
  dir: string;
  fetch?: typeof fetch;
}): Promise<string | null> {
  return downloadHubArtifact({ ...options, kind: "bundle" });
}

/** 从 hub 下 worker-<提交>.<kind>（bundle 或 tar.gz）到 dir，先取 .sha256，对不上返回 null。 */
export async function downloadHubArtifact(options: {
  hubHttp: string;
  commit: string;
  dir: string;
  kind: "bundle" | "tar.gz";
  fetch?: typeof fetch;
}): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/.test(options.commit)) return null;
  const { createHash } = await import("node:crypto");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const get = options.fetch ?? fetch;
  const base = `${options.hubHttp}/install/worker-${options.commit}.${options.kind}`;
  const signal = AbortSignal.timeout(5 * 60_000);
  const sumResponse = await get(`${base}.sha256`, { signal });
  if (!sumResponse.ok) return null;
  const expected = (await sumResponse.text()).trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) return null;
  const response = await get(base, { signal });
  if (!response.ok) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(body).digest("hex") !== expected) return null;
  await mkdir(options.dir, { recursive: true });
  const path = join(options.dir, `worker-${options.commit}.${options.kind}`);
  await writeFile(path, body);
  return path;
}

export interface TarballUpdateOptions {
  /** 当前安装目录（解压安装，没有 .git）。新版本解到旁边的 <dir>.next，换好后旧的留在 <dir>.prev 供回滚。 */
  readonly repoDir: string;
  readonly commit: string;
  readonly report: (status: UpdateReport) => void;
  /** 下载并校验目标提交的 tar.gz，返回本地路径；拿不到返回 null。 */
  readonly fetchTarball: (commit: string) => Promise<string | null>;
  readonly run?: CommandRunner;
  /** 默认 npm install --omit=dev（注册表沿用环境里的 NPM_CONFIG_REGISTRY，即 worker.env 里存的那个）。 */
  readonly installArgs?: readonly string[];
}

/** 解压安装记提交号的文件（bootstrap-worker.sh 写，readBuildInfo 读）。 */
export const COMMIT_FILE = ".agent-hub-commit";

/**
 * 没有 git 的安装怎么更新：下 tar 包 → 解到 <dir>.next → 复用旧 node_modules 再 npm install →
 * 原子地 rename 换上（旧版留 <dir>.prev）。换上之前任何一步失败都不碰当前版本；
 * 换上之后新版起不来由 worker-boot-guard.sh 换回 <dir>.prev。返回 true = 已换好，调用方退出重启。
 */
export async function runTarballUpdate(
  options: TarballUpdateOptions,
): Promise<boolean> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { rename, rm, writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const run = options.run ?? execRunner;
  const dir = options.repoDir.replace(/\/+$/, "");
  let log = "";
  const tail = (): string => log.slice(-LOG_LIMIT);
  const step = async (
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<{ code: number; output: string }> => {
    log += `$ ${command} ${args.join(" ")}\n`;
    const result = await run(command, args, cwd);
    log +=
      result.output.endsWith("\n") || result.output === ""
        ? result.output
        : `${result.output}\n`;
    return result;
  };
  const report = (state: WorkerUpdateState, message: string): void =>
    options.report({ state, message, logTail: tail() });

  if (!/^[0-9a-f]{40}$/.test(options.commit)) {
    report("refused", "目标提交号不合法");
    return false;
  }
  const target = options.commit;
  let previous = "";
  try {
    previous = readFileSync(join(dir, COMMIT_FILE), "utf8").trim();
  } catch {
    // 没有标记
  }
  if (previous === target) {
    report("succeeded", `已是目标版本 ${target.slice(0, 7)}，无需更新`);
    return false;
  }
  report("updating", `从 hub 下载 ${target.slice(0, 7)} 的代码包`);
  const tarball = await options.fetchTarball(target).catch(() => null);
  if (!tarball) {
    report(
      "failed",
      "从 hub 下载代码包失败（或 sha256 对不上），没有改动任何东西",
    );
    return false;
  }
  const next = `${dir}.next`;
  const prev = `${dir}.prev`;
  const abandon = async (why: string): Promise<false> => {
    await rm(next, { recursive: true, force: true }).catch(() => {});
    report("failed", `${why}，没有改动当前版本`);
    return false;
  };
  await rm(next, { recursive: true, force: true });
  await mkdir(next, { recursive: true });
  if ((await step("tar", ["-xzf", tarball, "-C", next], next)).code !== 0)
    return abandon("解压代码包失败");
  await rm(tarball, { force: true }).catch(() => {});
  await writeFile(join(next, COMMIT_FILE), `${target}\n`);
  // 复用旧依赖：拷一份过去（不动正在跑的那份），npm install 只补差的
  if (existsSync(join(dir, "node_modules")))
    await step(
      "cp",
      ["-a", join(dir, "node_modules"), join(next, "node_modules")],
      next,
    );
  report("updating", "安装依赖（npm install）");
  if (
    (
      await step(
        "npm",
        options.installArgs ?? [
          "install",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
        ],
        next,
      )
    ).code !== 0
  ) {
    return abandon("npm install 失败");
  }
  // 换上：<dir> → <dir>.prev，<dir>.next → <dir>。正在跑的进程拿着的是旧文件，不受影响。
  try {
    await rm(prev, { recursive: true, force: true });
    await rename(dir, prev);
  } catch (error) {
    return abandon(`挪开当前版本失败（${(error as Error).message}）`);
  }
  try {
    await rename(next, dir);
  } catch (error) {
    await rename(prev, dir).catch(() => {});
    return abandon(`换上新版本失败（${(error as Error).message}）`);
  }
  report(
    "succeeded",
    `已更新到 ${target.slice(0, 7)}（旧版留在 ${prev}），正在重启`,
  );
  return true;
}
