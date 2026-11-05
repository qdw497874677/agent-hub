/** GitHub 连接器（ADR 0032 R4）：只轮询、只认写权限的人、外部文本一律不可信；GitHub 的所有规则都在这个包里，核心不 import 它。 */
export * from './rules.ts';
export * from './client.ts';
export * from './source.ts';
export * from './sink.ts';
export * from './tools.ts';
