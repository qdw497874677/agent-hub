/** 垫片聚合用的纯函数（单测覆盖）：解析 AGENT_HUB_MCP、工具名前缀。 */
export type ShimMcpEntry =
  | { readonly transport: 'http'; readonly name: string; readonly url: string }
  | {
      readonly transport: 'stdio';
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseShimMcp(raw: string | undefined): ShimMcpEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): ShimMcpEntry[] => {
    if (typeof item !== 'object' || item === null) return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry['name'] !== 'string' || !NAME.test(entry['name'])) return [];
    if (entry['transport'] === 'http' && typeof entry['url'] === 'string' && entry['url'] !== '') {
      return [{ transport: 'http', name: entry['name'], url: entry['url'] }];
    }
    if (entry['transport'] === 'stdio' && typeof entry['command'] === 'string') {
      const args = Array.isArray(entry['args']) ? entry['args'].filter((arg): arg is string => typeof arg === 'string') : [];
      const env = typeof entry['env'] === 'object' && entry['env'] !== null ? (entry['env'] as Record<string, unknown>) : {};
      return [
        {
          transport: 'stdio',
          name: entry['name'],
          command: entry['command'],
          args,
          env: Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
        }
      ];
    }
    return [];
  });
}

export const aggregateName = (server: string, tool: string): string => `${server}__${tool}`;

export function splitAggregateName(name: string, servers: readonly string[]): { server: string; tool: string } | null {
  for (const server of servers) {
    const prefix = `${server}__`;
    if (name.startsWith(prefix) && name.length > prefix.length) return { server, tool: name.slice(prefix.length) };
  }
  return null;
}
