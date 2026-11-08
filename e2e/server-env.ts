/**
 * 测试进程可以持有 ZAI_CODING_CN_API_KEY，只为登录后 POST 进 Hub。
 * 传给 hub / worker 的环境里去掉它。设置了 E2E_HUB_MODEL 时再去掉会伪装成原生模型的变量。
 */
export function serverEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  delete env['ZAI_CODING_CN_API_KEY'];
  delete env['ZAI_API_KEY'];
  if (env['E2E_HUB_MODEL']) {
    delete env['PI_DEFAULT_MODEL'];
    delete env['OPENCODE_API_KEY'];
    delete env['OPENAI_API_KEY'];
    delete env['ANTHROPIC_API_KEY'];
  }
  return env;
}
