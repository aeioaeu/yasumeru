import { RULES, SOURCES } from './rules-2026.js';
import { simulateHousehold } from './calc.js';

const $ = (id) => document.getElementById(id);

// 画面に出す額は全部「万円」。入力が万円単位なので、答えを1円まで出すと
// 持っていない精度を主張することになる（社会保険料は等級表、住民税は自治体で変わる）。
//
// man10() で 0.1万円（＝1,000円）に丸めた「数」を作り、manNum() が文字にする。
// 100万円を超えたら整数に丸める、という手加減はしない。丸め方を額で変えると、
// 内訳の足し算が合わなくなる（120 + 30 − 46 は 105 にならない）。
const man10 = (n) => Math.round(n / 1000) / 10;
const manNum = (v) => v.toFixed(1).replace(/\.0$/, '');
const man = (n) => `${manNum(man10(n))}万円`;

// ── 入力を読む ────────────────────────────

// 画面に出す呼び方。入力欄は持たない（自分で名づけるものではない）。
// 直書きすると、変えたときにそこだけ古いまま残るので、必ずここから取る。
const LABELS = { father: 'あなた', mother: 'パートナー' };

// 月給は画面に、40歳以上は畳んだ中にある。
// どちらも data-role で括ってあるので、役割で引けば場所を問わない。
//
// ボーナスは MVP では扱わない（0 で通す）。額そのものより、
// 「休業中に出るのか・いくら出るのか」が会社ごとに違いすぎて、
// 入力を1つ増やしても答えが確からしくならない。前提にそう書いてある。
function readPerson(role) {
  const q = (cls) => document.querySelector(`[data-role="${role}"] ${cls}`);
  const num = (cls, dflt) => Math.max(0, Number(q(cls)?.value) || dflt);
  return {
    label: LABELS[role],
    // 入力は万円単位。500000 を桁を数えて読ませるより、50 と書けるほうが速いし、
    // 社会保険料は等級表・住民税は自治体で変わるので、一円単位の精度はそもそも出せない。
    monthlySalary: num('.p-salary', 0) * 10000,
    annualBonus: 0,
    bonusMonths: [6, 12],
    isOver40: !!q('.p-over40')?.checked,
    bonusRateDuringLeave: 0,
  };
}

function readConfig() {
  const months = Math.min(12, Math.max(1, Number($('father-months').value) || 1));
  $('father-months-out').textContent = `${months}か月`;
  return {
    birthDate: $('birth-date').value || '2026-10-15',
    mother: readPerson('mother'),
    father: { ...readPerson('father'), leaveMonths: months },
  };
}

// 0.1万円に丸めると、内訳の足し引きが合計と合わなくなることがある
// （780通りで試して36%）。ずれは必ず0.1万円なので、それを1つの項に寄せる。
// 寄せ先は「寄せても真の値から一番離れない項」を選ぶ。
// 画面の足し算が合わないと、そこで読むのが止まる。
function balance(values, signs, target) {
  const shown = values.map(man10);
  const sum = () => Math.round(shown.reduce((a, v, i) => a + v * signs[i], 0) * 10) / 10;
  const residual = Math.round((target - sum()) * 10) / 10;
  if (residual === 0) return shown;

  // 各項について、その項で吸収したときに増える誤差を測り、一番小さいものを選ぶ
  let best = 0, bestErr = Infinity;
  values.forEach((v, i) => {
    const delta = residual / signs[i];
    const err = Math.abs(shown[i] + delta - v / 10000);
    if (err < bestErr) { bestErr = err; best = i; }
  });
  shown[best] = Math.round((shown[best] + residual / signs[best]) * 10) / 10;
  return shown;
}

