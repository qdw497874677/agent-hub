import { call, post, sq, withMember } from './http.ts';

/** 工作目录文件浏览（ADR 0025，只读）。 */
export interface FileEntryDto { name: string; path: string; type: 'file' | 'dir' | 'symlink'; size: number; modifiedAt: number; ignored: boolean; sensitive: boolean; git: string | null }
export interface DirectoryPageDto { path: string; entries: FileEntryDto[]; truncated: boolean; isGit: boolean }
export interface FileContentDto { path: string; size: number; modifiedAt: number; binary: boolean; truncated: boolean; data: string }
export interface ChangedFileDto { path: string; status: string; additions: number; deletions: number; oldPath?: string }
export interface FileChangesDto { base: 'session' | 'head' | 'turn' | 'branch'; commit: string | null; target?: string | null; turn?: number | null; branch?: string | null; files: ChangedFileDto[] }
export interface TurnCheckpointDto { turn: number; promptSeq: number; before: string; after: string | null; startedAt: number; endedAt: number | null; files: number | null; additions: number | null; deletions: number | null }
/** 'session' | 'head' | 'branch'（相对分支起点）| 'turn'（最近一轮）| 'turn:3'（第 3 轮）。 */
export type DiffBaseSpec = string;
const baseQuery = (base: DiffBaseSpec) => { const [b, n] = base.split(':'); return `base=${b}${n ? `&turn=${n}` : ''}`; };
export interface FileDiffDto { path: string; patch: string; truncated: boolean; binary: boolean; reviewVersion?: string | null; reviewMember?: string | null }
export interface ReviewNoteDto { id: string; member: string | null; path: string; base: string; side: 'old' | 'new'; start: number; end: number; version: string; text: string; anchorState: 'current' | 'stale' | 'unknown'; delivery: null | { batchId: string; targetSessionId: string; state: 'queued' | 'sending' | 'delivered' | 'undelivered' | 'cancelled' | 'unknown' } }
export type ReviewDraftDto = Pick<ReviewNoteDto, 'path' | 'member' | 'base' | 'side' | 'start' | 'end' | 'version' | 'text'>;
export interface ReviewDto { notes: ReviewNoteDto[]; targets: { id: string; title: string }[] }
export const reviewApi = {
  get: (id: string, options?: { notes?: string[]; statusOnly?: boolean }) => {
    const params = new URLSearchParams();
    for (const note of options?.notes ?? []) params.append('note', note);
    if (options?.statusOnly) params.set('statusOnly', '1');
    const query = params.toString();
    return call<ReviewDto>(`${sq(id)}/git/review${query ? `?${query}` : ''}`);
  },
  save: (id: string, draft: ReviewDraftDto) => post<ReviewNoteDto>(`${sq(id)}/git/review/notes`, draft),
  remove: (id: string, noteId: string) => call<void>(`${sq(id)}/git/review/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }),
  send: (id: string, batch: { batchId: string; targetSessionId: string; noteIds: string[] }) => post<unknown>(`${sq(id)}/git/review/send`, batch),
  retry: (id: string, batchId: string) => post<unknown>(`${sq(id)}/git/review/batches/${encodeURIComponent(batchId)}/retry`, {})
};
export interface FilesContextMemberDto { workspaceId: string; name: string; repoId?: string; state: 'ready' | 'preparing' | 'failed' }
export interface FilesContextGroupDto { root: string; members: readonly FilesContextMemberDto[] }
export interface FilesContextDto {
  sessionId: string;
  root: string;
  workerId: string | null;
  sessionBase: string | null;
  otherProjectSessions?: number;
  group?: FilesContextGroupDto;
  member?: string | null;
}
export const filesApi = {
  context: (id: string, member?: string | null) => call<FilesContextDto>(withMember(`${sq(id)}/files/context`, member)),
  list: (id: string, path: string, member?: string | null) => call<DirectoryPageDto>(withMember(`${sq(id)}/files?path=${encodeURIComponent(path)}`, member)),
  read: (id: string, path: string, confirm: boolean, member?: string | null) => call<FileContentDto>(withMember(`${sq(id)}/files/content?path=${encodeURIComponent(path)}${confirm ? '&confirm=1' : ''}`, member)),
  downloadUrl: (id: string, path: string, confirm: boolean, member?: string | null) => withMember(`${sq(id)}/files/download?path=${encodeURIComponent(path)}${confirm ? '&confirm=1' : ''}`, member),
  find: (id: string, q: string, member?: string | null) => call<{ files: string[] }>(withMember(`${sq(id)}/files/find?q=${encodeURIComponent(q)}`, member)).then((r) => r.files),
  changes: (id: string, base: DiffBaseSpec, member?: string | null) => call<FileChangesDto>(withMember(`${sq(id)}/git/changes?${baseQuery(base)}`, member)),
  diff: (id: string, path: string, base: DiffBaseSpec, member?: string | null) => call<FileDiffDto>(withMember(`${sq(id)}/git/diff?path=${encodeURIComponent(path)}&${baseQuery(base)}`, member)),
  turns: (id: string, member?: string | null) => call<{ turns: TurnCheckpointDto[] }>(withMember(`${sq(id)}/git/turns`, member)).then((r) => r.turns),
  eventsUrl: (id: string, paths: readonly string[], member?: string | null) => withMember(`${sq(id)}/files/events?paths=${paths.map(encodeURIComponent).join(',')}`, member)
};
