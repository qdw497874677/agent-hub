/**
 * Playwright 的 webServer 不是把 config.env 原样交给子进程。
 * 安装包里的启动是 `{ ...默认值, ...process.env, ...config.env }`，并且 `shell: true`。
 * 从 config.env 里 delete 掉的名字不会出现在最后一次展开里，于是 shell 仍从 process.env 继承。
 * 把名字设成自己的 undefined 属性，后一次展开才能盖住 process.env；Node 的 spawn 会丢掉值为 undefined 的项，
 * shell、npm build、hub、以及 hub 再拉起的 worker 都看不到这个名字。
 * 测试 / seed 进程自己的 process.env 不动。HUB_PROVIDER_TOKEN 不在这份名单里。
 */

/** 种子只在测试进程里用，任何模式都不许进 webServer。 */
export const SEED_ONLY_ENV = ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'] as const;

/** 指定了 E2E_HUB_MODEL 时，这些原生 / Go 变量也不许进 webServer，避免空模型或默认模型走到 Go。 */
export const HUB_MODEL_ONLY_ENV = [
  'PI_DEFAULT_MODEL',
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY'
] as const;

export function strippedEnvNames(source: NodeJS.ProcessEnv): readonly string[] {
  return source['E2E_HUB_MODEL'] ? [...SEED_ONLY_ENV, ...HUB_MODEL_ONLY_ENV] : [...SEED_ONLY_ENV];
}

export function serverEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const name of strippedEnvNames(source)) env[name] = undefined;
  return env;
}

/** 与当前安装的 Playwright webServer 启动对象同形。configEnv 应来自 serverEnv()。 */
export function playwrightWebServerEnv(source: NodeJS.ProcessEnv, configEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    BROWSER: 'none',
    FORCE_COLOR: '1',
    DEBUG_COLORS: '1',
    ...source,
    ...configEnv
  };
}
