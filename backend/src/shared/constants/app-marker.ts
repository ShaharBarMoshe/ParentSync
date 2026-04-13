/**
 * Marker appended to all WhatsApp messages sent by ParentSync.
 * Used to filter out app-generated messages when reading channels
 * (e.g., the approval channel also being a scanned channel).
 */
export const APP_MESSAGE_MARKER = '\n\n— ParentSync';
