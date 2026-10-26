import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { capabilityMatrix, available, denied } from '../capability.ts';
import { ATTACHMENT_LIMITS, base64Bytes, isSafeRelativePath, safeFileName, validateAttachments } from '../attachment.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { promptSessionUseCase } from './conversation.ts';
import { listProjectFiles, readSessionAttachment } from './attachments.ts';

function agent(attachments = available): AgentDescriptor {
  return {
    id: asAgentId('fake'),
    label: 'Fake',
    capabilities: capabilityMatrix({
      prompt: available,
      interrupt: available,
      fork: available,
      resume: available,
      tool_calls: available,
      artifacts: available,
      structured_events: available,
      attachments
    }),
    models: ['m1'],
    defaultModel: 'm1',
    options: []
  };
}

async function world(descriptor = agent()) {
  const w = inMemoryDeps();
  w.agents.push(descriptor);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo/' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const fs = w.deps.fs as typeof w.deps.fs & { files: Map<string, Uint8Array> };
  return { ...w, fs, project: project.value, session: session.value };
}

const PNG = Buffer.from('fake-png-bytes').toString('base64');

test('附件校验：数量、类型、大小、路径各有一道关', () => {
  assert.equal(base64Bytes(Buffer.from('abcd').toString('base64')), 4);
  assert.equal(base64Bytes(Buffer.from('abcde').toString('base64')), 5);
  assert.ok(validateAttachments([{ kind: 'image', name: 'a.png', mimeType: 'image/png', data: PNG }]).ok);
  assert.ok(!validateAttachments([{ kind: 'image', name: 'a.svg', mimeType: 'image/svg+xml', data: PNG }]).ok);
  const big = 'A'.repeat(Math.ceil((ATTACHMENT_LIMITS.imageBytes * 4) / 3) + 8);
  assert.ok(!validateAttachments([{ kind: 'image', name: 'big.png', mimeType: 'image/png', data: big }]).ok);
  const many = Array.from({ length: ATTACHMENT_LIMITS.maxCount + 1 }, () => ({ kind: 'mention' as const, path: 'a.ts' }));
  assert.ok(!validateAttachments(many).ok);
  for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'a//b', '']) assert.equal(isSafeRelativePath(bad), false, bad);
  assert.equal(isSafeRelativePath('src/a.ts'), true);
  assert.equal(safeFileName('../../evil name.png'), 'evil_name.png');
  assert.equal(safeFileName('.hidden'), 'hidden');
});

test('发消息带附件：上传落进项目目录，journal 只留元数据，worker 拿到内容块', async () => {
  const w = await world();
  w.dispatched.length = 0;
  const sent = await promptSessionUseCase(w.deps, {
    sessionId: w.session.id,
    text: '看图',
    attachments: [
      { kind: 'image', name: 'shot.png', mimeType: 'image/png', data: PNG },
      { kind: 'mention', path: 'src/main.ts' }
    ]
  });
  assert.ok(sent.ok, JSON.stringify(sent));
  const journal = await w.deps.sessions.eventsAfter(w.session.id, 0 as never);
  const prompt = journal.at(-1)?.event;
  assert.ok(prompt?.kind === 'prompt');
  assert.equal(prompt.attachments?.length, 2);
  const [image, mention] = prompt.attachments ?? [];
  assert.equal(image?.kind, 'image');
  assert.ok(image?.path.startsWith(`.agent-hub/attachments/${w.session.id}/`));
  assert.equal(image?.bytes, Buffer.from('fake-png-bytes').byteLength);
  assert.ok(!('data' in (image ?? {})), 'journal 里不存字节');
  assert.deepEqual(mention, { kind: 'mention', name: 'main.ts', path: 'src/main.ts' });
  assert.ok(!w.fs.files.has(`/tmp/demo/${image?.path}`), 'hub 不替 worker 写文件');

  const command = w.dispatched.find((entry) => entry.kind === 'prompt');
  assert.ok(command?.kind === 'prompt');
  assert.equal(command.parts[0]?.kind === 'image' ? command.parts[0].data : null, PNG);
  assert.equal(command.parts[0]?.path, `/tmp/demo/${image?.path}`, 'worker 照这个路径落盘');
  await w.fs.writeFile(`/tmp/demo/${image?.path}`, Buffer.from('fake-png-bytes'));
  assert.equal(command.parts[1]?.path, '/tmp/demo/src/main.ts');

  const back = await readSessionAttachment(w.deps, w.session.id, image?.path ?? '');
  assert.ok(back.ok);
  assert.equal(Buffer.from(back.value).toString(), 'fake-png-bytes');
});

