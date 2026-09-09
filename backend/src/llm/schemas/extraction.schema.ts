import { z } from 'zod';

/**
 * Provider-facing schemas for structured output.
 *
 * Gemini's structured-output mode accepts only a subset of OpenAPI schema.
 * Two rules follow from that and are load-bearing here:
 *
 * 1. **No `z.record()`.** Dynamic keys are not expressible in that subset. The
 *    old batch protocol asked for `{"1": [...], "2": [...]}`, which is exactly
 *    a record — it cannot be ported to structured output. Batches are an
 *    array of `{ id, events }` instead, and the echoed `id` turns a
 *    misalignment into a loud error rather than a group silently getting `[]`.
 * 2. **No unions.** Optional fields are `.nullable().optional()` rather than
 *    modelled as variants; the normalizer treats `null` and absent alike.
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
    .nullable()
    .optional()
    .describe('Start time as HH:MM (24-hour), or null for an all-day event.'),
  endTime: z
    .string()
    .nullable()
    .optional()
    .describe(
      'End time as HH:MM (24-hour). Only when the message states a range or ' +
        'a duration; otherwise null.',
    ),
  location: z.string().nullable().optional().describe('Location, or null.'),
  description: z
    .string()
    .nullable()
    .optional()
    .describe('Extra detail worth keeping, or null.'),
  action: z
    .enum(['create', 'cancel', 'delay'])
    .nullable()
    .optional()
    .describe(
      'create for a new event, cancel to call one off, delay to move one. ' +
        'Defaults to create when null.',
    ),
  originalTitle: z
    .string()
    .nullable()
    .optional()
    .describe(
      'For cancel/delay only: the title of the existing event being changed, ' +
        'used to find it.',
    ),
  newDate: z
    .string()
    .nullable()
    .optional()
    .describe('For delay only: the new date as YYYY-MM-DD.'),
  newTime: z
    .string()
    .nullable()
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

export type SchemaEvent = z.infer<typeof EventSchema>;
export type BatchExtraction = z.infer<typeof BatchExtractionSchema>;
export type SingleExtraction = z.infer<typeof SingleExtractionSchema>;
