import { Injectable } from '@nestjs/common';
import { loadConfig } from './backup/config';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { remoteFromSpec } from './backup/remote';
import { BackupHealth, SectionState, evaluateHealth, pickVerify, readSection, Section } from './backup/status';

/** حالة النسخ الاحتياطي للمالك: تقرأ ملفات الحالة اللي تكتبها أدوات النسخ (ما تتصل بالتخزين البعيد ولا تشغل شي). */
@Injectable()
export class OpsService {
  private remoteVerify: { at: number; value: SectionState | null } | null = null;

  /** نتيجة فحص الاسترجاع المنشورة بالتخزين (يطلعها جهاز المالك). كاش 10 دقايق، وأي فشل بالوصول = ما نعتمد عليها (بدون خطأ للمالك). */
  private async publishedVerify(remoteSpec: string | undefined, workDir: string, now: number): Promise<SectionState | null> {
    if (!remoteSpec) return null;
    if (this.remoteVerify && now - this.remoteVerify.at < Number(process.env.OPS_REMOTE_CACHE_SECONDS ?? 600) * 1000) return this.remoteVerify.value;
    let value: SectionState | null = null;
    try {
      const remote = remoteFromSpec(remoteSpec);
      if ((await remote.list('status/verify.json')).some((e) => e.key === 'status/verify.json')) {
        await mkdir(workDir, { recursive: true }); const tmp = join(workDir, `pv-${now}.json`);
        try { await remote.get('status/verify.json', tmp); value = JSON.parse(await readFile(tmp, 'utf8')) as SectionState; } finally { await rm(tmp, { force: true }); }
      }
    } catch { value = null; }
    this.remoteVerify = { at: now, value };
    return value;
  }

  async backupStatus(now = new Date()): Promise<BackupHealth> {
    const cfg = loadConfig();
    const s: Partial<Record<Section, Awaited<ReturnType<typeof readSection>>>> = {};
    for (const n of ['base', 'logical', 'wal', 'uploads', 'prune', 'verify'] as Section[]) s[n] = await readSection(cfg.stateDir, n);
    s.verify = pickVerify(s.verify, await this.publishedVerify(cfg.remote, cfg.workDir, now.getTime()));
    return evaluateHealth(s, now, !!cfg.remote && !!cfg.publicKeyPath);
  }
}
