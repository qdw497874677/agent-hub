/**
 * 飞书连接器（issue #219 C4 的第一个真实 IM 渠道）：长连接入站 + 走已有 outbox 出站。
 * 只实现端口，不认识核心；规则在 rules.ts，发送在 client.ts。
 */
export * from './rules.ts';
export * from './client.ts';
export * from './source.ts';
export * from './sink.ts';
