export function applyPendingTypingSeed(seedText: string, currentValue: string): string {
  if (currentValue.length === 0) {
    return seedText;
  }

  if (currentValue.startsWith(seedText)) {
    return currentValue;
  }

  return `${seedText}${currentValue}`;
}
