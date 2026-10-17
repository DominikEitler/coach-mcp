import { test } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configuration } from '../src/config.js';
import { DataStore } from '../src/data.js';
import { Intervals, checkRange, resetWriteLimit } from '../src/intervals.js';
import { createServer } from '../src/server.js';
import { createApp } from '../src/http.js';
import { Coaching, isoWeek, localDate } from '../src/coaching.js';
import { Notifier, evening, morning, startSchedule, weekly, type Message } from '../src/notify.js';
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
await test('upstream sync fast-forwards, retries failed pushes and stops at divergence', async (t) => {
  const { root, git } = await fixture(t);
  const remote = await mkdtemp(join(tmpdir(), 'coach-remote-'));
  const other = await mkdtemp(join(tmpdir(), 'coach-other-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  t.after(() => rm(other, { recursive: true, force: true }));
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'HEAD');
  execFileSync('git', ['clone', '-q', remote, other]);
  const elsewhere = async (file: string, text: string) => {
    await mkdir(join(other, 'notes'), { recursive: true });
    await writeFile(join(other, file), text);
    execFileSync('git', ['-C', other, 'add', file]);
    execFileSync('git', [
      '-C',
      other,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@l',
      'commit',
      '-qm',
      file,
    ]);
    execFileSync('git', ['-C', other, 'push', '-q']);
  };
  const remoteHead = () =>
    execFileSync('git', ['-C', remote, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const data = new DataStore(root, true, true);

  // An edit made elsewhere is fast-forwarded before writing, and the write is pushed.
  await elsewhere('notes/elsewhere.md', '# Edited on GitHub\n');
  const note = await data.update('notes/coach.md', '# Coach note\n', null, 'Add coach note');
  assert.equal(note.synced, true);
  assert.equal(await readFile(join(root, 'notes/elsewhere.md'), 'utf8'), '# Edited on GitHub\n');
  assert.equal(remoteHead(), git('rev-parse', 'HEAD'));

  // A rejected push keeps the commit locally, and the next sync publishes it.
  const hook = join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const saved = await data.update('notes/coach.md', '# Changed\n', note.sha256, 'Change note');
  assert.equal(saved.synced, false);
  assert.notEqual(remoteHead(), git('rev-parse', 'HEAD'));
  await rm(hook);
  await data.sync();
  assert.equal(remoteHead(), git('rev-parse', 'HEAD'));

  // Commits on both sides are never merged or overwritten automatically.
  execFileSync('git', ['-C', other, 'pull', '-q']);
  await elsewhere('notes/elsewhere.md', '# Edited again\n');
  await writeFile(join(root, 'notes/local.md'), 'local\n');
  git('add', 'notes/local.md');
  git('-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-qm', 'local');
  await assert.rejects(data.sync(), /diverged/);
  await assert.rejects(
    data.update('notes/coach.md', '# Blocked\n', saved.sha256, 'Blocked change'),
    /diverged/,
  );
  assert.equal(await readFile(join(root, 'notes/coach.md'), 'utf8'), '# Changed\n');
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
await test("calendar entries: only the coach's own, inside the window, rate limited", async () => {
  resetWriteLimit();
  type Event = Record<string, unknown> & { id: number };
  const calendar = new Map<number, Event>([
    [7, { id: 7, category: 'WORKOUT', type: 'Ride', name: 'Own entry', external_id: null }],
  ]);
  let nextId = 100;
  const posted: unknown[] = [];
  const request: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const match = /events\/(\d+)$/.exec(url.pathname);
    if (init?.method === 'POST' && url.pathname.endsWith('/events/bulk')) {
      assert.equal(url.searchParams.get('upsert'), 'true');
      const body = JSON.parse(init.body as string) as Event[];
      posted.push(...body);
      const saved = body.map((event) => {
        const existing = [...calendar.values()].find((e) => e.external_id === event.external_id);
        const stored = { ...event, id: existing?.id ?? nextId++ };
        const steps = String(event.description)
          .split('\n')
          .filter((l) => l.startsWith('- '));
        calendar.set(stored.id, { ...stored, workout_doc: { steps }, moving_time: 600 });
        return stored;
      });
      return Promise.resolve(Response.json(saved));
    }
    if (match && init?.method === 'DELETE') {
      calendar.delete(Number(match[1]));
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (match) {
      const event = calendar.get(Number(match[1]));
      return Promise.resolve(event ? Response.json(event) : new Response('', { status: 404 }));
    }
    return Promise.resolve(new Response('', { status: 500 }));
  };
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const run = {
    category: 'WORKOUT' as const,
    date: day(3),
    type: 'Run' as const,
    name: 'Easy run',
    description: '- 40m Z2 Pace',
  };
  await assert.rejects(new Intervals('k', '0', request).saveCalendarEntry(run), /disabled/);
  const api = new Intervals('k', '0', request, true);
  const created = await api.saveCalendarEntry(run);
  assert.equal(created.steps, 1);
  const first = posted[0] as Event;
  assert.equal(first.category, 'WORKOUT');
  assert.match(String(first.external_id), /^coach-mcp:/);
  const moved = await api.saveCalendarEntry({ ...run, id: Number(created.id), date: day(4) });
  assert.equal(moved.id, created.id);
  assert.equal(moved.date, day(4));
  assert.equal((posted[1] as Event).external_id, first.external_id);
  const group = await api.saveCalendarEntry({
    ...run,
    name: 'USI track',
    description: 'Coached session',
  });
  assert.equal(group.steps, 0);
  assert.ok('note' in group);
  await assert.rejects(api.saveCalendarEntry({ ...run, id: 7 }), /not created by the coach/);
  await assert.rejects(api.deleteCalendarEntry(7), /not created by the coach/);
  assert.equal(calendar.get(7)?.name, 'Own entry');
  await assert.rejects(api.saveCalendarEntry({ ...run, date: day(-3) }), /from today/);
  await assert.rejects(api.saveCalendarEntry({ ...run, date: day(600) }), /from today/);
  const season = await api.saveCalendarEntry({
    category: 'RACE_A',
    type: 'Run',
    date: day(300),
    name: 'Vienna City Marathon',
  });
  assert.equal(season.category, 'RACE_A');
  assert.equal(season.date, day(300));
  await assert.rejects(
    api.saveCalendarEntry({ category: 'RACE_B', date: day(10), name: 'No sport' }),
    /sport type/,
  );
  const trip = await api.saveCalendarEntry({
    category: 'HOLIDAY',
    date: day(20),
    end_date: day(22),
    name: 'Trip to Graz',
  });
  assert.equal(trip.end_date, day(22));
  const sent = posted.at(-1) as Event;
  assert.equal(String(sent.end_date_local).slice(0, 10), day(23));
  await assert.rejects(api.saveCalendarEntry({ ...run, end_date: day(5) }), /span several days/);
  await assert.rejects(
    api.saveCalendarEntry({ category: 'NOTE', date: day(9), end_date: day(8), name: 'Backwards' }),
    /before date/,
  );
  await assert.rejects(
    api.saveCalendarEntry({ category: 'PLAN' as never, date: day(9), name: 'Plan' }),
    /cannot be written/,
  );
  const removed = await api.deleteCalendarEntry(Number(created.id));
  assert.equal(removed.deleted.id, created.id);
  assert.equal(calendar.has(Number(created.id)), false);
  resetWriteLimit();
  for (let i = 0; i < 30; i++) await api.saveCalendarEntry(run);
  await assert.rejects(api.saveCalendarEntry(run), /limit/);
  resetWriteLimit();
});
await test('calendar weeks and athlete-local dates', () => {
  assert.deepEqual(isoWeek('2026-10-17'), {
    year: 2026,
    week: 42,
    label: '2026-KW42',
    monday: '2026-10-12',
    sunday: '2026-10-18',
  });
  assert.equal(isoWeek('2027-01-01').label, '2026-KW53');
  assert.equal(isoWeek('2024-12-30').label, '2025-KW01');
  assert.equal(localDate('Europe/Vienna', new Date('2026-10-17T22:30:00Z')), '2026-10-18');
  assert.throws(() => isoWeek('2026-02-30'));
});
await test('week and day views match plan with activities', async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'weeks'));
  await mkdir(join(root, 'blocks'));
  await writeFile(join(root, 'weeks/2026-KW02.md'), '# KW02 2026\n');
  await writeFile(join(root, 'blocks/current.md'), '# Current block\n');
  const events = [
    {
      id: 1,
      category: 'WORKOUT',
      type: 'Run',
      name: 'Easy',
      start_date_local: '2026-01-05T00:00:00',
      moving_time: 3600,
      icu_training_load: 40,
      external_id: 'coach-mcp:a',
      workout_doc: { steps: [{}, {}] },
    },
    {
      id: 2,
      category: 'WORKOUT',
      type: 'Ride',
      name: 'USI',
      start_date_local: '2026-01-06T00:00:00',
      moving_time: 3600,
      icu_training_load: 60,
    },
    {
      id: 3,
      category: 'WORKOUT',
      type: 'Swim',
      name: 'Swim',
      start_date_local: '2026-01-07T00:00:00',
      moving_time: 1800,
    },
    { id: 4, category: 'NOTE', name: 'Travel', start_date_local: '2026-01-07T00:00:00' },
    {
      id: 5,
      category: 'HOLIDAY',
      name: 'Trip',
      start_date_local: '2026-01-07T00:00:00',
      end_date_local: '2026-01-09T00:00:00',
    },
  ];
  const activities = [
    {
      id: 'i1',
      type: 'Run',
      start_date_local: '2026-01-05T07:00:00',
      moving_time: 3500,
      icu_training_load: 38,
    },
    {
      id: 'i2',
      type: 'Ride',
      start_date_local: '2026-01-06T18:00:00',
      moving_time: 1800,
      icu_training_load: 25,
    },
    {
      id: 'i3',
      type: 'Run',
      start_date_local: '2026-01-08T18:00:00',
      moving_time: 2400,
      icu_training_load: 30,
    },
  ];
  const request: typeof fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const oldest = url.searchParams.get('oldest') ?? '';
    const newest = (url.searchParams.get('newest') ?? '') + 'T99';
    const inRange = (rows: { start_date_local?: string; id?: unknown }[]) =>
      rows.filter(
        (r) => (r.start_date_local ?? '') >= oldest && (r.start_date_local ?? '') <= newest,
      );
    if (url.pathname.endsWith('/events')) return Promise.resolve(Response.json(inRange(events)));
    if (url.pathname.endsWith('/activities'))
      return Promise.resolve(Response.json(inRange(activities)));
    if (url.pathname.endsWith('/wellness'))
      return Promise.resolve(
        Response.json([{ id: '2026-01-05', restingHR: 46, hrv: 60, locked: false }]),
      );
    if (url.pathname.includes('/activity/'))
      return Promise.resolve(
        Response.json({ id: 'i1', icu_intervals: [{ type: 'WORK', moving_time: 3500 }] }),
      );
    return Promise.resolve(new Response('', { status: 404 }));
  };
  const coaching = new Coaching(
    new Intervals('k', '0', request),
    new DataStore(root),
    'Europe/Vienna',
  );
  const week = await coaching.week('2026-01-07');
  assert.equal(week.week, '2026-KW02');
  assert.equal((week.week_document as { content: string }).content, '# KW02 2026\n');
  assert.equal((week.current_block as { content: string }).content, '# Current block\n');
  const [mon, tue, wed, thu] = week.days;
  assert.equal(mon!.planned[0]!.status, 'done');
  assert.equal(mon!.planned[0]!.by_coach, true);
  assert.equal(mon!.planned[0]!.steps, 2);
  assert.equal(tue!.planned[0]!.status, 'shortened');
  assert.equal(wed!.planned[0]!.status, 'missed');
  assert.equal(wed!.notes[0]!.name, 'Travel');
  assert.equal(thu!.planned.length, 0);
  assert.deepEqual(
    thu!.notes.map((n) => n.name),
    ['Trip'],
  );
  assert.equal(week.days[4]!.notes.length, 0);
  assert.equal(thu!.activities[0]!.matched, false);
  assert.equal(week.totals.run!.done_time, 5900);
  assert.equal(week.totals.run!.planned_time, 3600);
  assert.deepEqual(week.wellness, [{ id: '2026-01-05', restingHR: 46, hrv: 60 }]);
  const monday = await coaching.day('2026-01-05');
  assert.equal(monday.weekday, 'Monday');
  assert.equal((monday.planned as { status: string }[])[0]!.status, 'done');
  const activity = (monday.activities as { detail?: { icu_intervals: unknown[] } }[])[0]!;
  assert.equal(activity.detail?.icu_intervals.length, 1);
});
await test('push messages, ntfy request and schedule', async () => {
  const base = {
    date: '2026-10-27',
    weekday: 'Tuesday',
    today: '2026-10-27',
    week: '2026-KW44',
    notes: [],
  };
  const workday = {
    ...base,
    planned: [
      { name: 'Easy run', type: 'Run', moving_time: 2700, status: 'done' },
      { name: 'USI cycling', type: 'Ride', moving_time: 7200, status: 'open' },
    ],
    activities: [
      { type: 'Run', moving_time: 2800, distance: 8200, matched: true },
      { type: 'Swim', moving_time: 1800, distance: 1500, matched: false },
    ],
    wellness: { sleepSecs: 25920, restingHR: 46 },
  };
  const am = morning(workday);
  assert.equal(am.title, 'Today, Tue 27.10.');
  assert.equal(
    am.body,
    '🏃 Easy run · 45 min\n🚴 USI cycling · 120 min\n😴 Sleep 7:12 · resting HR 46',
  );
  const rest = morning({ ...base, planned: [], activities: [], wellness: null });
  assert.equal(rest.body, 'Rest day');
  const away = morning({
    ...base,
    planned: [],
    activities: [],
    wellness: null,
    notes: [{ category: 'HOLIDAY', name: 'Trip to Graz' }],
  });
  assert.equal(away.body, 'Rest day\n🏖️ Trip to Graz');
  const pm = evening(workday)!;
  assert.equal(pm.title, 'Evening, Tue 27.10.');
  assert.equal(pm.tags, 'warning');
  assert.equal(
    pm.body,
    '🏃 ✓ Easy run · done\n🚴 ✗ USI cycling · not recorded\n🏊 + Swim · 1,5 km · 30 min',
  );
  assert.equal(evening({ ...base, planned: [], activities: [], wellness: null }), null);
  const emptyWeek = {
    week: '2026-KW45',
    dates: { monday: '2026-11-02', sunday: '2026-11-08' },
    days: [{ planned: [] }],
  };
  assert.equal(weekly(emptyWeek)!.title, 'KW45 not planned yet');
  assert.equal(weekly({ ...emptyWeek, days: [{ planned: [{}] }] }), null);

  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const notifier = new Notifier('https://ntfy.example/', 'coach', 'tk_test', (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(new Response('{}'));
  });
  await notifier.send(am);
  const sent = requests[0]!;
  assert.equal(sent.url, 'https://ntfy.example');
  assert.equal(sent.headers.Authorization, 'Bearer tk_test');
  const json = JSON.parse(sent.body) as {
    topic: string;
    title: string;
    message: string;
    click: string;
    actions: { label: string; url: string }[];
  };
  assert.equal(json.topic, 'coach');
  assert.equal(json.title, 'Today, Tue 27.10.');
  assert.equal(json.message, am.body);
  assert.equal(new URL(json.click).searchParams.get('q'), "What's on today?");
  assert.deepEqual(
    json.actions.map((a) => a.label),
    ['Discuss', 'Intervals'],
  );
  assert.equal(json.actions[1]!.url, 'https://intervals.icu/');

  const pushed: Message[] = [];
  const fakeCoaching = {
    day: () => Promise.resolve(workday),
    week: () => Promise.resolve(emptyWeek),
  } as unknown as Coaching;
  const fakeNotifier = {
    send: (m: Message) => (pushed.push(m), Promise.resolve()),
  } as unknown as Notifier;
  const schedule = startSchedule(fakeCoaching, fakeNotifier, 'Europe/Vienna', {
    morning: '07:00',
    evening: '21:00',
    weekly: '18:00',
  });
  schedule.stop();
  await schedule.tick(new Date('2026-10-27T06:00:10Z')); // 07:00 in Vienna (CET)
  await schedule.tick(new Date('2026-10-27T06:00:40Z'));
  await schedule.tick(new Date('2026-10-27T12:00:00Z'));
  assert.deepEqual(
    pushed.map((m) => m.title),
    ['Today, Tue 27.10.'],
  );
  await schedule.tick(new Date('2026-11-01T17:00:00Z')); // Sunday 18:00 in Vienna
  assert.equal(pushed.at(-1)!.title, 'KW45 not planned yet');
  assert.throws(() => configuration({ ENABLE_NOTIFICATIONS: 'true' }), /NTFY_URL/);
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
  assert.equal(listed.tools.length, 9);
  assert.ok(listed.tools.some((v) => v.name === 'get_week'));
  assert.ok(!listed.tools.some((v) => v.name === 'update_coaching_document'));
  assert.ok(!listed.tools.some((v) => v.name === 'save_planned_workout'));
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
  assert.equal((await client.listTools()).tools.length, 9);
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
  assert.equal((await client.listTools()).tools.length, 9);
});
