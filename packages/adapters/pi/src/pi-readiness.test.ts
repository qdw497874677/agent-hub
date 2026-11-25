import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createPiRuntime, PiSession } from './pi-runtime.ts';
import type { StartSpec } from '@agent-hub/domain';

const spec = (options: StartSpec['options'] = {}): StartSpec => ({
  sessionId: 'readiness-test' as StartSpec['sessionId'], taskId: null,
  workspaceRoot: process.cwd(), resume: null, options, requirePromptReady: true
});

async function fixture(fail = false) {
  const dir = await mkdtemp(join(process.cwd(), '.pi-ready-test-'));
  const command = join(dir, 'pi.cjs');
  const log = join(dir, 'calls');
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
let thinking = 'off';
readline.createInterface({input: process.stdin}).on('line', line => {
  const c = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, c.type + '\\n');
  const send = (success, data, error) => console.log(JSON.stringify({type:'response', id:c.id, success, data, error}));
  if (c.type === 'get_state') setTimeout(() => send(true, {sessionId:'real-ref', model:{provider:'p',id:'m'}, thinkingLevel:thinking}), 70);
  else if (c.type === 'set_thinking_level') setTimeout(() => { if (${fail}) send(false, null, 'bad thinking'); else {thinking = c.level; send(true, {});} }, 70);
  else if (c.type === 'get_available_thinking_levels') send(true, {levels:['off','high']});
  else send(true, {});
});
`);
  await chmod(command, 0o755);
  return { command, log, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('managed Pi waits for real protocol and acknowledged configuration once', async () => {
  const f = await fixture();
  try {
    const refs: string[] = [];
    const result = await createPiRuntime({command: f.command, onAgentSessionRef: (_id, ref) => refs.push(ref)}).start(spec({model:'p/m', thinking:'high'}));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const session = result.value;
    try {
      let settled = false;
      const ready = session.prepareForPrompt!().then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(settled, false);
      const [one, two] = await Promise.all([ready, session.prepareForPrompt!()]);
      assert.equal(one.ok, true); assert.equal(two.ok, true);
      assert.deepEqual(refs, ['real-ref']);
      const calls = (await readFile(f.log, 'utf8')).trim().split('\n');
      assert.equal(calls.filter((c) => c === 'set_thinking_level').length, 1);
      assert.equal(calls.includes('prompt'), false);
    } finally { await session.dispose(); }
  } finally { await f.cleanup(); }
});

test('managed Pi fails on spawn, option rejection, and unconfirmed model', async () => {
  const f = await fixture(true);
  try {
    for (const [command, start, expected] of [
      [join(tmpdir(), 'pi-definitely-missing-command'), spec(), /启动准备失败/],
      [f.command, spec({thinking:'high'}), /bad thinking/],
      [f.command, spec({model:'p/wrong'}), /未确认请求的模型/]
    ] as const) {
      const started = await createPiRuntime({command}).start(start);
      assert.equal(started.ok, true);
      if (!started.ok) continue;
      const result = await started.value.prepareForPrompt!();
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, expected);
      await started.value.dispose();
    }
  } finally { await f.cleanup(); }
});

test('overlapping option discovery does not publish stale startup output', async () => {
  const child = spawn(process.execPath, ['-e', `
    const readline = require('node:readline'); let n = 0;
    readline.createInterface({input:process.stdin}).on('line', line => {
      const c = JSON.parse(line); const index = ++n;
      const data = c.type === 'get_state' ? {model:{provider:'p',id:index === 1 ? 'old' : 'new'}, thinkingLevel:'off'} : {levels:['off']};
      setTimeout(() => console.log(JSON.stringify({type:'response',id:c.id,success:true,data})), index === 1 ? 150 : 1);
    });
  `], {stdio:['pipe','pipe','pipe']});
  const reports: string[] = [];
  const session = new PiSession(spec().sessionId, child, ['p/old', 'p/new'], (options) => {
    reports.push(String(options.find((option) => option.id === 'model')?.current));
  });
  try {
    const old = session.loadOptions();
    const current = session.loadOptions();
    await Promise.all([old, current]);
    assert.deepEqual(reports, ['p/new']);
    assert.equal(session.options().find((option) => option.id === 'model')?.current, 'p/new');
  } finally { await session.dispose(); }
});
