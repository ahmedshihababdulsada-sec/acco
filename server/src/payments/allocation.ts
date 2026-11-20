/**
 * توزيع مبلغ على بنود بالنسبة لأوزانها بطريقة أكبر البواقي (القسم 12 هـ):
 * كل بند ياخذ floor(المبلغ × وزنه / مجموع الأوزان)، والوحدات الباقية تنعطى للبنود بأكبر كسر (التعادل: الأول أولاً).
 * المجموع يطلع دائماً = المبلغ بالضبط. BigInt حتى ما يفيض الضرب بالمبالغ الكبيرة.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('allocate: المبلغ لازم عدد صحيح غير سالب');
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new Error('allocate: الأوزان لازم أعداد صحيحة غير سالبة');
  if (total === 0 || weights.length === 0) return weights.map(() => 0);
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sum === 0n) throw new Error('allocate: مجموع الأوزان صفر، ما ينقسم المبلغ');
  const T = BigInt(total);
  const base = weights.map((w) => (T * BigInt(w)) / sum);
  const rem = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % sum }));
  let left = Number(T - base.reduce((a, b) => a + b, 0n));
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = base.map(Number);
  for (const { i, r } of rem) { if (left === 0 || r === 0n) break; out[i] += 1; left -= 1; }
  return out;
}

/** كسب النقاط: على المدفوع فعلياً، الكسور تنهمل (القسم 6). */
export function pointsEarned(paid: number, perAmount: number, points: number): number {
  if (paid <= 0) return 0;
  return Math.floor(paid / perAmount) * points;
}

/** التقريب لصالح الزبون لأقرب خطوة (القسم 12 هـ): 16,667 → 16,500 بخطوة 250. يرجع مقدار التقريب. */
export function roundingDown(amount: number, step: number): number {
  return amount % step;
}

/**
 * سحب النقاط المكتسبة عند الاسترجاع (القسم 6): النقاط تنعاد حسابها على المبلغ الباقي، والفرق ينسحب.
 * earnedOrig = اللي انكسب بالوصل أصلاً، alreadyClawed = اللي انسحب بسبب استرجاعات سابقة (موجب)،
 * remainingNet = صافي الباقي بعد هذا الاسترجاع. إذا ما بقى شي ينسحب الباقي كله. القيمة ما تتجاوز المتبقي ولا تنزل تحت صفر.
 */
export function pointsClawback(earnedOrig: number, alreadyClawed: number, remainingNet: number, perAmount: number, points: number): number {
  const keep = earnedOrig - alreadyClawed;
  if (keep <= 0) return 0;
  // pointsEarned يرجع صفر لو ما بقى شي، والحد الأدنى صفر يمنع سحب أكثر من اللي بقي (حتى لو المالك رفع النسبة بعد الدفع)
  return Math.max(0, keep - pointsEarned(remainingNet, perAmount, points));
}
