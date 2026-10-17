// Send one push immediately, for testing: node dist/notify-now.js morning|evening|weekly
import { configuration } from './config.js';
import { Intervals } from './intervals.js';
import { DataStore } from './data.js';
import { Coaching } from './coaching.js';
import { Notifier, sendNow, type Kind } from './notify.js';

const kind = process.argv[2] as Kind;
if (!['morning', 'evening', 'weekly'].includes(kind)) {
  console.error('Usage: node dist/notify-now.js morning|evening|weekly');
  process.exit(2);
}
const config = configuration();
if (!config.NTFY_URL || !config.NTFY_TOKEN) {
  console.error('Set NTFY_URL and NTFY_TOKEN first.');
  process.exit(2);
}
const coaching = new Coaching(
  new Intervals(config.INTERVALS_API_KEY, config.INTERVALS_ATHLETE_ID),
  new DataStore(config.COACH_DATA_DIR),
  config.ATHLETE_TIMEZONE,
);
const message = await sendNow(
  kind,
  coaching,
  new Notifier(config.NTFY_URL, config.NTFY_TOPIC, config.NTFY_TOKEN),
  coaching.today(),
);
console.error(message ? `Sent: ${message.title}` : 'Nothing to send.');
