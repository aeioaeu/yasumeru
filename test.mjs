// 手計算した1ケースと実装の出力を突き合わせる。
//
//   node test.mjs
//
// 期待値はすべて手で計算したもので、計算式を各項目のコメントに残してある。
// 数値を変えるときは、まず手計算をやり直してここのコメントを書き換え、
// そのあとで実装を直すこと。逆をやると実装の間違いが期待値に写る。

import { RULES } from './rules-2026.js';
import {
  simulate,
  simulateHousehold,
  spouseDeductionStatus,
  durationBucketIndex,
  shareUpTo,
  shahoBonusParts,
  bonusShahoExempt,
  childcareBasisYear,
  fromAbs,
  shahoMonthly,
  shahoBonus,
  dailyWage,
  ikukyuBenefit,
  incomeTaxAnnual,
  residentTaxAnnual,
} from './calc.js';

let pass = 0;
let fail = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ok   ${label}: ${actual.toLocaleString()}`);
  } else {
    fail++;
    console.log(
      `  FAIL ${label}: 実装=${actual.toLocaleString()} / 手計算=${expected.toLocaleString()}`
    );
  }
}

// ══════════════════════════════════════════════════
// リファレンスケース
//   月給 400,000円（額面）
//   賞与 年 1,200,000円（6月・12月に各600,000円）
//   育休 2026年10月から12か月（2027年9月まで）
//   40歳未満（介護保険料なし）
//   出生後休業支援給付金は対象外
// ══════════════════════════════════════════════════

const SALARY = 400000;
const BONUS_YEAR = 1200000;
const BONUS_EACH = 600000;

console.log('\n── 社会保険料（本人負担） ──');

// 健保 400,000 × 4.95% = 19,800
// 厚年 400,000 × 9.15% = 36,600
// 雇用 400,000 × 0.5%  =  2,000
//                 合計 = 58,400
eq('月額の社会保険料', shahoMonthly(RULES, SALARY, false).total, 58400);

// 健保 600,000 × 4.95% = 29,700
// 厚年 600,000 × 9.15% = 54,900
// 雇用 600,000 × 0.5%  =  3,000
//                 合計 = 87,600
eq('賞与の社会保険料', shahoBonus(RULES, BONUS_EACH, false), 87600);

console.log('\n── 育児休業給付金 ──');

// 休業開始時賃金日額 = 400,000 × 6 ÷ 180 = 13,333.33…
// 上限16,540・下限3,203の範囲内なのでそのまま
eq('休業開始時賃金日額（円未満切捨て）', Math.floor(dailyWage(RULES, SALARY)), 13333);

// 1〜6か月目（通算180日まで）: 13,333.33… × 30 × 67% = 400,000 × 0.67 = 268,000
eq('1か月目の給付額（67%）', ikukyuBenefit(RULES, SALARY, 0).amount, 268000);
eq('6か月目の給付額（67%）', ikukyuBenefit(RULES, SALARY, 5).amount, 268000);

// 7か月目以降（通算180日超）: 400,000 × 0.50 = 200,000
eq('7か月目の給付額（50%）', ikukyuBenefit(RULES, SALARY, 6).amount, 200000);

// 公式パンフレットに載っている上限額との突合
// 16,540 × 30 × 67% = 332,454 / 16,540 × 30 × 50% = 248,100
eq('上限月給での67%上限', ikukyuBenefit(RULES, 10000000, 0).amount, RULES.ikukyu.refCap30High);
eq('上限月給での50%上限', ikukyuBenefit(RULES, 10000000, 6).amount, RULES.ikukyu.refCap30Low);

console.log('\n── 通常の年（年収600万円） ──');

// 支払金額 = 400,000×12 + 1,200,000 = 6,000,000
// 社会保険料 = 58,400×12 + 87,600×2 = 700,800 + 175,200 = 876,000
const NORMAL_PAID = 6000000;
const NORMAL_SHAHO = 876000;

// 給与所得控除 = 6,000,000×20% + 440,000 = 1,640,000
// 給与所得     = 6,000,000 − 1,640,000 = 4,360,000
// 基礎控除     = 4,360,000 は 336万超489万以下 → 880,000
// 課税所得     = 4,360,000 − 876,000 − 880,000 = 2,604,000
// 所得税       = 2,604,000×10% − 97,500 = 162,900
// 復興込み     = 162,900 × 1.021 = 166,320.9 → 166,320
eq('所得税（通常年）', incomeTaxAnnual(RULES, NORMAL_PAID, NORMAL_SHAHO).tax, 166320);

// 住民税の課税所得 = 4,360,000 − 876,000 − 430,000 = 3,054,000
// 所得割           = 305,400
// 調整控除         = 課税所得が200万超 → (50,000 −(3,054,000−2,000,000))×5% は負 → 下限2,500
// 所得割（調整後） = 305,400 − 2,500 = 302,900
// 住民税           = 302,900 + 均等割5,000 = 307,900
eq('住民税（通常年の所得に対する年額）', residentTaxAnnual(RULES, NORMAL_PAID, NORMAL_SHAHO).total, 307900);

console.log('\n── 育休に入った年（2026年：1〜9月勤務、10〜12月育休） ──');

// 給与 400,000×9 = 3,600,000
// 賞与 6月分のみ  =   600,000（12月は育休中で不支給）
// 支払金額        = 4,200,000  ← 給付金は非課税なのでここに入らない
// 社会保険料      = 58,400×9 + 87,600 = 613,200
const Y2026_PAID = 4200000;
const Y2026_SHAHO = 613200;

// 給与所得控除 = 4,200,000×20% + 440,000 = 1,280,000
// 給与所得     = 2,920,000
// 基礎控除     = 2,920,000 は 132万超336万以下 → 1,040,000
// 課税所得     = 2,920,000 − 613,200 − 1,040,000 = 1,266,800 → 1,266,000
// 所得税       = 1,266,000 × 5% = 63,300
// 復興込み     = 63,300 × 1.021 = 64,629.3 → 64,629
eq('所得税（育休に入った年）', incomeTaxAnnual(RULES, Y2026_PAID, Y2026_SHAHO).tax, 64629);

// 住民税の課税所得 = 2,920,000 − 613,200 − 430,000 = 1,876,800 → 1,876,000
// 所得割           = 187,600
// 調整控除         = 200万以下 → min(50,000, 1,876,000)×5% = 2,500
// 所得割（調整後） = 185,100
// 住民税           = 185,100 + 5,000 = 190,100  ← 2027年6月から効く
eq('住民税（育休に入った年の所得に対する年額）', residentTaxAnnual(RULES, Y2026_PAID, Y2026_SHAHO).total, 190100);

console.log('\n── 育休がまるまる乗った年（2027年：1〜9月育休、10月復職） ──');

// 給与 400,000×3 = 1,200,000
// 賞与 12月分のみ =   600,000
// 支払金額        = 1,800,000
// 社会保険料      = 58,400×3 + 87,600 = 262,800
const Y2027_PAID = 1800000;
const Y2027_SHAHO = 262800;

// 給与所得控除 = 1,800,000 ≤ 1,900,000 なので最低保障額 740,000
// 給与所得     = 1,060,000
// 基礎控除     = 1,060,000 ≤ 1,320,000 → 990,000
// 課税所得     = 1,060,000 − 262,800 − 990,000 = 負 → 0
// 所得税       = 0
eq('所得税（育休がまるまる乗った年）', incomeTaxAnnual(RULES, Y2027_PAID, Y2027_SHAHO).tax, 0);

// 住民税の給与所得控除は最低保障額が69万円（所得税の74万円と違う）
// 給与所得     = 1,800,000 − 690,000 = 1,110,000
// 課税所得     = 1,110,000 − 262,800 − 430,000 = 417,200 → 417,000
// 所得割       = 41,700 − 調整控除2,500 = 39,200
// 住民税       = 39,200 + 5,000 = 44,200  ← 2028年6月から効く
eq('住民税（育休がまるまる乗った年の所得に対する年額）', residentTaxAnnual(RULES, Y2027_PAID, Y2027_SHAHO).total, 44200);

console.log('\n── 通しのシミュレーション ──');

const result = simulate(RULES, {
  monthlySalary: SALARY,
  annualBonus: BONUS_YEAR,
  bonusMonths: [6, 12],
  leaveStartYear: 2026,
  leaveStartMonth: 10,
  leaveMonths: 12,
  isOver40: false,
  withShusseigo: false,
});

const yearOf = (scenario, y) => result[scenario].years.find((r) => r.year === y);

eq('源泉徴収票の支払金額 2026（育休あり）', yearOf('leave', 2026).paid, Y2026_PAID);
eq('源泉徴収票の支払金額 2027（育休あり）', yearOf('leave', 2027).paid, Y2027_PAID);
eq('源泉徴収票の支払金額 2028（育休あり・復職済み）', yearOf('leave', 2028).paid, NORMAL_PAID);
eq('源泉徴収票の支払金額 2026（育休なし）', yearOf('noLeave', 2026).paid, NORMAL_PAID);

eq('社会保険料 2026（育休あり）', yearOf('leave', 2026).shaho, Y2026_SHAHO);
eq('社会保険料 2027（育休あり）', yearOf('leave', 2027).shaho, Y2027_SHAHO);

eq('所得税 2027（育休あり）', yearOf('leave', 2027).incomeTax, 0);
eq('翌年度の住民税 2026年所得分（育休あり）', yearOf('leave', 2026).residentTaxForNextFiscalYear, 190100);
eq('翌年度の住民税 2027年所得分（育休あり）', yearOf('leave', 2027).residentTaxForNextFiscalYear, 44200);

console.log('\n── 罠の確認：育休中でも住民税を払い続けている ──');

// 2026年11月（育休中）の住民税は、2025年（通常勤務）の所得に対するもの。
// 給与も賞与もゼロなのに、通常年と同じ住民税が引かれ続ける。
const nov2026 = result.leave.months.find((m) => m.year === 2026 && m.month === 11);
eq('2026年11月の額面（育休中）', nov2026.gross, 0);
eq('2026年11月の社会保険料（免除）', nov2026.shaho, 0);
eq('2026年11月の所得税（非課税なのでゼロ）', nov2026.incomeTax, 0);
eq('2026年11月の住民税（2025年の所得に対するもの）', nov2026.residentTax, Math.floor(307900 / 12));
eq('2026年11月の住民税の基準年', nov2026.residentTaxBaseYear, 2025);

// 賞与を除いた月々の手取り。折れ線はこちらを描く。
// 2026年11月（育休中）: 給付268,000 − 社会保険料0 − 所得税0 − 住民税25,658 = 242,342
eq('2026年11月の月々の手取り', nov2026.netExBonus, 268000 - 25658);

// 育休を取らない場合の同じ月: 400,000 − 58,400 − 所得税166,320/12(=13,860) − 住民税25,658
//   = 400,000 − 58,400 − 13,860 − 25,658 = 302,082
const nov2026NoLeave = result.noLeave.months.find((m) => m.year === 2026 && m.month === 11);
eq(
  '2026年11月の月々の手取り（育休なし）',
  nov2026NoLeave.netExBonus,
  400000 - 58400 - Math.floor(166320 / 12) - Math.floor(307900 / 12)
);

// 賞与月でも、線に使う値には賞与が乗らない（賞与とその社会保険料の両方を除く）
const dec2026NoLeave = result.noLeave.months.find((m) => m.year === 2026 && m.month === 12);
eq('12月（賞与月）の額面には賞与が入る', dec2026NoLeave.gross, 400000 + 600000);
eq('12月の月々の手取りには賞与が入らない', dec2026NoLeave.netExBonus, nov2026NoLeave.netExBonus);

// 2028年7月（復職後）の住民税は、2027年（育休がまるまる乗った年）の所得に対するもの。
// ここで初めて大きく下がる。
const jul2028 = result.leave.months.find((m) => m.year === 2028 && m.month === 7);
eq('2028年7月の住民税（2027年の所得に対するもの）', jul2028.residentTax, Math.floor(44200 / 12));
eq('2028年7月の住民税の基準年', jul2028.residentTaxBaseYear, 2027);

// ══════════════════════════════════════════════════
// ここから夫婦合算・入金・保育料
//
//   母   月給400,000 / 賞与年1,200,000 / 2026年10月から12か月
//   父   月給500,000 / 賞与年1,500,000 / 2026年10月から2か月
//
// 父は月給50万なので、休業開始時賃金日額が上限16,540円に当たる。
// 上限が効くケースを1本入れておく。
// ══════════════════════════════════════════════════

console.log('\n── 父（月給50万・上限が効く） ──');

const P_SALARY = 500000;
const P_BONUS_YEAR = 1500000;
const P_BONUS_EACH = 750000;

// 500,000 × 6 ÷ 180 = 16,666.67 → 上限 16,540 でクリップされる
eq('父の休業開始時賃金日額（上限でクリップ）', dailyWage(RULES, P_SALARY), 16540);
// 16,540 × 30 × 67% = 332,454（公式パンフレットの支給上限額と一致）
eq('父の1か月目の給付額', ikukyuBenefit(RULES, P_SALARY, 0).amount, 332454);

// 健保 500,000×4.95% = 24,750 / 厚年 500,000×9.15% = 45,750 / 雇用 2,500 → 73,000
eq('父の月額の社会保険料', shahoMonthly(RULES, P_SALARY, false).total, 73000);
// 健保 750,000×4.95% = 37,125 / 厚年 750,000×9.15% = 68,625 / 雇用 3,750 → 109,500
eq('父の賞与の社会保険料', shahoBonus(RULES, P_BONUS_EACH, false), 109500);

const house = simulateHousehold(RULES, {
  people: [
    {
      label: '母',
      input: {
        monthlySalary: SALARY, annualBonus: BONUS_YEAR, bonusMonths: [6, 12],
        leaveStartYear: 2026, leaveStartMonth: 10, leaveMonths: 12,
        isOver40: false, withShusseigo: false,
      },
    },
    {
      label: '父',
      input: {
        monthlySalary: P_SALARY, annualBonus: P_BONUS_YEAR, bonusMonths: [6, 12],
        leaveStartYear: 2026, leaveStartMonth: 10, leaveMonths: 2,
        isOver40: false, withShusseigo: false,
      },
    },
  ],
});

const mom = house.people.find((p) => p.label === '母');
const dad = house.people.find((p) => p.label === '父');

console.log('\n── 入金のタイミング（2か月ぶんまとめて） ──');

// 支給申請は2つの支給単位期間をまとめて行う。
// 1回目は単位0（2026年10月）と単位1（11月）の分で、翌月の12月に入金される。
eq('母の入金の回数（12か月ぶん÷2）', mom.payments.payments.length, 6);
eq('最初の入金までの空白（か月）', mom.payments.gapMonths, 2);
eq('最初の入金の年', mom.payments.firstPayment.year, 2026);
eq('最初の入金の月', mom.payments.firstPayment.month, 12);
// 268,000 × 2 = 536,000
eq('最初の入金額（67%×2か月）', mom.payments.firstPayment.amount, 536000);
// 268,000×6 + 200,000×6 = 2,808,000
eq('母の給付金の総額', mom.payments.total, 2808000);
// 単位6と7（どちらも50%）→ 200,000 × 2 = 400,000
eq('4回目の入金額（50%×2か月）', mom.payments.payments[3].amount, 400000);

// 父は2か月なので入金は1回だけ。332,454 × 2 = 664,908
eq('父の入金の回数', dad.payments.payments.length, 1);
eq('父の入金額', dad.payments.firstPayment.amount, 664908);
eq('父の最初の入金の月', dad.payments.firstPayment.month, 12);

console.log('\n── 父の年ごと（育休2か月） ──');

// 給与 500,000×10（1〜9月と12月）＋ 賞与 750,000×2 = 6,500,000
// 社会保険料 73,000×10 + 109,500×2 = 949,000
const dad2026 = dad.sim.leave.years.find((y) => y.year === 2026);
eq('父の2026年の支払金額', dad2026.paid, 6500000);
eq('父の2026年の社会保険料', dad2026.shaho, 949000);

// 給与所得控除 6,500,000×20% + 440,000 = 1,740,000
// 給与所得     = 4,760,000
// 課税所得     = 4,760,000 − 949,000 − 430,000 = 3,381,000
// 所得割       = 338,100 − 調整控除2,500 = 335,600
eq('父の2026年の所得割額', dad2026.shotokuwari, 335600);

// 育休を取らない場合: 支払金額 7,500,000 / 社会保険料 1,095,000
// 給与所得控除 7,500,000×10% + 1,100,000 = 1,850,000 → 給与所得 5,650,000
// 課税所得 5,650,000 − 1,095,000 − 430,000 = 4,125,000
// 所得割 412,500 − 2,500 = 410,000
const dad2026No = dad.sim.noLeave.years.find((y) => y.year === 2026);
eq('父の2026年の支払金額（育休なし）', dad2026No.paid, 7500000);
eq('父の2026年の所得割額（育休なし）', dad2026No.shotokuwari, 410000);

console.log('\n── 保育料の階層を決める数字 ──');

// 保育の開始は既定で「遅いほうが復職した翌月」＝母の復職 2027年10月
eq('保育の開始（年）', fromAbs(house.careStartAbs).year, 2027);
eq('保育の開始（月）', fromAbs(house.careStartAbs).month, 10);

// 暦の月で見ると、9〜12月は前年の所得、1〜8月は前々年の所得が基準になる
eq('2027年10月分の基準年', childcareBasisYear(RULES, 2027, 10), 2026);
eq('2028年4月分の基準年', childcareBasisYear(RULES, 2028, 4), 2026);
eq('2028年8月分の基準年', childcareBasisYear(RULES, 2028, 8), 2026);
eq('2028年9月分の基準年（ここで切り替わる）', childcareBasisYear(RULES, 2028, 9), 2027);

// 最初の区間は2026年の所得が基準。
// 世帯の所得割額 = 母185,100 + 父335,600 = 520,700
const seg0 = house.childcare[0];
eq('最初の区間の基準年', seg0.basisYear, 2026);
eq('最初の区間の世帯の所得割額（育休あり）', seg0.household, 520700);

// 育休を取らなかった場合は 母302,900 + 父410,000 = 712,900
const seg0No = house.childcareNoLeave[0];
eq('同じ区間の世帯の所得割額（育休なし）', seg0No.household, 712900);
eq('保育料の階層を決める数字の差', seg0No.household - seg0.household, 192200);

console.log('\n── 申請の期限 ──');

// 育児休業開始日から起算して4か月を経過する日の属する月の末日。
// 2026年10月1日開始 → 4か月後は2027年2月1日、経過する日は2027年1月31日 → 期限は2027年1月31日
const firstApp = mom.applications.items.find((i) => i.what.includes('初回の支給申請'));
eq('初回支給申請の期限（年）', firstApp.deadline.getUTCFullYear(), 2027);
eq('初回支給申請の期限（月）', firstApp.deadline.getUTCMonth() + 1, 1);
eq('初回支給申請の期限（日）', firstApp.deadline.getUTCDate(), 31);

// 会社への申出は原則1か月前まで（育児休業の場合）
const notice = mom.applications.items.find((i) => i.what.includes('育児休業の申出'));
eq('会社への申出期限（月）', notice.deadline.getUTCMonth() + 1, 9);
eq('会社への申出期限（日）', notice.deadline.getUTCDate(), 1);

console.log('\n── 世帯の合算 ──');

// 2026年11月: 母は育休（給付268,000・住民税25,658）、父も育休（給付332,454）
const h202611 = house.months.find((m) => m.year === 2026 && m.month === 11);
eq('2026年11月の世帯の給付金', h202611.benefit, 268000 + 332454);
// 父の住民税 = 415,000/12 = 34,583
eq('2026年11月の世帯の住民税', h202611.residentTax, Math.floor(307900 / 12) + Math.floor(415000 / 12));

console.log('\n── 育休中に支払われた賞与 ──');

// 賞与の社会保険料の内訳。免除されるのは健保・介護・厚年で、雇用保険料は賃金なので残る。
// 健保 29,700 + 厚年 54,900 = 84,600 ／ 雇用 3,000
const bp = shahoBonusParts(RULES, BONUS_EACH, false);
eq('賞与の社会保険料のうち免除されうる分', bp.exemptable, 84600);
eq('賞与の社会保険料のうち雇用保険料', bp.employment, 3000);
eq('賞与の社会保険料の合計', bp.total, 87600);

// 「賞与を支払った月の末日を含んだ連続した1か月を超える育児休業等」で免除。
// ちょうど1か月の育休は「超える」に当たらない。
eq('育休2か月なら免除', bonusShahoExempt(RULES, { bonusInLeave: true, leaveMonths: 2 }) ? 1 : 0, 1);
eq('育休ちょうど1か月なら免除されない', bonusShahoExempt(RULES, { bonusInLeave: true, leaveMonths: 1 }) ? 1 : 0, 0);
eq('賞与月が育休外なら免除されない', bonusShahoExempt(RULES, { bonusInLeave: false, leaveMonths: 12 }) ? 1 : 0, 0);

const withBonus = simulate(RULES, {
  monthlySalary: SALARY, annualBonus: BONUS_YEAR, bonusMonths: [6, 12],
  leaveStartYear: 2026, leaveStartMonth: 10, leaveMonths: 12,
  isOver40: false, withShusseigo: false, bonusRateDuringLeave: 1,
});

// 2026年12月は育休中だが賞与が支払われる。
// 健保・厚年は免除され、雇用保険料 600,000×0.5% = 3,000 だけが残る。
const dec2026Bonus = withBonus.leave.months.find((m) => m.year === 2026 && m.month === 12);
eq('育休中の賞与の額面', dec2026Bonus.bonus, BONUS_EACH);
eq('育休中の賞与にかかる社会保険料（免除後）', dec2026Bonus.shahoOnBonus, 3000);
eq('育休中の賞与は免除された', dec2026Bonus.bonusExempt ? 1 : 0, 1);

// 賞与は非課税ではないので、源泉徴収票の支払金額には入る。
// 給与 400,000×9 + 賞与 600,000×2 = 4,800,000
// 社会保険料 58,400×9 + 87,600(6月・通常) + 3,000(12月・免除後) = 616,200
const wb2026 = withBonus.leave.years.find((y) => y.year === 2026);
eq('育休中も賞与が出る場合の2026年の支払金額', wb2026.paid, 4800000);
eq('育休中も賞与が出る場合の2026年の社会保険料', wb2026.shaho, 616200);

// 割合で入れられる。会社ごとに扱いが違うので計算せず入力してもらう。
// 通常60万の5割 → 30万。免除されるので雇用保険料 300,000×0.5% = 1,500 だけ残る。
const halfBonus = simulate(RULES, {
  monthlySalary: SALARY, annualBonus: BONUS_YEAR, bonusMonths: [6, 12],
  leaveStartYear: 2026, leaveStartMonth: 10, leaveMonths: 12,
  isOver40: false, withShusseigo: false, bonusRateDuringLeave: 0.5,
});
const dec2026Half = halfBonus.leave.months.find((m) => m.year === 2026 && m.month === 12);
eq('育休中の賞与を5割にしたときの額面', dec2026Half.bonus, 300000);
eq('その社会保険料（免除後の雇用保険料だけ）', dec2026Half.shahoOnBonus, 1500);

console.log('\n── 配偶者控除・配偶者特別控除の判定 ──');

// 令和8・9年分の所得要件（国税庁「令和8年4月 源泉所得税の改正のあらまし」）
//   同一生計配偶者（配偶者控除）  合計所得金額 62万円以下
//   配偶者特別控除               62万円超 133万円以下
//   控除を受ける本人             合計所得金額 1,000万円以下
eq('配偶者の合計所得62万円ちょうどは配偶者控除',
  spouseDeductionStatus(RULES, 620000, 5000000).kind === 'kojo' ? 1 : 0, 1);
eq('62万円超は配偶者特別控除',
  spouseDeductionStatus(RULES, 620001, 5000000).kind === 'tokubetsu' ? 1 : 0, 1);
eq('133万円ちょうどはまだ配偶者特別控除',
  spouseDeductionStatus(RULES, 1330000, 5000000).kind === 'tokubetsu' ? 1 : 0, 1);
eq('133万円超は対象外',
  spouseDeductionStatus(RULES, 1330001, 5000000).kind === 'none' ? 1 : 0, 1);
eq('本人の合計所得が1,000万円超なら対象外',
  spouseDeductionStatus(RULES, 1000000, 10000001).kind === 'none' ? 1 : 0, 1);

// リファレンスケースの母は、2027年の支払金額180万円。
// 給与所得控除74万（最低保障額）→ 合計所得 106万円 → 配偶者特別控除の対象。
eq('母の2027年の合計所得金額', yearOf('leave', 2027).totalIncome, 1800000 - 740000);

// 世帯で見ると、その年に父が配偶者特別控除を受けられるようになる。
// 父の合計所得は 7,500,000 − 1,850,000 = 5,650,000 で1,000万円以下。
const h2027 = house.years.find((y) => y.year === 2027);
eq('2027年に新しく対象になる控除の件数', h2027.spouseDeduction.length, 1);
eq('その控除は配偶者特別控除', h2027.spouseDeduction[0].kind === 'tokubetsu' ? 1 : 0, 1);
eq('控除を受けるのは父', h2027.spouseDeduction[0].holder === '父' ? 1 : 0, 1);

// 育休を取らなければ対象にならない年は拾わない
const h2029 = house.years.find((y) => y.year === 2029);
eq('復職後の年は対象にならない', h2029.spouseDeduction.length, 0);

console.log('\n── 統計の中での位置 ──');

// 出典: 厚生労働省「令和7年度雇用均等基本調査」（令和8年7月31日公表）表12
// 区分は 5日未満 / 5日〜2週間未満 / 2週間〜1か月未満 / 1か月〜3か月未満 / ...
eq('12か月は「12か月〜18か月未満」の区分', durationBucketIndex(RULES, 12), 8);
eq('2か月は「1か月〜3か月未満」の区分', durationBucketIndex(RULES, 2), 3);
eq('1か月ちょうども「1か月〜3か月未満」', durationBucketIndex(RULES, 1), 3);
eq('0.5か月は「2週間〜1か月未満」', durationBucketIndex(RULES, 0.5), 2);

// 男性が1か月未満：6.8 + 14.1 + 28.0 = 48.9
eq('男性で1か月未満の割合', shareUpTo(RULES, 'male', 0.9), 48.9);
// 男性が3か月未満：48.9 + 30.3 = 79.2
eq('男性で3か月未満の割合', shareUpTo(RULES, 'male', 2), 79.2);
// 女性で12か月〜18か月未満まで：0.6+0.6+0.5+1.4+3.6+4.6+10.6+28.7+31.4 = 82.0
eq('女性で18か月未満の割合', shareUpTo(RULES, 'female', 12), 82.0);

// 取得率は一次資料の数値そのまま
eq('女性の取得率（令和7年度）', RULES.toukei.rates.female.rate * 10, 883);
eq('男性の取得率（令和7年度）', RULES.toukei.rates.male.rate * 10, 509);
eq('男性の前年度', RULES.toukei.rates.male.prev * 10, 405);

// 分布の合計。四捨五入があるので 99.5〜100.5 に入っていればよい。
const sumF = RULES.toukei.durationBuckets.reduce((a, b) => a + b.female, 0);
const sumM = RULES.toukei.durationBuckets.reduce((a, b) => a + b.male, 0);
eq('女性の分布の合計が100前後', Math.abs(sumF - 100) <= 0.7 ? 1 : 0, 1);
eq('男性の分布の合計が100前後', Math.abs(sumM - 100) <= 0.7 ? 1 : 0, 1);

console.log('\n── ふるさと納税の特例分の上限 ──');

// 特例分の上限は住民税所得割額の20%。寄附する年の所得で決まる。
// 通常年: 302,900 × 20% = 60,580
const normalYear = result.noLeave.years.find((y) => y.year === 2026);
eq('通常年の特例分の上限', normalYear.furusatoTokureiCap, 60580);

// 育休に入った年: 185,100 × 20% = 37,020
eq('育休に入った年の特例分の上限', yearOf('leave', 2026).furusatoTokureiCap, 37020);

// 育休がまるまる乗った年: 39,200 × 20% = 7,840
eq('育休がまるまる乗った年の特例分の上限', yearOf('leave', 2027).furusatoTokureiCap, 7840);

console.log('\n──────────────────────────────');
console.log(`  ${pass} 件一致 / ${fail} 件くいちがい`);
console.log('──────────────────────────────\n');

if (fail > 0) process.exit(1);
