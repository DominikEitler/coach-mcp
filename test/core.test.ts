import { test } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configuration } from '../src/config.js';
import { DataStore } from '../src/data.js';
import { Intervals, checkRange } from '../src/intervals.js';
import { createServer } from '../src/server.js';
import { createApp } from '../src/http.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'coach-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'athlete'));
  await mkdir(join(root, 'notes'));
  await writeFile(join(root, '.gitignore'), '.coach-write-lock/\n*.tmp\n');
  await writeFile(join(root, 'athlete/profile.md'), '# Original\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'baseline');
  return { root, git };
}
await test('configuration fails closed and calendar dates are validated', () => {
  assert.throws(() => configuration({ TRANSPORT: 'http' }));
  assert.throws(() => configuration({ ENABLE_DATA_WRITES: 'yes' }));
  assert.throws(() => checkRange('2026-02-30', '2026-03-01'));
  assert.throws(() => checkRange('2026-03-01', '2026-02-28'));
  assert.throws(() => checkRange('2026-01-01', '2026-12-31'));
  checkRange('2024-02-29', '2024-03-01');
});
await test('data revisions, commits, conflicts and filesystem boundaries', async (t) => {
  const { root, git } = await fixture(t);
  const data = new DataStore(root, true);
  const current = await data.read('athlete/profile.md');
  const saved = await data.update(
    current.path,
    '# Updated\n',
    current.sha256,
    'Agreed profile update',
    'Yes, update my profile',
  );
  assert.equal(saved.changed, true);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('log', '-1', '--format=%s'), 'coach: Agreed profile update');
  await assert.rejects(
    data.update(current.path, 'stale', current.sha256, 'Stale update', 'Yes'),
    /changed/,
  );
  assert.equal(await readFile(join(root, current.path), 'utf8'), '# Updated\n');
  await assert.rejects(data.read('../outside.md'), /approved/);
  await symlink(join(root, 'athlete/profile.md'), join(root, 'notes/link.md'));
  await assert.rejects(data.read('notes/link.md'), /non-linked/);
  await assert.rejects(data.update('notes/new.md', 'hello', null, 'New note'), /clean/);
  await assert.rejects(new DataStore(root).update(current.path, '', null, 'disabled'), /disabled/);
});
await test('concurrent writes cannot overwrite each other', async (t) => {
  const { root } = await fixture(t);
  const a = new DataStore(root, true),
    b = new DataStore(root, true);
  const { sha256 } = await a.read('athlete/profile.md');
  const outcomes = await Promise.allSettled([
    a.update('athlete/profile.md', 'A', sha256, 'First update', 'Yes'),
    b.update('athlete/profile.md', 'B', sha256, 'Second update', 'Yes'),
  ]);
  assert.equal(outcomes.filter((v) => v.status === 'fulfilled').length, 1);
});
await test('protected documents require a recorded athlete confirmation', async (t) => {
  const { root, git } = await fixture(t);
  const data = new DataStore(root, true);
  const { sha256 } = await data.read('athlete/profile.md');
  await assert.rejects(
    data.update('athlete/profile.md', '# Inferred\n', sha256, 'Raise FTP'),
    /Protected/,
  );
  await assert.rejects(data.update('season/2026.md', '# Goals\n', null, 'New goals'), /Protected/);
  await assert.rejects(
    data.update('coach/handbook.md', '# Rules\n', null, 'New rules'),
    /Protected/,
  );
  assert.equal(await readFile(join(root, 'athlete/profile.md'), 'utf8'), '# Original\n');
  await data.update('athlete/profile.md', '# FTP 280\n', sha256, 'Raise FTP', 'Yes, set 280 W');
  assert.equal(
    git('log', '-1', '--format=%(trailers:key=Athlete-Confirmation,valueonly)'),
    'Yes, set 280 W',
  );
  const note = await data.update('notes/lessons.md', '# Lesson\n', null, 'Record lesson');
  assert.equal(note.changed, true);
});
await test('Intervals requests use official paths, auth, ranges and safe errors', async () => {
  const calls: URL[] = [];
  const api = new Intervals('secret', '0', (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      'Basic ' + Buffer.from('API_KEY:secret').toString('base64'),
    );
    return Promise.resolve(
      Response.json(url.pathname.includes('/activity/') ? { id: 'i123' } : [{ id: 'i123' }]),
    );
  });
  await api.list('activities', '2026-09-01', '2026-09-07');
  await api.activity('i123');
  assert.equal(calls[0]?.pathname, '/api/v1/athlete/0/activities');
  assert.equal(calls[0]?.searchParams.get('newest'), '2026-09-07');
  assert.equal(calls[1]?.searchParams.get('intervals'), 'true');
  await assert.rejects(api.activity('../secrets'), /Invalid/);
  await assert.rejects(
    new Intervals().list('wellness', '2026-09-01', '2026-09-07'),
    /not configured/,
  );
  await assert.rejects(
    new Intervals('secret', '0', () =>
      Promise.resolve(new Response('secret response body', { status: 401 })),
    ).activity('1'),
    /^Error: Intervals.icu returned HTTP 401\.$/,
  );
  await assert.rejects(
    new Intervals('secret', '0', () => Promise.resolve(new Response('', { status: 403 }))).activity(
      'i1',
    ),
    /Activity i1 not found for this athlete/,
  );
});
await test('Intervals responses are reduced to coaching fields without losing values', async () => {
  const run = {
    id: 'i1',
    type: 'Run',
    distance: 9625.98,
    moving_time: 4077,
    icu_rpe: 5,
    icu_average_watts: null,
    interval_summary: [],
    skyline_chart_bytes: 'abc',
    icu_sync_date: '2026-09-26',
  };
  const api = new Intervals('secret', '0', (input) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith('/activities')) return Promise.resolve(Response.json([run]));
    if (path.endsWith('/wellness'))
      return Promise.resolve(
        Response.json([{ id: '2026-09-26', hrv: 61, locked: false, mood: null }]),
      );
    if (path.endsWith('/activity/i1'))
      return Promise.resolve(
        Response.json({
          ...run,
          lthr: 182,
          icu_intervals: [{ type: 'WORK', moving_time: 4077, start_index: 0, zone: null }],
        }),
      );
    return Promise.resolve(Response.json(['not an activity']));
  });
  assert.deepEqual(await api.activities('2026-09-26', '2026-09-26'), [
    { id: 'i1', type: 'Run', distance: 9625.98, moving_time: 4077, icu_rpe: 5 },
  ]);
  assert.deepEqual(await api.wellness('2026-09-26', '2026-09-26'), [{ id: '2026-09-26', hrv: 61 }]);
  assert.deepEqual(await api.activity('i1'), {
    id: 'i1',
    type: 'Run',
    distance: 9625.98,
    moving_time: 4077,
    icu_rpe: 5,
    lthr: 182,
    icu_intervals: [{ type: 'WORK', moving_time: 4077 }],
  });
  await assert.rejects(api.activity('2'), /unexpected response/);
});
await test('MCP discovery, tool errors and partial context via real SDK client', async (t) => {
  const { root } = await fixture(t);
  const server = createServer(configuration({ COACH_DATA_DIR: root }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 7);
  assert.ok(!listed.tools.some((v) => v.name === 'update_coaching_document'));
  const result = await client.callTool({
    name: 'get_coaching_context',
    arguments: { oldest: '2026-09-01', newest: '2026-09-07', documents: ['athlete/profile.md'] },
  });
  const body = z
    .object({
      sources: z.object({
        activities: z.object({ available: z.boolean() }),
        'document:athlete/profile.md': z.object({ data: z.object({ content: z.string() }) }),
      }),
    })
    .parse(JSON.parse((result.content as { text: string }[])[0]!.text));
  assert.equal(body.sources.activities.available, false);
  assert.equal(body.sources['document:athlete/profile.md'].data.content, '# Original\n');
  const error = await client.callTool({
    name: 'read_coaching_document',
    arguments: { path: '../secret.md' },
  });
  assert.equal(error.isError, true);
});
await test('HTTP authentication, origin checks and MCP initialize/discovery', async (t) => {
  const { root } = await fixture(t);
  const token = 'x'.repeat(40);
  const app = createApp(
    configuration({ TRANSPORT: 'http', MCP_TOKEN: token, COACH_DATA_DIR: root }),
  );
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => listener.close((e) => (e ? reject(e) : resolve()))),
  );
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  assert.equal((await client.listTools()).tools.length, 7);
  await client.close();
});
await test('built entry point supports stdio without stdout noise', async (t) => {
  const { root } = await fixture(t);
  const client = new Client({ name: 'stdio-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['dist/index.js'],
      env: { COACH_DATA_DIR: root },
      stderr: 'pipe',
    }),
  );
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 7);
});
