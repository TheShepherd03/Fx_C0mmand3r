// Central money formatting so the app shows the ACCOUNT's real deposit currency
// (e.g. ZAR -> "R", USD -> "$"), not a hardcoded dollar sign.
// The currency code is published by the Bridge EA (AccountInfoString(ACCOUNT_CURRENCY)).

const SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  ZAR: 'R',
  AUD: 'A$',
  CAD: 'C$',
  NZD: 'NZ$',
  CHF: 'CHF ',
  SGD: 'S$',
  HKD: 'HK$',
  CNY: '¥',
  INR: '₹',
  NGN: '₦',
  KES: 'KSh ',
  AED: 'AED ',
  SAR: 'SAR ',
  BTC: '₿',
};

/** Symbol for a currency code. Unknown codes fall back to "CODE " (e.g. "PLN 12.00"). */
export function currencySymbol(code?: string | null): string {
  if (!code) return '$'; // safe default until the EA publishes currency
  const c = code.toUpperCase();
  return SYMBOLS[c] ?? `${c} `;
}

/** Format an amount with the account currency symbol. Unsigned — callers add +/- as they do today. */
export function formatMoney(
  value: number | undefined | null,
  code?: string | null,
  decimals: number = 2
): string {
  const sym = currencySymbol(code);
  const n = typeof value === 'number' && isFinite(value) ? value : 0;
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
