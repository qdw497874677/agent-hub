import { mkdtempSync, rmSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

type Event = { kind: string; text?: string; delta?: string; promptActor?: string; messageSource?: unknown; deliveryId?: string; outcome?: string };
type Entry = { seq: number; event: Event };
type Delivery = { id: string; seq: number; state: string };
type Message = { messageId: string; body: string; status: string; wake: boolean; initiatorKind?: string };

test.afterAll(stopFakeWorker);

test('real account and MCP messages retain provenance through delivery and journal', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const workerId = await ensureFakeWorker(page, baseURL!, FAKE_AGENT_ID, { agentArgs: ['--mcp-http'] });
  // Worker roots explicitly include /tmp; browser TMPDIR may be a separate short path.
  const rootPath = mkdtempSync('/tmp/ah-provenance-');
  try {
    const post = async (path: string, data: object) => {
      const response = await page.request.post(path, { data, headers });
      expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
      return response.json();
    };
    const project = await post('/api/projects', { name: `real provenance ${Date.now()}`, rootPath, workerId }) as { id: string };
    const task = await post('/api/tasks', { projectId: project.id, title: 'provenance' }) as { id: string };
    const derive = async () => (await post('/api/sessions/derive', { taskId: task.id, agentId: FAKE_AGENT_ID, workerId, model: '' }) as { id: string }).id;
    const a = await derive();
    const b = await derive();
    await post(`/api/projects/${project.id}/session-links`, { aSessionId: a, bSessionId: b });
    const events = async (session: string): Promise<Entry[]> => {
      const response = await page.request.get(`/api/sessions/${session}/events`);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const deliveries = async (session: string): Promise<Delivery[]> => (await (await page.request.get(`/api/sessions/${session}/deliveries`)).json()) as Delivery[];
    const messages = async (): Promise<Message[]> => ((await (await page.request.get(`/api/sessions/${b}/messages`)).json()) as { messages: Message[] }).messages;
    const waitEnded = async (session: string, seq: number) => {
      await expect.poll(async () => {
        const delivery = (await deliveries(session)).find((d) => d.seq === seq);
        if (!delivery || delivery.state !== 'delivered') return null;
        return (await events(session)).filter(({ event }) => event.kind === 'ended' && event.deliveryId === delivery.id).map(({ event }) => event.outcome);
      }, { timeout: 90_000 }).toEqual(['done']);
    };
    const waitPrompt = async (session: string, text: string) => {
      await expect.poll(async () => (await events(session)).filter(({ event }) => event.kind === 'prompt' && event.text === text).length, { timeout: 90_000 }).toBe(1);
      return (await events(session)).find(({ event }) => event.kind === 'prompt' && event.text === text)!;
    };

    const humanText = 'real human direct prompt';
    const human = await post(`/api/sessions/${b}/prompt`, { text: humanText, attachments: [] }) as { deliveryId: string };
    const humanEvent = await waitPrompt(b, humanText);
    expect(humanEvent.event.promptActor).toBe('account');
    expect(humanEvent.event).not.toHaveProperty('messageSource');
    await waitEnded(b, humanEvent.seq);
    expect((await deliveries(b)).find((d) => d.seq === humanEvent.seq)?.id).toBe(human.deliveryId);

    const body = 'provenance-wake-body <tag>';
    const sent = await post(`/api/sessions/${a}/messages`, { kind: 'send', to: `session:${b}`, body }) as { messageId: string };
    const received = await waitPrompt(b, body);
    expect(received.event.messageSource).toEqual({ kind: 'agent_message', messageId: sent.messageId, messageKind: 'send', sender: 'session', initiator: 'account' });
    expect(JSON.stringify(received.event)).not.toContain(a);
    await waitEnded(b, received.seq);
    expect((await events(b)).some(({ event }) => event.delta === 'provenance-input-wrapped:true')).toBe(true);

    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(`/#/p/${project.id}/focus/${b}`);
    const card = page.getByTestId('agent-message-card').filter({ hasText: body }).first();
    await expect(card).toHaveAttribute('data-provenance', 'verified');
    await expect(card.getByRole('link', { name: '查看来源会话' })).toBeVisible();
    await expect(card).not.toContainText(sent.messageId);
    await expect(card).not.toContainText(a);

    const toolBody = 'provenance-tool-wake';
    const toolText = `please-provenance-send target=${b} body=${toolBody} wake=true`;
    await post(`/api/sessions/${a}/prompt`, { text: toolText, attachments: [] });
    const toolPrompt = await waitPrompt(a, toolText);
    await waitEnded(a, toolPrompt.seq);
    const aEvents = await events(a);
    expect(JSON.stringify(aEvents)).not.toContain('provenance-tool-error:');
    const toolResults = aEvents.flatMap(({ event }) => event.delta?.startsWith('provenance-tool:') ? [event.delta.slice('provenance-tool:'.length)] : []);
    expect(toolResults).toHaveLength(1);
    const toolResult = JSON.parse(toolResults[0]) as { result: { structuredContent: { messageId: string; targetSessionId: string } } };
    await expect.poll(async () => (await messages()).filter((m) => m.body === toolBody).length, { timeout: 90_000 }).toBe(1);
    const toolMessage = (await messages()).find((m) => m.body === toolBody)!;
    expect(toolMessage.initiatorKind).toBe('session_tool');
    expect(toolResult.result.structuredContent).toMatchObject({ messageId: toolMessage.messageId, targetSessionId: b });
    const toolReceived = await waitPrompt(b, toolBody);
    expect(toolReceived.event.messageSource).toEqual({ kind: 'agent_message', messageId: toolMessage.messageId, messageKind: 'send', sender: 'session', initiator: 'session_tool' });
    expect(JSON.stringify(toolReceived.event)).not.toContain(a);
    await waitEnded(b, toolReceived.seq);
    await expect(page.getByTestId('agent-message-card').filter({ hasText: toolBody }).first()).toContainText('由会话发起');
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});
