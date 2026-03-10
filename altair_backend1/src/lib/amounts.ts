export const formatAmountFromRaw = (raw: string, decimals: number): string => {
  const normalizedRaw = raw?.trim?.() ?? '';
  if (!normalizedRaw) return '0';
  const value = BigInt(normalizedRaw);
  if (decimals <= 0) return value.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionStr}`;
};

export const parseAmountToRaw = (amount: string, decimals: number): string => {
  const normalized = amount?.trim?.() ?? '';
  if (!normalized) return '0';
  if (decimals <= 0) return BigInt(normalized).toString();
  const [wholePart, fractionPart = ''] = normalized.split('.');
  const safeWhole = wholePart.length > 0 ? wholePart : '0';
  const fraction = fractionPart.padEnd(decimals, '0').slice(0, decimals);
  const raw = BigInt(safeWhole) * 10n ** BigInt(decimals) + BigInt(fraction || '0');
  return raw.toString();
};
