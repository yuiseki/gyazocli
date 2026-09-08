/**
 * Validating the numeric options the commands accept. Lives on its own because
 * the date handling needs it too, and because failing here means exiting with
 * a message rather than throwing.
 */

export function parsePositiveIntegerOption(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    console.error(`Error: ${optionName} must be a positive integer.`);
    process.exit(1);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`Error: ${optionName} must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}
