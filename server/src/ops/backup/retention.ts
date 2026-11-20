export interface BackupItem { id: string; at: Date }
export interface RetentionPolicy { daily: number; weekly: number; monthly: number }

/** بداية الأسبوع (الإثنين) كتاريخ بتوقيت العيادة، لتجميع النسخ بالأسابيع */
function bucketKeys(at: Date, tzOffsetMin: number): { day: string; week: string; month: string } {
  const local = new Date(at.getTime() + tzOffsetMin * 60_000);
  const day = local.toISOString().slice(0, 10);
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return { day, week: monday.toISOString().slice(0, 10), month: day.slice(0, 7) };
}

/**
 * سياسة الاحتفاظ (جد/أب/ابن): آخر N يوم فيه نسخة (أحدث نسخة باليوم)، وآخر N أسبوع، وآخر N شهر. تُحسب على الفترات اللي فيها نسخ فعلاً
 * (فالفجوة ما تخلي نسخ قديمة تنحذف بدالها). أحدث نسخة دائماً تبقى. يرجع معرفات اللي تبقى.
 */
export function selectRetained(items: BackupItem[], policy: RetentionPolicy, tzOffsetMin = 180): Set<string> {
  const sorted = [...items].sort((a, b) => b.at.getTime() - a.at.getTime());           // الأحدث أول
  const keep = new Set<string>();
  if (sorted.length) keep.add(sorted[0].id);
  const pick = (kind: 'day' | 'week' | 'month', n: number) => {
    const seen = new Set<string>();
    for (const it of sorted) {
      const k = bucketKeys(it.at, tzOffsetMin)[kind];
      if (seen.has(k)) continue;                                                       // أول واحد بالفترة هو الأحدث
      if (seen.size >= n) break;
      seen.add(k); keep.add(it.id);
    }
  };
  pick('day', policy.daily); pick('week', policy.weekly); pick('month', policy.monthly);
  return keep;
}

/** رقم المقطع (آخر 16 خانة hex) من اسم ملف WAL. null للأسماء الثانية (history/backup). */
export function walSegment(name: string): string | null {
  const m = /^([0-9A-F]{8})([0-9A-F]{16})(\.[0-9A-F]{8}\.backup)?$/.exec(name);
  return m ? m[2] : null;
}

/** ملفات WAL اللي ما عاد نحتاجها: مقطعها أقدم من بداية أقدم نسخة كاملة محتفظ بها. ملفات .history ما تنحذف أبداً. */
export function walToDelete(walNames: string[], oldestRetainedStartWal: string | null): string[] {
  if (!oldestRetainedStartWal) return [];
  const limit = walSegment(oldestRetainedStartWal);
  if (!limit) return [];
  return walNames.filter((n) => { const s = walSegment(n); return s !== null && s < limit; });
}
