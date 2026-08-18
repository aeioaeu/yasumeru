// 育休を取る場合と取らない場合を、育休開始から復職後2年まで並べて計算する。
//
// このファイルには制度の数値を書かない。すべて rules-2026.js から受け取る。
//
// 前提として置いていること（画面にも明記する）:
//   ・育休は月の初日に始まり、支給単位期間は暦月と一致するものとして扱う
//   ・育休中は給与も賞与も支払われないものとして扱う
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
    // 育休中の免除の対象になるのはこちら（健康保険・介護保険・厚生年金）
    exemptable: yen(health + care + pension),
    // 雇用保険料は賃金にかかるので、賞与が支払われれば育休中でも負担がある
    employment: yen(employment),
    total: yen(health + care + pension + employment),
  };
}

export function shahoBonus(rules, bonusAmount, isOver40) {
  return shahoBonusParts(rules, bonusAmount, isOver40).total;
}

/**
 * 育休中に支払われた賞与の社会保険料が免除されるか。
 *
 * 日本年金機構の要件は「賞与を支払った月の末日を含んだ連続した1か月を超える
 * 育児休業等を取得した場合」。1か月を超えるかは暦日で判断する。
 *
 * このツールは育休が月初に始まり暦月と一致する前提なので、
 * 賞与月が育休期間に入っていて、かつ育休が2か月以上なら免除と判定する。
 * （ちょうど1か月の育休は「超える」に当たらないので免除されない）
 */
export function bonusShahoExempt(rules, { bonusInLeave, leaveMonths }) {
  if (!bonusInLeave) return false;
  return leaveMonths > rules.shaho.bonusExemptionMinLeaveMonths;
}

// ── 育児休業給付金 ────────────────────────────

// 休業開始時賃金日額 = 休業開始前6か月の賃金合計 ÷ 180
// 賞与は算定の基礎に含まれない。
export function dailyWage(rules, monthlySalary) {
  const k = rules.ikukyu;
  const raw = (monthlySalary * k.wageMonthsCount) / k.wageDaysDivisor;
  return Math.min(Math.max(raw, k.dailyWageFloor), k.dailyWageCap);
}

// unitIndex は0始まり。支給単位期間ごとの給付額。
export function ikukyuBenefit(rules, monthlySalary, unitIndex) {
  const k = rules.ikukyu;
  const d = dailyWage(rules, monthlySalary);
  const daysSoFar = (unitIndex + 1) * k.daysPerUnit;
  const rate = daysSoFar <= k.rateSwitchDay ? k.rateHigh : k.rateLow;
  return { amount: yen(d * k.daysPerUnit * rate), rate };
}

