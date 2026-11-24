import type { Context } from 'hono';
import { principalOfSubject, type Principal, type Subject } from '@agent-hub/domain';

/**
 * 共享的 HTTP 小工具：只收「行为完全一样」的重复。
 *
 * 这里刻意不做通用 Result → Response 包装器：各车道的成功体、状态码、失败时的
 * no-store / 脱敏 / 探测语义并不相同，强行合并会把差异藏起来。
 */

/**
 * 只认当前登录的人（cookie 会话）；令牌（含 bot 令牌）、系统主体、角色冒充一律不是人。
 *
 * `via` 是对象或 undefined，所以三处旧实现的 `principal.via` 与 `via === undefined`
 * 判断等价，可以共用这一份。
 */
export function humanOf(subject: Subject | null): Principal | null {
  const principal = principalOfSubject(subject);
  if (!principal || principal.via) return null;
  return principal;
}

/** 请求体不是 JSON / 读取失败时返回 null，让各路由的 schema 统一拒绝（malformed JSON ≠ 500）。 */
export async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

/** 派工 / 验收 / 发布相关响应都可能带「某人现在能做什么」，任何缓存都不允许。 */
export const NO_STORE = { 'cache-control': 'no-store' } as const;
