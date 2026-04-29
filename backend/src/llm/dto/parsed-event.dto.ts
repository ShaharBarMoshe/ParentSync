export type EventAction = 'create' | 'cancel' | 'delay';

export interface ParsedEvent {
  title: string;
  description?: string;
  date: string; // YYYY-MM-DD (empty string for cancel/delay when original date unknown)
  time?: string; // HH:MM
  location?: string;
  action?: EventAction; // defaults to 'create' when absent
  originalTitle?: string; // for cancel/delay: search hint for the original event name
  newDate?: string; // for delay: target date (YYYY-MM-DD)
  newTime?: string; // for delay: target time (HH:MM)
}
