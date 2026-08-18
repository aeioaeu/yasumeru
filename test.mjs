// 手計算したケースと実装の出力を突き合わせる。
//
//   node test.mjs
//
// 期待値はすべて手で計算したもので、計算式を各項目のコメントに残してある。
// 数値を変えるときは、まず手計算をやり直してここのコメントを書き換え、
// そのあとで実装を直すこと。逆をやると実装の間違いが期待値に写る。

import { RULES } from './rules-2026.js';
import {
  buildSchedule,
  simulateHousehold,
  shusseigoDaysFor,
  shussanTeateDaily,
  dailyWage,
  shahoMonthly,
  shahoBonus,
  shahoBonusParts,
  bonusShahoExempt,
  monthShahoExempt,
  incomeTaxAnnual,
  residentTaxAnnual,
  spouseDeductionStatus,
  childcareBasisYear,
  durationBucketIndex,
  shareUpTo,
  daysInclusive,
  absOfDate,
  toAbs,
  fromAbs,
  parseDate,
} from './calc.js';

let pass = 0;
let fail = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ok   ${label}: ${fmt(actual)}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}: 実装=${fmt(actual)} / 手計算=${fmt(expected)}`);
  }
}

const fmt = (v) => (typeof v === 'number' ? v.toLocaleString() : String(v));
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// ══════════════════════════════════════════════════
// リファレンスケース
//   出産予定日 2026年10月15日
//   母 月給 400,000円 / 賞与 年 1,200,000円（6月・12月に各600,000円）
//   父 月給 500,000円 / 賞与 年 1,500,000円（6月・12月に各750,000円）
//   父の育休 1か月（既定）。40歳未満（介護保険料なし）
//
//   母は制度の上限まで取る（産休 → 育休を子が1歳に達する日の前日まで）。
//   動かすのは父の月数だけ。
// ══════════════════════════════════════════════════

const BIRTH = '2026-10-15';
const MOTHER = {
  label: '母', monthlySalary: 400000, annualBonus: 1200000,
  bonusMonths: [6, 12], isOver40: false,
};
const FATHER = {
  label: '父', monthlySalary: 500000, annualBonus: 1500000,
  bonusMonths: [6, 12], isOver40: false, leaveMonths: 1,
};

const house = (fatherLeaveMonths = 1) =>
  simulateHousehold(RULES, {
    birthDate: BIRTH,
    mother: MOTHER,
    father: { ...FATHER, leaveMonths: fatherLeaveMonths },
  });

console.log('\n── 日程 ──');

const sch = buildSchedule(RULES, { birthDate: BIRTH, fatherLeaveMonths: 1 });

// 産前休業は出産の日以前42日。出産日を含めて42日なので開始は 10/15 の41日前 = 9/4。
eq('産前休業の開始', iso(sch.sankyu.start), '2026-09-04');
// 産後休業は出産の翌日以後56日。10/15 + 56日 = 12/10。
eq('産後休業の終了', iso(sch.sankyu.end), '2026-12-10');
// 産休の日数 = 42 + 56 = 98
eq('産休の日数', sch.sankyuDays, 98);

// 母の育児休業開始日は「出生日から起算して58日目」= 10/15 を1日目として58日目 = 12/11。
// これは産後休業（10/16〜12/10）の翌日にあたる。
eq('母の育休の開始', iso(sch.mother.leaveStart), '2026-12-11');
// 育児休業は「子が1歳に達する日（＝1歳の誕生日の前日 10/14）の前日」= 2027/10/13 まで。
eq('母の育休の終了', iso(sch.mother.leaveEnd), '2027-10-13');
// 2026/12/11 〜 2027/10/13 の日数
//   12月 21日 + 1月31 + 2月28 + 3月31 + 4月30 + 5月31 + 6月30 + 7月31 + 8月31 + 9月30 + 10月13
//   = 21+31+28+31+30+31+30+31+31+30+13 = 307
eq('母の育休の日数', sch.motherLeaveDays, 307);

// 母の上限は「出産日（産前休業の末日）＋産後休業＋育児休業で1年」。
//   出産日1日 + 産後休業56日 + 育休307日 = 364日 ≦ 365日
eq('母の合計が1年に収まる', 1 + 56 + sch.motherLeaveDays <= RULES.ikukyu.maxTotalDaysPerParent ? 1 : 0, 1);

// 父は出生日から1か月。10/15 の翌月応当日 11/15 の前日 = 11/14。10/15〜11/14 は31日。
eq('父の育休の開始', iso(sch.father.leaveStart), '2026-10-15');
eq('父の育休の終了', iso(sch.father.leaveEnd), '2026-11-14');
eq('父の育休の日数', sch.fatherLeaveDays, 31);

console.log('\n── 出生後休業支援給付金の父母連動 ──');

// 父の対象期間は「出生日〜8週間を経過する日の翌日」= 10/15 〜 12/10。
// 父の育休 10/15〜11/14（31日）はこの中に収まるので、上限の28日が支給対象。
// 配偶者（母）は子の出生日の翌日に産後休業中なので、配偶者要件は自動的に満たされる。
eq('父の出生後休業支援の日数', shusseigoDaysFor(RULES, 'father', sch), 28);

// 母の対象期間は「出生日〜16週間を経過する日の翌日」= 10/15 〜 2027/2/4。
// 母の育休は 12/11 から始まるので 12/11〜2/4 の56日が期間内。上限28日。
// 配偶者（父）が8週以内に14日以上取っているので配偶者要件を満たす。
eq('母の出生後休業支援の日数', shusseigoDaysFor(RULES, 'mother', sch), 28);

// 【ここがこのツールの要】父が取らないと、母の13%も出ない。
const schNoFather = buildSchedule(RULES, { birthDate: BIRTH, fatherLeaveMonths: 0 });
eq('父が取らないときの母の日数', shusseigoDaysFor(RULES, 'mother', schNoFather), 0);

console.log('\n── 出産手当金 ──');

// 1日あたり = 標準報酬月額の平均 ÷30（10円未満四捨五入）× 2/3（1円未満四捨五入）
//   400,000 ÷ 30 = 13,333.33… → 10円未満四捨五入 → 13,330
//   13,330 × 2/3 = 8,886.67 → 1円未満四捨五入 → 8,887
eq('出産手当金の日額（母）', shussanTeateDaily(RULES, 400000), 8887);

const h = house(1);
const at = (y, m) => h.months.find((x) => x.year === y && x.month === m);

// 9月は 9/4〜9/30 の27日が産休。27 × 8,887 = 239,949
eq('2026年9月の出産手当金', at(2026, 9).take.mother.teate, 239949);
// 10月は丸ごと産休。31 × 8,887 = 275,497
eq('2026年10月の出産手当金', at(2026, 10).take.mother.teate, 275497);
// 12月は 12/1〜12/10 の10日。10 × 8,887 = 88,870
eq('2026年12月の出産手当金', at(2026, 12).take.mother.teate, 88870);
// 産休98日ぶんの合計 = 98 × 8,887 = 870,926
const teateTotal = h.months.reduce((a, m) => a + m.take.mother.teate, 0);
eq('出産手当金の合計', teateTotal, 870926);

console.log('\n── 休業開始時賃金日額 ──');

// 母: 400,000 × 6 ÷ 180 = 13,333.33…（上限16,540・下限3,203の範囲内）
eq('母の賃金日額（切り捨て前）', Math.floor(dailyWage(RULES, 400000)), 13333);
// 父: 500,000 × 6 ÷ 180 = 16,666.67 → 上限16,540でクランプ
eq('父の賃金日額', dailyWage(RULES, 500000), 16540);
// 公式パンフレットの支給上限額との突合: 16,540 × 30 × 67% = 332,454
eq('30日・67%の支給上限額', Math.floor(16540 * 30 * 0.67), RULES.ikukyu.refCap30High);

console.log('\n── 育児休業給付金（母） ──');

// 母の育休は 12/11 から。12月は21日ぶん。通算180日以内なので67%。
//   給付   21 × 13,333.33… × 67% = 187,600
//   13%分  21 × 13,333.33… × 13% =  36,400（28日の上限内）
//   合計 224,000
eq('2026年12月の母の給付', at(2026, 12).take.mother.benefit, 224000);
// 1月は31日。うち出生後休業支援の残りは 28 − 21 = 7日。
//   給付   31 × 13,333.33… × 67% = 276,933
//   13%分   7 × 13,333.33… × 13% =  12,133
//   合計 289,066
eq('2027年1月の母の給付', at(2027, 1).take.mother.benefit, 289066);
// 2月は28日、13%分は終わっている。28 × 13,333.33… × 67% = 250,133
eq('2027年2月の母の給付', at(2027, 2).take.mother.benefit, 250133);

// 給付率の切替。母の育休開始 12/11 から通算180日目は 2027/6/8。
//   12月21 + 1月31 + 2月28 + 3月31 + 4月30 + 5月31 = 172日（5月末まで）
//   6月8日で180日に達し、6月9日から50%になる。
//   6月 = 8日×67% + 22日×50%
//       = 8 × 13,333.33… × 0.67 +  22 × 13,333.33… × 0.50
//       = 71,466.66… + 146,666.66… = 218,133.33… → 218,133
//   （率ごとに丸めず、その月の育児休業給付金を合計してから円未満を切り捨てる）
eq('2027年6月の母の給付（率の切替月）', at(2027, 6).take.mother.benefit, 218133);
// 7月は全部50%。31 × 13,333.33… × 50% = 206,666
eq('2027年7月の母の給付', at(2027, 7).take.mother.benefit, 206666);

console.log('\n── 育児休業給付金（父・1か月） ──');

// 父の育休は 10/15〜11/14。賃金日額は上限の16,540。
// 10月は 10/15〜10/31 の17日。
//   給付  17 × 16,540 × 67% = 188,391（16,540×0.67=11,081.8 → 17日で188,390.6）
//   13%分 17 × 16,540 × 13% =  36,553
//   合計 224,944 … 実装は月内で合算してから切り捨てるので 224,943
eq('2026年10月の父の給付', at(2026, 10).take.father.benefit, 224943);
// 11月は 11/1〜11/14 の14日。13%分の残りは 28 − 17 = 11日。
//   給付  14 × 16,540 × 67% = 155,145
//   13%分 11 × 16,540 × 13% =  23,652
//   合計 178,797
eq('2026年11月の父の給付', at(2026, 11).take.father.benefit, 178797);

// 父の給付の総額（1か月 = 31日、うち28日に13%が乗る）。
// 育児休業給付金と出生後休業支援給付金は別々の給付金なので、
// それぞれ暦月ごとに円未満を切り捨ててから足す。
//   10月 188,390（17日×67%）+ 36,553（17日×13%）= 224,943
//   11月 155,145（14日×67%）+ 23,652（11日×13%）= 178,797
//                                          合計 = 403,740
const fatherBenefit = h.months.reduce((a, m) => a + m.take.father.benefit, 0);
eq('父の給付の総額', fatherBenefit, 403740);

console.log('\n── 社会保険料の免除 ──');

const motherPeriods = h.people.mother.periods;
const fatherPeriods = h.people.father.periods;

// 産休は「産休開始月から終了日の翌日が属する月の前月まで」。
// 産休 9/4〜12/10 なら、終了日の翌日 12/11 の属する月は12月、その前月は11月。
// つまり9・10・11月が免除。これは「月末時点で産休中の月」と同じ。
eq('母 2026年9月は免除', monthShahoExempt(RULES, toAbs(2026, 9), motherPeriods) ? 1 : 0, 1);
eq('母 2026年11月は免除', monthShahoExempt(RULES, toAbs(2026, 11), motherPeriods) ? 1 : 0, 1);
// 12月は12/10で産休が終わるが、12/11から育休に入るので月末時点で育休中 → 免除
eq('母 2026年12月は免除', monthShahoExempt(RULES, toAbs(2026, 12), motherPeriods) ? 1 : 0, 1);
// 産休に入る前の8月は通常勤務
eq('母 2026年8月は免除でない', monthShahoExempt(RULES, toAbs(2026, 8), motherPeriods) ? 1 : 0, 0);
// 育休が10/13に終わる2027年10月は、月末時点で育休中でない。
// 14日ルールは育休の開始月にしか使えないので、免除されない。
eq('母 2027年10月は免除でない', monthShahoExempt(RULES, toAbs(2027, 10), motherPeriods) ? 1 : 0, 0);

// 父の育休 10/15〜11/14。10月末は育休中なので免除。
eq('父 2026年10月は免除', monthShahoExempt(RULES, toAbs(2026, 10), fatherPeriods) ? 1 : 0, 1);
// 11月末（11/30）は育休が終わっている。14日ルールは開始月だけなので免除されない。
eq('父 2026年11月は免除でない', monthShahoExempt(RULES, toAbs(2026, 11), fatherPeriods) ? 1 : 0, 0);

// 免除される月の本人負担（月給50万・40歳未満）
//   健保 500,000 × 4.95% = 24,750
//   厚年 500,000 × 9.15% = 45,750
//                    計 = 70,500
eq('父の免除される額（月）', shahoMonthly(RULES, 500000, false).exemptable, 70500);
// 雇用保険料は賃金にかかるので、日割りの給与に対してはかかる。
// 10月の給与 = 500,000 × 14/31 = 225,806 → 雇用保険料 225,806 × 0.5% = 1,129
eq('父 2026年10月の給与', at(2026, 10).take.father.salary, 225806);
eq('父 2026年10月の社会保険料', at(2026, 10).take.father.shaho, 1129);

console.log('\n── 賞与の社会保険料の免除 ──');

// 要件は「賞与を支払った月の末日を含んだ連続した1か月を超える育児休業等」。
// 父が1か月（10/15〜11/14）だと12月の賞与月には育休がかかっていないので対象外。
eq('父1か月・12月賞与は免除でない',
  bonusShahoExempt(RULES, toAbs(2026, 12), fatherPeriods) ? 1 : 0, 0);

// 父が3か月（10/15〜2027/1/14）なら12月末を含み、開始日の翌月応当日(11/15)を越えて
// 続いているので「1か月を超える」を満たす。
const h3 = house(3);
eq('父3か月・12月賞与は免除',
  bonusShahoExempt(RULES, toAbs(2026, 12), h3.people.father.periods) ? 1 : 0, 1);

// 父が2か月（10/15〜12/14）だと12月の末日を含まないので対象外。
const h2 = house(2);
eq('父2か月・12月賞与は免除でない',
  bonusShahoExempt(RULES, toAbs(2026, 12), h2.people.father.periods) ? 1 : 0, 0);

// 母は12月末に育休中で、育休は1か月を大きく超えるので12月の賞与は免除。
eq('母・12月賞与は免除',
  bonusShahoExempt(RULES, toAbs(2026, 12), motherPeriods) ? 1 : 0, 1);

// 賞与の社会保険料（父・賞与750,000・40歳未満）
//   健保 750,000 × 4.95% = 37,125
//   厚年 750,000 × 9.15% = 68,625
//   雇用 750,000 × 0.5%  =  3,750
//                   合計 = 109,500
const bp = shahoBonusParts(RULES, 750000, false);
eq('父の賞与の社会保険料（合計）', bp.total, 109500);
eq('父の賞与のうち免除される分', bp.exemptable, 105750);

console.log('\n── 書類に載る年収（非課税の給付は入らない） ──');

// 母の育休は 2027/10/13 に終わるので、10月は 10/14〜10/31 の18日が勤務。
//   10月 400,000 × 18/31 = 232,258.06… → 232,258
//   11月 400,000（まるまる勤務）
//   12月 400,000 ＋ 賞与 600,000（6月の賞与は育休中なので0）
//                              → 支払金額 1,632,258
// 育児休業給付も出産手当金も非課税なので、ここには1円も入らない。
const motherY2027 = h.people.mother.years.find((y) => y.year === 2027);
eq('母の2027年の支払金額', motherY2027.paid, 1632258);
// 同じ年に受け取った給付（非課税）
const motherBenefit2027 = h.months
  .filter((m) => m.year === 2027)
  .reduce((a, m) => a + m.take.mother.benefit, 0);
eq('母の2027年の給付（支払金額に入らない）', motherBenefit2027 > 2000000 ? 1 : 0, 1);

console.log('\n── 父が取ることで世帯はどう動くか ──');

// 父が1か月取ると、母の13%（28日 × 13,333.33… × 13% = 48,533）が新たに発生する。
const hSkipMotherShusseigo = h.shusseigo.skip.mother;
eq('父が取らないシナリオの母の13%日数', hSkipMotherShusseigo, 0);
eq('父が取るシナリオの母の13%日数', h.shusseigo.take.mother, 28);

// 差額の向き。父が1か月取ると世帯の手取りは増える。
// 給付が非課税で社会保険料も免除されるうえ、母の13%が上乗せされるため。
eq('父1か月の差額はプラス', h.summary.diff > 0 ? 1 : 0, 1);

// 父が長く取るほど、差額は縮んでいく（67%→50%になり、13%は28日で終わるため）。
const h6 = house(6);
eq('父6か月の差額は1か月より小さい', h6.summary.diff < h.summary.diff ? 1 : 0, 1);

// 父の月数は制度の上限（1歳まで＝12か月）でクランプされる。
const h99 = simulateHousehold(RULES, {
  birthDate: BIRTH, mother: MOTHER, father: { ...FATHER, leaveMonths: 99 },
});
eq('父の月数は12でクランプ', h99.summary.fatherLeaveMonths, 12);

console.log('\n── 所得税・住民税（1年ぶんの通常勤務で検算） ──');

// 母の通常年: 支払金額 = 400,000×12 + 1,200,000 = 6,000,000
//   社会保険料 = (19,800+36,600+2,000)×12 + (29,700+54,900+3,000)×2
//              = 58,400×12 + 87,600×2 = 700,800 + 175,200 = 876,000
eq('母の通常月の社会保険料', shahoMonthly(RULES, 400000, false).total, 58400);
eq('母の通常賞与の社会保険料', shahoBonus(RULES, 600000, false), 87600);

// 給与所得控除 = 6,000,000×20% + 440,000 = 1,640,000
// 給与所得     = 6,000,000 − 1,640,000 = 4,360,000
// 基礎控除     = 4,360,000 は336万超489万以下 → 880,000
// 課税所得     = 4,360,000 − 876,000 − 880,000 = 2,604,000
// 所得税       = 2,604,000×10% − 97,500 = 162,900
// 復興込み     = 162,900 × 1.021 = 166,320.9 → 166,320
const itMother = incomeTaxAnnual(RULES, 6000000, 876000);
eq('母の通常年の所得税', itMother.tax, 166320);

// 住民税の課税所得 = 4,360,000 − 876,000 − 430,000 = 3,054,000
// 所得割           = 305,400
// 調整控除         = 課税所得が200万超 → (50,000−(3,054,000−2,000,000))×5% は負 → 下限2,500
// 所得割（調整後） = 305,400 − 2,500 = 302,900
// 住民税           = 302,900 + 均等割5,000 = 307,900
const rtMother = residentTaxAnnual(RULES, 6000000, 876000);
eq('母の通常年の住民税', rtMother.total, 307900);
eq('母の通常年の所得割額', rtMother.shotokuwari, 302900);
// ふるさと納税の特例分の上限 = 302,900 × 20% = 60,580
eq('母の通常年のふるさと納税の上限', Math.floor(302900 * RULES.furusato.tokureiCapRate), 60580);

console.log('\n── 保育料の基準年 ──');

// 9〜3月は前年の所得、4〜8月は前々年の所得。
eq('2028年9月の基準年', childcareBasisYear(RULES, 2028, 9), 2027);
eq('2028年8月の基準年', childcareBasisYear(RULES, 2028, 8), 2026);
eq('2028年3月の基準年', childcareBasisYear(RULES, 2028, 3), 2026);

console.log('\n── 配偶者控除の判定 ──');

// 母の2027年の合計所得金額は、支払金額1,632,258 に対して
//   給与所得控除は190万円以下なので740,000（最低保障額）
//   給与所得 = 1,632,258 − 740,000 = 892,258
// 892,258 は 620,000 超 1,330,000 以下 → 配偶者特別控除の対象
eq('母の2027年の合計所得金額', motherY2027.totalIncome, 892258);
eq('母は配偶者特別控除の対象',
  spouseDeductionStatus(RULES, 892258, 7500000).kind, 'tokubetsu');
// 控除を受ける側の合計所得金額が1,000万円を超えると対象外
eq('高所得の配偶者は対象外',
  spouseDeductionStatus(RULES, 892258, 12000000).kind, 'none');
// 合計所得金額が62万円以下なら配偶者控除（こちらは母がまるまる1年休んだ年に効く）
eq('所得が62万以下なら配偶者控除',
  spouseDeductionStatus(RULES, 500000, 7500000).kind, 'kojo');

console.log('\n── 入金までの空白 ──');

// 支給申請は原則2つの支給単位期間をまとめて行う。
// 母の育休は12/11開始なので、支給単位期間は 12/11〜1/10、1/11〜2/10。
// 2つめが終わる2月の翌月＝3月に最初の入金が来る。育休開始月(12月)からは3か月あく。
eq('母の最初の入金月', `${h.payments.mother.firstPayment.year}/${h.payments.mother.firstPayment.month}`, '2027/3');
eq('母の入金までの空白（か月）', h.payments.mother.gapMonths, 3);

// 母の産休開始（9月）から数えると、給付の入金がないまま6か月続く。
// 出産手当金も産後にまとめて申請するのが一般的なので、ここが家計にいちばん効く。
eq('産休開始から最初の育休給付の入金まで',
  h.payments.mother.firstPayment.payAbs - absOfDate(sch.sankyu.start), 6);

console.log('\n── 統計の区分 ──');

// 父が1か月なら「1か月以上3か月未満」の区分に入る
const bi = durationBucketIndex(RULES, 1);
eq('1か月の区分に男性の割合がある', RULES.toukei.durationBuckets[bi].male > 0 ? 1 : 0, 1);
// 同じ区分か、それより短い区分の人の割合は0〜100の範囲
const share = shareUpTo(RULES, 'male', 1);
eq('割合が0〜100に入る', share >= 0 && share <= 100 ? 1 : 0, 1);

// 分布の合計。四捨五入があるので 99.5〜100.5 に入っていればよい。
const sumF = RULES.toukei.durationBuckets.reduce((a, b) => a + b.female, 0);
const sumM = RULES.toukei.durationBuckets.reduce((a, b) => a + b.male, 0);
eq('女性の分布の合計が100前後', Math.abs(sumF - 100) <= 0.7 ? 1 : 0, 1);
eq('男性の分布の合計が100前後', Math.abs(sumM - 100) <= 0.7 ? 1 : 0, 1);

console.log('\n── 境界のケース ──');

// 出産予定日が月末のとき、母の育休開始日がどこに来るか。
// 10/31 + 57日 = 12/27
const schEnd = buildSchedule(RULES, { birthDate: '2026-10-31', fatherLeaveMonths: 1 });
eq('月末出産のときの母の育休開始', iso(schEnd.mother.leaveStart), '2026-12-27');
// 父の育休 10/31 の翌月応当日は11/30（11月に31日がないため）。その前日 = 11/29。
eq('月末出産のときの父の育休終了', iso(schEnd.father.leaveEnd), '2026-11-29');

// うるう年をまたぐケース。2028年はうるう年。
const schLeap = buildSchedule(RULES, { birthDate: '2027-10-15', fatherLeaveMonths: 1 });
// 2027/10/15 + 57日 = 2027/12/11、1歳誕生日 2028/10/15、育休終了 2028/10/13
eq('うるう年をまたぐ母の育休終了', iso(schLeap.mother.leaveEnd), '2028-10-13');
// 2027/12/11 〜 2028/10/13 は、2月が29日なので1日長い
eq('うるう年をまたぐ母の育休日数', schLeap.motherLeaveDays, 308);

// 賃金日額の下限に張り付くケース。月給10万円。
//   100,000 × 6 ÷ 180 = 3,333.33 → 下限3,203より上なのでそのまま
eq('月給10万の賃金日額', Math.floor(dailyWage(RULES, 100000)), 3333);
// 月給9万円なら 90,000×6÷180 = 3,000 → 下限3,203でクランプ
eq('月給9万の賃金日額（下限）', dailyWage(RULES, 90000), 3203);

console.log('\n──────────────────────────────');
console.log(`  ${pass} 件一致 / ${fail} 件くいちがい`);
console.log('──────────────────────────────\n');

if (fail > 0) process.exit(1);
