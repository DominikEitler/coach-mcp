import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === v;
  }, 'Use a valid calendar date YYYY-MM-DD');
export const rangeShape = { oldest: date, newest: date };
export function checkRange(oldest: string, newest: string) {
  date.parse(oldest);
  date.parse(newest);
  const days = (Date.parse(newest) - Date.parse(oldest)) / 86400000;
  if (days < 0 || days > 90)
    throw new Error('Date range must be ordered and no longer than 91 inclusive days.');
}
type Row = Record<string, unknown>;
// Coaching-relevant activity fields, chosen from observed run, ride and swim payloads.
// prettier-ignore
const activitySummary = [
  'id', 'start_date_local', 'type', 'name', 'description', 'race', 'commute',
  'distance', 'moving_time', 'elapsed_time', 'total_elevation_gain',
  'average_speed', 'gap', 'average_heartrate', 'max_heartrate', 'average_cadence',
  'icu_average_watts', 'icu_weighted_avg_watts', 'icu_intensity', 'icu_variability_index',
  'icu_efficiency_factor', 'decoupling', 'polarization_index',
  'icu_training_load', 'hr_load', 'pace_load', 'power_load', 'trimp', 'strain_score',
  'icu_rpe', 'feel', 'session_rpe',
  'icu_hr_zone_times', 'pace_zone_times', 'gap_zone_times', 'icu_zone_times',
  'interval_summary', 'icu_lap_count', 'average_temp', 'icu_ctl', 'icu_atl', 'icu_ftp',
];
// Transport, sync, device and chart metadata with no coaching value.
// prettier-ignore
const activityNoise = new Set([
  'skyline_chart_bytes', 'stream_types', 'recording_stops', 'power_field_names', 'power_field',
  'icu_training_load_data', 'external_id', 'file_sport_index', 'file_type', 'icu_athlete_id',
  'created', 'icu_sync_date', 'analyzed', 'source', 'icu_median_time_delta', 'tiz_order',
  'use_gap_zone_times', 'use_elevation_correction', 'gap_model', 'power_meter_serial',
  'power_meter_battery', 'icu_ignore_time', 'icu_ignore_power', 'icu_ignore_hr',
  'ignore_velocity', 'ignore_pace', 'has_heartrate', 'has_weather', 'has_segments',
  'device_watts', 'start_index', 'end_index',
]);
const wellnessNoise = new Set([
  'updated',
  'locked',
  'tempWeight',
  'tempRestingHR',
  'ctlLoad',
  'atlLoad',
]);
const present = (value: unknown) =>
  value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0);
const pick = (row: Row, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => present(row[key])).map((key) => [key, row[key]]));
const omit = (row: Row, drop: Set<string>) =>
  Object.fromEntries(
    Object.entries(row).filter(([key, value]) => !drop.has(key) && present(value)),
  );
