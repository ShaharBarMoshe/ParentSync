import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as crypto from 'crypto';
import { LLM_SERVICE } from '../../shared/constants/injection-tokens';
import type { ILLMService } from '../interfaces/llm-service.interface';
import type { ParsedEvent } from '../dto/parsed-event.dto';

const SYSTEM_PROMPT = `You are a calendar event extractor. Extract calendar events from messages, which may be WhatsApp group chat logs or emails.

CRITICAL RULES:
- ONLY extract information that is EXPLICITLY stated in the message text. NEVER invent, guess, or hallucinate details (names, times, locations, descriptions) that are not present in the text.
- If a detail is not mentioned, DO NOT include that field. Leave optional fields out entirely rather than guessing.
- Return a JSON array of events. If no actionable event is detected, return an empty array: []
- Each event object must have these fields:
  - "title" (string, required): A clear, concise event title in Hebrew, based ONLY on what the message says
  - "description" (string, optional): Brief description in Hebrew ONLY if relevant details are explicitly mentioned
  - "date" (string, required): Date in YYYY-MM-DD format
  - "time" (string, optional): Time in HH:MM format (24-hour) ONLY if explicitly mentioned in the message content
  - "location" (string, optional): Location in Hebrew ONLY if explicitly mentioned in the message content
- All text fields (title, description, location) MUST be in Hebrew.
- For relative dates like "next Tuesday" or "tomorrow", use the current date context provided.
- If a date format is DD.MM.YY, interpret it correctly (e.g., 12.3.26 = 2026-03-12).
- Return ONLY the JSON array, no other text or markdown formatting.

WhatsApp chat format:
- Messages may appear as "[HH:MM, M/D/YYYY] phone: text". The timestamp in brackets is when the message was SENT, not necessarily when an event occurs.
- Extract event times ONLY from the message TEXT content, not from the WhatsApp message timestamps.
- Casual conversation, status updates (e.g., "we'll arrive in 20 minutes", "there's an alert"), and coordination messages are NOT calendar events — return [].
- Only extract events that describe a planned activity with a clear subject (e.g., a trip, appointment, birthday, meeting, gathering) OR an actionable task (payment, form to fill, document to sign, item to bring).
- If a message describes a planned activity with a clear DATE but NO specific time, still create the event WITHOUT the "time" field. These will be created as calendar tasks (to-do items). A clear date is enough — a specific time is NOT required.

Action items (payments, forms, documents, things to bring/wear):
- Messages asking to pay, fill a form, sign a document, bring an item, wear specific clothing, or complete any action are actionable tasks — extract them as events WITHOUT a time field.
- If the message contains a URL or link, include it in the "description" field.
- If no specific deadline date is mentioned, use the current date as the date (treat it as "today").
- The "description" field should include the FULL relevant details: amount, link, instructions, deadline, what to bring/wear — everything the parent needs to act on.

Example input: "יום הולדת למיקי 12.3.26 בפארק הג׳ונגל מודיעין"
Example output: [{"title":"יום הולדת של מיקי","date":"2026-03-12","location":"פארק הג׳ונגל, מודיעין"}]

Example input: "תור לרופא ביום שלישי ב-15:00 עם ד״ר כהן"
Example output: [{"title":"תור לרופא","date":"2026-03-17","time":"15:00","description":"תור אצל ד״ר כהן"}]

Example input: "טיול שנתי ביום חמישי הקרוב"
Example output: [{"title":"טיול שנתי","date":"2026-03-19"}]

Example input: "הזכרה: להביא תחפושת ביום שלישי"
Example output: [{"title":"להביא תחפושת","date":"2026-03-17","description":"להביא תחפושת"}]

Example input: "מבחן במתמטיקה ביום ראשון"
Example output: [{"title":"מבחן במתמטיקה","date":"2026-03-15"}]

Example input: "טיול שנתי ב-15 לחודש"
Example output: [{"title":"טיול שנתי","date":"2026-03-15"}]

Example input: "ניפגש מחר בגינה"
Example output: [{"title":"מפגש בגינה","date":"2026-03-14","location":"גינה"}]

Example input: "הורים יקרים, נא להעביר תשלום עבור טיול שנתי בסך 120 ש״ח דרך הלינק: https://pay.school.co.il/trip2026 עד ה-20 לחודש"
Example output: [{"title":"תשלום עבור טיול שנתי","date":"2026-03-20","description":"סכום: 120 ש״ח\\nלינק לתשלום: https://pay.school.co.il/trip2026"}]

Example input: "נא למלא שאלון בריאות לקראת הטיול https://forms.google.com/abc123"
Example output: [{"title":"מילוי שאלון בריאות","date":"2026-03-13","description":"שאלון בריאות לקראת הטיול\\nלינק: https://forms.google.com/abc123"}]

Example input: "יש להחזיר טופס הרשאה חתום עד יום רביעי"
Example output: [{"title":"החזרת טופס הרשאה חתום","date":"2026-03-18","description":"יש להחזיר טופס הרשאה חתום"}]

Example input: "ביום שלישי יום לבן — נא להלביש את הילדים בלבן"
Example output: [{"title":"יום לבן","date":"2026-03-17","description":"להלביש בלבן"}]

Example input: "מחר יום ספורט, נא להביא ביגוד ספורטיבי ונעלי ספורט"
Example output: [{"title":"יום ספורט","date":"2026-03-14","description":"להביא: ביגוד ספורטיבי, נעלי ספורט"}]

Example input: "תזכורת: להביא מחברת מתמטיקה ומספריים ליום ראשון"
Example output: [{"title":"להביא ציוד","date":"2026-03-15","description":"להביא: מחברת מתמטיקה, מספריים"}]

Example input: "[15:47, 4/3/2026] +972 50-408-8090: דניאל הולך לגינה ליד גן לילי בסביבות השעה 16:00\\n[15:54, 4/3/2026] +972 54-722-1506: נגיע עוד 20 דקות\\n[15:59, 4/3/2026] +972 50-389-7893: נגיע עוד 20 דקות"
Example output: []

Example input: "שלום מה נשמע?"
Example output: []`;

