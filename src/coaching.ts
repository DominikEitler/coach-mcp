import type { DataStore } from './data.js';
import { coachPrefix, date, type Intervals } from './intervals.js';

type Row = Record<string, unknown>;
const day = 86400000;
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The athlete-local calendar date for a time zone, as YYYY-MM-DD. */
export function localDate(timeZone: string, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** ISO calendar week (KW) containing a date, Monday to Sunday. */
export function isoWeek(value: string) {
  date.parse(value);
  const time = Date.parse(value);
  const monday = time - ((new Date(time).getUTCDay() + 6) % 7) * day;
  const year = new Date(monday + 3 * day).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const firstMonday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * day;
  const week = 1 + Math.round((monday - firstMonday) / (7 * day));
  return {
    year,
    week,
    label: `${year}-KW${String(week).padStart(2, '0')}`,
    monday: iso(monday),
    sunday: iso(monday + 6 * day),
  };
}

const sport = (type: unknown) => {
  const t = typeof type === 'string' ? type : '';
  if (/Run/.test(t)) return 'run';
  if (/Ride|Cyclocross/.test(t)) return 'bike';
  if (/Swim/.test(t)) return 'swim';
  return 'other';
};
const weekday = (value: string) =>
  new Date(value + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
const num = (value: unknown) => (typeof value === 'number' ? value : 0);
const onDay = (row: Row, value: string) =>
  typeof row.start_date_local === 'string' && row.start_date_local.startsWith(value);

function plannedEntry(event: Row) {
  const doc = event.workout_doc as { steps?: unknown[] } | null | undefined;
  const description = typeof event.description === 'string' ? event.description : '';
  return {
    id: event.id,
    category: event.category,
    type: event.type,
    name: event.name,
    moving_time: event.moving_time ?? null,
    icu_training_load: event.icu_training_load ?? null,
    steps: doc?.steps?.length ?? 0,
    by_coach: typeof event.external_id === 'string' && event.external_id.startsWith(coachPrefix),
    ...(description && { description: description.slice(0, 800) }),
  };
}
const isPlannedSession = (event: Row) =>
  event.category === 'WORKOUT' || /^RACE_/.test(String(event.category));

/**
 * Match one day's planned sessions with its activities by sport, so the coach gets plan
 * versus actual without doing the bookkeeping.
 */
function matchDay(value: string, today: string, events: Row[], activities: Row[]) {
  const unmatched = [...activities];
  const planned = events.filter(isPlannedSession).map((event) => {
    const index = unmatched.findIndex((a) => sport(a.type) === sport(event.type));
    const activity = index >= 0 ? unmatched.splice(index, 1)[0] : undefined;
    let status: string;
    if (activity) {
      const ratio = num(event.moving_time) ? num(activity.moving_time) / num(event.moving_time) : 1;
      status = ratio < 0.7 ? 'shortened' : 'done';
    } else status = value < today ? 'missed' : value === today ? 'open' : 'upcoming';
    return { ...plannedEntry(event), status, ...(activity && { activity_id: activity.id }) };
  });
  return {
    date: value,
    weekday: weekday(value),
    planned,
    notes: events.filter((event) => !isPlannedSession(event)).map(plannedEntry),
    activities: activities.map((a): Row => ({ ...a, matched: !unmatched.includes(a) })),
  };
}

function totals(days: ReturnType<typeof matchDay>[]) {
  const sum: Record<string, Record<string, number>> = {};
  const add = (group: string, key: string, value: unknown) => {
    sum[group] ??= { planned_time: 0, planned_load: 0, done_time: 0, done_load: 0 };
    sum[group][key]! += num(value);
  };
  for (const d of days) {
    for (const p of d.planned) {
      add(sport(p.type), 'planned_time', p.moving_time);
      add(sport(p.type), 'planned_load', p.icu_training_load);
    }
    for (const a of d.activities) {
      add(sport(a.type), 'done_time', a.moving_time);
      add(sport(a.type), 'done_load', a.icu_training_load);
    }
  }
  return sum;
}

const wellnessFields = ['restingHR', 'hrv', 'sleepSecs', 'sleepScore', 'ctl', 'atl', 'weight'];
const compactWellness = (row: Row) =>
  Object.fromEntries(
    ['id', ...wellnessFields].filter((k) => row[k] != null).map((k) => [k, row[k]]),
  );

async function settle<T>(task: Promise<T>) {
  try {
    return { available: true as const, data: await task };
  } catch (e) {
    return {
      available: false as const,
      error: e instanceof Error ? e.message : 'Source unavailable.',
    };
  }
}

export class Coaching {
  constructor(
    private api: Intervals,
    private data: DataStore,
    private timeZone: string,
  ) {}
  today() {
    return localDate(this.timeZone);
  }
  /** One day: planned sessions, activities with interval detail, and wellness. */
  async day(value = this.today()) {
    date.parse(value);
    const today = this.today();
    const [events, activities, wellness] = await Promise.all([
      settle(this.api.list('events', value, value) as Promise<Row[]>),
      settle(this.api.activities(value, value)),
      settle(this.api.wellness(value, value)),
    ]);
    const plan = events.available ? events.data.filter((e) => onDay(e, value)) : [];
    const done = activities.available ? activities.data : [];
    const detail = await Promise.all(
      done.slice(0, 3).map((a) => settle(this.api.activity(String(a.id)))),
    );
    const matched = matchDay(value, today, plan, done);
    return {
      date: value,
      weekday: matched.weekday,
      today,
      week: isoWeek(value).label,
      planned: events.available ? matched.planned : events,
      notes: matched.notes,
      activities: activities.available
        ? matched.activities.map((a, i) => ({
            ...a,
            ...(detail[i]?.available && { detail: detail[i].data }),
          }))
        : activities,
      wellness: wellness.available ? (wellness.data.map(compactWellness)[0] ?? null) : wellness,
    };
  }
  /** One ISO week: week file, block pointer, plan versus actual per day, totals, wellness. */
  async week(value = this.today()) {
    const week = isoWeek(value);
    const today = this.today();
    const [events, activities, wellness, document, block] = await Promise.all([
      settle(this.api.list('events', week.monday, week.sunday) as Promise<Row[]>),
      settle(this.api.activities(week.monday, week.sunday)),
      settle(this.api.wellness(week.monday, week.sunday)),
      settle(this.data.read(`weeks/${week.label}.md`)),
      settle(this.data.read('blocks/current.md')),
    ]);
    const plan = events.available ? events.data : [];
    const done = activities.available ? activities.data : [];
    const days = Array.from({ length: 7 }, (_, i) => {
      const value = iso(Date.parse(week.monday) + i * day);
      return matchDay(
        value,
        today,
        plan.filter((e) => onDay(e, value)),
        done.filter((a) => onDay(a, value)),
      );
    });
    return {
      week: week.label,
      dates: { monday: week.monday, sunday: week.sunday },
      today,
      week_document: document.available ? document.data : document,
      current_block: block.available ? block.data : block,
      sources: {
        calendar: events.available ? 'available' : events.error,
        activities: activities.available ? 'available' : activities.error,
        wellness: wellness.available ? 'available' : wellness.error,
      },
      days,
      totals: totals(days),
      wellness: wellness.available ? wellness.data.map(compactWellness) : [],
    };
  }
}
