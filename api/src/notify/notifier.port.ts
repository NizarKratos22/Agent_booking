export interface Notifier {
  /** Free-form text to a patient (inside the 24h window) or a template outside it. */
  sendWhatsApp(to: string, text: string): Promise<void>;
  /** Booking confirmation/reminder with confirmer/annuler buttons. */
  sendBookingButtons(to: string, text: string, bookingId: string): Promise<void>;
  /** To the dentist/secretary. urgent=true should be visually distinct (prefix + separate template). */
  notifyStaff(to: string, text: string, urgent?: boolean): Promise<void>;
}

export const NOTIFIER = Symbol('NOTIFIER');

/** Dev/test notifier: logs instead of sending. */
export class ConsoleNotifier implements Notifier {
  sent: { to: string; text: string; kind: string; urgent?: boolean }[] = [];
  async sendWhatsApp(to: string, text: string) {
    this.sent.push({ to, text, kind: 'wa' });
    console.log(`[WA → ${to}] ${text}`);
  }
  async sendBookingButtons(to: string, text: string, bookingId: string) {
    this.sent.push({ to, text, kind: `buttons:${bookingId}` });
    console.log(`[WA buttons → ${to}] ${text} [confirmer|annuler] (${bookingId})`);
  }
  async notifyStaff(to: string, text: string, urgent = false) {
    this.sent.push({ to, text, kind: 'staff', urgent });
    console.log(`[STAFF${urgent ? ' !!URGENT!!' : ''} → ${to}] ${text}`);
  }
}