// ── 結果 ────────────────────────────────
//
// 出すのは1つだけ。「二人とも家にいる間、世帯の手取りはいくらか」。
// 父の育休は生まれた日から始まるので、その間母は産後休業中。
// この重なっている時期が、一番先に知りたいところ。
function drawResult(house, months) {
  const sn = house.snapshot;

  const overlap = house.months.filter(
    (m) => m.take.father.onIkukyu && m.take.mother.onLeave
  );
  const avg = (f) =>
    overlap.length ? Math.round(overlap.reduce((a, m) => a + f(m), 0) / overlap.length) : 0;

  if (!overlap.length) {
    $('net-value').textContent = '—';
    $('res-period').textContent = '';
    $('net-parts').textContent = '';
    $('cmp-body').innerHTML = '';
    $('net-three').textContent = '';
    return;
  }

  const during = avg((m) => m.takeNetExBonus);
  const withoutFather = avg((m) => m.skipNetExBonus);
  const ratio = sn.normalNet > 0 ? Math.round((during / sn.normalNet) * 100) : null;

  const shown = man10(during);
  $('net-value').textContent = manNum(shown);

  // いつの、誰の話なのか。数字より先に置く
  $('res-period').textContent = `あなたの育休 ${months}か月のあいだ（パートナーも休業中）`;

  // 何でできている額なのかを開く。ここを畳むと「この数字は何なのか」が残らない。
  // 1画面に収めるため、人ごとの内訳までは出さず、足し引きだけにしてある。
  const got = avg((m) =>
    m.take.mother.teate + m.take.father.teate + m.take.mother.benefit + m.take.father.benefit);
  const salary = avg((m) => m.take.mother.salary + m.take.father.salary);
  const cut = avg((m) =>
    m.take.mother.shahoOnSalary + m.take.father.shahoOnSalary +
    m.take.mother.incomeTax + m.take.father.incomeTax + m.residentTax);
  const [g, s, c] = balance([got, salary, cut], [1, 1, -1], shown);
  $('net-parts').innerHTML =
    `内訳：給付金と手当金 ${manNum(g)}万円` +
    (house.shusseigo.take.father > 0 ? '（最初の28日は+13%）' : '') +
    ` ＋ お給料 ${manNum(s)}万円 − 税・社会保険料 ${manNum(c)}万円`;

  // 比べる相手を2つ並べる。どちらも「いまの額」を主語にして書く。
  // 差だけ・割合だけを出すと、何を基準にした数字なのかが読み取れない。
  //
  // 差は「出ている数字どうしの引き算」で出す。丸める前の額から出すと、
  // 画面の 61.6 − 61.2 と注記の 0.5万円 が食い違うことがある。
  const skipShown = man10(withoutFather);
  const gap = Math.round((shown - skipShown) * 10) / 10;
  const rows = [
    ['ふだんの月', man10(sn.normalNet), ratio != null ? `いまはその ${ratio}%` : '', 'down'],
    ['取らない場合', skipShown,
      gap >= 0 ? `いまのほうが ${manNum(gap)}万円 多い` : `いまのほうが ${manNum(-gap)}万円 少ない`,
      gap > 0 ? 'up' : 'down'],
  ];
  // 額と注記は別の列にする。同じセルに入れると、注記の長さで額の右端が動いて
  // 行どうしの桁が揃わなくなる（縦に並べた数字は、揃っていないと比べられない）。
  $('cmp-body').innerHTML = rows.map(([label, value, note, tone]) =>
    `<tr><th scope="row">${label}</th>` +
    `<td class="cmp-yen">${manNum(value)}万円</td>` +
    `<td class="cmp-note ${tone}">${note}</td></tr>`
  ).join('');

  // 差額は入口にしない。答えを見たあとに、1行だけ置く
  const d = house.summary.diff;
  $('net-three').textContent =
    `3年の合計では 取らない場合より ${d < 0 ? `−${man(-d)}` : `+${man(d)}`}`;

  // 読み上げには、変わった結果を一文で渡す（数字だけ読み上げても意味にならない）
  $('live-status').textContent =
    `${LABELS.father}の育休は${months}か月。` +
    `そのあいだの世帯の手取りは、ひと月あたり およそ ${manNum(shown)}万円。` +
    `育休を取らない場合は ${manNum(skipShown)}万円です。`;
}

// スライダーの線を、いまの値まで色で埋める
function drawSlider(months) {
  $('father-months').style.setProperty('--fill', `${((months - 1) / 11) * 100}%`);
}

// ── 畳んである中身 ─────────────────────────

function drawAbout() {
  document.querySelectorAll('.p-mother').forEach((e) => { e.textContent = LABELS.mother; });
  document.querySelectorAll('.p-father').forEach((e) => { e.textContent = LABELS.father; });

  const unverified = [];
  if (!RULES.shaho.kodomoShienApplied) {
    unverified.push(
      `子ども・子育て支援金（令和8年4月分から ${(RULES.shaho.kodomoShienRateTotal * 100).toFixed(2)}%）は、` +
      `労使で折半かどうかと、育休中に止まるかどうかを公式の資料で確認できなかったため、まだ計算に入れていません。`
    );
  }
  unverified.push(
    '住民税の調整控除で使う「人的控除の差」を5万円としています。' +
    '令和8年度の改正で増えた基礎控除の分は、この差には反映されない前提です。'
  );
  $('unverified').innerHTML = `<strong>確かめきれていないこと</strong>：${unverified.join(' ')}`;

  $('rules-version').textContent =
    `${RULES.version} 版です。${RULES.validUntil} を過ぎたら、数字を確認し直す必要があります。`;

  // いま画面に出している数字の根拠だけを並べる。
  // 外した節の資料まで並べると、出していないものの出典を読ませることになる。
  $('sources').innerHTML = SOURCES.filter((s) => s.shown).map((s) =>
    `<li><a href="${s.url}" target="_blank" rel="noopener">${s.label}</a>` +
    `<span class="org">（${s.org}）</span><span class="covers">${s.covers}</span></li>`
  ).join('');
}

// ── 起動 ──────────────────────────────

function render() {
  const config = readConfig();
  const house = simulateHousehold(RULES, config);
  drawResult(house, config.father.leaveMonths);
  drawSlider(config.father.leaveMonths);
}

document.addEventListener('input', (e) => {
  if (e.target.closest('[data-role]') || e.target.id === 'birth-date') render();
});
document.addEventListener('change', (e) => {
  if (e.target.closest('[data-role]') || e.target.id === 'birth-date') render();
});
$('father-months').addEventListener('input', render);

// 相手や勤務先と見るために刷ることがある。畳んだままでは白紙が出る。
let reopenAfterPrint = [];
window.addEventListener('beforeprint', () => {
  reopenAfterPrint = [...document.querySelectorAll('details:not([open])')];
  reopenAfterPrint.forEach((d) => { d.open = true; });
});
window.addEventListener('afterprint', () => {
  reopenAfterPrint.forEach((d) => { d.open = false; });
  reopenAfterPrint = [];
});

drawAbout();
render();
