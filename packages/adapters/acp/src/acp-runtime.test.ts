import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asSessionId, asTaskId } from '@agent-hub/domain';
import type { PromptInput, RuntimeSession, SessionEvent, StartSpec } from '@agent-hub/domain';
import { hermesAcpOptionValue } from './hermes-acp.ts';
import { createAcpRuntime } from './acp-runtime.ts';
import type { AcpAgentConfig } from './config.ts';
import { opencodeCodec } from './codecs/opencode.ts';

const FAKE = fileURLToPath(new URL('../test-fixtures/fake-agent.mjs', import.meta.url));

const config: AcpAgentConfig = {
  id: 'fake',
  label: 'Fake',
  command: process.execPath,
  args: [FAKE],
  authenticate: (methods) => (methods.includes('key') ? { methodId: 'key' } : null),
  sessionMeta: { yoloMode: true }
};

function spec(t: TestContext, overrides: Partial<StartSpec> = {}): Promise<StartSpec> {
  return mkdtemp(join(tmpdir(), 'hub-acp-')).then((workspaceRoot) => {
    t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
    return {
      sessionId: asSessionId('hub-1'),
      taskId: asTaskId('task-1'),
      workspaceRoot,
      resume: null,
      options: {},
      ...overrides
    };
  });
}

async function collectUntilEnded(session: RuntimeSession): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of session.events()) {
    out.push(event);
    if (event.kind === 'ended') break;
  }
  return out;
}

/** #269/2：送达号是端口上的可选字段，测试里显式带上，等 domain 补字段后类型不用改。 */
function keyed(text: string, deliveryId: string): PromptInput & { readonly deliveryId: string } {
  return { text, parts: [], deliveryId };
}

function nativeRef(session: RuntimeSession): string | null {
  return (session as RuntimeSession & { nativeSessionRef(): string | null }).nativeSessionRef();
}

test('acp runtime: native ref excludes missing and pending session ids', async (t) => {
  for (const ref of [undefined, '', 'pending', ' PENDING ', '   ']) await t.test(String(ref), async (t) => {
    const script = `
      const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value}) + '\\n');
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') return send({id:msg.id,result:{protocolVersion:1}});
        if (msg.method === 'session/new') return send({id:msg.id,result:${JSON.stringify(ref === undefined ? {} : { sessionId: ref })}});
      });`;
    const started = await createAcpRuntime({ id: 'fake', label: 'Fake', command: process.execPath, args: ['-e', script] }).start(await spec(t));
    assert.ok(started.ok);
    t.after(() => started.value.dispose());
    assert.equal(nativeRef(started.value), null);
  });
});

test('OpenCode prompt failure requires the first exact wire response and preserves the process', async (t) => {
  const scenarios = [
    { name: 'proof with prior output', mode: 'proof', codec: true, keyed: true, handled: true },
    { name: 'proof before any output', mode: 'no-output', codec: true, keyed: true, handled: true },
    { name: 'other agent', mode: 'proof', codec: false, keyed: true, handled: false },
    { name: 'unkeyed', mode: 'proof', codec: true, keyed: false, handled: false },
    { name: 'wrong code', mode: 'code', codec: true, keyed: true, handled: false },
    { name: 'missing structured data', mode: 'data', codec: true, keyed: true, handled: false },
    { name: 'wrong name', mode: 'name', codec: true, keyed: true, handled: false },
    { name: 'wrong id followed by unrelated error', mode: 'foreign', codec: true, keyed: true, handled: false },
    { name: 'malformed first response poisons duplicate', mode: 'malformed', codec: true, keyed: true, handled: false },
    { name: 'method-bearing error poisons duplicate', mode: 'method', codec: true, keyed: true, handled: false },
    { name: 'malformed method-only frame poisons duplicate', mode: 'method-only', codec: true, keyed: true, handled: false },
    { name: 'valid reverse request does not poison proof', mode: 'reverse', codec: true, keyed: true, handled: true },
    { name: 'interrupt invalidates evidence', mode: 'interrupt', codec: true, keyed: true, handled: false },
    { name: 'disposed turn cannot be ended by response', mode: 'dispose', codec: true, keyed: true, handled: false }
  ] as const;
  for (const scenario of scenarios) await t.test(scenario.name, async (t) => {
    const script = `
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      const response = (id,error) => send({jsonrpc:'2.0',id,error});
      const error = {code:-32603,message:'SECRET provider details',data:{errorName:'provider.invalid-request',secret:'SECRET'}};
      let pending, previous;
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') return send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1}});
        if (msg.method === 'session/new') return send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'s1'}});
        if (msg.method === 'session/cancel') { if (pending) response(pending,error); return; }
        if (msg.method !== 'session/prompt') return;
        if (msg.params.prompt[0].text === 'next') {
          if (previous !== undefined) response(previous,error);
          send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'next output'}}}});
          return send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn'}});
        }
        const mode = ${JSON.stringify(scenario.mode)};
        previous = msg.id;
        if (mode === 'proof') send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'prior output'}}}});
        if (mode === 'interrupt' || mode === 'dispose') { pending = msg.id; return; }
        if (mode === 'code') error.code = -32602;
        if (mode === 'data') delete error.data;
        if (mode === 'name') error.data.errorName = 'other';
        if (mode === 'foreign') { response(msg.id + 1000,error); error.data.errorName = 'other'; }
        if (mode === 'malformed') send({jsonrpc:'2.0',id:msg.id,result:{},error});
        if (mode === 'method') send({jsonrpc:'2.0',id:msg.id,method:'bogus',error});
        if (mode === 'method-only') send({jsonrpc:'2.0',id:msg.id,method:42});
        if (mode === 'reverse') send({jsonrpc:'2.0',id:msg.id,method:'unrecognized',params:{}});
        response(msg.id,error);
      });`;
    const runtime = createAcpRuntime({ id: 'fake', label: 'Fake', command: process.execPath, args: ['-e', script], ...(scenario.codec ? { codec: opencodeCodec } : {}) });
    const started = await runtime.start(await spec(t));
    assert.ok(started.ok);
    const session = started.value;
    t.after(() => session.dispose());
    const prompt = session.prompt(scenario.keyed ? keyed('first', 'd-first') : { text: 'first', parts: [] });
    if (scenario.mode === 'interrupt') await session.interrupt();
    if (scenario.mode === 'dispose') await session.dispose();
    const result = await prompt;
    assert.equal(result.ok, scenario.handled);
    if (scenario.mode === 'dispose') return;
    assert.ok((await session.prompt(keyed('next', 'd-next'))).ok);
    const events: SessionEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.kind === 'ended' && event.deliveryId === 'd-next') break;
    }
    const ended = events.filter((event) => event.kind === 'ended');
    assert.equal(ended.length, scenario.handled ? 2 : 1);
    if (scenario.handled) {
      assert.deepEqual(ended[0], { kind: 'ended', outcome: 'failed', reason: 'OpenCode 的模型服务拒绝了本轮请求。', deliveryId: 'd-first' });
      if (scenario.mode === 'proof') assert.ok(events.some((event) => event.kind === 'text' && event.delta === 'prior output'));
      assert.ok(!JSON.stringify(events).includes('SECRET'));
    }
  });
});

