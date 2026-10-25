// 最小的 ACP agent（ndjson over stdio），只给 acp-runtime 的测试用。
import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const say = (sessionId, text) =>
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

let model = 'a';
const options = () => [
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model, options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }
];
const seen = [];
let pendingPrompt;

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    // 我们发出的 request_permission 的回答
    say('s1', `perm:${msg.result.outcome.optionId}`);
    send({ id: pendingPrompt, result: { stopReason: 'end_turn' } });
    return;
  }
  seen.push(msg.method + (msg.params?._meta ? JSON.stringify(msg.params._meta) : ''));
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'key', name: 'Key' }] } });
    case 'authenticate':
      return send({ id: msg.id, result: {} });
    case 'session/new':
      return send({ id: msg.id, result: { sessionId: 's1', configOptions: options() } });
    case 'session/load':
      say(msg.params.sessionId, 'replayed history');
      return send({ id: msg.id, result: { configOptions: options() } });
    case 'session/set_config_option':
      model = msg.params.value;
      return send({ id: msg.id, result: { configOptions: options() } });
    case 'session/prompt':
      say(msg.params.sessionId, `methods:${seen.join(',')}`);
      if (msg.params.prompt[0].text !== 'ask') return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      pendingPrompt = msg.id;
      return send({
        id: 99,
        method: 'session/request_permission',
        params: {
          sessionId: 's1',
          toolCall: { toolCallId: 't' },
          options: [
            { optionId: 'no', name: 'No', kind: 'reject_once' },
            { optionId: 'yes', name: 'Yes', kind: 'allow_once' }
          ]
        }
      });
  }
});
