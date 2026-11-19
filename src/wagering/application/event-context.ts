import type { EventContext } from "../../shared/messaging/integration-event.ts";
import type { IdGenerator } from "./ports/id-generator.ts";

/** Um eventId novo por evento; correlação herdada da requisição, causa = transação que o originou. */
export function eventContext(
  ids: IdGenerator,
  correlationId: string,
  causationId: string,
  occurredAt: Date,
): EventContext {
  return { eventId: ids.next(), correlationId, causationId, occurredAt };
}