test('OpenCode EOF with a living child and a foreign response is not a turn outcome', async (t) => {
  const script = `
    const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value}) + '\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') return send({id:msg.id,result:{protocolVersion:1}});
      if (msg.method === 'session/new') return send({id:msg.id,result:{sessionId:'s1'}});
      if (msg.method === 'session/prompt') {
        send({id:msg.id + 999,error:{code:-32603,message:'bad',data:{errorName:'provider.invalid-request'}}});
        process.stdout.end();
      }
    });`;
  const runtime = createAcpRuntime({ id: 'fake', label: 'Fake', command: process.execPath, args: ['-e', script], codec: opencodeCodec });
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());
  assert.equal((await session.prompt(keyed('first', 'd-first'))).ok, false);
  await session.dispose();
  const events: SessionEvent[] = [];
  for await (const event of session.events()) events.push(event);
  assert.ok(!events.some((event) => event.kind === 'ended' && event.deliveryId === 'd-first'));
});

test('OpenCode proven failure closes the event queue when keepAlive is false', async (t) => {
  const script = `
    const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value}) + '\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') return send({id:msg.id,result:{protocolVersion:1}});
      if (msg.method === 'session/new') return send({id:msg.id,result:{sessionId:'s1'}});
      if (msg.method === 'session/prompt') return send({id:msg.id,error:{code:-32603,message:'bad',data:{errorName:'provider.invalid-request'}}});
    });`;
  const runtime = createAcpRuntime({ id: 'fake', label: 'Fake', command: process.execPath, args: ['-e', script], codec: opencodeCodec }, { keepAlive: false });
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  t.after(() => started.value.dispose());
  assert.equal((await started.value.prompt(keyed('first', 'd-first'))).ok, true);
  const events: SessionEvent[] = [];
  for await (const event of started.value.events()) events.push(event);
  assert.deepEqual(events.filter((event) => event.kind === 'ended'), [{ kind: 'ended', outcome: 'failed', reason: 'OpenCode 的模型服务拒绝了本轮请求。', deliveryId: 'd-first' }]);
});

