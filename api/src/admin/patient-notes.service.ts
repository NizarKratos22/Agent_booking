import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { normalizePhone } from '../config/phone';

export interface PatientNote {
  text: string;
  /** ISO timestamp. */
  at: string;
  /** The admin phone that wrote it. */
  by: string;
}

/**
 * The secretary's memos about a patient ("anxieux, prévoir 10 min de plus", "doit 50 TND"),
 * keyed by phone, one JSON file per cabinet on our own disk like the call logs: health data
 * stays with us. They go into the system prompt when that patient calls and are never read aloud.
 */
@Injectable()
export class PatientNotesService {
  static readonly MAX_PER_PATIENT = 20;
  private readonly dir = process.env.PATIENT_NOTES_DIR ?? join(process.cwd(), 'patient-notes');

  constructor() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private file(cabinetId: string): string {
    return join(this.dir, `${cabinetId}.json`);
  }

  private load(cabinetId: string): Record<string, PatientNote[]> {
    try {
      return JSON.parse(readFileSync(this.file(cabinetId), 'utf-8'));
    } catch {
      return {};
    }
  }

  /** Append a note; the newest MAX_PER_PATIENT are kept. Returns the patient's notes. */
  add(cabinetId: string, phone: string, text: string, by: string): PatientNote[] {
    const all = this.load(cabinetId);
    const key = normalizePhone(phone);
    const list = [...(all[key] ?? []), { text: text.trim(), at: new Date().toISOString(), by }].slice(-PatientNotesService.MAX_PER_PATIENT);
    all[key] = list;
    writeFileSync(this.file(cabinetId), JSON.stringify(all, null, 2));
    return list;
  }

  for(cabinetId: string, phone: string): PatientNote[] {
    const key = normalizePhone(phone);
    return key ? (this.load(cabinetId)[key] ?? []) : [];
  }
}
