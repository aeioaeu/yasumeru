// 父が育休を取る場合と取らない場合を、出産予定日を起点に並べて計算する。
//
// このファイルには制度の数値を書かない。すべて rules-2026.js から受け取る。
//
// ── 何を固定して、何を動かすか ──────────────────
//
// このツールが答える問いは「父が育休を取ると、世帯のお金はどう動くか」だけ。
// 母は制度の上限まで取るものとして固定する。動かせるのは父の月数だけ。
//
//   母 … 産前休業 → 産後休業 → 育児休業（子が1歳に達する日の前日まで）
//        両シナリオで同じ。だから母の産休・育休そのものは差額に効かない。
//   父 … 出生日から N か月（1か月以上）。ここだけが2つのシナリオの違い。
//
// 母を両シナリオに同じだけ載せる理由は2つある。
//   1. 産後8週間は就業させてはならない（労基法65条）ので、
//      母の「育休を取らない」は通常勤務ではない。母を片方にしか載せないと、
//      産休分の落ち込みまで父の育休のせいに数えてしまう。
//   2. 保育料の階層・ふるさと納税の上限・書類に載る年収は「差」ではなく
//      絶対値で決まる。差がゼロでも、載せないと世帯の水準が嘘になる。
//
// ── 前提として置いていること（画面にも明記する）──
//   ・出産予定日どおりに生まれるものとして扱う
//   ・産休・育休中は給与も賞与も支払われない（賞与は割合を入力できる）
//   ・月の途中で休業に入る月の給与は、暦日で日割りする
//   ・社会保険料は標準報酬月額で決まるので、給与を日割りしても月額は変わらない
//   ・扶養は考慮しない（基礎控除と社会保険料控除だけで計算する）
//   ・健康保険料率は協会けんぽの全国平均を使う（都道府県で幅がある）
//   ・住民税は単身・級地1を想定した目安

// ── 小さな道具 ───────────────────────────────

const yen = (n) => Math.floor(n);

function bracketValue(table, amount) {
  for (const b of table) {
    if (amount <= b.upTo) {
      return b.type === 'flat' ? b.value : yen(amount * b.rate + b.add);
    }
  }
  return 0;
}

function lookupKiso(table, income) {
  for (const b of table) {
    if (income <= b.incomeUpTo) return b.value;
  }
  return 0;
}

function floorTo(n, unit) {
  return Math.floor(n / unit) * unit;
}

// ── 暦の道具 ─────────────────────────────────
//
// 母の育休は「出生日から58日目」に始まるので、月の途中から始まるのが普通。
// 月グリッドだけでは表せないため、内部は日付で持ち、表示のときに暦月へ畳む。

const DAY_MS = 86400000;

export function parseDate(s) {
  if (typeof s !== 'string') return s;
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export const addDays = (t, n) => t + n * DAY_MS;

export function addMonths(t, n) {
  const d = new Date(t);
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  // 応当日がない月はその月の末日を応当日とみなす（5月31日の翌月応当日は6月30日）
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, lastDay));
}

// 通し月番号。年 × 12 + 月。表示と集計はこの単位で行う。
export const toAbs = (year, month) => year * 12 + (month - 1);
export const fromAbs = (abs) => ({ year: Math.floor(abs / 12), month: (abs % 12) + 1 });

export function absOfDate(t) {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

export function monthBounds(abs) {
  const y = Math.floor(abs / 12);
  const m = abs % 12;
  return { start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 0) };
}

// 両端を含む日数
export const daysInclusive = (a, b) => Math.round((b - a) / DAY_MS) + 1;

export function overlapDays(a1, a2, b1, b2) {
  const s = Math.max(a1, b1);
  const e = Math.min(a2, b2);
  return e < s ? 0 : Math.round((e - s) / DAY_MS) + 1;
}