test('acp branch attempt: only proven fork or method-not-found can start a session', async (t) => {
  const branch = { fromAgentSessionRef: 'source', turnRef: 'turn', previousTurnRef: 'previous' };
  const scenarios = [
    { name: 'native', fork: { result: { sessionId: 'forked' } }, expected: 'native', methods: ['initialize', 'session/fork'] },
    { name: 'method unavailable', fork: { error: { code: -32601, message: 'not available' } }, expected: 'plain', methods: ['initialize', 'session/fork', 'session/new'] },
    { name: 'plain returns source', fork: { error: { code: -32601, message: 'not available' } }, fresh: { result: { sessionId: 'source' } }, expected: 'unknown', methods: ['initialize', 'session/fork', 'session/new'] },
    { name: 'ambiguous rejection', fork: { error: { code: -32603, message: 'source missing' } }, expected: 'unknown', methods: ['initialize', 'session/fork'] },
    { name: 'malformed ref', fork: { result: { sessionId: 'pending' } }, expected: 'unknown', methods: ['initialize', 'session/fork'] },
    { name: 'mixed-case padded placeholder', fork: { result: { sessionId: ' PENDING ' } }, expected: 'unknown', methods: ['initialize', 'session/fork'] },
    { name: 'source ref', fork: { result: { sessionId: 'source' } }, expected: 'unknown', methods: ['initialize', 'session/fork'] },
    { name: 'oversized utf8 ref', fork: { result: { sessionId: '界'.repeat(171) } }, expected: 'unknown', methods: ['initialize', 'session/fork'] },
    { name: 'both unavailable', fork: { error: { code: -32601, message: 'not available' } }, fresh: { error: { code: -32601, message: 'not available' } }, expected: 'both_failed', methods: ['initialize', 'session/fork', 'session/new'] },
    { name: 'fresh ambiguous', fork: { error: { code: -32601, message: 'not available' } }, fresh: { error: { code: -32603, message: 'failed' } }, expected: 'unknown', methods: ['initialize', 'session/fork', 'session/new'] }
  ] as const;
  for (const scenario of scenarios) await t.test(scenario.name, async (t) => {
    const startSpec = await spec(t, { branch });
    const log = join(startSpec.workspaceRoot, 'requests');
    const script = `
      const fs = require('node:fs');
      const readline = require('node:readline');
      const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\\n');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const msg = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(msg) + '\\n');
        if (msg.method === 'initialize') return send({id:msg.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{fork:{}}}}});
        if (msg.method === 'session/fork') return send({id:msg.id,...${JSON.stringify(scenario.fork)}});
        if (msg.method === 'session/new') return send({id:msg.id,...${JSON.stringify('fresh' in scenario ? scenario.fresh : { result: { sessionId: 'fresh' } })}});
        return send({id:msg.id,error:{code:-32601,message:'unexpected'}});
      });`;
    const refs: string[] = [];
    const runtime = createAcpRuntime({ id: 'branch-fake', label: 'Fake', command: process.execPath, args: ['-e', script], branchAtTurn: 'jetbrains-air' }, {
      onAgentSessionRef: (_id, ref) => refs.push(ref)
    });
    assert.ok(runtime.startBranchAttempt);
    const result = await runtime.startBranchAttempt(startSpec);
    if (scenario.expected === 'native' || scenario.expected === 'plain') {
      assert.equal(result.state, 'started');
      if (result.state !== 'started') return;
      t.after(() => result.session.dispose());
      assert.equal(result.outcome, scenario.expected);
      assert.equal(result.agentSessionRef, scenario.expected === 'native' ? 'forked' : 'fresh');
      assert.equal(nativeRef(result.session), result.agentSessionRef);
    } else assert.deepEqual(result, { state: scenario.expected });
    assert.deepEqual(refs, []);
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => request.method), scenario.methods);
    assert.equal(requests[1].params.sessionId, 'source');
    assert.equal(requests[1].params._meta.jetbrains.air.fork.messageId, 'previous');
  });
});

test('acp runtime: exact session identity gates anchors, replay and early notifications', async (t) => {
  const script = `
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\\n');
    const update = (sessionId, id, meta) => send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',messageId:id,content:{type:'text',text:id}},...(meta ? {_meta:meta} : {})}});
    let loads = 0;
    readline.createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') return send({id:msg.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{fork:{}}}}});
      if (msg.method === 'session/new') { update('s1','early'); return send({id:msg.id,result:{sessionId:'s1'}}); }
      if (msg.method === 'session/load') {
        loads++;
        update('foreign','foreign-replay');
        update(msg.params.sessionId,loads === 1 ? 'baseline' : 'replay-main');
        return send({id:msg.id,result:{}});
      }
      if (msg.method === 'session/prompt') {
        const text = msg.params.prompt[0].text;
        if (text === 'foreign') { update('foreign','foreign-live'); }
        if (text === 'early') update('s1','early');
        if (text === 'main') { update('s1','main'); update('foreign','foreign-after-main'); }
        if (text === 'child') { update('s1','parent-before-child'); update('s1','child-ref',{'opencode/child-session':{id:'child',parentID:'s1',depth:1}}); }
        if (text === 'child-only') update('s1','child-only-ref',{'opencode/child-session':{id:'child',parentID:'s1',depth:1}});
        if (text === 'foreign-replay') update('s1','foreign-replay');
        if (text === 'baseline') update('s1','baseline');
        send({id:msg.id,result:{stopReason:'end_turn'}});
      }
    });`;
  const refs: Array<[string, string | undefined]> = [];
  const runtime = createAcpRuntime({ id: 'identity', label: 'Fake', command: process.execPath, args: ['-e', script], branchAtTurn: 'jetbrains-air', codec: opencodeCodec }, {
    onTurnRef: (_session, ref, deliveryId) => refs.push([ref, deliveryId])
  });
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value as RuntimeSession & { resync(): Promise<readonly { event: SessionEvent }[]> };
  t.after(() => session.dispose());
  for (const name of ['foreign', 'early', 'main', 'child', 'child-only']) assert.ok((await session.prompt(keyed(name, `d-${name}`))).ok);
  assert.deepEqual(refs, [['early', undefined], ['main', 'd-main'], ['parent-before-child', 'd-child']]);
  const replay = await session.resync();
  assert.deepEqual(replay.flatMap(({ event }) => event.kind === 'text' ? [event.delta] : []), ['baseline']);
  assert.ok((await session.prompt(keyed('foreign-replay', 'd-foreign-replay'))).ok);
  assert.ok((await session.prompt(keyed('baseline', 'd-baseline'))).ok);
  assert.deepEqual(refs.slice(-2), [['foreign-replay', 'd-foreign-replay'], ['baseline', undefined]]);
  const events: SessionEvent[] = [];
  const iterator = session.events()[Symbol.asyncIterator]();
  while (events.filter((event) => event.kind === 'ended').length < 7) {
    const event = await iterator.next();
    assert.ok(!event.done);
    events.push(event.value);
  }
  assert.ok(events.some((event) => event.kind === 'text' && event.subagentId === 'child' && event.delta === 'child-ref'));
  const texts = events.flatMap((event) => event.kind === 'text' ? [event.delta] : []);
  assert.equal(texts.filter((text) => text === 'early').length, 1, 'the pre-response update was not displayed');
  assert.ok(!texts.includes('foreign-live'));
  assert.ok(!texts.includes('foreign-after-main'));
});