const CACHE_TTL_SECONDS = 86400; // 24 hours

@Injectable()
export class MessageParserService {
  private readonly logger = new Logger(MessageParserService.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILLMService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async parseMessage(
    content: string,
    currentDate?: string,
  ): Promise<ParsedEvent[]> {
    const cacheKey = this.getCacheKey(content);

    // Check cache
    const cached = await this.cacheManager.get<ParsedEvent[]>(cacheKey);
    if (cached) {
      this.logger.debug('Cache hit for message parsing');
      return cached;
    }
    this.logger.debug('Cache miss for message parsing');

    try {
      const dateContext = currentDate ?? new Date().toISOString().split('T')[0];
      const userMessage = `Current date: ${dateContext}\n\nMessage to parse:\n${content}`;

      const response = await this.llmService.callLLM([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ]);

      const events = this.extractJsonFromResponse(response);
      const validatedEvents = this.validateEvents(events);

      // Cache the result
      await this.cacheManager.set(cacheKey, validatedEvents, CACHE_TTL_SECONDS);

      return validatedEvents;
    } catch (error) {
      this.logger.error(`Failed to parse message: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse multiple message groups in a single LLM call. Each group is tagged
   * with a numeric ID so the LLM can return events keyed by group.
   * Falls back to individual parsing if the batch response can't be parsed.
   */
  async parseMessageBatch(
    groups: { id: string; content: string }[],
    currentDate?: string,
  ): Promise<Map<string, ParsedEvent[]>> {
    const result = new Map<string, ParsedEvent[]>();

    if (groups.length === 0) return result;

    // Check cache for each group; separate cached vs uncached
    const uncached: { id: string; content: string }[] = [];
    for (const group of groups) {
      const cacheKey = this.getCacheKey(group.content);
      const cached = await this.cacheManager.get<ParsedEvent[]>(cacheKey);
      if (cached) {
        result.set(group.id, cached);
      } else {
        uncached.push(group);
      }
    }

    if (uncached.length === 0) {
      this.logger.debug(`Batch: all ${groups.length} groups served from cache`);
      return result;
    }

    // Single group — use the simpler single-message flow
    if (uncached.length === 1) {
      const events = await this.parseMessage(uncached[0].content, currentDate);
      result.set(uncached[0].id, events);
      return result;
    }

    this.logger.log(
      `Batch parsing ${uncached.length} message groups in a single LLM call`,
    );

    try {
      const dateContext = currentDate ?? new Date().toISOString().split('T')[0];

      const numberedMessages = uncached
        .map((g, i) => `===MESSAGE_${i + 1}===\n${g.content}`)
        .join('\n\n');

      const userMessage =
        `Current date: ${dateContext}\n\n` +
        `Parse the following ${uncached.length} messages. ` +
        `Return a JSON object where each key is the message number (as a string) and each value is an array of events extracted from that message. ` +
        `Example format: {"1": [{"title":"...", "date":"..."}], "2": [], "3": [{"title":"...", "date":"...", "time":"..."}]}\n\n` +
        numberedMessages;

      const response = await this.llmService.callLLM([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ]);

      const parsed = this.extractBatchJsonFromResponse(response, uncached.length);

      if (parsed) {
        for (let i = 0; i < uncached.length; i++) {
          const key = String(i + 1);
          const events = parsed[key] || [];
          const validated = this.validateEvents(events);
          result.set(uncached[i].id, validated);
          // Cache each group individually
          const cacheKey = this.getCacheKey(uncached[i].content);
          await this.cacheManager.set(cacheKey, validated, CACHE_TTL_SECONDS);
        }
        return result;
      }
    } catch (error) {
      this.logger.warn(
        `Batch parse failed, falling back to individual parsing: ${error.message}`,
      );
    }

    // Fallback: parse each group individually
    for (const group of uncached) {
      const events = await this.parseMessage(group.content, currentDate);
      result.set(group.id, events);
    }
    return result;
  }

  private extractBatchJsonFromResponse(
    response: string,
    expectedCount: number,
  ): Record<string, unknown[]> | null {
    const trimmed = response.trim();

    // Try direct parse
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Try extracting from code blocks
      const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          obj = JSON.parse(jsonMatch[1].trim());
        } catch {
          // fall through
        }
      }
      // Try finding object braces
      if (!obj) {
        const braceMatch = trimmed.match(/\{[\s\S]*\}/);
        if (braceMatch) {
          try {
            obj = JSON.parse(braceMatch[0]);
          } catch {
            // fall through
          }
        }
      }
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      this.logger.warn('Batch response is not a JSON object — falling back');
      return null;
    }

    const record = obj as Record<string, unknown>;
    // Verify at least some expected keys exist
    const hasAnyKey = Array.from({ length: expectedCount }, (_, i) =>
      String(i + 1),
    ).some((k) => k in record);

    if (!hasAnyKey) {
      this.logger.warn('Batch response has no expected message keys — falling back');
      return null;
    }

    // Normalize: ensure each value is an array
    const result: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(record)) {
      result[key] = Array.isArray(value) ? value : [];
    }
    return result;
  }

  private extractJsonFromResponse(response: string): unknown[] {
    // Try direct JSON parse first
    const trimmed = response.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      // Try extracting JSON from markdown code blocks
      const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1].trim());
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // fall through
        }
      }

      // Try finding array brackets
      const bracketMatch = trimmed.match(/\[[\s\S]*\]/);
      if (bracketMatch) {
        try {
          const parsed = JSON.parse(bracketMatch[0]);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // fall through
        }
      }

      this.logger.warn('Could not extract JSON array from LLM response');
      return [];
    }
  }

  private validateEvents(events: unknown[]): ParsedEvent[] {
    return events
      .filter((event): event is Record<string, unknown> => {
        if (typeof event !== 'object' || event === null) return false;
        const e = event as Record<string, unknown>;
        // Must have title and date
        if (typeof e.title !== 'string' || !e.title.trim()) return false;
        if (typeof e.date !== 'string' || !e.date.match(/^\d{4}-\d{2}-\d{2}$/))
          return false;
        // Validate time format if present
        if (e.time && (typeof e.time !== 'string' || !e.time.match(/^\d{2}:\d{2}$/)))
          return false;
        return true;
      })
      .map((event) => ({
        title: String(event.title).trim(),
        description: event.description ? String(event.description).trim() : undefined,
        date: String(event.date),
        time: event.time ? String(event.time) : undefined,
        location: event.location ? String(event.location).trim() : undefined,
      }));
  }

  private getCacheKey(content: string): string {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `msg-parse:${hash}`;
  }
}
