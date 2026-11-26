import type { JournalEntryDto, SessionDto } from '@agent-hub/contract';
import { applyFrame, awaitingAfter, catchUp, seedLive, withFullHistory, type Frame, type LiveMap } from './live-core.ts';

type SyncState = 'syncing' | 'stale';
type HistoryState = 'loading' | 'loaded' | 'error';
type Pending = {
  frames: Frame[];
  generation: number;
  running?: Promise<void>;
  full: boolean;
  activeFull?: boolean;
  overflow: boolean;
  session?: SessionDto;
};

/** Serializes history reads and live frames per session. All mutations happen synchronously. */
export class LiveSync {
  private live: LiveMap = {};
  private pending = new Map<string, Pending>();
  private seeded = new Set<string>();
  private sync: Record<string, SyncState> = {};
  private history: Record<string, HistoryState> = {};
  private connected = false;
  private disposed = false;
  private readonly read: (id: string, after?: number) => Promise<readonly JournalEntryDto[]>;
  private readonly publish: (live: LiveMap, sync: Readonly<Record<string, SyncState>>, history: Readonly<Record<string, HistoryState>>) => void;
  private readonly maxFrames: number;

  constructor(
    read: (id: string, after?: number) => Promise<readonly JournalEntryDto[]>,
    publish: (live: LiveMap, sync: Readonly<Record<string, SyncState>>, history: Readonly<Record<string, HistoryState>>) => void,
    maxFrames = 2000
  ) { this.read = read; this.publish = publish; this.maxFrames = maxFrames; }

  private emit(): void {
    if (!this.disposed) this.publish(this.live, this.sync, this.history);
  }

  private state(id: string, value?: SyncState): void {
    const next = { ...this.sync };
    if (value) next[id] = value;
    else delete next[id];
    this.sync = next;
  }

  private item(id: string): Pending {
    let item = this.pending.get(id);
    if (!item) {
      item = { frames: [], generation: 0, full: false, overflow: false };
      this.pending.set(id, item);
    }
    return item;
  }

  seed(sessions: readonly SessionDto[], previews: Readonly<Record<string, readonly JournalEntryDto[]>>): void {
    const before = this.live;
    this.live = seedLive(before, sessions, previews);
    for (const session of sessions) {
      const pending = this.pending.get(session.id);
      if (pending) pending.session = session;
      if (!this.seeded.has(session.id) && this.live[session.id]) {
        this.seeded.add(session.id);
        const item = this.item(session.id);
        item.session = session;
        // A frame may have arrived before its preview. A full read restores its prefix.
        if (before[session.id] && !pending) item.full = true;
        this.state(session.id, this.connected ? 'syncing' : 'stale');
        if (this.connected) queueMicrotask(() => { if (this.connected && this.sync[session.id] === 'syncing') void this.start(session.id); });
      }
    }
    this.emit();
  }

  frame(frame: Frame): void {
    if (!this.connected || this.disposed) return;
    let item = this.pending.get(frame.sessionId);
    const previous = this.live[frame.sessionId];
    if (!this.sync[frame.sessionId] && frame.seq > (previous?.lastSeq ?? 0) + 1) {
      item = this.item(frame.sessionId);
      if (!previous) item.full = true;
      this.state(frame.sessionId, 'syncing');
      // Queue before starting the read, including synchronous read failures.
      item.frames.push(frame);
      this.emit();
      void this.start(frame.sessionId);
      return;
    }
    if (item && this.sync[frame.sessionId]) {
      if (item.frames.length >= this.maxFrames) {
        item.frames = [];
        item.overflow = true;
        item.full = true;
      }
      item.frames.push(frame);
      return;
    }
    this.live = applyFrame(this.live, frame);
    this.emit();
  }

  disconnect(): void {
    this.connected = false;
    for (const id of new Set([...Object.keys(this.live), ...this.pending.keys()])) {
      const item = this.item(id);
      if (item.activeFull || this.history[id] === 'loading') item.full = true;
      item.generation++;
      item.running = undefined;
      this.state(id, 'stale');
    }
    this.emit();
  }

  open(): void {
    if (!this.connected) {
      for (const item of this.pending.values()) {
        if (item.running) {
          item.generation++;
          item.full ||= item.activeFull ?? false;
          item.running = undefined;
        }
      }
    }
    this.connected = true;
    for (const id of new Set([...Object.keys(this.live), ...this.pending.keys()])) {
      this.state(id, 'syncing');
      void this.start(id);
    }
    this.emit();
  }