test('acp runtime: explicit child metadata cannot own a branch anchor without a codec', async (t) => {
  const script = `
    const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value}) + '\\n');
    const update = (id, meta) => send({method:'session/update',params:{sessionId:'s1',update:{sessionUpdate:'agent_message_chunk',messageId:id,content:{type:'text',text:id}},...(meta ? {_meta:meta} : {})}});
    const child = {'opencode/child-session':{id:'child',parentID:'s1',depth:1}};
    require('node:readline').createInterface({input:process.stdin}).on('line',line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') return send({id:msg.id,result:{protocolVersion:1}});
      if (msg.method === 'session/new') return send({id:msg.id,result:{sessionId:'s1'}});
      if (msg.method === 'session/prompt') {
        const text = msg.params.prompt[0].text;
        if (text === 'parent-and-child') { update('parent'); update('child', child); }
        if (text === 'child-only') update('child-only', child);
        if (text === 'other-meta') update('ordinary', {other:'metadata'});
        return send({id:msg.id,result:{stopReason:'end_turn'}});
      }
    });`;
  const refs: Array<[string, string | undefined]> = [];
  const runtime = createAcpRuntime({ id: 'generic-branch', label: 'Fake', command: process.execPath, args: ['-e', script], branchAtTurn: 'jetbrains-air' }, {
    onTurnRef: (_id, ref, deliveryId) => refs.push([ref, deliveryId])
  });
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  t.after(() => started.value.dispose());
  for (const text of ['parent-and-child', 'child-only', 'other-meta']) assert.ok((await started.value.prompt(keyed(text, `d-${text}`))).ok);
  assert.deepEqual(refs, [['parent', 'd-parent-and-child'], ['ordinary', 'd-other-meta']]);
  const events: SessionEvent[] = [];
  const iterator = started.value.events()[Symbol.asyncIterator]();
  while (events.filter((event) => event.kind === 'ended').length < 3) {
    const event = await iterator.next();
    assert.ok(!event.done);
    events.push(event.value);
  }
  assert.deepEqual(events.flatMap((event) => event.kind === 'text' ? [event.delta] : []), ['parent', 'child', 'child-only', 'ordinary']);
});

test('acp runtime: initial load replay accepts only the exact requested session', async (t) => {
  const script = `
    const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value}) + '\\n');
    const update = (sid,id) => send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',messageId:id,content:{type:'text',text:id}}}});
    require('node:readline').createInterface({input:process.stdin}).on('line',line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') return send({id:msg.id,result:{protocolVersion:1}});
      if (msg.method === 'session/load') { update('other','foreign'); update(msg.params.sessionId,'replayed'); return send({id:msg.id,result:{}}); }
      if (msg.method === 'session/prompt') { update('s1',msg.params.prompt[0].text); return send({id:msg.id,result:{stopReason:'end_turn'}}); }
    });`;
  const refs: Array<[string, string | undefined]> = [];
  const runtime = createAcpRuntime({ id: 'initial-load', label: 'Fake', command: process.execPath, args: ['-e', script], branchAtTurn: 'jetbrains-air' }, {
    onTurnRef: (_id, ref, deliveryId) => refs.push([ref, deliveryId])
  });
  const started = await runtime.start(await spec(t, { resume: { agentSessionRef: 's1', cursor: 0 } }));
  assert.ok(started.ok);
  t.after(() => started.value.dispose());
  assert.ok((await started.value.prompt(keyed('foreign', 'd1'))).ok);
  assert.ok((await started.value.prompt(keyed('replayed', 'd2'))).ok);
  assert.deepEqual(refs, [['foreign', 'd1'], ['replayed', undefined]]);
});

test('acp branch attempt: only supported dialect exposes it and invalid specs do not launch', async (t) => {
  assert.equal(createAcpRuntime(config).startBranchAttempt, undefined);
  let launches = 0;
  const runtime = createAcpRuntime({ ...config, branchAtTurn: 'jetbrains-air', launch: () => { launches += 1; return {}; } });
  assert.ok(runtime.startBranchAttempt);
  assert.deepEqual(await runtime.startBranchAttempt(await spec(t)), { state: 'unknown' });
  assert.deepEqual(await runtime.startBranchAttempt(await spec(t, { branch: { fromAgentSessionRef: 's', turnRef: null, previousTurnRef: 'p' }, resume: { agentSessionRef: 's', cursor: 0 } })), { state: 'unknown' });
  assert.equal(launches, 0);
});

