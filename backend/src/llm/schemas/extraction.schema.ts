import { z } from 'zod';

/**
 * Provider-facing schemas for structured output.
 *
 * Gemini's structured-output mode does not accept general JSON Schema — the
 * request is validated against a protobuf definition, and anything outside
 * that subset is rejected with a 400 before the model ever runs. Three rules
 * follow, and all three are load-bearing:
 *
 * 1. **No `z.record()`.** Dynamic keys are not expressible. The old batch
 *    protocol asked for `{"1": [...], "2": [...]}`, which is exactly a record.
 *    Batches are an array of `{ id, events }` instead, and the echoed `id`
 *    turns a misalignment into a loud error rather than a group silently
 *    getting `[]`.
 * 2. **No `.nullable()`.** It converts to `type: ["string", "null"]`, and
 *    Gemini's `type` field is not repeating:
 *    `Proto field is not repeating, cannot start list`. Use `.optional()`
 *    alone — an absent field says "not stated" just as well, and the
 *    normalizer already treats absent, null and empty alike.
 * 3. **No unions.** Same reason: they land as `anyOf`.
 *
 * `schema-compat.spec.ts` enforces all three against the real LangChain
 * conversion, so this fails in CI rather than against a live sync.
 *
 * `.describe()` text is part of the contract the model sees — it replaces the
 * format instructions that used to be prose in the prompt.
 */

export const EventSchema = z.object({
  title: z.string().describe('Short title of the event.'),
  date: z
    .string()
    .describe(
      'Event date as YYYY-MM-DD. Use an empty string only for a cancel or ' +
        'delay whose original date the message does not state.',
    ),
  time: z
    .string()
    .optional()
    .describe(
      'Start time as HH:MM (24-hour). Omit entirely for an all-day event.',
    ),
  endTime: z
    .string()
    .optional()
    .describe(
      'End time as HH:MM (24-hour). Include only when the message states a ' +
        'range or a duration; otherwise omit.',
    ),
  location: z.string().optional().describe('Location, when the message says.'),
  description: z
    .string()
    .optional()
    .describe('Extra detail worth keeping, when there is any.'),
  action: z
    .enum(['create', 'cancel', 'delay'])
    .optional()
    .describe(
      'create for a new event, cancel to call one off, delay to move one. ' +
        'Defaults to create when omitted.',
    ),
  originalTitle: z
    .string()
    .optional()
    .describe(
      'For cancel/delay only: the title of the existing event being changed, ' +
        'used to find it.',
    ),
  newDate: z
    .string()
    .optional()
    .describe('For delay only: the new date as YYYY-MM-DD.'),
  newTime: z
    .string()
    .optional()
    .describe('For delay only: the new time as HH:MM.'),
});

/** One message (or image bundle) in, its events out. */
export const SingleExtractionSchema = z.object({
  events: z
    .array(EventSchema)
    .describe('Every event found. Empty array when the message has none.'),
});

/**
 * Several messages in one call. `id` echoes the id the request supplied so the
 * caller can match results to inputs without relying on array order.
 */
export const BatchExtractionSchema = z.object({
  results: z
    .array(
      z.object({
        id: z
          .string()
          .describe('The exact id given for this message in the request.'),
        events: z
          .array(EventSchema)
          .describe('Events found in that message; empty array when none.'),
      }),
    )
    .describe('One entry per message in the request, in any order.'),
});

/** Stage-1 relevance gate. */
export const VerdictSchema = z.object({
  isEvent: z
    .boolean()
    .describe(
      'True when the message might contain a calendar event worth extracting.',
    ),
  reason: z.string().describe('A few words explaining the decision.'),
});

/** Layer-3 duplicate judge. */
export const IdenticalSchema = z.object({
  identical: z
    .boolean()
    .describe('True when both descriptions refer to the same real gathering.'),
});

/** Every schema that is ever sent to a provider — the compat spec sweeps these. */
export const PROVIDER_SCHEMAS = {
  SingleExtractionSchema,
  BatchExtractionSchema,
  VerdictSchema,
  IdenticalSchema,
} as const;

export type SchemaEvent = z.infer<typeof EventSchema>;
export type BatchExtraction = z.infer<typeof BatchExtractionSchema>;
export type SingleExtraction = z.infer<typeof SingleExtractionSchema>;
