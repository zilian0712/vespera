import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const roomModule = build({
  entryPoints: ['src/room.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  define: { 'import.meta.env.VITE_API_BASE': '"https://watch.test"' },
}).then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

test('creating a room posts to the API and returns a valid invitation', async context => {
  const invitation = { roomId: 'room-a', token: 'test-invitation' };
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://watch.test/api/rooms');
    assert.equal(init.method, 'POST');
    return Response.json(invitation, { status: 201 });
  });
  const { createRoom } = await roomModule;
  assert.deepEqual(await createRoom(), invitation);
});

for (const { name, response, message } of [
  { name: 'an empty proxy failure', response: () => new Response(null, { status: 500 }), message: '房间服务暂时不可用（HTTP 500），请检查后端连接' },
  { name: 'an HTML gateway failure', response: () => new Response('<html>Bad Gateway</html>', { status: 502 }), message: '房间服务暂时不可用（HTTP 502），请检查后端连接' },
  { name: 'an empty successful response', response: () => new Response(null, { status: 201 }), message: '房间服务返回了无效数据，请稍后重试' },
  { name: 'a missing invitation token', response: () => Response.json({ roomId: 'room-a' }, { status: 201 }), message: '房间服务返回了无效数据，请稍后重试' },
  { name: 'an invalid invitation token', response: () => Response.json({ roomId: 'room-a', token: 123 }, { status: 201 }), message: '房间服务返回了无效数据，请稍后重试' },
  { name: 'an empty room identifier', response: () => Response.json({ roomId: '', token: 'test-invitation' }, { status: 201 }), message: '房间服务返回了无效数据，请稍后重试' },
  { name: 'a structured API error', response: () => Response.json({ error: { message: '服务暂时不可用，请稍后重试' } }, { status: 503 }), message: '服务暂时不可用，请稍后重试' },
  { name: 'an error without a message', response: () => Response.json({ error: null }, { status: 503 }), message: '创建房间失败（HTTP 503），请稍后重试' },
]) {
  test(`creating a room reports ${name} without exposing a JSON parse error`, async context => {
    context.mock.method(globalThis, 'fetch', async () => response());
    const { createRoom } = await roomModule;
    await assert.rejects(createRoom(), { message });
  });
}

test('creating a room preserves network failures', async context => {
  const failure = new TypeError('Failed to fetch');
  context.mock.method(globalThis, 'fetch', async () => { throw failure; });
  const { createRoom } = await roomModule;
  await assert.rejects(createRoom(), error => error === failure);
});