test('acp branch attempt: native session is returned only after options are applied', async (t) => {
  const refs: string[] = [];
  const runtime = createAcpRuntime({ ...config, args: [FAKE, '--fork'], branchAtTurn: 'jetbrains-air' }, {
    onAgentSessionRef: (_id, ref) => refs.push(ref)
  });
  assert.ok(runtime.startBranchAttempt);
  const result = await runtime.startBranchAttempt(await spec(t, {
    branch: { fromAgentSessionRef: 'source', turnRef: 'turn', previousTurnRef: 'previous' },
    options: { model: 'b' }
  }));
  assert.equal(result.state, 'started');
  if (result.state !== 'started') return;
  t.after(() => result.session.dispose());
  assert.equal(result.outcome, 'native');
  assert.equal(result.agentSessionRef, 'f-previous');
  assert.equal(result.session.options()[0]?.current, 'b');
  assert.deepEqual(refs, []);
  const events = collectUntilEnded(result.session);
  assert.ok((await result.session.prompt({ text: 'hi', parts: [] })).ok);
  const text = (await events).find((event) => event.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.match(text.delta, /^methods:initialize,authenticate,session\/fork.*session\/set_config_option,session\/prompt$/);
});

test('acp branch attempt: disconnect during fork is unknown and cannot trigger session/new', async (t) => {
  const startSpec = await spec(t, { branch: { fromAgentSessionRef: 'source', turnRef: 'turn', previousTurnRef: 'previous' } });
  const log = join(startSpec.workspaceRoot, 'requests');
  const script = `
    const fs = require('node:fs');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(log)}, msg.method + '\\n');
      if (msg.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{fork:{}}}}}) + '\\n');
      else process.exit(0);
    });`;
  const runtime = createAcpRuntime({ id: 'disconnect', label: 'Fake', command: process.execPath, args: ['-e', script], branchAtTurn: 'jetbrains-air' });
  assert.ok(runtime.startBranchAttempt);
  assert.deepEqual(await runtime.startBranchAttempt(startSpec), { state: 'unknown' });
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['initialize', 'session/fork']);
});

test('acp runtime: turn refs belong to the completed prompt, never replayed or reused IDs', async (t) => {
  const script = `
    const readline = require('node:readline');
    const out = (message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message}) + '\\n');
    const update = (id) => out({method:'session/update', params:{sessionId:'s1', update:{sessionUpdate:'agent_message_chunk', content:{type:'text',text:'ok'}, messageId:id}}});
    readline.createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') return out({id:msg.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{fork:{}}}}});
      if (msg.method === 'session/load') { update('replayed'); return out({id:msg.id,result:{}}); }
      if (msg.method === 'session/prompt') {
        const text = msg.params.prompt[0].text;
        if (text !== 'empty') { update(text); update(text); }
        return out({id:msg.id,result:{stopReason:'end_turn'}});
      }
      out({id:msg.id,result:{}});
    });`;
  const refs: Array<[string, string | undefined]> = [];
  const runtime = createAcpRuntime({ id: 'fake-fork', label: 'Fake', command: process.execPath, args: ['-e', script], branchAtTurn: 'jetbrains-air' }, {
    onTurnRef: (_session, ref, deliveryId) => refs.push([ref, deliveryId])
  });
  const started = await runtime.start(await spec(t, { resume: { agentSessionRef: 's1', cursor: 0 } }));
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());
  assert.ok((await session.prompt(keyed('fresh', 'd1'))).ok);
  assert.ok((await session.prompt(keyed('replayed', 'd2'))).ok);
  assert.ok((await session.prompt(keyed('fresh', 'd3'))).ok);
  assert.ok((await session.prompt({ text: 'unkeyed', parts: [] })).ok);
  assert.deepEqual(refs, [['fresh', 'd1'], ['replayed', undefined], ['fresh', undefined], ['unkeyed', undefined]]);

  // An empty completion pauses for stderr; a subsequent turn must not leak into it.
  const empty = session.prompt(keyed('empty', 'd4'));
  while ((session as unknown as { turn: unknown }).turn !== null) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok((await session.prompt(keyed('next', 'd5'))).ok);
  assert.ok((await empty).ok);
  assert.deepEqual(refs.at(-1), ['next', 'd5']);
  assert.equal(refs.length, 5);
});

test('acp runtime: deliveryId 只挂在确认属于这一轮的 ended 上；无 key / dispose 的 ended 不带', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;

  // 带 key：应答 = 这一轮 session/prompt 的确切终态，ended 原样带回同一个 id
  const keyedTurn = collectUntilEnded(session);
  assert.ok((await session.prompt(keyed('hi', 'd-acp-1'))).ok);
  const keyedEvents = await keyedTurn;
  assert.deepEqual(keyedEvents.at(-1), { kind: 'ended', outcome: 'done', deliveryId: 'd-acp-1' });

  // 没带 key：不编造 deliveryId（老调用方 / 无送达记录的轮次）
  const bareTurn = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'hi', parts: [] })).ok);
  const bareEnded = (await bareTurn).at(-1);
  assert.ok(bareEnded && bareEnded.kind === 'ended');
  assert.equal('deliveryId' in bareEnded, false);

  // 生命周期（dispose）不是送达的终态：即使上一轮带过 key，stopped 也不带
  const rest = collectUntilEnded(session);
  await session.dispose();
  const stopped = (await rest).at(-1);
  assert.ok(stopped && stopped.kind === 'ended');
  assert.deepEqual(stopped, { kind: 'ended', outcome: 'stopped' });
  assert.equal('deliveryId' in stopped, false);
});

