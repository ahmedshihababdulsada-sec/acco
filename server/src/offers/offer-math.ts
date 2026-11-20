/** نسبة العرض بالمئة (منزلتين) → أجزاء من عشرة آلاف. نشتغل بالأعداد الصحيحة حتى ما تدخل أخطاء الفاصلة. */
export function percentBasis(percent: string | number): bigint {
  const [i, f = ''] = String(percent).split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
}

/** خصم العرض على سعر بند: النزول لأقرب دينار (لصالح العيادة). مثال: 12.5% من 33,333 = 4,166.6 → 4,166. */
export function offerDiscount(listPrice: number, percent: string | number): number {
  return Number((BigInt(listPrice) * percentBasis(percent)) / 10000n);
}
