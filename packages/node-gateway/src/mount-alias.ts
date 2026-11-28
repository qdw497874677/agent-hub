import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isEqualOrDescendantPath } from './path-boundary.ts';

type Mount = { device: string; root: string; point: string };
const unescapeMount = (value: string): string => value.replace(/\\(040|011|012|134)/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

/** Conservative Linux mountinfo proof: reject any other visible mount covering
 * the same backing filesystem path. Unreadable or malformed tables fail closed. */
export function unaliasedMountPath(path: string, procRoot = '/proc'): boolean {
  try {
    if (!isAbsolute(path)) return false;
    const lines = readFileSync(join(procRoot, 'self/mountinfo'), 'utf8').trim().split('\n');
    const mounts: Mount[] = lines.map((line) => {
      const fields = line.split(' ');
      if (fields.length < 10 || !fields.includes('-') || !/^\d+:\d+$/.test(fields[2] ?? '')) throw new Error('invalid mountinfo');
      const root = unescapeMount(fields[3]!);
      const point = unescapeMount(fields[4]!);
      if (!isAbsolute(root) || !isAbsolute(point)) throw new Error('invalid mount path');
      return { device: fields[2]!, root, point };
    });
    const covering = mounts.filter((mount) => isEqualOrDescendantPath(mount.point, path)).sort((a, b) => b.point.length - a.point.length);
    if (!covering.length || (covering[1] && covering[0]!.point === covering[1].point)) return false;
    const current = covering[0]!;
    const backing = join(current.root, relative(current.point, path));
    return !mounts.some((mount) => {
      if (mount === current || mount.device !== current.device) return false;
      if (isEqualOrDescendantPath(mount.root, backing)) return join(mount.point, relative(mount.root, backing)) !== path;
      if (isEqualOrDescendantPath(backing, mount.root)) return join(path, relative(backing, mount.root)) !== mount.point;
      return false;
    });
  } catch { return false; }
}