test('acp runtime: 上一轮还在飞时拒绝并发 prompt，不把两轮的 update 混在一起', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());

  // 'ask' 会等客户端回 permission（本适配器自动允许），第一轮在应答到达前一直算在飞
  const first = session.prompt(keyed('ask', 'd-acp-2'));
  const second = await session.prompt({ text: 'hi', parts: [] });
  assert.equal(second.ok, false, '并发 prompt 直接拒');
  assert.match(second.ok ? '' : second.error.message, /上一轮还没结束/);
  const events = await first;
  assert.ok(events.ok);
  const ended = await (async () => {
    for await (const event of session.events()) if (event.kind === 'ended') return event;
    return null;
  })();
  assert.ok(ended && ended.kind === 'ended');
  assert.equal(ended.deliveryId, 'd-acp-2');
});

/**
 * 在 `ms` 内等一条 ended；超时返回 null，但**保留**已经挂上的 next()，
 * 下次调用继续用它，避免把随后到达的事件吞进一个没人等的 promise。
 */
function endedReader(events: AsyncIterator<SessionEvent>): (ms: number) => Promise<SessionEvent | null> {
  let pending = events.next();
  return async (ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const raced = await Promise.race([
        pending.then((next) => ({ kind: 'next' as const, next })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' as const }), left))
      ]);
      if (raced.kind === 'timeout') return null;
      pending = events.next();
      if (raced.next.done) return null;
      if (raced.next.value.kind === 'ended') return raced.next.value;
    }
  };
}

test('acp runtime: 事件流断了但进程还活着 → 不推 ended；真实退出才报终态且不带 key', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;
  const pid = session.pid?.() ?? null;
  assert.ok(pid !== null, '拿得到子进程 pid');
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  });

  const nextEnded = endedReader(session.events()[Symbol.asyncIterator]());
  // please-detach：agent 关掉 stdout、这一轮不应答、进程继续活着
  const prompt = await session.prompt(keyed('please-detach', 'd-acp-detach'));
  assert.equal(prompt.ok, false, '连接断了，这一条 prompt 不可能成功');

  // 旧实现会在这里凭 connection.closed 推一条带 key 的 failed ended；断流不是进程退出证明。
  assert.equal(await nextEnded(300), null, '进程还活着，不能凭断流编一个终态');

  process.kill(pid, 'SIGKILL');
  const ended = await nextEnded(5000);
  assert.ok(ended && ended.kind === 'ended');
  assert.equal(ended.outcome, 'failed');
  // 这一条 prompt 的应答已经是失败（hub 已知投递没成），进程退出属于生命周期，不补挂 key。
  assert.equal('deliveryId' in ended, false);
});

test('acp runtime: 认证钩子、_meta、开跑前选项都按顺序落到 agent 上', async (t) => {
  const refs: string[] = [];
  const reported: string[] = [];
  const runtime = createAcpRuntime(config, {
    onAgentSessionRef: (_id, ref) => refs.push(ref),
    onOptions: (_id, options) => reported.push(String(options[0]?.current))
  });
  const started = await runtime.start(await spec(t, { options: { model: 'b' } }));
  assert.ok(started.ok);
  const session = started.value;
  assert.deepEqual(refs, ['s1'], '新会话立刻报出 agent 的真实 ref');
  assert.equal(nativeRef(session), 's1');
  assert.equal(session.options()[0]?.current, 'b');
  assert.ok(reported.includes('b'));

  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'hi', parts: [] })).ok);
  const seen = await events;
  assert.deepEqual(seen.at(-1), { kind: 'ended', outcome: 'done' });
  const text = seen.find((event) => event.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.equal(text.delta, 'methods:initialize,authenticate,session/new{"yoloMode":true},session/set_config_option,session/prompt');
  await session.dispose();
});

test('acp runtime: 恢复时丢掉回放、权限请求自动选 allow、dispose 记 stopped', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(await spec(t, { resume: { agentSessionRef: 's-old', cursor: 0 } }));
  assert.ok(started.ok);
  const session = started.value;
  assert.equal(nativeRef(session), 's-old');

  const turn = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'ask', parts: [] })).ok);
  const events = await turn;
  const texts = events.flatMap((event) => (event.kind === 'text' ? [event.delta] : []));
  assert.ok(!texts.includes('replayed history'), '回放的历史不该再出现');
  assert.ok(texts.includes('perm:yes'));
  const commands = events.find((event) => event.kind === 'commands');
  assert.ok(commands && commands.kind === 'commands');
  assert.deepEqual(commands.commands.map((command) => command.name), ['init'], '恢复会话时重新上报的命令表要保留');

  const rest = collectUntilEnded(session);
  await session.dispose();
  assert.deepEqual((await rest).at(-1), { kind: 'ended', outcome: 'stopped' });
});

