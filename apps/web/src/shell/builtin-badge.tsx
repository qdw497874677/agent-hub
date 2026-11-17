/** 「内置」小标：Hub 随代码带的资产（来源 builtin），各个资产列表统一用它。 */
export function BuiltinBadge({ version }: { version?: string }) {
  return (
    <span data-testid="asset-builtin" title={version ? `Hub 内置 · 清单版本 ${version}` : 'Hub 内置'} className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">
      内置
    </span>
  );
}
