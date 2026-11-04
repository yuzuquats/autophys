/** Optional bound for required reads; interactive generators keep their defaults. */
export class RecurrenceExpansionLimitError extends Error {
  constructor(readonly limit: number, readonly eventId?: string) {
    super("recurrence expansion limit exceeded");
    this.name = "RecurrenceExpansionLimitError";
  }
}
