export function periodComparison(
  current: number | null,
  previous: number | null,
  options: { label: string; lowerIsBetter?: boolean; percentagePoints?: boolean },
): { text: string; color: string; title: string } {
  const neutral = '#a1a1aa';
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return { text: 'No prior data', color: neutral, title: `No comparable data for ${options.label}.` };
  }
  if (previous === 0 && current !== 0 && !options.percentagePoints) {
    return { text: 'New', color: neutral, title: `Up from zero in ${options.label}; percentage change is undefined.` };
  }
  const change = options.percentagePoints
    ? current - previous
    : previous === 0
      ? 0
      : ((current - previous) / previous) * 100;
  const amount = Number(Math.abs(change).toFixed(options.percentagePoints ? 2 : 1));
  const unit = options.percentagePoints ? ' pp' : '%';
  const direction = amount === 0 ? '' : change > 0 ? '↑ ' : '↓ ';
  const color = amount === 0 || !options.lowerIsBetter ? neutral : change < 0 ? '#34d399' : '#fbbf24';
  return {
    text: `${direction}${amount}${unit}`,
    color,
    title: `${options.percentagePoints ? 'Percentage-point' : 'Percentage'} change versus ${options.label}. Previous value: ${previous.toLocaleString('en-US', { maximumFractionDigits: 4 })}${options.percentagePoints ? '%' : ''}.`,
  };
}
