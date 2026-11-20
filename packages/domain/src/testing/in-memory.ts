/**
 * 用例测试与 HTTP 合同测试共用的内存假件。
 *
 * 放在 domain 里是因为它们只实现 domain 的端口、不碰任何 I/O；
 * 通过 `@agent-hub/domain/testing` 暴露，生产代码不会 import 它。
 *
 * 实现按端口 / 已有工厂分在 `fakes/` 下，这里只做原样的再导出（导出集合与签名不变）。
 */
export * from './fakes/accounts.ts';
export * from './fakes/access.ts';
export * from './fakes/assets.ts';
export * from './fakes/repos.ts';
export * from './fakes/runtime.ts';
export * from './fakes/world.ts';
