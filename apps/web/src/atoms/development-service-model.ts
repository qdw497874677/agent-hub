// Pure transport shapes shared by the UI model and API without importing browser HTTP code.
export interface DevelopmentWorker { id: string; name: string; state: 'online' | 'offline' }
export interface DevelopmentService { id: string | null; port: number; name: string; openable: boolean }

export function orderDevelopmentWorkers(workers: readonly DevelopmentWorker[], currentId: string | null | undefined): DevelopmentWorker[] {
  return [...workers].sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));
}
export function developmentServiceLabels(service: DevelopmentService): { title: string; subtitle: string } {
  const port = `端口 ${service.port}`;
  const name = service.name.trim();
  const title = name || port;
  const parts = title === port ? [] : [port];
  if (!service.id) parts.push('仅查看');
  else if (!service.openable) parts.push('暂不可打开');
  return { title, subtitle: parts.join(' · ') };
}
export function developmentManualPort(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}