test('acp runtime: 回合结束后进程保活，后续 update 仍产出事件，dispose 才真关闭', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;
  const events = session.events()[Symbol.asyncIterator]();

  assert.ok((await session.prompt({ text: 'please-late', parts: [] })).ok);
  // 先把这一轮读到底：最后一条是回合事件 ended
  const seen: SessionEvent[] = [];
  while (seen.at(-1)?.kind !== 'ended') {
    const next = await events.next();
    assert.ok(!next.done, '回合结束后队列不该关');
    seen.push(next.value);
  }
  assert.deepEqual(seen.at(-1), { kind: 'ended', outcome: 'done' });
  assert.ok(seen.some((event) => event.kind === 'text' && event.delta === 'late:先回一句'));

  // 回合结束后进程还活着：迟到的 session/update 继续映射成事件
  const late = await events.next();
  assert.ok(!late.done, '保活时队列还开着');
  assert.equal(late.value.kind === 'text' ? late.value.delta : null, 'late:我还在');

  // dispose 是唯一真正关闭的路径：报 stopped，之后队列结束
  const stopped = events.next();
  await session.dispose();
  const tail = await stopped;
  assert.ok(!tail.done);
  assert.deepEqual(tail.value, { kind: 'ended', outcome: 'stopped' });
  assert.equal((await events.next()).done, true, 'dispose 之后不再产出事件');
});

test('acp runtime: keepAlive=false 时回合结束就关队列（老行为）', async (t) => {
  const runtime = createAcpRuntime(config, { keepAlive: false });
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;
  const events = session.events()[Symbol.asyncIterator]();

  assert.ok((await session.prompt({ text: 'hi', parts: [] })).ok);
  const seen: SessionEvent[] = [];
  while (seen.at(-1)?.kind !== 'ended') {
    const next = await events.next();
    assert.ok(!next.done);
    seen.push(next.value);
  }
  assert.equal((await events.next()).done, true, '回合结束就关队列');
  await session.dispose();
});

test('acp runtime: 命令不存在时返回 unavailable，不崩', async (t) => {
  const runtime = createAcpRuntime({ ...config, command: '/nonexistent/agent' });
  const started = await runtime.start(await spec(t));
  assert.equal(started.ok, false);
});

test('acp runtime: 没有资产时也调 launch（Hermes 靠它无条件隔离 HERMES_HOME）', async (t) => {
  let called = 0;
  const runtime = createAcpRuntime({
    ...config,
    launch: (assets) => {
      called += 1;
      assert.equal(assets, undefined, '没有资产时给 undefined，而不是不调');
      return { env: { HERMES_HOME: '/tmp/isolated' } };
    }
  });
  const started = await runtime.start(await spec(t, { assets: undefined }));
  assert.ok(started.ok);
  assert.equal(called, 1);
  await started.value.dispose();
});

test('acp runtime: launch 给的 sessionMeta 叠加到 session/new 的 _meta 上（Grok 的 rules 走这里）', async (t) => {
  const assets = { root: '/x', skills: [], instructions: [] };
  const runtime = createAcpRuntime({ ...config, launch: () => ({ sessionMeta: { rules: 'R' } }) });
  const started = await runtime.start(await spec(t, { assets }));
  assert.ok(started.ok);
  const session = started.value;
  const turn = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'methods', parts: [] })).ok);
  const text = (await turn).find((event) => event.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.match(text.delta, /session\/new\{"yoloMode":true,"rules":"R"\}/);
  await session.dispose();
});

test('acp runtime: 只报老式 models/modes 的 agent（Hermes）→ 选项照样能看能改，走 set_model / set_mode', async (t) => {
  const runtime = createAcpRuntime({ ...config, args: [FAKE, '--legacy'], optionValue: hermesAcpOptionValue });
  const started = await runtime.start(await spec(t, { options: { model: 'hub-p/m-2', mode: 'accept_edits' } }));
  assert.ok(started.ok, started.ok ? '' : started.error.message);
  const session = started.value;
  const byId = Object.fromEntries(session.options().map((o) => [o.id, o]));
  assert.equal(byId['model']?.category, 'model');
  assert.equal(byId['model']?.current, 'hub-p/m-2', 'agent 收到 custom:m-2，hub 看到的仍是 hub 模型 id（不改写 session.model）');
  assert.ok(byId['model']?.choices.some((c) => c.kind === 'value' && c.value.value === 'hub-p/m-2'));
  assert.equal(byId['mode']?.current, 'accept_edits');

  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'hi', parts: [] })).ok);
  const text = (await events).find((event) => event.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.equal(text.delta, 'methods:initialize,authenticate,session/new{"yoloMode":true},session/set_model,session/set_mode,session/prompt');
  const bad = await session.changeOption('effort', 'high');
  assert.equal(bad.ok, false);
  await session.dispose();
});

test('acp runtime: 一轮什么都没回 → failed，带 stopReason 和脱敏后的 stderr', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());
  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-empty', parts: [] })).ok);
  const ended = (await events).at(-1);
  assert.ok(ended && ended.kind === 'ended');
  assert.equal(ended.outcome, 'failed');
  assert.match(ended.reason ?? '', /agent 没有返回任何内容（可能是模型\/鉴权\/网络问题）/);
  assert.match(ended.reason ?? '', /stopReason: end_turn/);
  assert.match(ended.reason ?? '', /401 Unauthorized/);
  assert.doesNotMatch(ended.reason ?? '', /livesecret|abcdefghijklmnop/);
  await session.dispose();
});

