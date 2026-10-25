/**
 * 契约漂移守卫：只在编译期生效（根 tsconfig 覆盖 packages/**，`npm run typecheck` 会编到它）。
 * 故意不从包根导出——web 的类型程序不该被拖进 domain。
 *
 * wire schema 是 domain 模型在线上的投影。domain 加了字段、改了枚举而 schema 没跟上，
 * 这里就编不过——`npm run typecheck` 当场报出是哪一对漂了。
 *
 * 只比形状、不比可变性（domain 全是 readonly）。
 * 方向：domain 值必须能原样当 DTO 发出去（品牌 id 本来就是 string 的子类型）；
 * 枚举类的则要求两边完全相等，免得一边多出一个状态另一边不认。
 */
import type {
  Artifact,
  AgentDescriptor,
  CanvasLayout,
  CapabilityState,
  HomeView,
  JournalEntry,
  OptionCategory,
  Project,
  RuntimeOption,
  SearchHit,
  Session,
  SessionEvent,
  SessionStatus,
  Task,
  TaskStatus,
  WorkLogEntry,
  LogKind,
  WorkerStatus
} from '@agent-hub/domain';
import type { z } from 'zod';
import type {
  ArtifactDto,
  AgentDto,
  HomeDto,
  JournalEntryDto,
  LayoutDto,
  ProjectDto,
  RuntimeOptionDto,
  SearchHitDto,
  SessionDto,
  SessionEventDto,
  TaskDto,
  WorkerInfoDto,
  capabilityStateSchema,
  optionCategorySchema,
  sessionStatusSchema,
  taskStatusSchema,
  logKindSchema,
  WorkLogEntryDto
} from './wire.ts';

/** zod 推出的数组是可变的，domain 一律 readonly；比较前把 DTO 拉平成只读，只比形状。 */
type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
type Extends<A, B> = [A] extends [DeepReadonly<B>] ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type ContractDrift = [
  Assert<Extends<Project, ProjectDto>>,
  Assert<Extends<Task, TaskDto>>,
  Assert<Extends<WorkLogEntry, WorkLogEntryDto>>,
  Assert<Same<LogKind, z.infer<typeof logKindSchema>>>,
  Assert<Extends<Session, SessionDto>>,
  Assert<Extends<Artifact, ArtifactDto>>,
  Assert<Extends<SessionEvent, SessionEventDto>>,
  Assert<Extends<JournalEntry, JournalEntryDto>>,
  Assert<Extends<RuntimeOption, RuntimeOptionDto>>,
  Assert<Extends<AgentDescriptor, AgentDto>>,
  Assert<Extends<SearchHit, SearchHitDto>>,
  Assert<Extends<WorkerStatus, WorkerInfoDto>>,
  Assert<Extends<HomeView, HomeDto>>,
  Assert<Extends<CanvasLayout, LayoutDto>>,
  Assert<Same<TaskStatus, z.infer<typeof taskStatusSchema>>>,
  Assert<Same<SessionStatus, z.infer<typeof sessionStatusSchema>>>,
  Assert<Same<CapabilityState, z.infer<typeof capabilityStateSchema>>>,
  Assert<Same<OptionCategory, z.infer<typeof optionCategorySchema>>>
];
