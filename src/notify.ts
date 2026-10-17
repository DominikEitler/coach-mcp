import { isoWeek, localDate, type Coaching } from './coaching.js';

type Planned = { name?: unknown; type?: unknown; moving_time?: unknown; status?: string };
type Activity = { type?: unknown; moving_time?: unknown; distance?: unknown; matched?: unknown };
export type Message = { title: string; body: string; question: string; tags?: string };
/** The parts of a get_day or get_week result the messages use. */
export type DayView = {
  date: string;
  planned: unknown;
  activities: unknown;
  wellness: unknown;
  notes?: unknown;
};
export type WeekView = {
  week: string;
  dates: { monday: string; sunday: string };
  days: { planned: unknown[] }[];
};

const minutes = (seconds: unknown) =>
  typeof seconds === 'number' && seconds > 0 ? `${Math.round(seconds / 60)} min` : '';
const km = (metres: unknown) =>
  typeof metres === 'number' && metres > 0
    ? `${(metres / 1000).toFixed(1).replace('.', ',')} km`
    : '';
/** Austrian short date with weekday, e.g. "Tue 27.10." */
const label = (value: string) => {
  const [, m, d] = value.split('-');
  const weekday = new Date(value + 'T00:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return `${weekday} ${d}.${m}.`;
};
const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
const text = (value: unknown, fallback = '') =>
  typeof value === 'string' && value ? value : fallback;
const marks: Record<string, string> = { done: '✓', shortened: '↘', missed: '✗', open: '✗' };
const noteEmoji: Record<string, string> = { NOTE: '📝', HOLIDAY: '🏖️', SICK: '🤒', INJURED: '🩹' };
/** Emoji for an Intervals sport type, shown at the start of each line. */
export function sportEmoji(type: unknown) {
  const t = typeof type === 'string' ? type : '';
  if (/Run/.test(t)) return '🏃';
  if (/Ride|Cyclocross/.test(t)) return '🚴';
  if (/Swim/.test(t)) return '🏊';
  if (/Weight|Strength/.test(t)) return '🏋️';
  if (/Yoga/.test(t)) return '🧘';
  if (/Walk|Hike/.test(t)) return '🚶';
  if (/Ski/.test(t)) return '⛷️';
  return '•';
}

/** Morning push: today's planned sessions, or a rest day, plus last night's sleep. */
export function morning(day: DayView): Message {
  const planned = Array.isArray(day.planned) ? (day.planned as Planned[]) : [];
  const wellness = (day.wellness ?? {}) as { sleepSecs?: number; restingHR?: number };
  const sleep =
    typeof wellness.sleepSecs === 'number'
      ? `Sleep ${Math.floor(wellness.sleepSecs / 3600)}:${String(Math.round((wellness.sleepSecs % 3600) / 60)).padStart(2, '0')}`
      : '';
  const rhr = typeof wellness.restingHR === 'number' ? `resting HR ${wellness.restingHR}` : '';
  const sessions = planned.map(
    (p) =>
      `${sportEmoji(p.type)} ${join(text(p.name, text(p.type, 'Session')), minutes(p.moving_time))}`,
  );
  const notes = (
    Array.isArray(day.notes) ? (day.notes as { category?: unknown; name?: unknown }[]) : []
  )
    .filter((n) => typeof n.category === 'string' && n.category in noteEmoji)
    .map((n) => `${noteEmoji[n.category as string]} ${text(n.name, 'Note')}`);
  return {
    title: `Today, ${label(day.date)}`,
    body: [
      ...(sessions.length ? sessions : ['Rest day']),
      ...notes,
      sleep || rhr ? `😴 ${join(sleep, rhr)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    question: sessions.length ? "What's on today?" : "It's a rest day. Anything to adjust?",
    tags: sessions.length ? 'calendar' : 'zzz',
  };
}

/** Evening push: plan versus actual for today. Nothing on a rest day without activity. */
export function evening(day: DayView): Message | null {
  const planned = Array.isArray(day.planned) ? (day.planned as Planned[]) : [];
  const activities = Array.isArray(day.activities) ? (day.activities as Activity[]) : [];
  const extra = activities.filter((a) => a.matched === false);
  if (!planned.length && !activities.length) return null;
  const lines = [
    ...planned.map(
      (p) =>
        `${sportEmoji(p.type)} ${marks[p.status ?? ''] ?? '•'} ${join(text(p.name, text(p.type, 'Session')), p.status === 'open' ? 'not recorded' : (p.status ?? ''))}`,
    ),
    ...extra.map(
      (a) =>
        `${sportEmoji(a.type)} + ${join(text(a.type, 'Activity'), km(a.distance), minutes(a.moving_time))}`,
    ),
  ];
  const missed = planned.some((p) => p.status === 'open' || p.status === 'missed');
  return {
    // Titles stay under about 25 characters (iPhone); the tag emoji shows the status.
    title: `Evening, ${label(day.date)}`,
    body: lines.join('\n'),
    question: 'How did today go?',
    tags: missed ? 'warning' : 'white_check_mark',
  };
}

/** Sunday reminder when the coming week has no planned sessions in the calendar yet. */
export function weekly(next: WeekView): Message | null {
  const planned = next.days.reduce((n, d) => n + d.planned.length, 0);
  if (planned > 0) return null;
  const kw = next.week.split('-')[1] ?? next.week;
  return {
    title: `${kw} not planned yet`,
    body: `Nothing in the calendar for ${label(next.dates.monday)}–${label(next.dates.sunday)}. Time for the weekly planning?`,
    question: `Review this week and plan ${kw}.`,
    tags: 'spiral_calendar',
  };
}

export class Notifier {
  constructor(
    private url: string,
    private topic: string,
    private token: string,
    private request: typeof fetch = fetch,
  ) {}
  /**
   * Publish to ntfy as JSON (title and text stay plain UTF-8; headers would need
   * encoding). The tap opens Claude with the message's question.
   */
  async send(message: Message, priority?: 'high') {
    const claude = `https://claude.ai/new?q=${encodeURIComponent(message.question)}`;
    const response = await this.request(this.url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: this.topic,
        title: message.title,
        message: message.body,
        click: claude,
        actions: [
          { action: 'view', label: 'Discuss', url: claude },
          { action: 'view', label: 'Intervals', url: 'https://intervals.icu/' },
        ],
        ...(message.tags && { tags: message.tags.split(',') }),
        ...(priority && { priority: 4 }),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}.`);
  }
}

export type Kind = 'morning' | 'evening' | 'weekly';

/** Build and send one push for a date; returns the message, or null when nothing is due. */
export async function sendNow(kind: Kind, coaching: Coaching, notifier: Notifier, today: string) {
  let message: Message | null;
  if (kind === 'weekly') {
    const sunday = isoWeek(today).sunday;
    const next = new Date(Date.parse(sunday) + 86400000).toISOString().slice(0, 10);
    message = weekly(await coaching.week(next));
  } else {
    const day = await coaching.day(today);
    message = kind === 'morning' ? morning(day) : evening(day);
  }
  if (message) await notifier.send(message);
  return message;
}

export type Schedule = { morning: string; evening: string; weekly: string };

/**
 * Check every 30 seconds whether a push is due in the athlete's time zone. Each push is
 * sent at most once per day and kind while the process runs.
 */
export function startSchedule(
  coaching: Coaching,
  notifier: Notifier,
  timeZone: string,
  schedule: Schedule,
  log = console.error,
) {
  const sent = new Set<string>();
  const tick = async (now = new Date()) => {
    const today = localDate(timeZone, now);
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
    const due = [
      ['morning', time === schedule.morning],
      ['evening', time === schedule.evening],
      ['weekly', weekday === 0 && time === schedule.weekly],
    ] as const;
    for (const [kind, isDue] of due) {
      const key = `${kind}:${today}`;
      if (!isDue || sent.has(key)) continue;
      sent.add(key);
      try {
        await sendNow(kind, coaching, notifier, today);
      } catch (e) {
        log(`Notification ${kind} failed: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    }
  };
  const timer = setInterval(() => void tick(), 30000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