export function shusseigoBenefit(rules, monthlySalary) {
  const d = dailyWage(rules, monthlySalary);
  return yen(d * rules.shusseigo.maxDays * rules.shusseigo.rate);
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

// ── 全体のシミュレーション ─────────────────────

/**
 * @param {object} rules   rules-2026.js の RULES
 * @param {object} input
 *   monthlySalary  月給（額面）
 *   annualBonus    年間賞与の合計（額面）
 *   bonusMonths    賞与月（1-12の配列。既定は6月と12月）
 *   leaveStartYear 育休開始年
 *   leaveStartMonth 育休開始月（1-12）
 *   leaveMonths    育休の月数
 *   isOver40       40歳以上（介護保険料がかかる）
 *   withShusseigo  出生後休業支援給付金の対象か
 */
export function simulate(rules, input, timeline) {
  const {
    monthlySalary,
    annualBonus,
    bonusMonths = [6, 12],
    leaveStartYear,
    leaveStartMonth,
    leaveMonths,
    isOver40 = false,
    withShusseigo = false,
    // 育休中の賞与を、通常の何割で支給するか（0 なら出ない）。
    // 算定期間が育休と被ったときの扱いは会社ごとに大きく違う
    // （部署の平均評価にする、期間按分する、一律カットする など）。
    // 公開された制度ではないので計算せず、入力してもらう。
    bonusRateDuringLeave = 0,
  } = input;

  const bonusPerPayment = bonusMonths.length ? annualBonus / bonusMonths.length : 0;

  const leaveStartAbs = leaveStartYear * 12 + (leaveStartMonth - 1);

  // 表示する期間。既定は育休開始月から復職後24か月まで。
  // 夫婦合算では2人の期間がずれるので、共通の窓を外から渡せるようにしてある。
  const startIndex = timeline ? timeline.startAbs : leaveStartAbs;
  const totalMonths = timeline ? timeline.totalMonths : leaveMonths + 24;

  // まず両シナリオの「月ごとの額面と社会保険料」を作る
  const build = (onLeaveEnabled) => {
    const months = [];
    for (let i = 0; i < totalMonths; i++) {
      const abs = startIndex + i;
      const year = Math.floor(abs / 12);
      const month = (abs % 12) + 1;
      // 支給単位期間の番号。育休開始月を0とする。
      const unitIndex = abs - leaveStartAbs;
      const onLeave = onLeaveEnabled && unitIndex >= 0 && unitIndex < leaveMonths;

      const salary = onLeave ? 0 : monthlySalary;
      // 賞与の算定期間が育休前を含むと、育休中でも賞与が出ることがある。
      const isBonusMonth = bonusMonths.includes(month);
      const bonus = !isBonusMonth
        ? 0
        : onLeave
          ? bonusPerPayment * bonusRateDuringLeave
          : bonusPerPayment;

      // 育休中は健康保険・厚生年金が免除され、賃金がないので雇用保険料もかからない
      const shahoOnSalary = onLeave ? 0 : shahoMonthly(rules, monthlySalary, isOver40).total;

      // 賞与の社会保険料。育休中に支払われた賞与は、要件を満たせば
      // 健保・厚年が免除される。雇用保険料は賃金なのでかかったまま。
      let shahoOnBonus = 0;
      let bonusExempt = false;
      if (bonus > 0) {
        const parts = shahoBonusParts(rules, bonus, isOver40);
        bonusExempt = onLeave && bonusShahoExempt(rules, { bonusInLeave: true, leaveMonths });
        shahoOnBonus = bonusExempt ? parts.employment : parts.total;
      }
      const shaho = shahoOnSalary + shahoOnBonus;

      let benefit = 0;
      let benefitRate = null;
      if (onLeave) {
        const b = ikukyuBenefit(rules, monthlySalary, unitIndex);
        benefit = b.amount;
        benefitRate = b.rate;
        if (withShusseigo && unitIndex === 0) {
          benefit += shusseigoBenefit(rules, monthlySalary);
        }
      }

      months.push({
        year, month, abs, unitIndex, onLeave,
        salary: yen(salary),
        bonus: yen(bonus),
        gross: yen(salary + bonus),
        shaho: yen(shaho),
        shahoOnSalary: yen(shahoOnSalary),
        shahoOnBonus: yen(shahoOnBonus),
        bonusExempt,
        benefit,
        benefitRate,
      });
    }
    return months;
  };

  const scenarios = {};
  for (const key of ['leave', 'noLeave']) {
    const months = build(key === 'leave');

    // 年ごとに集計する。源泉徴収票の「支払金額」は給与＋賞与の額面合計で、
    // 非課税の育児休業給付は入らない。ここが住宅ローン・保育料・児童手当に効く。
    const byYear = new Map();
    for (const m of months) {
      if (!byYear.has(m.year)) {
        byYear.set(m.year, { year: m.year, paid: 0, shaho: 0, benefit: 0, monthsCounted: 0 });
      }
      const y = byYear.get(m.year);
      y.paid += m.gross;
      y.shaho += m.shaho;
      y.benefit += m.benefit;
      y.monthsCounted++;
    }

    // 表示範囲が年の途中で切れる年は、残りの月を通常勤務として補う。
    // そうしないと「年の一部しか見ていないせいで年収が低い」という嘘が出る。
    const fullMonthShaho = shahoMonthly(rules, monthlySalary, isOver40).total;
    for (const y of byYear.values()) {
      const missing = 12 - y.monthsCounted;
      if (missing > 0) {
        y.paid += monthlySalary * missing;
        y.shaho += fullMonthShaho * missing;
        // 賞与月が表示範囲の外にある場合の補い
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

    // 育休開始の前年は通常勤務。住民税の初年度分の基礎になる。
    const prevYear = leaveStartYear - 1;
    const normalAnnualPaid = yen(monthlySalary * 12 + annualBonus);
    const normalAnnualShaho = yen(
      fullMonthShaho * 12 + shahoBonus(rules, bonusPerPayment, isOver40) * bonusMonths.length
    );
    byYear.set(prevYear, {
      year: prevYear,
      paid: normalAnnualPaid,
      shaho: normalAnnualShaho,
      benefit: 0,
      monthsCounted: 12,
      baseline: true,
    });

    const years = [...byYear.values()].sort((a, b) => a.year - b.year);
    for (const y of years) {
      const it = incomeTaxAnnual(rules, y.paid, y.shaho);
      y.incomeTax = it.tax;
      y.taxableIncome = it.taxable;
      // 合計所得金額（給与だけの場合は給与所得）。配偶者控除の判定に使う。
      y.totalIncome = it.kyuyoShotoku;
      // その年の所得に対する住民税は、翌年6月から翌々年5月にかけて課される
      const rt = residentTaxAnnual(rules, y.paid, y.shaho);
      y.residentTaxForNextFiscalYear = rt.total;
      y.residentTaxExempt = rt.exempt;
      // 保育料の階層は均等割を含まない「所得割額」で決まるので、別に持っておく
      y.shotokuwari = rt.shotokuwari;
      // ふるさと納税の特例分の上限は、住民税所得割額の20%。
      // 寄附する年の所得で決まり、引かれるのは翌年度の住民税から。
      y.furusatoTokureiCap = Math.floor(rt.shotokuwari * rules.furusato.tokureiCapRate);
    }

    // 各月に、所得税（その年の年額の1/12）と住民税（前年所得に基づく年額の1/12）を割り付ける
    const yearMap = new Map(years.map((y) => [y.year, y]));
    for (const m of months) {
      const thisYear = yearMap.get(m.year);
      // 住民税の年度は6月始まり。6月以降はその年の前年所得、5月以前は前々年所得。
      const baseYear = m.month >= rules.juminzei.collectionStartMonth ? m.year - 1 : m.year - 2;
      const baseYearData = yearMap.get(baseYear);

      m.incomeTax = thisYear ? yen(thisYear.incomeTax / 12) : 0;
      m.residentTax = baseYearData
        ? yen(baseYearData.residentTaxForNextFiscalYear / 12)
        : yen(residentTaxAnnual(rules, normalAnnualPaid, normalAnnualShaho).total / 12);
      m.residentTaxBaseYear = baseYearData ? baseYear : null;

      // 育休中は給与の源泉徴収がないので所得税は引かれない。
      // 一方で住民税は前年所得に対するものなので、育休中でも払い続ける。
      if (m.onLeave) m.incomeTax = 0;

      m.net = yen(m.gross + m.benefit - m.shaho - m.incomeTax - m.residentTax);

      // 賞与を除いた「月々の」手取り。
      // 賞与を混ぜたまま折れ線にすると、賞与月の山が縦軸を支配してしまい、
      // 給付率が落ちる段差と住民税が下がる段差が見えなくなる。
      // 賞与は年ごとの集計と合計差額には入っている。
      m.netExBonus = yen(m.net - (m.bonus - m.shahoOnBonus));
    }

    scenarios[key] = { months, years };
  }

  // 差額
  const sumNet = (s) => s.months.reduce((a, m) => a + m.net, 0);
  const diff = sumNet(scenarios.leave) - sumNet(scenarios.noLeave);

  return {
    ...scenarios,
    summary: {
      leaveTotal: sumNet(scenarios.leave),
      noLeaveTotal: sumNet(scenarios.noLeave),
      diff,
      monthsShown: totalMonths,
    },
  };
}

// ── 暦の小道具 ────────────────────────────

export const toAbs = (year, month) => year * 12 + (month - 1);
export const fromAbs = (abs) => ({ year: Math.floor(abs / 12), month: (abs % 12) + 1 });

// ── 入金のタイミング ──────────────────────

/**
 * 給付は毎月発生するが、入金は毎月ではない。
 * 支給申請は原則2つの支給単位期間をまとめて行うので、
 * 育休に入ってから最初の入金までに空白ができる。
 *
 * ここが目安である点に注意。実際の入金日は事業主がいつ申請するかで動く。
 * ハローワークの支給決定後、約1週間で本人名義の口座に振り込まれる。
 *
 * @param months 育休を取る場合の月の配列（simulate の leave.months）
 */
export function paymentSchedule(rules, months, leaveMonths, leaveStartAbs) {
  const per = rules.shinsei.unitsPerApplication;
  const byUnit = new Map(months.filter((m) => m.onLeave).map((m) => [m.unitIndex, m]));

  const payments = [];
  for (let k = 0; k * per < leaveMonths; k++) {
    const from = k * per;
    const to = Math.min(from + per - 1, leaveMonths - 1);

    let amount = 0;
    const covers = [];
    for (let u = from; u <= to; u++) {
      const m = byUnit.get(u);
      if (!m) continue;
      amount += m.benefit;
      covers.push({ unitIndex: u, year: m.year, month: m.month, benefit: m.benefit });
    }
    if (amount <= 0) continue;

    // 対象の支給単位期間が終わった翌月に、申請・支給決定・入金が起きるものとして置く。
    // 支給決定後の振込までは約1週間なので、月単位ではこの粒度で足りる。
    const payAbs = leaveStartAbs + to + 1;
    payments.push({
      index: k,
      fromUnit: from,
      toUnit: to,
      amount: Math.floor(amount),
      payAbs,
      ...fromAbs(payAbs),
      covers,
    });
  }

  const first = payments[0] || null;
  return {
    payments,
    // 育休に入ってから最初の入金までに、給付金の入らない月がいくつあるか
    gapMonths: first ? first.payAbs - leaveStartAbs : 0,
    firstPayment: first,
    total: payments.reduce((a, p) => a + p.amount, 0),
  };
}

// ── 申請の期限 ────────────────────────────

/**
 * いつまでに何を出すか。日付は目安で、勤務先の締めや労使協定で前後する。
 */
export function applicationSchedule(rules, input) {
  const s = rules.shinsei;
  const startAbs = toAbs(input.leaveStartYear, input.leaveStartMonth);
  const startDate = new Date(Date.UTC(input.leaveStartYear, input.leaveStartMonth - 1, 1));

  const items = [];

  // 会社への申出
  const noticeDays = input.withShusseigo ? s.leaveNoticeDaysShusseiji : s.leaveNoticeDaysNormal;
  const noticeDate = new Date(startDate);
  noticeDate.setUTCDate(noticeDate.getUTCDate() - noticeDays);
  items.push({
    who: '勤務先へ',
    what: '育児休業の申出',
    deadline: noticeDate,
    note: input.withShusseigo
      ? '産後パパ育休は原則2週間前まで。労使協定で1か月前までとしている会社もある'
      : '育児休業は原則1か月前まで',
  });

  // 受給資格確認＋初回支給申請
  // 「育児休業開始日から起算して4か月を経過する日の属する月の末日」
  const fourMonths = new Date(startDate);
  fourMonths.setUTCMonth(fourMonths.getUTCMonth() + s.firstApplicationDeadlineMonths);
  fourMonths.setUTCDate(fourMonths.getUTCDate() - 1);
  const firstDeadline = new Date(Date.UTC(fourMonths.getUTCFullYear(), fourMonths.getUTCMonth() + 1, 0));
  items.push({
    who: 'ハローワークへ（原則は勤務先が提出）',
    what: '受給資格の確認と、初回の支給申請',
    deadline: firstDeadline,
    note: '初回は原則、最初と次の2つの支給単位期間をまとめて申請する',
  });

  // 社会保険料の免除
  items.push({
    who: '年金事務所へ（勤務先が提出）',
    what: '育児休業等取得者申出書',
    deadline: null,
    note: '育休期間中に出す。月末時点で育休中の月、または同月内に14日以上取得した月の保険料が免除される',
  });

  // 以降の支給申請
  const per = s.unitsPerApplication;
  if (input.leaveMonths > per) {
    items.push({
      who: 'ハローワークへ（原則は勤務先が提出）',
      what: `2回目以降の支給申請（${per}か月ごと）`,
      deadline: null,
      note: '事業所ごとに申請月が指定されている場合がある。勤務先に確認する',
    });
  }

  return { startAbs, items };
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
 * 住民税額が6月ごろに確定するため、確定を待って9月に切り替わる。
 *
 * 暦の月で言い直すと、9〜12月は前年の所得、1〜8月は前々年の所得。
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

    // その年の所得に対する所得割額を、世帯（人数ぶん）合算する
    const parts = peopleYears.map((py) => {
      const row = py.years.find((r) => r.year === basisYear);
      return { label: py.label, amount: row ? row.shotokuwari : null };
    });
    const known = parts.every((p) => p.amount != null);
    const household = known ? parts.reduce((a, p) => a + p.amount, 0) : null;

    if (!current || current.basisYear !== basisYear) {
      if (current) segments.push(current);
      current = {
        basisYear,
        fromAbs: abs,
        toAbs: abs,
        parts,
        household,
        known,
      };
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
 *
 * @param spouseIncome 控除の対象になる側（育休で所得が下がった側）の合計所得金額
 * @param selfIncome   控除を受ける側の合計所得金額
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
 *
 * 比べて優劣をつけるためではなく、「自分だけじゃない」を知るためのもの。
 * 平均との比較は返さない。
 */
export function durationBucketIndex(rules, leaveMonths) {
  const bs = rules.toukei.durationBuckets;
  for (let i = 0; i < bs.length; i++) {
    if (leaveMonths >= bs[i].from && leaveMonths < bs[i].to) return i;
  }
  return bs.length - 1;
}

/**
 * 同じ区分か、それより短い区分の人が何%いるか。
 * 「これより短く取っている人がこれだけいる」を出すために使う。
 */
export function shareUpTo(rules, sex, leaveMonths) {
  const bs = rules.toukei.durationBuckets;
  const idx = durationBucketIndex(rules, leaveMonths);
  let sum = 0;
  for (let i = 0; i <= idx; i++) sum += bs[i][sex] ?? 0;
  return Math.round(sum * 10) / 10;
}

// ── 夫婦合算 ─────────────────────────────

/**
 * 2人ぶんを共通の時間軸に載せて合算する。
 * 育休の期間はそれぞれ違ってよい。保育の開始は、既定では
 * 「遅いほうが復職した翌月」に置く（そこから保育が始まることが多いため）。
 */
export function simulateHousehold(rules, config) {
  const people = config.people.filter(Boolean);
  if (people.length === 0) throw new Error('人が1人も指定されていない');

  // 共通の窓: いちばん早い育休開始から、いちばん遅い復職の24か月後まで
  const startAbs = Math.min(
    ...people.map((p) => toAbs(p.input.leaveStartYear, p.input.leaveStartMonth))
  );
  const endAbs = Math.max(
    ...people.map((p) => toAbs(p.input.leaveStartYear, p.input.leaveStartMonth) + p.input.leaveMonths)
  );
  const totalMonths = endAbs - startAbs + 24;
  const timeline = { startAbs, totalMonths };

  const sims = people.map((p) => ({
    label: p.label,
    input: p.input,
    sim: simulate(rules, p.input, timeline),
  }));

  // 「毎月の手取りがどうなるか」を人ごとに出す。
  // 育休を考えている人がいちばん先に知りたいのはここで、
  // 給付率67%と聞くと怖いが、非課税＋社会保険料の免除があるので
  // 手取りで見ると印象がかなり変わる。
  for (const p of sims) {
    const leaveStartAbs0 = toAbs(p.input.leaveStartYear, p.input.leaveStartMonth);
    const at = (abs, scenario) =>
      p.sim[scenario].months.find((m) => m.abs === abs) || null;

    // 育休に入る直前の月（育休を取らなかった場合の同じ月でもよいが、
    // 直前の月のほうが「今の手取り」に近い）
    const before = at(leaveStartAbs0 - 1, 'noLeave') || at(leaveStartAbs0, 'noLeave');
    const first = at(leaveStartAbs0, 'leave');
    // 給付率が下がったあとの代表月（7か月目）
    const late = p.input.leaveMonths > 6 ? at(leaveStartAbs0 + 6, 'leave') : null;

    const ratio = (m) =>
      before && before.netExBonus > 0 && m
        ? Math.round((m.netExBonus / before.netExBonus) * 1000) / 10
        : null;

    p.snapshot = {
      beforeNet: before ? before.netExBonus : null,
      firstNet: first ? first.netExBonus : null,
      lateNet: late ? late.netExBonus : null,
      firstRatio: ratio(first),
      lateRatio: ratio(late),
      firstBenefit: first ? first.benefit : 0,
      lateBenefit: late ? late.benefit : 0,
    };
  }

  // 入金と申請は人ごと
  for (const p of sims) {
    const leaveStartAbs = toAbs(p.input.leaveStartYear, p.input.leaveStartMonth);
    p.leaveStartAbs = leaveStartAbs;
    p.returnAbs = leaveStartAbs + p.input.leaveMonths;
    p.payments = paymentSchedule(rules, p.sim.leave.months, p.input.leaveMonths, leaveStartAbs);
    p.applications = applicationSchedule(rules, p.input);
  }

  // 世帯の月ごと合算
  const months = [];
  for (let i = 0; i < totalMonths; i++) {
    const abs = startAbs + i;
    const { year, month } = fromAbs(abs);
    const per = sims.map((p) => ({
      label: p.label,
      leave: p.sim.leave.months[i],
      noLeave: p.sim.noLeave.months[i],
    }));
    months.push({
      abs, year, month,
      per,
      onLeave: per.some((x) => x.leave.onLeave),
      leaveNet: per.reduce((a, x) => a + x.leave.net, 0),
      noLeaveNet: per.reduce((a, x) => a + x.noLeave.net, 0),
      leaveNetExBonus: per.reduce((a, x) => a + x.leave.netExBonus, 0),
      noLeaveNetExBonus: per.reduce((a, x) => a + x.noLeave.netExBonus, 0),
      benefit: per.reduce((a, x) => a + x.leave.benefit, 0),
      residentTax: per.reduce((a, x) => a + x.leave.residentTax, 0),
    });
  }

  // 世帯の年ごと合算
  const yearSet = new Set();
  for (const p of sims) for (const y of p.sim.leave.years) yearSet.add(y.year);
  const years = [...yearSet].sort((a, b) => a - b).map((year) => {
    const per = sims.map((p) => ({
      label: p.label,
      leave: p.sim.leave.years.find((y) => y.year === year),
      noLeave: p.sim.noLeave.years.find((y) => y.year === year),
    }));
    const sum = (k, sc) => per.reduce((a, x) => a + (x[sc] ? x[sc][k] : 0), 0);
    return {
      year,
      per,
      paid: sum('paid', 'leave'),
      paidNoLeave: sum('paid', 'noLeave'),
      benefit: sum('benefit', 'leave'),
      incomeTax: sum('incomeTax', 'leave'),
      residentTax: sum('residentTaxForNextFiscalYear', 'leave'),
      shotokuwari: sum('shotokuwari', 'leave'),
      shotokuwariNoLeave: sum('shotokuwari', 'noLeave'),
      // 2人いる場合だけ、配偶者控除・配偶者特別控除の対象になるかを見る
      spouseDeduction: per.length === 2 ? (() => {
        const out = [];
        for (const [a, b] of [[0, 1], [1, 0]]) {
          if (!per[a].leave || !per[b].leave) continue;
          const st = spouseDeductionStatus(
            rules, per[a].leave.totalIncome, per[b].leave.totalIncome
          );
          const stNo = per[a].noLeave && per[b].noLeave
            ? spouseDeductionStatus(rules, per[a].noLeave.totalIncome, per[b].noLeave.totalIncome)
            : { kind: 'none' };
          // 育休を取ったことで新しく対象になったものだけ拾う
          if (st.kind !== 'none' && stNo.kind === 'none') {
            out.push({ target: per[a].label, holder: per[b].label, kind: st.kind });
          }
        }
        return out;
      })() : [],
    };
  });

  // 保育の開始。既定は「遅いほうが復職した翌月」。
  const defaultCareStart = Math.max(...sims.map((p) => p.returnAbs));
  const careStartAbs = config.careStartAbs ?? defaultCareStart;
  const careEndAbs = Math.min(startAbs + totalMonths - 1, careStartAbs + 35); // 0〜2歳の3年ぶん

  const childcare = childcareBasis(
    rules,
    sims.map((p) => ({ label: p.label, years: p.sim.leave.years })),
    careStartAbs,
    careEndAbs
  );
  const childcareNoLeave = childcareBasis(
    rules,
    sims.map((p) => ({ label: p.label, years: p.sim.noLeave.years })),
    careStartAbs,
    careEndAbs
  );

  const leaveTotal = months.reduce((a, m) => a + m.leaveNet, 0);
  const noLeaveTotal = months.reduce((a, m) => a + m.noLeaveNet, 0);

  return {
    people: sims,
    months,
    years,
    childcare,
    childcareNoLeave,
    careStartAbs,
    defaultCareStartAbs: defaultCareStart,
    timeline,
    summary: {
      leaveTotal,
      noLeaveTotal,
      diff: leaveTotal - noLeaveTotal,
      monthsShown: totalMonths,
    },
  };
}
