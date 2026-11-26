/** Structured parts of an agent-to-agent message, shared by UI projections and API DTOs. */
export type AgentMessagePartDto =
  | { readonly type: 'data'; readonly schema?: string; readonly data: unknown }
  | { readonly type: 'ref'; readonly repo: string; readonly branch?: string; readonly sha?: string }
  | { readonly type: 'file'; readonly session: string; readonly member?: string; readonly path: string }
  | { readonly type: 'link'; readonly url: string; readonly label?: string };
