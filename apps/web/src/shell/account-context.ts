import { createContext, useContext } from 'react';
import type { AccountDto } from './api.ts';

/**
 * 当前登录账号，登录后由 AuthGate 放进 context。
 *
 * 单独放一个模块而不是留在 auth.tsx 里，是因为 auth.tsx → providers-dialog.tsx → workers.tsx，
 * 机器页的组件（运行时别名要按角色决定能不能改）若直接 import auth.tsx 就成了循环 import，
 * `npm run check` 会拦。auth.tsx 仍然 re-export 这两个名字，老调用点不用动。
 */
export const AccountContext = createContext<AccountDto | null>(null);

export const useAccount = (): AccountDto | null => useContext(AccountContext);

/** owner = 主人；clusterAdmin 是集群管理员，按主人算。 */
export const isOwner = (account: AccountDto | null): boolean => account?.role === 'owner' || account?.clusterAdmin === true;

/** owner 和 admin 都能看到机器配置，只有 owner 能改。 */
export const canAdminister = (account: AccountDto | null): boolean => isOwner(account) || account?.role === 'admin';
