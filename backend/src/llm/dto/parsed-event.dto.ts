export interface ParsedEvent {
  title: string;
  description?: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM
  location?: string;
}
