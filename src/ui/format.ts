import { colors } from 'gloomberb/theme';

export const missing = '--';
export const number = (value: number | null | undefined, decimals = 2) => value == null || !Number.isFinite(value) ? missing : value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const compact = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? missing : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
export const usd = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? missing : `$${number(value)}`;
export const percent = (value: number | null | undefined, decimals = 2, signed = true) => value == null || !Number.isFinite(value) ? missing : `${signed && value > 0 ? '+' : ''}${number(value * 100, decimals)}%`;
export const tone = (value: number | null | undefined) => value == null || value === 0 ? colors.textDim : value > 0 ? colors.positive : colors.negative;
export const price = (value: number | null | undefined, szDecimals = 0) => {
  if (value == null || !Number.isFinite(value)) return missing;
  const decimals = Math.max(0, Math.min(6 - szDecimals, 4 - Math.floor(Math.log10(Math.abs(value) || 1))));
  return number(value, decimals);
};
export const time = (value: number | null | undefined) => value ? new Date(value).toISOString().slice(11, 19) : missing;
export const dateTime = (value: number | null | undefined) => value ? new Date(value).toISOString().replace('T', ' ').slice(0, 19) : missing;
export const shortAddress = (value?: string) => value ? `${value.slice(0, 6)}...${value.slice(-4)}` : 'Disconnected';
export const options = <T extends string>(values: readonly T[]) => values.map(value => ({ value, label: value }));
