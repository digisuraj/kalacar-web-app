// Store-wide facts shown to customers. Generic for now (owner decision 2026-11-04);
// a region/PIN-based delivery estimate comes later.
export const DELIVERY_ESTIMATE = "12–17 business days";
export const DELIVERY_NOTE = "Carefully chosen, packed and shipped by us.";

/** "Order updates go to …" with the email and, when there is one, the phone number. */
export function updatesGoTo(email: string, phone: string) {
  const number = phone.trim();
  return number ? `Order updates go to ${email} and ${number}.` : `Order updates go to ${email}.`;
}
