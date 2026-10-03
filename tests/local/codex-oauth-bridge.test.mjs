import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  createBridge,
  prepareRequest,
  finishMessage,
  BridgeError,
} from '../../scripts/codex-oauth-bridge.mjs';

const token = 'local-test-token-0123456789abcdef0123456789';
const models = new Map([
  [
    'gpt-6-luna',
    {
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
        reasoningEffort,
      })),
    },
  ],
]);
const request = {
  model: 'gpt-6-luna',
  messages: [{ role: 'user', content: 'Explain fractions.' }],
};
const tools = [
  {
    type: 'function',
    function: {
      name: 'read_lesson',
      description: 'Read a lesson.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
];

test('preserves conversation roles, tool results and images; rejects unsupported inputs', () => {
  const prepared = prepareRequest(
    {
      ...request,
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: 'Lesson text' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    },
    models,
  );
  assert.match(prepared.input[0].text, /tool_call_id/);
  assert.equal(prepared.input[1].type, 'image');
  assert.equal(prepared.effort, 'high');
  assert.throws(() => prepareRequest({ ...request, model: 'unknown' }, models), /Choose a model/);
  assert.throws(
    () => prepareRequest({ ...request, reasoning_effort: 'ultra' }, models),
    /Unsupported reasoning/,
  );
  assert.throws(
    () =>
      prepareRequest(
        { ...request, messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] },
        models,
      ),
    /Only text and image/,
  );
});

test('tool calls remain requests with stable OpenAI shape; malformed calls fail', () => {
  const message = finishMessage(
    JSON.stringify({
      content: '',
      tool_calls: [{ name: 'read_lesson', arguments: '{"id":"lesson-1"}' }],
    }),
    tools,
    'required',
  );
  assert.match(message.tool_calls[0].id, /^call_/);
  assert.equal(message.tool_calls[0].function.name, 'read_lesson');
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { id: 'lesson-1' });
  assert.throws(
    () => finishMessage('{"content":"done","tool_calls":[]}', tools, 'required'),
    /required tool/,
  );
  assert.throws(
    () => finishMessage('{"content":"","tool_calls":[{"name":"shell","arguments":"{}"}]}', tools),
    /unknown tool/,
  );
  assert.throws(
    () =>
      finishMessage('{"content":"","tool_calls":[{"name":"read_lesson","arguments":"[]"}]}', tools),
    /JSON object/,
  );
});

async function fixture(t, generate) {
  const server = createBridge({ models, generate }, token);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  return (path, options = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
}
const post = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('HTTP rejects unauthorized, cross-origin, malformed and unavailable-model requests before generation', async (t) => {
  let called = false;
  const fetchBridge = await fixture(t, async () => {
    called = true;
  });
  assert.equal((await fetchBridge('/v1/models', { headers: { Authorization: '' } })).status, 401);
  assert.equal(
    (await fetchBridge('/health', { headers: { Origin: 'http://localhost:3000' } })).status,
    403,
  );
  assert.equal(
    (await fetchBridge('/v1/chat/completions', { ...post(request), body: '{' })).status,
    400,
  );
  assert.equal(
    (await fetchBridge('/v1/chat/completions', post({ ...request, model: 'unknown' }))).status,
    400,
  );
  assert.equal(called, false);
});

test('streams text once and terminates with stop and DONE', async (t) => {
  const fetchBridge = await fixture(t, async (_body, _signal, delta) => {
    delta('A fraction');
    delta(' is part of a whole.');
    return { role: 'assistant', content: 'A fraction is part of a whole.' };
  });
  const response = await fetchBridge('/v1/chat/completions', post({ ...request, stream: true }));
  const stream = await response.text();
  assert.equal((stream.match(/A fraction/g) || []).length, 1);
  assert.match(stream, /"finish_reason":"stop"/);
  assert.match(stream, /data: \[DONE\]/);
});

test('streams a function call for the application to execute', async (t) => {
  const fetchBridge = await fixture(t, async () =>
    finishMessage(
      '{"content":"","tool_calls":[{"name":"read_lesson","arguments":"{\\"id\\":\\"one\\"}"}]}',
      tools,
    ),
  );
  const response = await fetchBridge(
    '/v1/chat/completions',
    post({ ...request, tools, stream: true }),
  );
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  const tool = events.flatMap((event) => event.choices[0].delta.tool_calls || [])[0];
  assert.equal(tool.index, 0);
  assert.equal(tool.function.name, 'read_lesson');
  assert.deepEqual(JSON.parse(tool.function.arguments), { id: 'one' });
  assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('provider failures stay explicit in JSON and SSE', async (t) => {
  const fetchBridge = await fixture(t, async () => {
    throw new BridgeError('Usage limit reached.', 429);
  });
  const plain = await fetchBridge('/v1/chat/completions', post(request));
  assert.equal(plain.status, 429);
  assert.match((await plain.json()).error.message, /Usage limit/);
  const stream = await fetchBridge('/v1/chat/completions', post({ ...request, stream: true }));
  assert.match(await stream.text(), /"error":\{"message":"Usage limit reached."/);
});
