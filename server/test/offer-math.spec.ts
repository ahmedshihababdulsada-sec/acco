import { offerDiscount, percentBasis } from '../src/offers/offer-math';

describe('حساب العرض', () => {
  it('النسبة لأجزاء من عشرة آلاف بدون فاصلة عائمة', () => {
    expect(percentBasis('20')).toBe(2000n); expect(percentBasis('12.5')).toBe(1250n); expect(percentBasis('0.01')).toBe(1n);
    expect(percentBasis('99.99')).toBe(9999n); expect(percentBasis(7)).toBe(700n); expect(percentBasis('33.30')).toBe(3330n); expect(percentBasis('0.1')).toBe(10n);
  });
  it('الخصم ينزل لأقرب دينار (لصالح العيادة)', () => {
    expect(offerDiscount(100000, '20')).toBe(20000);
    expect(offerDiscount(33333, '12.5')).toBe(4166);              // 4166.625 → 4166
    expect(offerDiscount(10, '99.99')).toBe(9);                   // 9.999 → 9
    expect(offerDiscount(1, '99.99')).toBe(0);
    expect(offerDiscount(0, '50')).toBe(0);
    expect(offerDiscount(9_000_000_000, '33.33')).toBe(2_999_700_000);
    expect(offerDiscount(333, '0.01')).toBe(0); expect(offerDiscount(10000, '0.01')).toBe(1);
  });
  it('الخصم دايماً أقل من السعر', () => {
    for (const price of [1, 7, 250, 40000, 123457]) for (const pct of ['0.01', '33.33', '50', '99.99']) expect(offerDiscount(price, pct)).toBeLessThan(price);
  });
});
