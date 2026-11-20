import { allocate, pointsClawback, pointsEarned, roundingDown } from '../src/payments/allocation';

describe('توزيع المبالغ على البنود (أكبر البواقي)', () => {
  it('مثال القواعد المحاسبية 1: خصم 6,000 ونقاط 4,000 على 10,000/20,000/30,000', () => {
    const prices = [10000, 20000, 30000];
    const manual = allocate(6000, prices);
    const points = allocate(4000, prices);
    expect(manual).toEqual([1000, 2000, 3000]);
    expect(points).toEqual([667, 1333, 2000]);
    expect(prices.map((p, i) => p - manual[i] - points[i])).toEqual([8333, 16667, 25000]);
  });
  it('المجموع دائماً = المبلغ بالضبط (اختبار عشوائي ثابت البذرة)', () => {
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 3000; t++) {
      const n = 1 + Math.floor(rnd() * 6);
      const w = Array.from({ length: n }, () => Math.floor(rnd() * 5_000_000));
      if (w.every((x) => x === 0)) continue;
      const total = Math.floor(rnd() * Math.min(w.reduce((a, b) => a + b, 0), 9_000_000) + 1);
      const out = allocate(total, w);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      out.forEach((x, i) => { expect(x).toBeGreaterThanOrEqual(0); if (w[i] === 0) expect(x).toBe(0); });
    }
  });
  it('ما يفيض بالأرقام الكبيرة', () => {
    const out = allocate(9_000_000_000_000, [4_000_000_000_000, 5_000_000_000_000, 1]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(9_000_000_000_000);
  });
  it('تعادل البواقي: الأول أولاً، والمبلغ الصفري وبند وحيد', () => {
    expect(allocate(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocate(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(777, [123])).toEqual([777]);
  });
  it('رفض المدخلات الغلط: مبلغ سالب أو كسر، أوزان سالبة، مجموع أوزان صفر لمبلغ موجب', () => {
    expect(() => allocate(-1, [1])).toThrow();
    expect(() => allocate(1.5, [1])).toThrow();
    expect(() => allocate(5, [-1, 2])).toThrow();
    expect(() => allocate(5, [0, 0])).toThrow();
    expect(allocate(0, [0, 0])).toEqual([0, 0]);                       // الخصم الصفري على إجمالي صفري: ما يقسم على صفر
  });
});

describe('كسب النقاط والتقريب', () => {
  it('الكسور تنهمل: 15,000 تعطي نقاط 10,000 بس', () => {
    expect(pointsEarned(15000, 10000, 250)).toBe(250);
    expect(pointsEarned(9999, 10000, 250)).toBe(0);
    expect(pointsEarned(50000, 10000, 250)).toBe(1250);
    expect(pointsEarned(0, 10000, 250)).toBe(0);
    expect(pointsEarned(-5, 10000, 250)).toBe(0);
  });
  it('التقريب لصالح الزبون لأقرب 250: 16,667 تصير 16,500', () => {
    expect(roundingDown(16667, 250)).toBe(167);
    expect(16667 - roundingDown(16667, 250)).toBe(16500);
    expect(roundingDown(16500, 250)).toBe(0);
    expect(roundingDown(249, 250)).toBe(249);
    expect(roundingDown(1000, 1)).toBe(0);
  });
  it('مثال 2: بندان 5,000 و15,000 بدون خصم يكسبان 500، والباقي بعد الاسترجاع 15,000 يكسب 250', () => {
    expect(pointsEarned(20000, 10000, 250)).toBe(500);
    expect(500 - pointsEarned(15000, 10000, 250)).toBe(250);
  });
});

describe('سحب النقاط المكتسبة عند الاسترجاع (أمثلة القواعد المحاسبية)', () => {
  const claw = (earned: number, already: number, remaining: number) => pointsClawback(earned, already, remaining, 10000, 250);
  it('مثال 1: كسب 1,250، استرجاع بند 16,667 يخلي 33,333 → يستحق 750 → تنسحب 500 (مو ثلث الكسب)', () => {
    expect(claw(1250, 0, 33333)).toBe(500);
  });
  it('مثال 2: بندان 5,000 و15,000 (كسب 500)، استرجاع الـ 5,000 → الباقي 15,000 يستحق 250 → تنسحب 250 مو 125', () => {
    expect(claw(500, 0, 15000)).toBe(250);
  });
  it('مثال 3: تكرار الاسترجاع ما يسحب النقاط مرتين، والاسترجاع الكامل ينتهي بكسب صفر', () => {
    // مثال 1 بالتسلسل: بند 2 ثم بند 1 ثم بند 3
    const a = claw(1250, 0, 33333);                 // 500
    const b = claw(1250, a, 25000);                 // الباقي 25,000 يستحق 500 → يبقى 500، انسحب 500 → ما ينسحب زيادة
    const c = claw(1250, a + b, 0);                 // ما بقى شي
    expect([a, b, c]).toEqual([500, 250, 500]);
    expect(a + b + c).toBe(1250);
    expect(claw(1250, 1250, 0)).toBe(0);            // ما ينسحب شي ثاني بعد ما انسحب الكل
  });
  it('ما ينزل تحت صفر ولا يتجاوز المتبقي، والكسب صفر ما ينسحب منه شي', () => {
    expect(claw(0, 0, 0)).toBe(0);
    expect(claw(250, 0, 100000)).toBe(0);           // الباقي يستحق أكثر من اللي انكسب: ما ينسحب
    expect(claw(250, 100, 0)).toBe(150);
    expect(claw(250, 300, 0)).toBe(0);
  });
  it('لو المالك رفع نسبة الكسب بعد الدفع: ما ينسحب أقل من اللازم عند الاسترجاع الكامل، وما نسحب زيادة قبله', () => {
    expect(pointsClawback(1250, 0, 33333, 10000, 500)).toBe(0);         // 33,333 على النسبة الجديدة تستحق 1500 > 1250: ما ينسحب شي
    expect(pointsClawback(1250, 0, 0, 10000, 500)).toBe(1250);          // استرجاع كامل: ينسحب الكل
  });
});
