import { Injectable } from '@nestjs/common';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * Append-only JSONL per call, one file per day, on our own disk (health data stays
 * with us). A retention job deletes files older than RETENTION_DAYS (default 90).
 * This is also the regression corpus: every real call becomes a test case.
 */
@Injectable()
export class CallLog {
  private readonly dir = process.env.CALL_LOG_DIR ?? join(process.cwd(), 'call-logs');
  private flags = new Map<string, Set<string>>();

  constructor() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private file(): string {
    return join(this.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  append(callId: string, cabinetId: string, role: 'user' | 'assistant' | 'tool', text: string): void {
    appendFileSync(this.file(), JSON.stringify({ t: new Date().toISOString(), call: callId, cabinet: cabinetId, role, text }) + '\n');
  }

  flag(callId: string, flag: string): void {
    if (!this.flags.has(callId)) this.flags.set(callId, new Set());
    this.flags.get(callId)!.add(flag);
  }

  close(callId: string, endedReason?: string, seconds?: number): void {
    const flags = [...(this.flags.get(callId) ?? [])];
    appendFileSync(this.file(), JSON.stringify({ t: new Date().toISOString(), call: callId, role: 'end', endedReason, seconds, flags }) + '\n');
    this.flags.delete(callId);
  }

  /** Delete logs older than RETENTION_DAYS. Call from a daily cron. */
  purge(retentionDays = Number(process.env.RETENTION_DAYS ?? 90)): number {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      if (statSync(p).mtimeMs < cutoff) {
        unlinkSync(p);
        n++;
      }
    }
    return n;
  }
}