const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function rows(value: unknown) {
  if (!Array.isArray(value) || !value.every(isRow))
    throw new Error('Intervals.icu returned an unexpected response.');
  return value;
}
// Planned workouts the coach may create, change and delete carry this external_id prefix;
// everything else in the calendar is the athlete's and is never modified.
export const coachPrefix = 'coach-mcp:';
export const workoutTypes = [
  'Run',
  'Ride',
  'VirtualRide',
  'Swim',
  'OpenWaterSwim',
  'WeightTraining',
  'Workout',
  'Walk',
  'Yoga',
] as const;
export type PlannedWorkout = {
  id?: number;
  date: string;
  type: (typeof workoutTypes)[number];
  name: string;
  description: string;
  indoor?: boolean;
};
const writeWindowDays = 92;
const writesPerHour = 30;
// Shared by all requests in this process: HTTP mode builds a new client per request.
const recentWrites: number[] = [];
function countWrite(now = Date.now()) {
  while (recentWrites.length && recentWrites[0]! < now - 3600000) recentWrites.shift();
  if (recentWrites.length >= writesPerHour)
    throw new Error(`Intervals write limit reached (${writesPerHour} per hour). Try again later.`);
  recentWrites.push(now);
}
export function resetWriteLimit() {
  recentWrites.length = 0;
}
function checkWindow(day: string, today = new Date()) {
  date.parse(day);
  const start =
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 86400000;
  const offset = (Date.parse(day) - start) / 86400000;
  if (offset < 0 || offset > writeWindowDays + 1)
    throw new Error(
      `Planned workouts can only be written from today to ${writeWindowDays} days ahead.`,
    );
}
const summarize = (event: Row) => {
  const doc = event.workout_doc as { steps?: unknown[] } | null | undefined;
  return {
    id: event.id,
    date: typeof event.start_date_local === 'string' ? event.start_date_local.slice(0, 10) : null,
    type: event.type,
    name: event.name,
    moving_time: event.moving_time ?? null,
    icu_training_load: event.icu_training_load ?? null,
    steps: doc?.steps?.length ?? 0,
  };
};
export class IntervalsHttpError extends Error {
  constructor(readonly status: number) {
    super(`Intervals.icu returned HTTP ${status}${status === 429 ? '; retry later' : ''}.`);
  }
}
export class Intervals {
  constructor(
    private key?: string,
    private athlete = '0',
    private request: typeof fetch = fetch,
    private writable = false,
  ) {}
  get(path: string, query: Record<string, string> = {}) {
    return this.send('GET', path, query);
  }
  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ) {
    if (!this.key)
      throw new Error('Intervals.icu is not configured. Set INTERVALS_API_KEY on the server.');
    const url = new URL('https://intervals.icu/api/v1/' + path);
    url.search = new URLSearchParams(query).toString();
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers: {
          Authorization: 'Basic ' + Buffer.from('API_KEY:' + this.key).toString('base64'),
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new Error('Intervals.icu request failed or timed out.');
    }
    if (!response.ok) throw new IntervalsHttpError(response.status);
    if (method === 'DELETE') return null;
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error('Intervals.icu returned invalid JSON.');
    }
  }
  async list(kind: 'activities' | 'wellness' | 'events', oldest: string, newest: string) {
    checkRange(oldest, newest);
    return this.get(`athlete/${this.athlete}/${kind}`, { oldest, newest });
  }
  async activities(oldest: string, newest: string) {
    return rows(await this.list('activities', oldest, newest)).map((row) =>
      pick(row, activitySummary),
    );
  }
  async wellness(oldest: string, newest: string) {
    return rows(await this.list('wellness', oldest, newest)).map((row) => omit(row, wellnessNoise));
  }
  async activity(id: string) {
    if (!/^i?\d+$/.test(id)) throw new Error('Invalid activity ID.');
    let detail: unknown;
    try {
      detail = await this.get(`activity/${id}`, { intervals: 'true' });
    } catch (e) {
      // Intervals answers 403 for activities that don't exist or belong to another athlete.
      if (e instanceof IntervalsHttpError && (e.status === 403 || e.status === 404))
        throw new Error(`Activity ${id} not found for this athlete (HTTP ${e.status}).`);
      throw e;
    }
    if (!isRow(detail)) throw new Error('Intervals.icu returned an unexpected response.');
    const { icu_intervals: intervals, ...rest } = detail;
    return {
      ...omit(rest, activityNoise),
      ...(present(intervals) && {
        icu_intervals: rows(intervals).map((row) => omit(row, activityNoise)),
      }),
    };
  }
  private async event(id: number) {
    let event: unknown;
    try {
      event = await this.get(`athlete/${this.athlete}/events/${id}`);
    } catch (e) {
      if (e instanceof IntervalsHttpError && (e.status === 403 || e.status === 404))
        throw new Error(`Calendar event ${id} not found.`);
      throw e;
    }
    if (!isRow(event)) throw new Error('Intervals.icu returned an unexpected response.');
    return event;
  }
  private async ownEvent(id: number) {
    const event = await this.event(id);
    if (typeof event.external_id !== 'string' || !event.external_id.startsWith(coachPrefix))
      throw new Error(
        `Calendar event ${id} was not created by the coach; change it in Intervals instead.`,
      );
    return event;
  }
  /** Create or update a planned workout owned by the coach, then read it back. */
  async savePlannedWorkout(workout: PlannedWorkout) {
    if (!this.writable) throw new Error('Intervals writes are disabled.');
    checkWindow(workout.date);
    const externalId =
      workout.id === undefined
        ? coachPrefix + randomUUID()
        : (await this.ownEvent(workout.id)).external_id;
    countWrite();
    const saved = rows(
      await this.send('POST', `athlete/${this.athlete}/events/bulk`, { upsert: 'true' }, [
        {
          category: 'WORKOUT',
          type: workout.type,
          start_date_local: `${workout.date}T00:00:00`,
          name: workout.name,
          description: workout.description,
          external_id: externalId,
          ...(workout.indoor !== undefined && { indoor: workout.indoor }),
        },
      ]),
    );
    const id = saved[0]?.id;
    if (typeof id !== 'number') throw new Error('Intervals.icu returned an unexpected response.');
    const result = summarize(await this.event(id));
    return {
      ...result,
      ...(result.steps === 0 && {
        note: 'Intervals found no workout structure in the description. Expected for unstructured sessions such as group sessions; otherwise check the workout syntax.',
      }),
    };
  }
  /** Delete a planned workout owned by the coach and confirm it is gone. */
  async deletePlannedWorkout(id: number) {
    if (!this.writable) throw new Error('Intervals writes are disabled.');
    const event = await this.ownEvent(id);
    countWrite();
    await this.send('DELETE', `athlete/${this.athlete}/events/${id}`);
    try {
      await this.event(id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('not found'))
        return { deleted: summarize(event) };
      throw e;
    }
    throw new Error(`Calendar event ${id} still exists after deleting; check it in Intervals.`);
  }
}
