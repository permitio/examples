const MONEY = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** An amount with its currency symbol and two decimals: `£1,500.00`. */
export function formatMoney(currency: string, amount: number): string {
  return `${currency}${MONEY.format(amount)}`;
}
