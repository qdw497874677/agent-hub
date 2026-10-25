import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PromptInput } from '@agent-hub/domain';
import { readPromptCapabilities, toAcpPrompt } from './map-acp.ts';

const b64 = (text: string) => Buffer.from(text).toString('base64');

const input: PromptInput = {
  text: '看看',
  parts: [
    { kind: 'image', name: 'a.png', mimeType: 'image/png', data: b64('png'), path: '/w/.agent-hub/attachments/s/a.png' },
    { kind: 'file', name: 'notes.md', mimeType: 'text/markdown', data: b64('# hi'), path: '/w/x/notes.md' },
    { kind: 'file', name: 'blob.bin', mimeType: 'application/octet-stream', data: b64('\u0000\u00ff'), path: '/w/blob.bin' },
    { kind: 'mention', name: 'main 1.ts', path: '/w/src/main 1.ts' }
  ]
};

test('acp prompt：图片→image，文本文件→内嵌 resource，其余→resource_link', () => {
  const caps = readPromptCapabilities({ agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } } });
  const blocks = toAcpPrompt(input, caps, 'Grok');
  assert.ok(blocks.ok);
  assert.deepEqual(
    blocks.value.map((block) => block['type']),
    ['text', 'image', 'resource', 'resource_link', 'resource_link']
  );
  assert.deepEqual(blocks.value[2], {
    type: 'resource',
    resource: { uri: 'file:///w/x/notes.md', mimeType: 'text/markdown', text: '# hi' }
  });
  assert.equal(blocks.value[4]?.['uri'], 'file:///w/src/main%201.ts');
});

test('acp prompt：没声明能力时按基线降级，图片明确拒绝而不是静默丢掉', () => {
  const caps = readPromptCapabilities({});
  const refused = toAcpPrompt(input, caps, 'OpenCode');
  assert.ok(!refused.ok);
  assert.match(refused.error.message, /OpenCode 没有声明图片输入能力/);
  const noImage = toAcpPrompt({ ...input, parts: input.parts.slice(1) }, caps, 'OpenCode');
  assert.ok(noImage.ok);
  assert.deepEqual(noImage.value.map((block) => block['type']), ['text', 'resource_link', 'resource_link', 'resource_link']);
});