test('发消息带附件：agent 不收附件就拒绝并说明原因；越界路径拒绝；空消息拒绝', async () => {
  const w = await world(agent(denied('这个 agent 只收文本')));
  const refused = await promptSessionUseCase(w.deps, {
    sessionId: w.session.id,
    text: 'x',
    attachments: [{ kind: 'mention', path: 'a.ts' }]
  });
  assert.ok(!refused.ok);
  assert.equal(refused.error.message, '这个 agent 只收文本');

  const v = await world();
  const escaped = await promptSessionUseCase(v.deps, {
    sessionId: v.session.id,
    text: 'x',
    attachments: [{ kind: 'mention', path: '../secret' }]
  });
  assert.ok(!escaped.ok);
  const empty = await promptSessionUseCase(v.deps, { sessionId: v.session.id, text: '  ' });
  assert.ok(!empty.ok);
  const onlyImage = await promptSessionUseCase(v.deps, {
    sessionId: v.session.id,
    text: '',
    attachments: [{ kind: 'image', name: 'a.png', mimeType: 'image/png', data: PNG }]
  });
  assert.ok(onlyImage.ok, '只发图不写字也可以');
});

test('附件回取只放行本会话的附件目录', async () => {
  const w = await world();
  w.fs.files.set('/tmp/demo/.env', new TextEncoder().encode('SECRET'));
  for (const path of ['.env', `.agent-hub/attachments/other/x.png`, `.agent-hub/attachments/${w.session.id}/../../../.env`]) {
    const read = await readSessionAttachment(w.deps, w.session.id, path);
    assert.ok(!read.ok, path);
  }
});

test('@ 引用选择器：名字前缀优先、再包含、再路径、再模糊；空查询浅层优先', async () => {
  const w = await world();
  for (const path of ['src/deep/main.ts', 'main.ts', 'docs/domain.md', 'src/app/remain.tsx', 'README.md']) {
    w.fs.files.set(`/tmp/demo/${path}`, new Uint8Array());
  }
  const found = await listProjectFiles(w.deps, w.project.id, 'main');
  assert.ok(found.ok);
  assert.deepEqual(found.value.files.slice(0, 4), ['main.ts', 'src/deep/main.ts', 'docs/domain.md', 'src/app/remain.tsx']);
  const fuzzy = await listProjectFiles(w.deps, w.project.id, 'rdmd');
  assert.ok(fuzzy.ok);
  assert.deepEqual(fuzzy.value.files, ['README.md']);
  const all = await listProjectFiles(w.deps, w.project.id, '');
  assert.ok(all.ok);
  assert.deepEqual(all.value.files.slice(0, 2), ['main.ts', 'README.md']);
});

test('远程项目：@ 清单与附件回取都问那台 Worker，不读 hub 本机', async () => {
  const w = await world();
  await w.deps.projects.save({ ...w.project, workerId: 'remote-1' });
  // 会话的工作空间才是权威：它在哪台机器，就问哪台。
  for (const workspace of await w.deps.workspaces.byProject(w.project.id)) {
    await w.deps.workspaces.save({ ...workspace, workerId: 'remote-1' });
  }
  const listed = await listProjectFiles(w.deps, w.project.id, '');
  assert.ok(listed.ok);
  assert.ok(listed.value.files.includes('on-remote-1.ts'));
  const path = `.agent-hub/attachments/${w.session.id}/1-0-a.png`;
  const back = await readSessionAttachment(w.deps, w.session.id, path);
  assert.ok(back.ok);
  assert.equal(Buffer.from(back.value).toString(), `remote-1:/tmp/demo/${path}`);
});
