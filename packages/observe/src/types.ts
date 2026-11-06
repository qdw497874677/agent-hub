/**
 * 可观测的只读契约（ADR 0033）。不认识业务表，也不认识 Langfuse。
 * 适配器把已经发生的事填进来；填不出的字段留空。
 */

export interface ObserveLink {
  /** 指向本条响应里另一个节点的 id。 */
  readonly to: string;
  /** 这条边为什么存在，例如「wakeKey = 这次运行」。 */
  readonly label: string;
}

export interface ObserveNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly state: string | null;
  readonly stateLabel: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** 起止都有才有数。 */
  readonly durationMs: number | null;
  /** 这个数是什么：记录跨度、送达用时、调度占用。没有耗时是 null。 */
  readonly durationLabel: string | null;
  /** 只有存储里写了父级、并且对得上时才填。 */
  readonly parentId: string | null;
  readonly links: readonly ObserveLink[];
  readonly attrs: readonly { readonly key: string; readonly value: string }[];
}

export interface ObserveTrace {
  /** 查看 id，例如 connector:run-18。不是 W3C trace id。 */
  readonly id: string;
  readonly source: string;
  /** 没有父级、也没有人链向它时，仍作为这棵树的根。 */
  readonly headId: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly externalUrl: string | null;
  readonly nodes: readonly ObserveNode[];
}

export interface ObserveListItem {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly at: number;
  readonly nativeState: string;
  readonly nativeStateLabel: string;
  readonly gap: string | null;
}

export interface ObserveListQuery {
  readonly since: number;
  readonly source: string | null;
  readonly projectId: string | null;
  readonly needsLook: boolean;
  readonly limit: number;
}

export interface ObserveList {
  readonly truncated: boolean;
  readonly items: readonly ObserveListItem[];
}

/** 授权主体由路由放进来。契约不解释它的形状，适配器自己认。 */
export interface ObserveReader {
  readonly id: string;
  list(query: ObserveListQuery, subject: unknown): Promise<ObserveList>;
  /** 原生 id，不含来源前缀。看不见时返回 null。 */
  get(nativeId: string, subject: unknown): Promise<ObserveTrace | null>;
}

export interface ObserveBranch {
  readonly node: ObserveNode;
  readonly children: readonly ObserveBranch[];
  readonly links: readonly { readonly label: string; readonly branch: ObserveBranch }[];
}

export interface ObserveTree {
  readonly roots: readonly ObserveBranch[];
  readonly missingParent: readonly ObserveNode[];
  readonly unlinked: readonly ObserveNode[];
  readonly unrecorded: readonly ObserveNode[];
}
