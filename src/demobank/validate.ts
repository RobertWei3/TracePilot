export type AddressInput = { line1: string; line2: string; city: string; state: string; zip: string };

/** Field-level validation, so a bad address is a business outcome and not a crash. */
export function validateAddress(a: AddressInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!a.line1.trim()) errors.line1 = "Street address is required.";
  if (a.line1.trim().length > 60) errors.line1 = "Street address must be 60 characters or fewer.";
  if (!a.city.trim()) errors.city = "City is required.";
  if (!/^[A-Za-z]{2}$/.test(a.state.trim())) errors.state = "State must be two letters, e.g. OR.";
  if (!/^\d{5}$/.test(a.zip.trim())) errors.zip = "ZIP code must be exactly 5 digits.";
  return errors;
}