test('acp runtime: child session updates → subagent start/子事件/end，父会话不混入子文本', async (t) => {
  const runtime = createAcpRuntime({ ...config, args: [FAKE, '--child'], codec: opencodeCodec });
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());
  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-child', parts: [] })).ok);
  const seen = await events;

  const start = seen.find((event) => event.kind === 'subagent' && event.phase === 'start');
  assert.ok(start && start.kind === 'subagent');
  assert.equal(start.id, 'c1');
  assert.equal(start.parentId, 's1');
  assert.equal(start.depth, 1);
  assert.equal(start.title, 'child task');
  assert.equal(start.agent, 'explorer');
  assert.equal(start.status, 'running');

  const childText = seen.find((event) => event.kind === 'text' && event.subagentId === 'c1');
  assert.ok(childText && childText.kind === 'text');
  assert.equal(childText.delta, 'child says hi');
  const childTool = seen.find((event) => event.kind === 'tool_call' && event.subagentId === 'c1');
  assert.ok(childTool && childTool.kind === 'tool_call');
  assert.equal(childTool.name, 'child: shell');
  const parentText = seen.find((event) => event.kind === 'text' && !event.subagentId);
  assert.ok(parentText && parentText.kind === 'text');
  assert.equal(parentText.delta, 'parent done');

  const end = seen.find((event) => event.kind === 'subagent' && event.phase === 'end');
  assert.ok(end && end.kind === 'subagent');
  assert.equal(end.id, 'c1');
  assert.equal(end.status, 'completed');
  assert.deepEqual(seen.at(-1), { kind: 'ended', outcome: 'done' });
});

test('acp runtime: 回合结束后 resync 重放只补后台子代理的新总结，不重发历史', async (t) => {
  const runtime = createAcpRuntime({ ...config, codec: opencodeCodec });
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok, started.ok ? '' : started.error.message);
  const session = started.value as RuntimeSession & {
    resync(): Promise<readonly { key: string; event: SessionEvent }[]>;
    pendingSubagents(): number;
  };
  t.after(() => session.dispose());

  const turn = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-backlog', parts: [] })).ok);
  const seen = await turn;
  const liveTexts = seen.flatMap((event) => (event.kind === 'text' ? [event.delta] : []));
  assert.ok(liveTexts.includes('已交给子代理'));
  assert.equal(session.pendingSubagents(), 1, '回合结束时后台子代理还没结束');

  // opencode 之后不再推 session/update；总结只有 session/load 的重放里才有
  await new Promise((resolve) => setTimeout(resolve, 400));
  const first = await session.resync();
  const summarized = first.flatMap((entry) => (entry.event.kind === 'text' ? [entry.event.delta] : []));
  assert.deepEqual(summarized, ['子代理已完成：child-done'], '只补新总结；重放里的旧 thought / 旧工具 / 旧文本都不该再发');
  assert.ok(first.every((entry) => entry.key.length > 0));

  // 再拉一次：整段历史都见过了，不该返回任何事件（worker 侧还有一层指纹兜底）
  assert.deepEqual(await session.resync(), []);

  // opencode 每次 session/load 之后都会重发同一份命令表：内容没变就不该再进队列
  const commandEvents = seen.filter((event) => event.kind === 'commands').length;
  assert.ok(commandEvents <= 1, `命令表只报一次，实际 ${commandEvents} 次`);

  // 重放的事件不能进正常队列：队列里只剩收尾（未结束的子代理 + dispose 的 stopped）
  const tail = session.events()[Symbol.asyncIterator]();
  await session.dispose();
  const rest: SessionEvent[] = [];
  for (;;) {
    const next = await tail.next();
    if (next.done) break;
    rest.push(next.value);
    if (next.value.kind === 'ended') break;
  }
  assert.deepEqual(rest.at(-1), { kind: 'ended', outcome: 'stopped' });
  assert.ok(!rest.some((event) => event.kind === 'text'), '重放过的历史没有重新进队列');
});

test('acp runtime: refusal / max_tokens 各自报失败原因，不再当成完成', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(await spec(t));
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());
  let events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-refuse', parts: [] })).ok);
  let ended = (await events).at(-1);
  assert.ok(ended && ended.kind === 'ended' && ended.outcome === 'failed');
  assert.match(ended.reason ?? '', /模型拒绝了这次请求/);
  events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-long', parts: [] })).ok);
  ended = (await events).at(-1);
  assert.ok(ended && ended.kind === 'ended' && ended.outcome === 'failed');
  assert.match(ended.reason ?? '', /长度上限/);
  await session.dispose();
});

test('acp runtime: 没上报过的配置项跳过，模型照常先落', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(await spec(t, { options: { not_a_real_option: 'x', model: 'b' } }));
  assert.ok(started.ok, started.ok ? '' : started.error.message);
  const session = started.value;
  t.after(() => session.dispose());
  assert.equal(session.options()[0]?.current, 'b', '模型照常落');
  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'hi', parts: [] })).ok);
  const text = (await events).find((event) => event.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.equal(
    text.delta,
    'methods:initialize,authenticate,session/new{"yoloMode":true},session/set_config_option,session/set_config_option,session/prompt',
    '未知项被 agent 拒绝后跳过，模型的值先于其它项应用'
  );
  await session.dispose();
});
