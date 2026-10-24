import { Injectable, NotFoundException } from '@nestjs/common';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CabinetConfig } from './cabinet.schema';
import { normalizePhone } from './phone';

@Injectable()
export class CabinetService {
  private readonly dir = process.env.CABINETS_DIR ?? join(process.cwd(), 'cabinets');
  private cache = new Map<string, CabinetConfig>();

  constructor() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      const cfg = CabinetConfig.parse(JSON.parse(readFileSync(join(this.dir, f), 'utf-8')));
      this.cache.set(cfg.id, cfg);
    }
  }

  get(id: string): CabinetConfig {
    const cfg = this.cache.get(id);
    if (!cfg) throw new NotFoundException(`cabinet ${id}`);
    return cfg;
  }

  /** Used by tests and by the admin-by-chat tools (set_mode etc.). */
  upsert(cfg: CabinetConfig, persist = true): void {
    const parsed = CabinetConfig.parse(cfg);
    this.cache.set(parsed.id, parsed);
    if (persist) writeFileSync(join(this.dir, `${parsed.id}.json`), JSON.stringify(parsed, null, 2));
  }

  byPhoneNumber(number: string): CabinetConfig | undefined {
    return [...this.cache.values()].find((c) => normalizePhone(c.phone_line) === normalizePhone(number));
  }

  /** Meta sends "21620000001" without the plus; config files may have spaces. Both normalise. */
  byWhatsAppAdmin(phone: string): CabinetConfig | undefined {
    const p = normalizePhone(phone);
    return [...this.cache.values()].find((c) => c.whatsapp_admin.some((a) => normalizePhone(a) === p));
  }

  /** The cabinet whose WhatsApp Business number received a message (Meta's metadata.display_phone_number). */
  byWhatsAppNumber(number: string): CabinetConfig | undefined {
    const p = normalizePhone(number);
    return p ? [...this.cache.values()].find((c) => normalizePhone(c.whatsapp_patient_from) === p) : undefined;
  }
}
