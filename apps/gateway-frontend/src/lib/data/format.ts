// Built once and reused. Constructing a formatter is the slow part of
// formatting, and these run for every cell of every table.
const COUNT = new Intl.NumberFormat('en-US');
const COMPACT_COUNT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
const CALENDAR_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
const UTC_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent' });

// The h23 cycle, because the en-US 24-hour clock otherwise writes midnight as
// 24:00:00 in some browsers.
const CLOCK = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// Dollar formatters by the most decimal places each one shows.
const DOLLARS = {
  2: dollarFormat(2),
  4: dollarFormat(4),
  6: dollarFormat(6),
  12: dollarFormat(12),
};

// Chrome calls itself Safari too, and is told apart by having no Version token.
// Mobile Safari puts a build token between its version and the word Safari.
const BROWSERS = [
  { name: 'Firefox', pattern: /Firefox\/(\d+)/ },
  { name: 'Safari', pattern: /Version\/(\d+)[.\d]*(?: Mobile\S*)? Safari/ },
  { name: 'Chrome', pattern: /Chrome\/(\d+)/ },
];

const SYSTEMS = [
  { name: 'iOS', pattern: /iPhone|iPad/ },
  { name: 'macOS', pattern: /Macintosh/ },
  { name: 'Windows', pattern: /Windows/ },
  { name: 'Linux', pattern: /Linux/ },
];

// One colour per provider, wherever a provider is drawn, from a table's dot to
// a chart's fill. Each sits in the lightness band that suits a fill on the dark
// surface and is at least 3:1 against it.
//
// Keyed by name and not by rank. Assigning by rank would repaint every
// surviving series the moment a filter drops one.
const PROVIDER_TONES: Record<string, { label: string; color: string }> = {
  openai: { label: 'OpenAI', color: '#059669' },
  azure: { label: 'Azure', color: '#0284c7' },
  anthropic: { label: 'Anthropic', color: '#d97706' },
  google: { label: 'Google', color: '#3b82f6' },
};

// A provider with no entry is neutral, and does not borrow a hue that already
// means something else.
const UNKNOWN_PROVIDER_COLOR = '#71717a';

