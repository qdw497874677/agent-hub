// e2e 专用入口：实现放在包内（apps/server/src/test-support/spawn.ts），
// 避免 apps/server 的测试反向跨包 import 被 check:boundaries 判违规。
export * from '../apps/server/src/test-support/spawn.ts';
