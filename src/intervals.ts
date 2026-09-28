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
  ) {}
  async get(path: string, query: Record<string, string> = {}) {
    if (!this.key)
      throw new Error('Intervals.icu is not configured. Set INTERVALS_API_KEY on the server.');
    const url = new URL('https://intervals.icu/api/v1/' + path);
    url.search = new URLSearchParams(query).toString();
    let response: Response;
    try {
      response = await this.request(url, {
        headers: {
          Authorization: 'Basic ' + Buffer.from('API_KEY:' + this.key).toString('base64'),
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new Error('Intervals.icu request failed or timed out.');
    }
    if (!response.ok) throw new IntervalsHttpError(response.status);
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
}