export function ymd(t) {
  const d = new Date(t);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

// ── 日程を組む ───────────────────────────────

/**
 * 出産予定日から、母と父の休業期間を導く。
 *
 * 母（制度の上限まで取る）
 *   産前休業 … 出産の日以前42日（出産日を含めて42日なので、開始は出産日の41日前）
 *   産後休業 … 出産の翌日以後56日
 *   育児休業 … 出生日から起算して58日目（＝産後休業の翌日）から、
 *              子が1歳に達する日（＝1歳の誕生日の前日）の前日まで
 *
 * 父
 *   育児休業 … 出生日から N か月（応当日の前日まで）
 *
 * 母の上限は「出産日（産前休業の末日）＋産後休業＋育児休業で1年」なので、
 * 上のとり方はその範囲に収まる。1歳6か月・2歳への延長は扱わない
 * （不承諾通知などの要件があり、取れるかを事前に決め打ちできないため）。
 */
export function buildSchedule(rules, { birthDate, fatherLeaveMonths }) {
  const birth = parseDate(birthDate);
  const s = rules.sankyu;
  const k = rules.ikukyu;

  const sankyuStart = addDays(birth, -(s.beforeDays - 1));
  const sankyuEnd = addDays(birth, s.afterDays);

  const motherLeaveStart = addDays(birth, k.motherLeaveStartDayFromBirth - 1);
  const b = ymd(birth);
  const firstBirthday = Date.UTC(b.year + 1, b.month - 1, b.day);
  // 「子が1歳に達する日」は1歳の誕生日の前日。育児休業はその前日まで。
  const motherLeaveEnd = addDays(firstBirthday, -2);

  const father =
    fatherLeaveMonths > 0
      ? { leaveStart: birth, leaveEnd: addDays(addMonths(birth, fatherLeaveMonths), -1) }
      : null;

  return {
    birth,
    firstBirthday,
    sankyu: { start: sankyuStart, end: sankyuEnd },
    mother: { leaveStart: motherLeaveStart, leaveEnd: motherLeaveEnd },
    father,
    motherLeaveDays: daysInclusive(motherLeaveStart, motherLeaveEnd),
    sankyuDays: daysInclusive(sankyuStart, sankyuEnd),
    fatherLeaveDays: father ? daysInclusive(father.leaveStart, father.leaveEnd) : 0,
  };
}

// ── 出生後休業支援給付金の要件 ───────────────────
//
// ここがこのツールで一番効く分岐。父母で非対称になっている。
//
//   父 … 母が子の出生日の翌日に産後休業中なので、配偶者要件は
//        「配偶者の育児休業を要件としない場合」に該当して自動的に満たされる。
//   母 … 配偶者（父）が出生日から8週以内に通算14日以上取っていることが要る。
//        つまり父が取らなければ、母の13%も出ない。
//
// 本人の対象期間は、産後休業をしない父が8週、産後休業をする母が16週。
// 支給日数の上限は28日。

export function shusseigoDaysFor(rules, role, schedule) {
  const g = rules.shusseigo;
  if (role === 'father') {
    if (!schedule.father) return 0;
    const windowEnd = addDays(schedule.birth, g.selfWindowWeeksNoPostpartum * 7);
    const days = overlapDays(
      schedule.father.leaveStart, schedule.father.leaveEnd,
      schedule.birth, windowEnd
    );
    // 配偶者（母）は出生日の翌日に産後休業中なので、配偶者要件は満たされる
    return days >= g.spouseMinDays ? Math.min(days, g.maxDays) : 0;
  }

  // 母。まず配偶者（父）の要件を見る。
  const spouseWindowEnd = addDays(schedule.birth, g.spouseWindowWeeks * 7);
  const spouseDays = schedule.father
    ? overlapDays(
        schedule.father.leaveStart, schedule.father.leaveEnd,
        schedule.birth, spouseWindowEnd
      )
    : 0;
  if (spouseDays < g.spouseMinDays) return 0;

  const windowEnd = addDays(schedule.birth, g.selfWindowWeeksWithPostpartum * 7);
  const days = overlapDays(
    schedule.mother.leaveStart, schedule.mother.leaveEnd,
    schedule.birth, windowEnd
  );
  return days >= g.spouseMinDays ? Math.min(days, g.maxDays) : 0;
}

// ── 社会保険料（本人負担・月額） ───────────────

export function shahoMonthly(rules, monthlySalary, isOver40) {
  const s = rules.shaho;
  const healthBase = Math.min(monthlySalary, s.healthMonthlyCap);
  const pensionBase = Math.min(monthlySalary, s.pensionMonthlyCap);

  const health = healthBase * s.healthRateSelf;
  const care = isOver40 ? healthBase * s.careRateSelf : 0;
  const pension = pensionBase * s.pensionRateSelf;
  const employment = monthlySalary * s.employmentRateSelf;

  return {
    health: yen(health),
    care: yen(care),
    pension: yen(pension),
    employment: yen(employment),
    // 産休・育休で免除されるのはこちら（健康保険・介護保険・厚生年金）
    exemptable: yen(health + care + pension),
    total: yen(health + care + pension + employment),
  };
}

export function shahoBonusParts(rules, bonusAmount, isOver40) {
  const s = rules.shaho;
  const healthBase = Math.min(bonusAmount, s.healthBonusCapPerYear);
  const pensionBase = Math.min(bonusAmount, s.pensionBonusCapPerPayment);

  const health = healthBase * s.healthRateSelf;
  const care = isOver40 ? healthBase * s.careRateSelf : 0;
  const pension = pensionBase * s.pensionRateSelf;
  const employment = bonusAmount * s.employmentRateSelf;

  return {
    exemptable: yen(health + care + pension),
    // 雇用保険料は賃金にかかるので、賞与が支払われれば休業中でも負担がある
    employment: yen(employment),
    total: yen(health + care + pension + employment),
  };
}

export function shahoBonus(rules, bonusAmount, isOver40) {
  return shahoBonusParts(rules, bonusAmount, isOver40).total;
}

/**
 * その月の給与にかかる健保・厚年が免除されるか。
 *
 * 産前産後休業
 *   免除は「産休開始月から、終了日の翌日が属する月の前月まで」
 *  （終了日が月の末日の場合は終了月まで）。
 *   これは「月末時点で産休中の月」と同じ範囲になる。
 *
 * 育児休業
 *   ・月末時点で育休中ならその月は免除（月末ルール）
 *   ・育休を開始した月に、同月内で14日以上取得していればその月も免除（14日ルール）
 */
export function monthShahoExempt(rules, abs, periods) {
  const { start: mStart, end: mEnd } = monthBounds(abs);
  for (const p of periods) {
    if (!p) continue;
    // 月末ルール（産休・育休に共通）
    if (p.start <= mEnd && mEnd <= p.end) return true;
    // 14日ルール（育休の開始月のみ）
    if (p.kind === 'ikukyu' && absOfDate(p.start) === abs) {
      const d = overlapDays(p.start, p.end, mStart, mEnd);
      if (d >= rules.shaho.exemptionMinDaysInMonth) return true;
    }
  }
  return false;
}

/**
 * 休業中に支払われた賞与の社会保険料が免除されるか。
 *
 * 要件は「賞与を支払った月の末日を含んだ連続した1か月を超える育児休業等」。
 * 1か月を超えるかは暦日で判断し、休日も期間に含む。
 * 産前産後休業も「育児休業等」に含まれるので、同じ扱いにする。
 */
export function bonusShahoExempt(rules, bonusMonthAbs, periods) {
  const { end: mEnd } = monthBounds(bonusMonthAbs);
  for (const p of periods) {
    if (!p) continue;
    if (!(p.start <= mEnd && mEnd <= p.end)) continue;
    // 「1か月を超える」= 開始日の翌月応当日を越えて続いている
    if (p.end >= addMonths(p.start, 1)) return true;
  }
  return false;
}

// ── 育児休業給付金 ────────────────────────────

/**
 * 休業開始時賃金日額 = 休業開始前6か月の賃金合計 ÷ 180
 *
 * 産前産後休業を取った人が育児休業を取る場合は、原則として
 * 【産前産後休業開始前】の直近6か月で算定する。
 * つまり母の賃金日額は、産休で給与が止まる前の水準で決まる。
 * 賞与など3か月を超える期間ごとに支払われるものは含まれない。
 */
export function dailyWage(rules, monthlySalary) {
  const k = rules.ikukyu;
  const raw = (monthlySalary * k.wageMonthsCount) / k.wageDaysDivisor;
  return Math.min(Math.max(raw, k.dailyWageFloor), k.dailyWageCap);
}

/**
 * 育児休業給付を1日ずつ積む。
 *
 * 給付率は通算の支給日数で切り替わる（180日目までが67%、181日目以降が50%）。
 * 母は月の途中から育休に入るので、支給単位期間と暦月は一致しない。
 * 日で積んでから暦月に畳むことで、どちらのずれも扱えるようにしている。
 *
 * 出生後休業支援給付金（13%）は、対象期間のうち最初の shusseigoDays 日分に乗る。
 */
export function benefitByMonth(rules, { leaveStart, leaveEnd, monthlySalary, shusseigoDays }) {
  const k = rules.ikukyu;
  const d = dailyWage(rules, monthlySalary);
  const total = daysInclusive(leaveStart, leaveEnd);

  const byMonth = new Map();
  const bump = (abs, key, v) => {
    if (!byMonth.has(abs)) {
      byMonth.set(abs, { abs, benefit: 0, shusseigo: 0, days: 0, daysHigh: 0, daysLow: 0 });
    }
    byMonth.get(abs)[key] += v;
  };

  for (let i = 0; i < total; i++) {
    const abs = absOfDate(addDays(leaveStart, i));
    const high = i < k.rateSwitchDay;
    bump(abs, 'benefit', d * (high ? k.rateHigh : k.rateLow));
    bump(abs, 'days', 1);
    bump(abs, high ? 'daysHigh' : 'daysLow', 1);
    if (i < shusseigoDays) bump(abs, 'shusseigo', d * rules.shusseigo.rate);
  }

  for (const m of byMonth.values()) {
    m.benefit = yen(m.benefit);
    m.shusseigo = yen(m.shusseigo);
    m.rate = m.daysHigh > 0 ? k.rateHigh : k.rateLow;
  }
  return byMonth;
}

// ── 出産手当金 ───────────────────────────────

/**
 * 1日あたり = 標準報酬月額の平均 ÷ 30（10円未満四捨五入）× 2/3（1円未満四捨五入）
 *
 * 健康保険の給付なので非課税。源泉徴収票の支払金額には載らない。
 * このツールは標準報酬月額を月給で代用している（等級表の当てはめはしない）。
 */
export function shussanTeateDaily(rules, monthlySalary) {
  const s = rules.sankyu;
  const perDay = monthlySalary / s.teateDailyDivisor;
  const rounded = Math.round(perDay / s.teateDailyRoundUnit) * s.teateDailyRoundUnit;
  return Math.round(rounded * s.teateRate);
}

export function teateByMonth(rules, { start, end, monthlySalary }) {
  const daily = shussanTeateDaily(rules, monthlySalary);
  const byMonth = new Map();
  const total = daysInclusive(start, end);
  for (let i = 0; i < total; i++) {
    const abs = absOfDate(addDays(start, i));
    if (!byMonth.has(abs)) byMonth.set(abs, { abs, teate: 0, days: 0 });
    const m = byMonth.get(abs);
    m.teate += daily;
    m.days += 1;
  }
  return byMonth;
}

// ── 所得税（年額・年末調整後の姿） ─────────────

export function incomeTaxAnnual(rules, salaryIncome, shahoPaid) {
  const t = rules.shotokuzei;
  if (salaryIncome <= 0) return { tax: 0, taxable: 0, kyuyoShotoku: 0, kiso: 0 };

  const kojo = bracketValue(t.kyuyoKojo, salaryIncome);
  const kyuyoShotoku = Math.max(0, salaryIncome - kojo);
  const kiso = lookupKiso(t.kisoKojo, kyuyoShotoku);

  const taxable = Math.max(
    0,
    floorTo(kyuyoShotoku - shahoPaid - kiso, rules.rounding.taxableIncomeUnit)
  );

  let base = 0;
  for (const b of t.sokusan) {
    if (taxable <= b.upTo) {
      base = taxable * b.rate - b.deduct;
      break;
    }
  }
  base = Math.max(0, base);
  const tax = yen(base * (1 + t.fukkoRate));

  return { tax, taxable, kyuyoShotoku, kiso };
}

// ── 住民税（前年所得に対して翌年度に課税） ──────

export function residentTaxAnnual(rules, salaryIncome, shahoPaid) {
  const j = rules.juminzei;
  if (salaryIncome <= 0) {
    return { total: 0, shotokuwari: 0, kintoWari: 0, exempt: true };
  }

  const kojo = bracketValue(j.kyuyoKojo, salaryIncome);
  const kyuyoShotoku = Math.max(0, salaryIncome - kojo);

  // 非課税限度額（単身の目安）。合計所得金額がこれ以下なら課税されない。
  if (kyuyoShotoku <= j.hikazeiKintoWari) {
    return { total: 0, shotokuwari: 0, kintoWari: 0, exempt: true };
  }

  const taxable = Math.max(
    0,
    floorTo(kyuyoShotoku - shahoPaid - j.kisoKojo, rules.rounding.taxableIncomeUnit)
  );

  let shotokuwari = taxable * j.shotokuwariRate;

  // 調整控除
  let chousei;
  if (taxable <= j.chouseiKojoThreshold) {
    chousei = Math.min(j.chouseiKojoJinteki, taxable) * j.chouseiKojoRate;
  } else {
    chousei = Math.max(
      (j.chouseiKojoJinteki - (taxable - j.chouseiKojoThreshold)) * j.chouseiKojoRate,
      j.chouseiKojoMin
    );
  }
  shotokuwari = Math.max(0, floorTo(shotokuwari - chousei, rules.rounding.juminzeiTaxUnit));

  return {
    total: shotokuwari + j.kintoWari,
    shotokuwari,
    kintoWari: j.kintoWari,
    exempt: false,
  };
}

/**
 * 産休にも育休にも入っていない、ふつうの月の手取り（賞与を除く）。
 *
 * 「ふだんと比べてどうか」を出すのに使う。月ごとの計算と辻褄が合うように、
 * 所得税は年額をその月の額面の比で按分し、住民税は年額の1/12を置く。
 */
export function normalMonthlyNet(rules, person) {
  const {
    monthlySalary, annualBonus, bonusMonths = [6, 12], isOver40 = false,
  } = person;
  const shaho = shahoMonthly(rules, monthlySalary, isOver40);
  const bonusPer = bonusMonths.length ? annualBonus / bonusMonths.length : 0;
  const annualPaid = monthlySalary * 12 + annualBonus;
  if (annualPaid <= 0) return 0;
  const annualShaho =
    shaho.total * 12 + shahoBonus(rules, bonusPer, isOver40) * bonusMonths.length;

  const it = incomeTaxAnnual(rules, annualPaid, annualShaho);
  const rt = residentTaxAnnual(rules, annualPaid, annualShaho);
  const incomeTax = yen((it.tax * monthlySalary) / annualPaid);
  return yen(monthlySalary - shaho.total - incomeTax - rt.total / 12);
}

// ── 1人分のシミュレーション ──────────────────

/**
 * @param rules    rules-2026.js の RULES
 * @param person   { role, label, monthlySalary, annualBonus, bonusMonths,
 *                   isOver40, bonusRateDuringLeave }
 * @param periods  この人の休業期間。[{kind:'sankyu'|'ikukyu', start, end}]
 * @param shusseigoDays 出生後休業支援給付金の支給日数（0なら対象外）
 * @param timeline { startAbs, totalMonths } 世帯で共通の表示窓
 */
export function simulatePerson(rules, person, periods, shusseigoDays, timeline) {
  const {
    monthlySalary,
    annualBonus,
    bonusMonths = [6, 12],
    isOver40 = false,
    // 休業中の賞与を、通常の何割で支給するか（0 なら出ない）。
    // 算定期間が休業と被ったときの扱いは会社ごとに大きく違うので、
    // 公開された制度ではない。計算せずに入力してもらう。
    bonusRateDuringLeave = 0,
  } = person;

  const bonusPerPayment = bonusMonths.length ? annualBonus / bonusMonths.length : 0;
  const live = periods.filter(Boolean);

  const ikukyu = live.find((p) => p.kind === 'ikukyu');
  const sankyu = live.find((p) => p.kind === 'sankyu');

  const benefitMap = ikukyu
    ? benefitByMonth(rules, {
        leaveStart: ikukyu.start,
        leaveEnd: ikukyu.end,
        monthlySalary,
        shusseigoDays,
      })
    : new Map();

  const teateMap = sankyu
    ? teateByMonth(rules, { start: sankyu.start, end: sankyu.end, monthlySalary })
    : new Map();

  const fullShaho = shahoMonthly(rules, monthlySalary, isOver40);

  const months = [];
  for (let i = 0; i < timeline.totalMonths; i++) {
    const abs = timeline.startAbs + i;
    const { year, month } = fromAbs(abs);
    const { start: mStart, end: mEnd } = monthBounds(abs);
    const daysInMonth = daysInclusive(mStart, mEnd);

    // その月に休業していた日数
    let leaveDays = 0;
    let onSankyu = false;
    let onIkukyu = false;
    for (const p of live) {
      const d = overlapDays(p.start, p.end, mStart, mEnd);
      if (d > 0) {
        leaveDays += d;
        if (p.kind === 'sankyu') onSankyu = true;
        else onIkukyu = true;
      }
    }
    leaveDays = Math.min(leaveDays, daysInMonth);
    const workDays = daysInMonth - leaveDays;
    const onLeave = leaveDays > 0;

    // 給与は暦日で日割りする。月の途中で休業に入る月がそのまま出る。
    const salary = yen((monthlySalary * workDays) / daysInMonth);

    const isBonusMonth = bonusMonths.includes(month);
    const bonus = !isBonusMonth
      ? 0
      : onLeave
        ? yen(bonusPerPayment * bonusRateDuringLeave)
        : yen(bonusPerPayment);

    // 社会保険料。健保・厚年は標準報酬月額で決まるので給与を日割りしても
    // 月額は変わらない。免除の判定は月単位（月末ルール・14日ルール）。
    const exempt = monthShahoExempt(rules, abs, live);
    const shahoOnSalary = exempt
      ? yen((salary * rules.shaho.employmentRateSelf))       // 雇用保険料は賃金にかかる
      : fullShaho.exemptable + yen(salary * rules.shaho.employmentRateSelf);

    let shahoOnBonus = 0;
    let bonusExempt = false;
    if (bonus > 0) {
      const parts = shahoBonusParts(rules, bonus, isOver40);
      bonusExempt = bonusShahoExempt(rules, abs, live);
      shahoOnBonus = bonusExempt ? parts.employment : parts.total;
    }

    const b = benefitMap.get(abs);
    const t = teateMap.get(abs);

    months.push({
      abs, year, month,
      daysInMonth, leaveDays, workDays,
      onLeave, onSankyu, onIkukyu,
      salary,
      bonus,
      gross: salary + bonus,
      shahoExempt: exempt,
      shaho: shahoOnSalary + shahoOnBonus,
      shahoOnSalary,
      shahoOnBonus,
      bonusExempt,
      // 育児休業給付金（＋出生後休業支援給付金）。どちらも非課税。
      benefit: b ? b.benefit + b.shusseigo : 0,
      benefitBase: b ? b.benefit : 0,
      shusseigo: b ? b.shusseigo : 0,
      benefitRate: b ? b.rate : null,
      benefitDays: b ? b.days : 0,
      // 出産手当金。健康保険の給付なので非課税。
      teate: t ? t.teate : 0,
      teateDays: t ? t.days : 0,
    });
  }

  // ── 年ごとの集計 ──
  //
  // 源泉徴収票の「支払金額」は給与＋賞与の額面合計。
  // 育児休業給付も出産手当金も非課税なので、ここには入らない。
  // 家計には入っているのに書類の上の年収だけが下がるのがここ。
  const byYear = new Map();
  for (const m of months) {
    if (!byYear.has(m.year)) {
      byYear.set(m.year, {
        year: m.year, paid: 0, shaho: 0, benefit: 0, teate: 0, monthsCounted: 0,
      });
    }
    const y = byYear.get(m.year);
    y.paid += m.gross;
    y.shaho += m.shaho;
    y.benefit += m.benefit;
    y.teate += m.teate;
    y.monthsCounted++;
  }

  // 表示範囲が年の途中で切れる年は、残りの月を通常勤務として補う。
  // そうしないと「年の一部しか見ていないせいで年収が低い」という嘘が出る。
  for (const y of byYear.values()) {
    const missing = 12 - y.monthsCounted;
    if (missing > 0) {
      y.paid += monthlySalary * missing;
      y.shaho += fullShaho.total * missing;
      const shownBonusMonths = months.filter(
        (m) => m.year === y.year && bonusMonths.includes(m.month)
      ).length;
      const missingBonus = bonusMonths.length - shownBonusMonths;
      if (missingBonus > 0) {
        y.paid += bonusPerPayment * missingBonus;
        y.shaho += shahoBonus(rules, bonusPerPayment, isOver40) * missingBonus;
      }
      y.partial = true;
    }
    y.paid = yen(y.paid);
    y.shaho = yen(y.shaho);
  }

  // 表示窓より前の年は通常勤務。住民税の初年度分の基礎になる。
  const firstYear = fromAbs(timeline.startAbs).year;
  const normalAnnualPaid = yen(monthlySalary * 12 + annualBonus);
  const normalAnnualShaho = yen(
    fullShaho.total * 12 + shahoBonus(rules, bonusPerPayment, isOver40) * bonusMonths.length
  );
  for (const y of [firstYear - 2, firstYear - 1]) {
    if (byYear.has(y)) continue;
    byYear.set(y, {
      year: y,
      paid: normalAnnualPaid,
      shaho: normalAnnualShaho,
      benefit: 0,
      teate: 0,
      monthsCounted: 12,
      baseline: true,
    });
  }

  const years = [...byYear.values()].sort((a, b) => a.year - b.year);
  for (const y of years) {
    const it = incomeTaxAnnual(rules, y.paid, y.shaho);
    y.incomeTax = it.tax;
    y.taxableIncome = it.taxable;
    // 合計所得金額（給与だけの場合は給与所得）。配偶者控除の判定に使う。
    y.totalIncome = it.kyuyoShotoku;
    const rt = residentTaxAnnual(rules, y.paid, y.shaho);
    y.residentTaxForNextFiscalYear = rt.total;
    y.residentTaxExempt = rt.exempt;
    // 保育料の階層は均等割を含まない「所得割額」で決まるので、別に持っておく
    y.shotokuwari = rt.shotokuwari;
    // ふるさと納税の特例分の上限は、住民税所得割額の20%。
    y.furusatoTokureiCap = Math.floor(rt.shotokuwari * rules.furusato.tokureiCapRate);
  }

  // ── 月ごとに税を割り付ける ──
  const yearMap = new Map(years.map((y) => [y.year, y]));

  // 所得税は、その年の年額を「その月の額面」の比で按分する。
  // 年額を12で割ると、給与の出ていない月にも所得税が載ってしまう。
  const grossByYear = new Map();
  for (const m of months) {
    grossByYear.set(m.year, (grossByYear.get(m.year) || 0) + m.gross);
  }

  for (const m of months) {
    const thisYear = yearMap.get(m.year);
    const shownGross = grossByYear.get(m.year) || 0;
    m.incomeTax =
      thisYear && shownGross > 0 ? yen((thisYear.incomeTax * m.gross) / shownGross) : 0;

    // 住民税の年度は6月始まり。6月以降はその年の前年所得、5月以前は前々年所得。
    const baseYear = m.month >= rules.juminzei.collectionStartMonth ? m.year - 1 : m.year - 2;
    const baseYearData = yearMap.get(baseYear);
    m.residentTax = baseYearData
      ? yen(baseYearData.residentTaxForNextFiscalYear / 12)
      : yen(residentTaxAnnual(rules, normalAnnualPaid, normalAnnualShaho).total / 12);
    m.residentTaxBaseYear = baseYearData ? baseYear : null;

    // 住民税は前年所得に対するものなので、休業中でも払い続ける。
    m.net = yen(m.gross + m.benefit + m.teate - m.shaho - m.incomeTax - m.residentTax);

    // 賞与を除いた「月々の」手取り。
    // 賞与を混ぜたまま折れ線にすると、賞与月の山が縦軸を支配してしまい、
    // 給付率が落ちる段差と住民税が下がる段差が見えなくなる。
    m.netExBonus = yen(m.net - (m.bonus - m.shahoOnBonus));
  }

  return { months, years };
}

// ── 入金のタイミング ──────────────────────

/**
 * 給付は毎月発生するが、入金は毎月ではない。
 * 支給申請は原則2つの支給単位期間をまとめて行うので、
 * 休業に入ってから最初の入金までに空白ができる。
 *
 * 支給単位期間は、育児休業開始日の応当日から翌月の応当日の前日まで。
 * 母は月の途中から育休に入るので、暦月とは一致しない。
 *
 * 実際の入金日は事業主がいつ申請するかで動く。ここは月の粒度の目安。
 */
export function paymentSchedule(rules, { leaveStart, leaveEnd, monthlySalary, shusseigoDays }) {
  const per = rules.shinsei.unitsPerApplication;
  const k = rules.ikukyu;
  const d = dailyWage(rules, monthlySalary);
  const totalDays = daysInclusive(leaveStart, leaveEnd);

  // 支給単位期間を切る
  const units = [];
  for (let u = 0; ; u++) {
    const uStart = addMonths(leaveStart, u);
    if (uStart > leaveEnd) break;
    const uEnd = Math.min(addDays(addMonths(leaveStart, u + 1), -1), leaveEnd);
    const from = Math.round((uStart - leaveStart) / DAY_MS);
    const days = daysInclusive(uStart, uEnd);
    // 育児休業給付金と出生後休業支援給付金は別々の給付金なので、
    // それぞれ円未満を切り捨ててから足す。benefitByMonth と揃えてある。
    let base = 0;
    let extra = 0;
    for (let i = from; i < from + days; i++) {
      base += d * (i < k.rateSwitchDay ? k.rateHigh : k.rateLow);
      if (i < shusseigoDays) extra += d * rules.shusseigo.rate;
    }
    units.push({
      index: u, start: uStart, end: uEnd, days,
      benefit: yen(base), shusseigo: yen(extra),
      amount: yen(base) + yen(extra),
    });
    if (uEnd >= leaveEnd) break;
  }

  const payments = [];
  for (let k2 = 0; k2 * per < units.length; k2++) {
    const group = units.slice(k2 * per, k2 * per + per);
    const amount = group.reduce((a, u) => a + u.amount, 0);
    if (amount <= 0) continue;
    // 対象の支給単位期間が終わった翌月に、申請・支給決定・入金が起きるものとして置く。
    const payAbs = absOfDate(group[group.length - 1].end) + 1;
    payments.push({
      index: k2,
      amount,
      payAbs,
      ...fromAbs(payAbs),
      covers: group.map((u) => ({
        index: u.index, days: u.days, amount: u.amount,
        from: ymd(u.start), to: ymd(u.end),
      })),
    });
  }

  const first = payments[0] || null;
  const leaveStartAbs = absOfDate(leaveStart);
  return {
    units,
    payments,
    // 休業に入ってから最初の入金までに、給付金の入らない月がいくつあるか
    gapMonths: first ? first.payAbs - leaveStartAbs : 0,
    firstPayment: first,
    total: payments.reduce((a, p) => a + p.amount, 0),
    totalDays,
  };
}

// ── 申請の期限 ────────────────────────────

/**
 * いつまでに何を出すか。日付は目安で、勤務先の締めや労使協定で前後する。
 */
export function applicationSchedule(rules, { role, periods }) {
  const s = rules.shinsei;
  const items = [];
  const ikukyu = periods.find((p) => p && p.kind === 'ikukyu');
  const sankyu = periods.find((p) => p && p.kind === 'sankyu');

  if (sankyu) {
    items.push({
      who: '勤務先へ',
      what: '産前産後休業の申出',
      deadline: null,
      note: '産前休業は本人の請求による。産後8週間は就業させてはならない（労基法65条）',
    });
    items.push({
      who: '年金事務所へ（勤務先が提出）',
      what: '産前産後休業取得者申出書',
      deadline: null,
      note: '産休期間中に出す。健康保険・厚生年金の保険料が本人・事業主とも免除される',
    });
    items.push({
      who: '協会けんぽ等へ（勤務先経由が多い）',
      what: '出産手当金の支給申請',
      deadline: null,
      note: '産後の分をまとめて申請するのが一般的。入金までに数か月かかることがある',
    });
  }

  if (ikukyu) {
    const noticeDate = addDays(ikukyu.start, -s.leaveNoticeDaysNormal);
    items.push({
      who: '勤務先へ',
      what: '育児休業の申出',
      deadline: new Date(noticeDate),
      note:
        role === 'mother'
          ? '産後休業から続けて取る場合も、育児休業は別に申し出る。原則1か月前まで'
          : '育児休業は原則1か月前まで。出産予定日より早く生まれることがあるので早めに出す',
    });

    // 受給資格確認＋初回支給申請
    // 「育児休業開始日から起算して4か月を経過する日の属する月の末日」
    const four = addMonths(ikukyu.start, s.firstApplicationDeadlineMonths);
    const fourMinus = addDays(four, -1);
    const f = ymd(fourMinus);
    const firstDeadline = new Date(Date.UTC(f.year, f.month, 0));
    items.push({
      who: 'ハローワークへ（原則は勤務先が提出）',
      what: '受給資格の確認と、初回の支給申請',
      deadline: firstDeadline,
      note: '初回は原則、最初と次の2つの支給単位期間をまとめて申請する',
    });

    items.push({
      who: '年金事務所へ（勤務先が提出）',
      what: '育児休業等取得者申出書',
      deadline: null,
      note: '育休期間中に出す。月末時点で育休中の月、または同月内に14日以上取得した月の保険料が免除される',
    });
  }

  return { items };
}

// 世帯で1回だけやること。人ごとの一覧に混ぜると同じ項目が2度出る。
export function householdApplications() {
  return [
    {
      who: 'お住まいの自治体へ',
      what: '保育所等の利用申込',
      deadline: null,
      note: '受付時期は自治体で違う。4月入園は前年の秋に締め切ることが多い。必ず自治体の案内で確認する',
    },
    {
      who: 'お住まいの自治体へ',
      what: '出生届・児童手当の認定請求',
      deadline: null,
      note: '出生届は出生の日から14日以内。児童手当は出生の翌日から15日以内に出すと出生月分から受け取れる',
    },
  ];
}

// ── 保育料の階層を決める数字 ────────────────

/**
 * 保育料の額そのものは自治体差が大きいので出さない。
 * 出すのは「階層を決める数字」と「それがどの年の所得か」だけ。
 *
 * 保育料は世帯（父母の合算）の市町村民税「所得割額」で決まり、
 * 年度の途中で基準が切り替わる。
 *   4〜8月分  … 前年度の所得割額（＝前々年の所得）
 *   9〜3月分  … 当年度の所得割額（＝前年の所得）
 */
export function childcareBasisYear(rules, year, month) {
  return month >= rules.hoikuryo.switchMonth ? year - 1 : year - 2;
}

export function childcareBasis(rules, peopleYears, careStartAbs, careEndAbs) {
  const segments = [];
  let current = null;

  for (let abs = careStartAbs; abs <= careEndAbs; abs++) {
    const { year, month } = fromAbs(abs);
    const basisYear = childcareBasisYear(rules, year, month);

    const parts = peopleYears.map((py) => {
      const row = py.years.find((r) => r.year === basisYear);
      return { label: py.label, amount: row ? row.shotokuwari : null };
    });
    const known = parts.every((p) => p.amount != null);
    const household = known ? parts.reduce((a, p) => a + p.amount, 0) : null;

    if (!current || current.basisYear !== basisYear) {
      if (current) segments.push(current);
      current = { basisYear, fromAbs: abs, toAbs: abs, parts, household, known };
    } else {
      current.toAbs = abs;
    }
  }
  if (current) segments.push(current);

  for (const s of segments) {
    Object.assign(s, { from: fromAbs(s.fromAbs), to: fromAbs(s.toAbs) });
  }
  return segments;
}

// ── 配偶者控除・配偶者特別控除の判定 ───────────

/**
 * 控除の「対象になるかどうか」だけを返す。控除額は返さない。
 * 令和8年分の控除額の表が国税庁にまだ出ていないため、推測で作らない。
 */
export function spouseDeductionStatus(rules, spouseIncome, selfIncome) {
  const h = rules.haigusha;
  if (selfIncome > h.selfMaxIncome) {
    return { kind: 'none', reason: 'self-income-over' };
  }
  if (spouseIncome <= h.kojoMaxIncome) return { kind: 'kojo' };
  if (spouseIncome <= h.tokubetsuMaxIncome) return { kind: 'tokubetsu' };
  return { kind: 'none', reason: 'spouse-income-over' };
}

// ── 統計の中での位置 ──────────────────────

/**
 * 育休の長さが、統計のどの区分に入るかを返す。
 * 比べて優劣をつけるためではなく、「自分だけじゃない」を知るためのもの。
 */
export function durationBucketIndex(rules, leaveMonths) {
  const bs = rules.toukei.durationBuckets;
  for (let i = 0; i < bs.length; i++) {
    if (leaveMonths >= bs[i].from && leaveMonths < bs[i].to) return i;
  }
  return bs.length - 1;
}

/** 同じ区分か、それより短い区分の人が何%いるか。 */
export function shareUpTo(rules, sex, leaveMonths) {
  const bs = rules.toukei.durationBuckets;
  const idx = durationBucketIndex(rules, leaveMonths);
  let sum = 0;
  for (let i = 0; i <= idx; i++) sum += bs[i][sex] ?? 0;
  return Math.round(sum * 10) / 10;
}

// ── 世帯のシミュレーション ─────────────────────

/**
 * 父が育休を取る場合と取らない場合を、同じ時間軸に載せて比べる。
 * 母は両方のシナリオで同じ（産休＋育休を制度の上限まで）。
 *
 * @param config
 *   birthDate         出産予定日 'YYYY-MM-DD'
 *   mother            { label, monthlySalary, annualBonus, bonusMonths, isOver40, bonusRateDuringLeave }
 *   father            同上 ＋ leaveMonths（1以上）
 *   careStartAbs      保育の開始月（省略時は母が復職する月）
 */
export function simulateHousehold(rules, config) {
  const { birthDate, mother, father } = config;
  const leaveMonths = Math.max(1, Math.min(rules.ikukyu.maxAgeMonths, father.leaveMonths || 1));

  const takeSchedule = buildSchedule(rules, { birthDate, fatherLeaveMonths: leaveMonths });
  const skipSchedule = buildSchedule(rules, { birthDate, fatherLeaveMonths: 0 });

  // 共通の窓: 産前休業の開始月から、母の復職の24か月後まで
  const startAbs = absOfDate(takeSchedule.sankyu.start);
  const motherReturnAbs = absOfDate(takeSchedule.mother.leaveEnd) + 1;
  const totalMonths = motherReturnAbs - startAbs + 24;
  const timeline = { startAbs, totalMonths };

  const motherPeriods = [
    { kind: 'sankyu', start: takeSchedule.sankyu.start, end: takeSchedule.sankyu.end },
    { kind: 'ikukyu', start: takeSchedule.mother.leaveStart, end: takeSchedule.mother.leaveEnd },
  ];
  const fatherPeriods = [
    { kind: 'ikukyu', start: takeSchedule.father.leaveStart, end: takeSchedule.father.leaveEnd },
  ];

  // 出生後休業支援給付金。父が取らないシナリオでは、母の13%も出ない。
  const shusseigo = {
    take: {
      mother: shusseigoDaysFor(rules, 'mother', takeSchedule),
      father: shusseigoDaysFor(rules, 'father', takeSchedule),
    },
    skip: {
      mother: shusseigoDaysFor(rules, 'mother', skipSchedule),
      father: 0,
    },
  };

  const sims = {
    take: {
      mother: simulatePerson(rules, mother, motherPeriods, shusseigo.take.mother, timeline),
      father: simulatePerson(rules, father, fatherPeriods, shusseigo.take.father, timeline),
    },
    skip: {
      mother: simulatePerson(rules, mother, motherPeriods, shusseigo.skip.mother, timeline),
      father: simulatePerson(rules, father, [], 0, timeline),
    },
  };

  // ── 世帯の月ごと合算 ──
  const months = [];
  for (let i = 0; i < totalMonths; i++) {
    const abs = startAbs + i;
    const { year, month } = fromAbs(abs);
    const cell = (sc) => ({
      mother: sims[sc].mother.months[i],
      father: sims[sc].father.months[i],
    });
    const take = cell('take');
    const skip = cell('skip');
    const sum = (c, k) => c.mother[k] + c.father[k];
    months.push({
      abs, year, month,
      take, skip,
      onLeave: take.mother.onLeave || take.father.onLeave,
      takeNet: sum(take, 'net'),
      skipNet: sum(skip, 'net'),
      takeNetExBonus: sum(take, 'netExBonus'),
      skipNetExBonus: sum(skip, 'netExBonus'),
      benefit: sum(take, 'benefit'),
      teate: sum(take, 'teate'),
      residentTax: sum(take, 'residentTax'),
    });
  }

  // ── 世帯の年ごと合算 ──
  const yearSet = new Set();
  for (const y of sims.take.mother.years) yearSet.add(y.year);
  for (const y of sims.take.father.years) yearSet.add(y.year);
  const pick = (sc, who, year) => sims[sc][who].years.find((y) => y.year === year);

  const years = [...yearSet].sort((a, b) => a - b).map((year) => {
    const per = ['mother', 'father'].map((who) => ({
      who,
      label: (who === 'mother' ? mother : father).label,
      take: pick('take', who, year),
      skip: pick('skip', who, year),
    }));
    const sum = (k, sc) => per.reduce((a, x) => a + (x[sc] ? x[sc][k] : 0), 0);
    return {
      year,
      per,
      paid: sum('paid', 'take'),
      paidSkip: sum('paid', 'skip'),
      benefit: sum('benefit', 'take'),
      teate: sum('teate', 'take'),
      incomeTax: sum('incomeTax', 'take'),
      residentTax: sum('residentTaxForNextFiscalYear', 'take'),
      shotokuwari: sum('shotokuwari', 'take'),
      shotokuwariSkip: sum('shotokuwari', 'skip'),
      // 父が育休を取ったことで新しく配偶者控除・配偶者特別控除の対象になるか
      spouseDeduction: (() => {
        const m = pick('take', 'mother', year);
        const f = pick('take', 'father', year);
        const mS = pick('skip', 'mother', year);
        const fS = pick('skip', 'father', year);
        if (!m || !f) return [];
        const out = [];
        const st = spouseDeductionStatus(rules, m.totalIncome, f.totalIncome);
        const stSkip = mS && fS
          ? spouseDeductionStatus(rules, mS.totalIncome, fS.totalIncome)
          : { kind: 'none' };
        if (st.kind !== 'none') {
          out.push({
            target: mother.label, holder: father.label, kind: st.kind,
            newlyEligible: stSkip.kind === 'none',
          });
        }
        return out;
      })(),
    };
  });

  // ── 入金と申請 ──
  const payments = {
    mother: paymentSchedule(rules, {
      leaveStart: takeSchedule.mother.leaveStart,
      leaveEnd: takeSchedule.mother.leaveEnd,
      monthlySalary: mother.monthlySalary,
      shusseigoDays: shusseigo.take.mother,
    }),
    father: paymentSchedule(rules, {
      leaveStart: takeSchedule.father.leaveStart,
      leaveEnd: takeSchedule.father.leaveEnd,
      monthlySalary: father.monthlySalary,
      shusseigoDays: shusseigo.take.father,
    }),
  };

  const applications = {
    mother: applicationSchedule(rules, { role: 'mother', periods: motherPeriods }),
    father: applicationSchedule(rules, { role: 'father', periods: fatherPeriods }),
    household: householdApplications(),
  };

  // ── 保育 ──
  const defaultCareStart = motherReturnAbs;
  const careStartAbs = config.careStartAbs ?? defaultCareStart;
  const careEndAbs = Math.min(startAbs + totalMonths - 1, careStartAbs + 35);

  const childcare = childcareBasis(
    rules,
    [
      { label: mother.label, years: sims.take.mother.years },
      { label: father.label, years: sims.take.father.years },
    ],
    careStartAbs, careEndAbs
  );
  const childcareSkip = childcareBasis(
    rules,
    [
      { label: mother.label, years: sims.skip.mother.years },
      { label: father.label, years: sims.skip.father.years },
    ],
    careStartAbs, careEndAbs
  );

  // ── 父の育休中、世帯の手取りはどう見えるか ──
  //
  // このツールが一番先に出すべきところ。
  // 父の育休は出生日から始まり、その間母は産後休業中なので、
  // 「二人とも家にいる間」の世帯の手取りがここで分かる。
  const fatherLeaveAbsList = [];
  for (let abs = absOfDate(takeSchedule.father.leaveStart);
       abs <= absOfDate(takeSchedule.father.leaveEnd); abs++) {
    fatherLeaveAbsList.push(abs);
  }
  const beforeAbs = startAbs - 1;
  const normalNet = normalMonthlyNet(rules, mother) + normalMonthlyNet(rules, father);

  const duringMonths = months.filter((m) => fatherLeaveAbsList.includes(m.abs));
  const snapshot = {
    beforeAbs,
    normalNet,
    duringTake: duringMonths.length
      ? Math.round(duringMonths.reduce((a, m) => a + m.takeNetExBonus, 0) / duringMonths.length)
      : null,
    duringSkip: duringMonths.length
      ? Math.round(duringMonths.reduce((a, m) => a + m.skipNetExBonus, 0) / duringMonths.length)
      : null,
    fatherLeaveMonths: leaveMonths,
    fatherLeaveDays: takeSchedule.fatherLeaveDays,
  };

  const takeTotal = months.reduce((a, m) => a + m.takeNet, 0);
  const skipTotal = months.reduce((a, m) => a + m.skipNet, 0);

  return {
    schedule: takeSchedule,
    timeline,
    shusseigo,
    people: {
      mother: { label: mother.label, input: mother, periods: motherPeriods, ...sims.take.mother },
      father: { label: father.label, input: father, periods: fatherPeriods, ...sims.take.father },
    },
    sims,
    months,
    years,
    payments,
    applications,
    childcare,
    childcareSkip,
    careStartAbs,
    defaultCareStartAbs: defaultCareStart,
    snapshot,
    summary: {
      takeTotal,
      skipTotal,
      diff: takeTotal - skipTotal,
      monthsShown: totalMonths,
      fatherLeaveMonths: leaveMonths,
    },
  };
}
