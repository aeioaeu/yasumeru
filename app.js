import { RULES, SOURCES } from './rules-2026.js';
import { simulateHousehold, fromAbs } from './calc.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('ja-JP');
const man = (n) => {
  const v = n / 10000;
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
  return `${s}万円`;
};
const ym = (abs) => {
  const { year, month } = fromAbs(abs);
  return `${year}年${month}月`;
};

// ── 入力を読む ────────────────────────────

// 画面に出す呼び方。入力欄は持たない（自分で名づけるものではない）。
// 直書きすると、変えたときにそこだけ古いまま残るので、必ずここから取る。
const LABELS = { father: 'あなた', mother: 'パートナー' };

// 一番先に出している額。スライダーの下と画面の底のバーでも同じ数字を使う。
// 二度計算せず、drawProse が出したものをそのまま配る。
let SNAP = { during: null, ratio: null };

function readPerson(role) {
  const node = document.querySelector(`.person[data-role="${role}"]`);
  const q = (cls) => node.querySelector(cls);
  const num = (cls, dflt) => Math.max(0, Number(q(cls).value) || dflt);
  return {
    label: LABELS[role],
    monthlySalary: num('.p-salary', 0),
    annualBonus: num('.p-bonus', 0),
    bonusMonths: [6, 12],
    isOver40: q('.p-over40').checked,
    bonusRateDuringLeave: Math.min(1, Math.max(0, (Number(q('.p-bonus-rate').value) || 0) / 100)),
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

// ── 文章の部分 ────────────────────────────

// 「父」と決め打ちにせず、呼び方は LABELS から配る。
// 静的な HTML に名前を書くと、変えたときにそこだけ古いまま残る。
function drawLabels() {
  const { mother, father } = LABELS;

  // 静的な文の中で人を指すところは、この2つのクラスで差し替える
  document.querySelectorAll('.p-mother').forEach((e) => { e.textContent = mother; });
  document.querySelectorAll('.p-father').forEach((e) => { e.textContent = father; });

  $('snap-note').innerHTML =
    `${mother}は出産手当金、${father}は育児休業給付。` +
    `<strong>どちらも税金がかからず、社会保険料も止まります。</strong>`;
}

function drawProse(house) {
  const { mother, father } = LABELS;
  const sn = house.snapshot;

  // ── 二人とも家にいる間、世帯の手取りはこのくらい ──
  //
  // 父の育休は生まれた日から始まるので、その間母は産後休業中。
  // この重なっている時期の世帯の手取りが、一番先に知りたいところ。
  const overlap = house.months.filter(
    (m) => m.take.father.onIkukyu && m.take.mother.onLeave
  );
  const avg = (arr, f) => (arr.length ? Math.round(arr.reduce((a, m) => a + f(m), 0) / arr.length) : 0);

  const cards = [];
  SNAP = { during: null, ratio: null };
  if (overlap.length) {
    const now = sn.normalNet;
    const during = avg(overlap, (m) => m.takeNetExBonus);
    const withoutFather = avg(overlap, (m) => m.skipNetExBonus);
    const ratio = now > 0 ? Math.round((during / now) * 1000) / 10 : null;
    SNAP = { during, ratio };
    cards.push(
      `<div class="hero-card wide">` +
      `<div class="hc-who">二人とも家にいる間（月あたり・ボーナス除く）</div>` +
      `<div class="hc-main"><span class="hc-yen">${fmt(during)}<span class="hc-unit">円</span></span>` +
      (ratio != null ? `<span class="hc-ratio">普段の ${ratio}%</span>` : '') + `</div>` +
      `<div class="hc-sub">` +
      `育休を取らない場合は ${fmt(withoutFather)}円 です。` +
      `${during >= withoutFather
          ? `<b>取ったほうが ${fmt(during - withoutFather)}円 多くなります。</b>`
          : `差は ${fmt(withoutFather - during)}円 です。`}` +
      `</div></div>`
    );
  }

  const teateAvg = avg(house.months.filter((m) => m.take.mother.teate > 0), (m) => m.take.mother.teate);
  if (teateAvg > 0) {
    cards.push(
      `<div class="hero-card">` +
      `<div class="hc-who">${mother}（産休中）</div>` +
      `<div class="hc-main"><span class="hc-yen">${fmt(teateAvg)}<span class="hc-unit">円</span></span></div>` +
      `<div class="hc-sub">出産手当金。お給料のおよそ3分の2です。</div>` +
      `</div>`
    );
  }

  const fMonths = house.months.filter((m) => m.take.father.benefit > 0);
  if (fMonths.length) {
    const fAvg = avg(fMonths, (m) => m.take.father.benefit);
    const withShusseigo = house.shusseigo.take.father > 0;
    cards.push(
      `<div class="hero-card">` +
      `<div class="hc-who">${father}（育休中）</div>` +
      `<div class="hc-main"><span class="hc-yen">${fmt(fAvg)}<span class="hc-unit">円</span></span></div>` +
      `<div class="hc-sub">育児休業給付。` +
      (withShusseigo
        ? `初めの28日は出生後休業支援給付金が上乗せされて <b>80%（手取り10割相当）</b>です。`
        : `給付率は67%です。`) +
      `</div></div>`
    );
  }
  $('hero-cards').innerHTML = cards.join('');
  $('hero-cards').innerHTML = cards.join('');

  // ── 3年で見ると ──
  //
  // 差額は入口にしない。手取りの答えを見たあとに、一段落として置く。
  const d = house.summary.diff;
  const facts = [{
    head: `${father}が${sn.fatherLeaveMonths}か月取ると、二人合わせて ` +
      `${d < 0 ? man(Math.abs(d)) + ' 少なくなります' : man(d) + ' 多くなります'}`,
    body: `${ym(house.timeline.startAbs)}から${house.summary.monthsShown}か月分の合計です。` +
      `取ると ${fmt(house.summary.takeTotal)}円、取らないと ${fmt(house.summary.skipTotal)}円。`,
  }];

  $('key-facts').innerHTML = facts.map((f) =>
    `<div class="fact">` +
    `<div class="fact-head">${f.head}</div>` +
    `<div class="fact-body">${f.body}</div></div>`
  ).join('');


  // ── 未確認と出典 ──
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

// ── 操作のまわり ──────────────────────────
//
// この道具で動かせるのは父の育休の月数だけ。
// なのに動かした先の数字は、スマホだと画面の外にある。
// 「動かす」と「結果を見る」を離さないための3つ。

// 1. 入れた金額を、普段使っている単位で返す。500000 は桁を数えないと読めない。
function drawAmountEchoes() {
  document.querySelectorAll('.person').forEach((node) => {
    node.querySelectorAll('.p-salary, .p-bonus').forEach((input) => {
      const echo = input.parentElement.querySelector('.echo');
      if (!echo) return;
      const v = Number(input.value);
      echo.textContent = v > 0 ? man(v) : '';
    });
  });
}

// 2. スライダーのすぐ下に結果を出す。動かしても数字が見えないなら、動かす意味が分からない。
// 3. 画面の底に同じスライダーと同じ数字を残す。読み進めた先からでも試せるように。
//    出すのは手取り。差額は入口にしない方針なので、ここにも置かない。
function drawControls(house, months) {
  const echo = $('slider-echo');
  const bar = $('sticky-bar');

  if (SNAP.during == null) {
    echo.textContent = '';
    $('sb-value').textContent = '—';
    return;
  }

  const ratio = SNAP.ratio != null ? `（普段の ${SNAP.ratio}%）` : '';
  echo.innerHTML =
    `${months}か月にすると、二人とも家にいる間の世帯の手取りは ` +
    `<b>${fmt(SNAP.during)}円</b>／月 ${ratio}`;

  $('sb-months').value = months;
  $('sb-months-out').textContent = `${months}か月`;

  // 線のどのあたりにいるかを色で出す
  const fill = `${((months - 1) / 11) * 100}%`;
  $('father-months').style.setProperty('--fill', fill);
  $('sb-months').style.setProperty('--fill', fill);
  $('sb-value').textContent = `${fmt(SNAP.during)}円`;
  bar.querySelector('.sb-label').textContent = '二人とも家にいる間';

  // 読み上げには、変わった結果を一文だけ渡す（数字だけ読み上げても意味にならない）
  $('live-status').textContent =
    `${LABELS.father}の育休は${months}か月。` +
    `二人とも家にいる間の世帯の手取りは、月およそ ${fmt(SNAP.during)}円です。`;
}

// 入力欄が画面から出たら、底のバーを出す。入力欄が見えている間は要らない。
// バーは position: fixed なので、その高さぶんを本文の下に空ける（--bar-h）。
function setBarHeight() {
  const bar = $('sticky-bar');
  document.documentElement.style.setProperty(
    '--bar-h', bar.hidden ? '0px' : `${bar.offsetHeight}px`
  );
}

function watchInputPanel() {
  const panel = document.querySelector('.input-panel');
  const bar = $('sticky-bar');
  if (!panel || !('IntersectionObserver' in window)) return;

  new IntersectionObserver(([e]) => {
    bar.hidden = e.isIntersecting || e.boundingClientRect.top >= 0;
    setBarHeight();
  }, { threshold: 0 }).observe(panel);
}

// 底のバーのスライダーは、入力欄のスライダーと同じものを指している
$('sb-months').addEventListener('input', (e) => {
  $('father-months').value = e.target.value;
  render();
});

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

// ── 起動 ──────────────────────────────

function render() {
  const config = readConfig();
  const house = simulateHousehold(RULES, config);
  drawLabels();
  drawProse(house);
  drawAmountEchoes();
  drawControls(house, config.father.leaveMonths);
}

document.addEventListener('input', (e) => {
  if (e.target.closest('.person') || e.target.id === 'birth-date') render();
});
document.addEventListener('change', (e) => {
  if (e.target.closest('.person') || e.target.id === 'birth-date') render();
});

// 説明は details に畳んである。リンクの飛び先がその中にあるときは開く。
function revealHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  for (let el = target; el; el = el.parentElement) {
    if (el.tagName === 'DETAILS') el.open = true;
  }
  if (target.tagName === 'DETAILS') target.open = true;
  target.scrollIntoView({ block: 'start' });
}
window.addEventListener('hashchange', revealHash);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(setBarHeight, 150);
});

render();
watchInputPanel();
revealHash();