  loadHistory(session: SessionDto): Promise<void> {
    const item = this.item(session.id);
    item.session = session;
    if (!item.running || !item.activeFull) item.full = true;
    this.history = { ...this.history, [session.id]: 'loading' };
    this.state(session.id, this.connected ? 'syncing' : 'stale');
    this.emit();
    return this.start(session.id);
  }

  retrySync(id: string): void {
    if (!this.sync[id]) return;
    if (!this.connected && !this.pending.get(id)?.full) return;
    if (this.pending.get(id)?.full && this.history[id] === 'error') this.history = { ...this.history, [id]: 'loading' };
    this.state(id, this.connected ? 'syncing' : 'stale');
    this.emit();
    void this.start(id);
  }

  private start(id: string): Promise<void> {
    const item = this.item(id);
    if (item.running) return item.running;
    const generation = item.generation;
    const run = async (): Promise<void> => {
      while ((this.connected || item.full) && generation === item.generation && !this.disposed) {
        const full = item.full || !this.live[id];
        item.activeFull = full;
        const base = this.live[id];
        const cursor = base?.lastSeq ?? 0;
        item.full = false;
        item.overflow = false;
        let entries: readonly JournalEntryDto[];
        try {
          entries = [...await this.read(id, full ? undefined : cursor)].sort((a, b) => a.seq - b.seq);
        } catch {
          if (generation !== item.generation || this.disposed) return;
          item.full ||= full;
          this.state(id, 'stale');
          if (this.history[id] === 'loading') this.history = { ...this.history, [id]: 'error' };
          this.emit();
          return;
        }
        if (generation !== item.generation || this.disposed) return;
        // A dropped frame or a full request made during catch-up needs a new snapshot.
        if (item.overflow || (!full && item.full)) continue;
        let expected = full ? 1 : cursor + 1;
        let gap = false;
        for (const entry of entries) {
          if (entry.seq < expected) continue;
          if (entry.seq !== expected) { gap = true; break; }
          expected++;
        }
        if (gap) {
          item.full ||= full;
          this.state(id, 'stale');
          if (this.history[id] === 'loading') this.history = { ...this.history, [id]: 'error' };
          this.emit();
          return;
        }
        const top = entries.at(-1)?.seq ?? 0;
        if (full && base && top < cursor) {
          item.full = true;
          this.state(id, 'stale');
          if (this.history[id] === 'loading') this.history = { ...this.history, [id]: 'error' };
          this.emit();
          return;
        }
        if (full) {
          // A session can first appear through SSE, before its DTO is seeded.
          const session = item.session ?? ({ id, status: base?.status ?? 'running', lastSeq: 0 } as SessionDto);
          this.live = withFullHistory(this.live, session, entries);
          const installed = this.live[id];
          if (installed) {
            let status = base?.status ?? session.status;
            let awaiting = base?.awaiting ?? false;
            for (const entry of entries) {
              if (base && entry.seq <= cursor) continue;
              if (entry.event.kind === 'prompt') status = 'running';
              if (entry.event.kind === 'ended') status = entry.event.outcome;
              awaiting = awaitingAfter(awaiting, entry.event, status);
            }
            this.live = { ...this.live, [id]: { ...installed, status, awaiting } };
          }
        } else {
          this.live = catchUp(this.live, id, entries);
        }
        const frames = item.frames.map((frame, index) => ({ frame, index })).sort((a, b) => a.frame.seq - b.frame.seq || a.index - b.index);
        item.frames = [];
        for (let index = 0; index < frames.length; index++) {
          const frame = frames[index]!.frame;
          const last = this.live[id]?.lastSeq ?? 0;
          if (frame.seq > last + 1) {
            item.frames = frames.slice(index).map((entry) => entry.frame);
            this.state(id, 'stale');
            if (this.history[id] === 'loading') this.history = { ...this.history, [id]: 'error' };
            this.emit();
            return;
          }
          if (frame.event === null && frame.seq < last) continue;
          this.live = applyFrame(this.live, frame);
        }
        if (full && this.history[id] === 'loading') this.history = { ...this.history, [id]: 'loaded' };
        this.state(id, this.connected ? undefined : 'stale');
        this.emit();
        return;
      }
    };
    const promise = run().finally(() => { if (item.running === promise) { item.running = undefined; item.activeFull = false; } });
    item.running = promise;
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }
}