function dollarFormat(decimals: number): Intl.NumberFormat {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

/**
 * A count at the scale it reads best in, such as '1.23K' or '3.4M'.
 */
export function fmt(n: number): string {
  return COMPACT_COUNT.format(n);
}

/**
 * A share of a whole as a rounded percentage, such as '26%'.
 */
export function fmtPercent(share: number): string {
  return PERCENT.format(share);
}

/**
 * Dollars with thousands separators, to the cent and to at most `decimals`
 * places beyond it.
 */
export function fmtDollars(dollars: number, decimals: keyof typeof DOLLARS = 2): string {
  return DOLLARS[decimals].format(dollars);
}

/**
 * Dollars for a chart or a table, where an amount under a cent must not read
 * as $0.00.
 */
export function fmtMoney(dollars: number, decimals: keyof typeof DOLLARS = 2): string {
  const isUnderACent = dollars !== 0 && Math.abs(dollars) < 0.01;

  return fmtDollars(dollars, isUnderACent && decimals < 6 ? 6 : decimals);
}

/**
 * The time of day in the reader's zone, as '16:44:02'.
 */
export function fmtClock(iso: string): string {
  return CLOCK.format(new Date(iso));
}

/**
 * A length of time at the two coarsest units that still read, such as
 * '4m 12s' or '2h 5m'.
 */
export function fmtElapsed(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) {
    return `${whole}s`;
  }

  const minutes = Math.floor(whole / 60);
  if (minutes < 60) {
    return `${minutes}m ${whole % 60}s`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A user agent as a browser and system, such as 'Firefox 131 · macOS'.
 */
export function parseUA(ua: string | null): string {
  if (!ua) {
    return 'System';
  }

  if (/Relay-Worker/.test(ua)) {
    return 'Relay system worker';
  }

  let browser = 'Unknown';

  for (const candidate of BROWSERS) {
    const version = ua.match(candidate.pattern)?.[1];

    if (version) {
      browser = `${candidate.name} ${version}`;
      break;
    }
  }

  const system = SYSTEMS.find((candidate) => candidate.pattern.test(ua));

  return system ? `${browser} · ${system.name}` : browser;
}

/**
 * Up to two initials for an avatar, from the first two words of a name.
 */
export function initialsOf(name: string): string {
  // Letters of any script, so that Élodie keeps her É and 张伟 is not reduced
  // to nothing.
  const words = name.replace(/[^\p{L} ]/gu, '').split(' ');
  const initials = words
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('');

  return initials.toUpperCase() || 'K';
}

/**
 * A date as 'Jul 05, 2026'.
 */
export function formatDate(iso: string): string {
  return CALENDAR_DATE.format(new Date(iso));
}

/**
 * How long ago a timestamp was, in words, or 'never' when there is none.
 */
export function timeAgo(iso: string | null): string {
  if (!iso) {
    return 'never';
  }

  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }

  const days = Math.floor(hours / 24);
  if (days === 1) {
    return 'yesterday';
  }

  if (days < 30) {
    return `${days} days ago`;
  }

  return formatDate(iso);
}

/**
 * An ISO timestamp split for display, as 'Jun 17', '16:44:02' and
 * '2026-06-17 16:44:02 UTC'.
 */
export function fmtTs(iso: string): { short: string; time: string; full: string } {
  const time = iso.slice(11, 19);

  return {
    short: UTC_DAY.format(new Date(iso)),
    time: time,
    full: `${iso.slice(0, 10)} ${time} UTC`,
  };
}

/**
 * One side of an audit diff as text, or null when the field was absent.
 */
export function fmtChangeValue(v: unknown): string | null {
  // An explicit null is a meaningful value, such as a field being cleared, so
  // it is spelled out. Only a missing value comes back as null, which the
  // caller draws as '∅'.
  if (v === undefined) {
    return null;
  }

  if (v === null) {
    return 'null';
  }

  if (Array.isArray(v)) {
    return `[${v.join(', ')}]`;
  }

  if (typeof v === 'object') {
    return JSON.stringify(v);
  }

  return String(v);
}

/**
 * A snake_case identifier as words, such as 'Rate Limit'.
 */
export function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Latency in the unit that reads best, such as '740ms' or '1.84s'.
 */
export function fmtLatency(ms: number | null): string {
  if (ms === null) {
    return '—';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Cost in dollars, to four decimals.
 */
export function fmtCost(dollars: number): string {
  // A single inference usually costs less than a cent, so two decimals would
  // show almost every row as $0.00.
  return `$${dollars.toFixed(4)}`;
}

/**
 * Larger totals, where four decimals is noise rather than signal.
 */
export function fmtCostTotal(dollars: number): string {
  if (dollars >= 1000) {
    return `$${COUNT.format(Math.round(dollars))}`;
  }

  return `$${dollars.toFixed(2)}`;
}

/**
 * Spend that may be under a cent, as one user's or one session's often is.
 */
export function fmtSpend(dollars: number): string {
  return dollars < 1 ? fmtCost(dollars) : fmtCostTotal(dollars);
}

/**
 * A chart bucket on its axis, as '14:00' for hours and 'Oct 3' for days.
 */
export function fmtBucket(iso: string | null, interval: 'hour' | 'day'): string {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  // An hour is the same moment everywhere, so it is shown in the reader's time.
  // A day is a UTC day, and the reader's date would name the day before for
  // anyone west of Greenwich.
  if (interval === 'hour') {
    return `${String(date.getHours()).padStart(2, '0')}:00`;
  }

  return UTC_DAY.format(date);
}

/**
 * A catalog price, in dollars per million tokens.
 */
export function fmtPricePerMillion(dollars: number | null): string {
  // Null is not zero. An unpublished price shown as '$0.00' is how a gateway
  // ends up reporting that a month of inference cost nothing, so the unknown
  // case says so in words.
  if (dollars === null) {
    return 'Unpriced';
  }

  if (dollars === 0) {
    return '$0.00';
  }

  // The cheapest models price cached input at $0.005, which two decimals would
  // round to zero.
  if (dollars < 0.01) {
    return `$${dollars.toFixed(3)}`;
  }

  return `$${dollars.toFixed(2)}`;
}

/**
 * A context window at the scale it is quoted in, such as '128K' or '1.05M'.
 */
export function fmtContext(tokens: number | null): string {
  if (tokens === null || tokens === 0) {
    return '—';
  }

  if (tokens >= 1_000_000) {
    const millions = (tokens / 1_000_000).toFixed(2);

    return `${millions.replace(/\.?0+$/, '')}M`;
  }

  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }

  return String(tokens);
}

/**
 * A token count with thousands separators, such as '1,284'.
 */
export function fmtTokens(n: number | null): string {
  return n === null ? '—' : COUNT.format(n);
}

/**
 * Output tokens per second.
 */
export function fmtThroughput(outputTokens: number | null, ms: number | null): string {
  if (!outputTokens || !ms) {
    return '—';
  }

  // Output only, because folding the prompt in would make a long prompt look
  // like a fast model.
  const seconds = ms / 1000;

  return `${Math.round(outputTokens / seconds)} tok/s`;
}

/**
 * A stable colour for a trace id, so rows from the same run read as one at a
 * glance.
 */
export function traceTone(traceId: string): string {
  // FNV-1a, which is four lines and spreads short hex strings evenly.
  let hash = 0x811c9dc5;

  for (let index = 0; index < traceId.length; index += 1) {
    hash ^= traceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  // Saturation and lightness are fixed so every hue stays legible on the dark
  // surface.
  return `hsl(${Math.abs(hash) % 360} 65% 62%)`;
}

const ID_TONES = ['#10b981', '#60a5fa', '#c084fc', '#f59e0b', '#2dd4bf', '#f472b6'];

/**
 * A colour for an id, which is the same wherever that id appears.
 */
export function toneFor(id: string): string {
  let hash = 0;

  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }

  return ID_TONES[hash % ID_TONES.length];
}

/**
 * A provider's display name and colour, with a neutral tone for unknown ones.
 */
export function providerTone(provider: string): { label: string; color: string } {
  return PROVIDER_TONES[provider.toLowerCase()] ?? { label: humanize(provider), color: UNKNOWN_PROVIDER_COLOR };
}

/**
 * A span of seconds at the coarsest unit that still reads, such as '45s',
 * '12 min' or '3 hr'.
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hr`;
  }

  return `${Math.round(hours / 24)} days`;
}

/**
 * Countdown to a future timestamp, such as '45s' or '12 min'.
 */
export function timeUntil(iso: string): string {
  // timeAgo measures backwards and calls any future date 'just now', which is
  // no use for a rate-limit window that always resets in the future.
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);

  return seconds <= 0 ? 'now' : formatDuration(seconds);
}

/**
 * How long a past timestamp has been past, as a bare length such as '12 min'.
 */
export function timeSince(iso: string): string {
  // A queue's waiting column needs a duration. timeAgo answers with prose such
  // as 'yesterday', which does not say how long a row has sat there.
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);

  return seconds <= 0 ? '0s' : formatDuration(seconds);
}

/**
 * A string map as one line, such as 'env=prod · team=billing'.
 */
export function pairSummary(record?: Record<string, string> | null): string {
  const entries = Object.entries(record ?? {});
  if (entries.length === 0) {
    return '—';
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(' · ');
}
