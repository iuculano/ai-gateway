/** Generate a plausible 14-day usage series from a 30-day total. */
export function genUsage(total: number, seed: number): number[] {
  const base = total > 0 ? total / 30 : 0;
  const arr: number[] = [];
  for (let i = 0; i < 14; i++) {
    const f = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.27 + seed * 2.1)) + 0.12 * Math.sin(i * 0.6 + seed);
    arr.push(Math.max(0, Math.round(base * f)));
  }
  return arr;
}

export function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** Map a series to SVG polyline points within a w x h box. */
export function linePoints(arr: number[], w: number, h: number): string {
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const span = max - min || 1;
  return arr
    .map((v, i) => {
      const x = (i / (arr.length - 1)) * w;
      const y = h - 2 - ((v - min) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function parseUA(ua: string | null): string {
  if (!ua) return 'System';
  if (/Relay-Worker/.test(ua)) return 'Relay system worker';
  const firefox = ua.match(/Firefox\/(\d+)/);
  const mobileSafari = ua.match(/Version\/(\d+)[.\d]* Mobile.*Safari/);
  const safari = ua.match(/Version\/(\d+)[.\d]* Safari/);
  const chrome = ua.match(/Chrome\/(\d+)/);
  let b = 'Unknown';
  if (firefox) b = `Firefox ${firefox[1]}`;
  else if (mobileSafari) b = `Safari ${mobileSafari[1]}`;
  else if (safari) b = `Safari ${safari[1]}`;
  else if (chrome) b = `Chrome ${chrome[1]}`;
  let os = '';
  if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Macintosh/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  return b + (os ? ` · ${os}` : '');
}

export function initialsOf(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z ]/g, '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || 'K'
  );
}

/** '2026-07-05T12:00:00.000Z' -> 'Jul 05, 2026' */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

/** Relative time for a past timestamp; 'never' when null. */
export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';

  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;

  return formatDate(iso);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-06-17T16:44:02Z' -> { short: 'Jun 17', time: '16:44:02', full: '2026-06-17 16:44:02 UTC' } */
export function fmtTs(iso: string): {
  short: string;
  time: string;
  full: string;
} {
  const d = iso.slice(0, 10).split('-');
  const t = iso.slice(11, 19);
  return {
    short: `${MONTHS[parseInt(d[1], 10) - 1]} ${parseInt(d[2], 10)}`,
    time: t,
    full: `${iso.slice(0, 10)} ${t} UTC`,
  };
}

export function fmtChangeValue(v: unknown): string | null {
  // An explicit null is a meaningful diff value (e.g. a field being cleared),
  // so render it as 'null'. Only a genuinely absent value returns the null
  // sentinel, which the caller renders as '∅'.
  if (v === undefined) return null;
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Latency in the unit that reads best: '740ms', '1.84s', '30.00s'. */
export function fmtLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Cost in dollars, to four decimals.
 *
 * Sub-cent amounts are the norm for a single inference, so the usual two
 * decimals would render almost every row as $0.00.
 */
export function fmtCost(dollars: number): string {
  return `$${dollars.toFixed(4)}`;
}

/** Larger totals, where four decimals is noise rather than signal. */
export function fmtCostTotal(dollars: number): string {
  if (dollars >= 1000) return `$${Math.round(dollars).toLocaleString('en-US')}`;
  return `$${dollars.toFixed(2)}`;
}

/** Thousands separators for token counts: 1284 -> '1,284'. */
export function fmtTokens(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString('en-US');
}

/**
 * Output tokens per second.
 *
 * Output only, not total - throughput is about how fast the model emitted,
 * and folding the prompt in would make a long prompt look like a fast model.
 */
export function fmtThroughput(outputTokens: number | null, ms: number | null): string {
  if (!outputTokens || !ms) return '—';
  return `${Math.round(outputTokens / (ms / 1000))} tok/s`;
}

/** Brand tones for the provider dot. Falls back to zinc for anything unmapped. */
const PROVIDER_TONES: Record<string, { label: string; color: string }> = {
  openai: { label: 'OpenAI', color: '#10b981' },
  azure: { label: 'Azure', color: '#38bdf8' },
  anthropic: { label: 'Anthropic', color: '#f59e0b' },
  google: { label: 'Google', color: '#60a5fa' },
  mistral: { label: 'Mistral', color: '#fb923c' },
  meta: { label: 'Meta', color: '#c084fc' },
};

export function providerTone(provider: string): { label: string; color: string } {
  return PROVIDER_TONES[provider.toLowerCase()] ?? { label: humanize(provider), color: '#71717a' };
}

/**
 * Countdown to a future timestamp: '45s', '12 min', '3 hr'.
 *
 * Distinct from timeAgo(), which measures backwards and collapses any future
 * date to 'just now' - a rate-limit window always resets in the future, so it
 * needs the opposite direction.
 */
export function timeUntil(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;

  return `${Math.round(hours / 24)} days`;
}
