import { RULES, SOURCES } from './rules-2026.js';
import {
  simulateHousehold, childcareBasisYear,
  durationBucketIndex, shareUpTo, toAbs, fromAbs, absOfDate,
} from './calc.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('ja-JP');
const man = (n) => {
  const v = n / 10000;
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
  return `${s}万円`;
};
// 狭い画面の軸目盛り用。「万円」まで書くと左マージンに収まらず頭が切れる。
const manShort = (n) => {
  const v = n / 10000;
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
  return `${s}万`;
};
const ym = (abs) => {
  const { year, month } = fromAbs(abs);
  return `${year}年${month}月`;
};
const dateJa = (d) =>
  `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;

// ── 入力を読む ────────────────────────────

let careStartOverride = null;

function readPerson(role) {
  const node = document.querySelector(`.person[data-role="${role}"]`);
  const q = (cls) => node.querySelector(cls);
  const num = (cls, dflt) => Math.max(0, Number(q(cls).value) || dflt);
  return {
    label: (q('.p-label').value || '').trim() || (role === 'mother' ? '母' : '父'),
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
    careStartAbs: careStartOverride ?? undefined,
  };
}

// ── 描画のための正規化 ──────────────────────
//
// calc.js は母と父を役割で持っている（母は固定、父だけが動く）。
// 描画のほうは「人ごとに繰り返す」形が書きやすいので、ここで配列に直す。
// 母は父より先に休みに入るので、この順に並べる。

let PEOPLE = [];

function peopleOf(house) {
  return ['mother', 'father'].map((role) => {
    const p = house.people[role];
    const ikukyu = p.periods.find((x) => x.kind === 'ikukyu');
    const sankyu = p.periods.find((x) => x.kind === 'sankyu');
    const first = sankyu || ikukyu;
    return {
      role,
      label: p.label,
      input: p.input,
      months: p.months,
      years: p.years,
      skipYears: house.sims.skip[role].years,
      skipMonths: house.sims.skip[role].months,
      periods: p.periods,
      // 休みに入る月と、復帰する月
      offStartAbs: absOfDate(first.start),
      leaveStartAbs: absOfDate(ikukyu.start),
      returnAbs: absOfDate(ikukyu.end) + 1,
      leaveMonths:
        role === 'father'
          ? house.summary.fatherLeaveMonths
          : Math.round(house.schedule.motherLeaveDays / 30),
      payments: house.payments[role],
      applications: house.applications[role],
    };
  });
}

// その月の、人ごとのセル
const perOf = (m, sc) => PEOPLE.map((p) => ({ label: p.label, role: p.role, c: m[sc][p.role] }));

// ── SVG の小道具 ──────────────────────────

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

// 上端だけ丸めた棒。データの端は4px、ベースラインには角を立てる。
function barPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  if (h <= 0) return '';
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y}
          L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr}
          L${x + w},${y + h} Z`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const f of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= mag * f) return mag * f;
  }
  return mag * 10;
}

// 縦軸の目盛りとグリッド
function drawYAxis(svg, { M, pw, y, maxV, ticks, narrow }) {
  for (let i = 0; i <= ticks; i++) {
    const v = (maxV / ticks) * i;
    svg.appendChild(el('line', {
      class: 'grid-line', x1: M.left, x2: M.left + pw, y1: y(v), y2: y(v),
    }));
    svg.appendChild(el('text', {
      class: 'axis-text', x: M.left - 6, y: y(v) + 4, 'text-anchor': 'end',
    }, i === 0 ? '0' : (narrow ? manShort(v) : man(v))));
  }
}

// 年の目盛り。ラベルどうしが重ならないよう距離で判定する。
function drawYearAxis(svg, { M, pw, ph, startAbs, n, x, narrow }) {
  const startLabelPx = narrow ? 62 : 70;
  const yearLabelPx = narrow ? 34 : 40;
  let lastRight = -Infinity;
  for (let i = 0; i < n; i++) {
    const { year, month } = fromAbs(startAbs + i);
    if (i === 0) {
      svg.appendChild(el('text', {
        class: 'axis-text', x: x(i), y: M.top + ph + 18, 'text-anchor': 'start',
      }, `${year}年${month}月`));
      lastRight = x(i) + startLabelPx;
    } else if (month === 1) {
      if (x(i) - yearLabelPx / 2 < lastRight + 8) continue;
      if (x(i) + yearLabelPx / 2 > M.left + pw) continue;
      svg.appendChild(el('text', {
        class: 'axis-text', x: x(i), y: M.top + ph + 18, 'text-anchor': 'middle',
      }, `${year}年`));
      lastRight = x(i) + yearLabelPx / 2;
    }
  }
}

function placeTip(tip, svg, xInView, W, top = 8) {
  const r = svg.getBoundingClientRect();
  const px = (xInView / W) * r.width;
  tip.hidden = false;
  tip.style.left = `${Math.max(4, Math.min(px + 12, r.width - tip.offsetWidth - 4))}px`;
  tip.style.top = `${top}px`;
}

// ── 世帯の手取り（折れ線・2系列） ──────────

function drawNetChart(house) {
  const svg = $('net-chart');
  svg.textContent = '';

  const W = Math.max(320, Math.round(svg.parentElement.clientWidth || 760));
  const narrow = W < 560;
  const H = narrow ? 270 : 322;
  const M = { top: narrow ? 52 : 58, right: narrow ? 14 : 74, bottom: 30, left: narrow ? 46 : 58 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;

  const ms = house.months;
  const n = ms.length;
  const startAbs = house.timeline.startAbs;

  const maxV = niceMax(Math.max(...ms.map((m) => Math.max(m.takeNetExBonus, m.skipNetExBonus))));
  const x = (i) => M.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v) => M.top + ph - (v / maxV) * ph;

  // 人ごとに休んでいる期間の帯。重なるところは濃くなる。
  // 母は産休から、父は育休から。ふたりとも家にいるのは重なったところ。
  PEOPLE.forEach((p) => {
    const x0 = x(Math.max(0, p.offStartAbs - startAbs));
    const x1 = x(Math.min(n - 1, p.returnAbs - startAbs));
    svg.appendChild(el('rect', {
      class: 'band', x: x0, y: M.top, width: Math.max(0, x1 - x0), height: ph,
    }));
  });
  svg.appendChild(el('text', {
    class: 'band-text', x: x(0) + 4, y: M.top - (narrow ? 34 : 40),
  }, '休んでいる期間（濃いところはふたりとも）'));

  drawYAxis(svg, { M, pw, y, maxV, ticks: narrow ? 2 : 4, narrow });
  drawYearAxis(svg, { M, pw, ph, startAbs, n, x, narrow });

  // 注記
  const annos = [];
  PEOPLE.forEach((p) => {
    if (p.leaveMonths > 6) {
      annos.push({ i: p.leaveStartAbs - startAbs + 6, label: `${p.label}の給付が50%に` });
    }
    annos.push({ i: p.returnAbs - startAbs, label: `${p.label}が復帰` });
  });
  let dropIdx = -1, dropAmt = 0;
  for (let i = 1; i < n; i++) {
    const d = ms[i - 1].residentTax - ms[i].residentTax;
    if (d > dropAmt) { dropAmt = d; dropIdx = i; }
  }
  if (dropIdx > 0 && dropAmt > 1000) annos.push({ i: dropIdx, label: '住民税が下がる' });

  // 注記の文字は2行に分けて置き、行ごとに直前のラベルの右端を覚えておく。
  // ぶつかる場合はその行を飛ばし、どちらの行にも置けなければ縦線だけ残す。
  annos.sort((a, b) => a.i - b.i);
  const rowRight = [-Infinity, -Infinity];
  const rowY = [M.top - 8, M.top - 22];
  annos.forEach((an) => {
    if (an.i < 0 || an.i >= n) return;
    const px = x(an.i);
    svg.appendChild(el('line', {
      class: 'anno-line', x1: px, x2: px, y1: M.top - 6, y2: M.top + ph,
    }));
    if (narrow) return;

    const wApprox = an.label.length * 9.5;  // 日本語はほぼ全角なので文字数から概算
    const anchor = px + wApprox > M.left + pw ? 'end' : 'start';
    const left = anchor === 'end' ? px - wApprox - 4 : px + 4;
    const right = left + wApprox;

    for (let r = 0; r < rowRight.length; r++) {
      if (left < rowRight[r] + 8) continue;
      svg.appendChild(el('text', {
        class: 'anno-text', x: anchor === 'end' ? px - 4 : px + 4, y: rowY[r], 'text-anchor': anchor,
      }, an.label));
      rowRight[r] = right;
      break;
    }
  });

  const line = (key) => ms.map((m, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(m[key])}`).join(' ');
  svg.appendChild(el('path', { class: 'line-2', d: line('skipNetExBonus') }));
  svg.appendChild(el('path', { class: 'line-1', d: line('takeNetExBonus') }));

  // 直接ラベル。上にいる側は線の上、下にいる側は線の下へ逃がす。
  let sepIdx = 0, sep = -1;
  ms.forEach((m, i) => {
    const d = Math.abs(m.takeNetExBonus - m.skipNetExBonus);
    if (d > sep) { sep = d; sepIdx = i; }
  });
  if (sep > 0) {
    const anchor = x(sepIdx) > M.left + pw * 0.7 ? 'end' : 'start';
    const ox = anchor === 'end' ? -8 : 8;
    const aHigher = ms[sepIdx].takeNetExBonus >= ms[sepIdx].skipNetExBonus;
    svg.appendChild(el('text', {
      class: 'series-label s1', x: x(sepIdx) + ox,
      y: y(ms[sepIdx].takeNetExBonus) + (aHigher ? -10 : 20), 'text-anchor': anchor,
    }, '父が育休を取る'));
    svg.appendChild(el('text', {
      class: 'series-label s2', x: x(sepIdx) + ox,
      y: y(ms[sepIdx].skipNetExBonus) + (aHigher ? 20 : -10), 'text-anchor': anchor,
    }, '父が取らない'));
  }

  svg.appendChild(el('circle', { class: 'dot-1', cx: x(n - 1), cy: y(ms[n - 1].takeNetExBonus), r: 4 }));
  svg.appendChild(el('circle', { class: 'dot-2', cx: x(n - 1), cy: y(ms[n - 1].skipNetExBonus), r: 4 }));

  // ホバー
  const cursor = el('line', { class: 'cursor-line', x1: 0, x2: 0, y1: M.top, y2: M.top + ph, opacity: 0 });
  svg.appendChild(cursor);
  const hit = el('rect', { class: 'hit', x: M.left, y: M.top, width: pw, height: ph });
  svg.appendChild(hit);

  const tip = $('net-tip');
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const cx = ((ev.clientX ?? ev.touches?.[0]?.clientX) - r.left) * (W / r.width);
    let i = Math.round(((cx - M.left) / pw) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    cursor.setAttribute('x1', x(i));
    cursor.setAttribute('x2', x(i));
    cursor.setAttribute('opacity', 1);

    const m = ms[i];
    const off = perOf(m, 'take')
      .filter((x) => x.c.onLeave)
      .map((x) => `${x.label}は${x.c.onSankyu && !x.c.onIkukyu ? '産休' : '育休'}`);
    tip.innerHTML =
      `<b>${m.year}年${m.month}月${off.length ? `（${off.join('・')}）` : ''}</b>` +
      `<div class="row s1"><span><i></i>父が育休を取る</span><span>${fmt(m.takeNetExBonus)}円</span></div>` +
      `<div class="row s2"><span><i></i>父が取らない</span><span>${fmt(m.skipNetExBonus)}円</span></div>` +
      (m.benefit > 0 ? `<div class="tip-note">育児休業給付の発生 ${fmt(m.benefit)}円（入金は別のタイミング）</div>` : '') +
      (m.teate > 0 ? `<div class="tip-note">出産手当金の発生 ${fmt(m.teate)}円</div>` : '') +
      `<div class="tip-note">住民税 ${fmt(m.residentTax)}円は${m.take.mother.residentTaxBaseYear}年の所得に対するもの</div>`;
    placeTip(tip, svg, x(i), W);
  };
  hit.addEventListener('mousemove', move);
  hit.addEventListener('touchmove', (e) => { move(e); e.preventDefault(); }, { passive: false });
  hit.addEventListener('mouseleave', () => {
    tip.hidden = true;
    cursor.setAttribute('opacity', 0);
  });
}

// ── 入金（棒・人ごと） ──────────────────────

function drawPayChart(house) {
  const svg = $('pay-chart');
  svg.textContent = '';

  const W = Math.max(320, Math.round(svg.parentElement.clientWidth || 760));
  const narrow = W < 560;
  const H = narrow ? 200 : 230;
  const M = { top: 26, right: narrow ? 10 : 16, bottom: 30, left: narrow ? 46 : 58 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;

  const startAbs = house.timeline.startAbs;
  // 入金が終わるところまでで切る（そのあとは何も起きないので見せない）
  const lastPay = Math.max(
    ...PEOPLE.flatMap((p) => p.payments.payments.map((q) => q.payAbs)),
    startAbs
  );
  const n = lastPay - startAbs + 2;

  const allAmounts = PEOPLE.flatMap((p) => p.payments.payments.map((q) => q.amount));
  const maxV = niceMax(Math.max(...allAmounts, 1));
  const x = (i) => M.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v) => M.top + ph - (v / maxV) * ph;

  drawYAxis(svg, { M, pw, y, maxV, ticks: 2, narrow });
  drawYearAxis(svg, { M, pw, ph, startAbs, n, x, narrow });

  const slot = pw / Math.max(1, n - 1);
  const count = PEOPLE.length;
  const barW = Math.max(4, Math.min(18, slot / count - 2));

  const tip = $('pay-tip');

  // 入金のない空白を示す帯。世帯の誰にも入金がないところまでで切る。
  // 母の初回だけで引くと、先に入る父の棒が帯の中に立って矛盾する。
  const firstPayAbs = Math.min(
    ...PEOPLE.filter((p) => p.payments.firstPayment).map((p) => p.payments.firstPayment.payAbs)
  );
  if (Number.isFinite(firstPayAbs)) {
    const gx0 = x(0);
    const gx1 = x(firstPayAbs - startAbs);
    svg.appendChild(el('rect', { class: 'gap-band', x: gx0, y: M.top, width: Math.max(0, gx1 - gx0), height: ph }));
    svg.appendChild(el('text', { class: 'band-text', x: gx0 + 4, y: M.top - 8 }, 'どちらにも入金なし'));
  }

  PEOPLE.forEach((p, pi) => {
    p.payments.payments.forEach((pay) => {
      const i = pay.payAbs - startAbs;
      if (i < 0 || i >= n) return;
      const cx = x(i) - (count * (barW + 2)) / 2 + pi * (barW + 2) + 1;
      const h = ph - (y(pay.amount) - M.top);
      const g = el('path', {
        class: `bar-p${pi + 1}`, d: barPath(cx, y(pay.amount), barW, h),
      });
      svg.appendChild(g);

      const hit = el('rect', {
        class: 'hit', x: cx - 4, y: M.top, width: barW + 8, height: ph,
      });
      hit.addEventListener('mouseenter', () => {
        tip.innerHTML =
          `<b>${ym(pay.payAbs)}ごろ・${p.label}</b>` +
          `<div class="row"><span>入金</span><span>${fmt(pay.amount)}円</span></div>` +
          `<div class="tip-note">対象は ${pay.covers.map((c) => `${c.year}年${c.month}月`).join(' と ')} の分</div>`;
        placeTip(tip, svg, x(i), W, 4);
      });
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.appendChild(hit);
    });
  });

  // 凡例（人ごと）
  $('pay-legend').innerHTML = PEOPLE
    .map((p, i) => `<span role="listitem"><i class="swatch p${i + 1}"></i>${p.label}</span>`)
    .join('');
}

// ── 源泉徴収票（人ごとの小さな棒グラフ） ──────
//
// 母の支払金額は、父が育休を取っても取らなくても変わらない。
// 母の産休・育休は両方のシナリオに同じだけ入っているからで、
// 2本並べても同じ高さの棒が2本立つだけになる。だから母は1系列で出す。
// 「母の年収は、父が何をしようと下がる」ことのほうが伝えたいことでもある。

function drawPaidCharts(house) {
  const host = $('paid-charts');
  host.textContent = '';

  PEOPLE.forEach((p) => {
    const compare = p.role === 'father';

    const h3 = document.createElement('h3');
    h3.className = 'sub-title';
    h3.textContent = p.label;
    host.appendChild(h3);

    const lead = document.createElement('p');
    lead.className = 'note';
    lead.innerHTML = compare
      ? '育休を取ると、その年の支払金額が下がります。'
      : `<strong>父が育休を取っても取らなくても同じです。</strong>` +
        `母の産休と育休はどちらの場合も同じだけあるので、書類の上の年収はどちらでも下がります。`;
    host.appendChild(lead);

    if (compare) {
      const lg = document.createElement('div');
      lg.className = 'legend';
      lg.setAttribute('role', 'list');
      lg.innerHTML =
        `<span role="listitem"><i class="swatch s1"></i>育休を取る</span>` +
        `<span role="listitem"><i class="swatch s2"></i>取らない</span>`;
      host.appendChild(lg);
    }

    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap sub';
    host.appendChild(wrap);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${p.label}の年ごとの源泉徴収票の支払金額`);
    wrap.appendChild(svg);
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    wrap.appendChild(tip);

    const W = Math.max(320, Math.round(wrap.clientWidth || 760));
    const narrow = W < 560;
    const H = narrow ? 190 : 210;
    const M = { top: 28, right: narrow ? 8 : 16, bottom: 34, left: narrow ? 46 : 58 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const pw = W - M.left - M.right;
    const ph = H - M.top - M.bottom;

    const years = p.years;
    const skipMap = new Map(p.skipYears.map((r) => [r.year, r]));
    const maxV = niceMax(Math.max(...years.map((r) => r.paid), ...p.skipYears.map((r) => r.paid)));
    const y = (v) => M.top + ph - (v / maxV) * ph;

    drawYAxis(svg, { M, pw, y, maxV, ticks: 2, narrow });

    const slot = pw / years.length;
    const barW = compare
      ? Math.max(6, Math.min(34, (slot - (narrow ? 18 : 26)) / 2 - 1))
      : Math.max(8, Math.min(46, slot - (narrow ? 16 : 24)));

    years.forEach((rowA, k) => {
      const rowB = skipMap.get(rowA.year);
      const cx = M.left + slot * k + slot / 2;
      const x1 = compare ? cx - barW - 1 : cx - barW / 2;
      const bar = (x, v, cls) =>
        svg.appendChild(el('path', { class: cls, d: barPath(x, y(v), barW, ph - (y(v) - M.top)) }));

      bar(x1, rowA.paid, 'bar-1');
      if (compare && rowB) bar(cx + 1, rowB.paid, 'bar-2');

      svg.appendChild(el('text', {
        class: 'bar-value', x: x1 + barW / 2, y: y(rowA.paid) - 5,
      }, narrow ? manShort(rowA.paid) : man(rowA.paid)));
      if (compare && rowB && !narrow) {
        svg.appendChild(el('text', {
          class: 'bar-value', x: cx + 1 + barW / 2, y: y(rowB.paid) - 5,
        }, man(rowB.paid)));
      }
      svg.appendChild(el('text', {
        class: 'axis-text', x: cx, y: M.top + ph + 18, 'text-anchor': 'middle',
      }, narrow ? `'${String(rowA.year).slice(2)}` : `${rowA.year}年`));

      const hit = el('rect', { class: 'hit', x: cx - slot / 2, y: M.top, width: slot, height: ph });
      hit.addEventListener('mouseenter', () => {
        const nonTaxable = rowA.benefit + rowA.teate;
        const names = [rowA.benefit > 0 && '育児休業給付', rowA.teate > 0 && '出産手当金']
          .filter(Boolean).join('と');
        tip.innerHTML =
          `<b>${rowA.year}年・${p.label}の源泉徴収票</b>` +
          (compare
            ? `<div class="row s1"><span><i></i>育休を取る</span><span>${fmt(rowA.paid)}円</span></div>` +
              `<div class="row s2"><span><i></i>取らない</span><span>${fmt(rowB ? rowB.paid : 0)}円</span></div>`
            : `<div class="row s1"><span><i></i>支払金額</span><span>${fmt(rowA.paid)}円</span></div>`) +
          (nonTaxable > 0
            ? `<div class="tip-note">この年に受け取った ${fmt(nonTaxable)}円（${names}）は非課税なので、この欄には入りません</div>`
            : '');
        placeTip(tip, svg, cx, W, 4);
      });
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.appendChild(hit);
    });
  });
}

// ── 保育料の表 ────────────────────────────

function drawCare(house) {
  const tb = document.querySelector('#care-table tbody');
  tb.textContent = '';
  const skipMap = new Map(house.childcareSkip.map((s) => [s.basisYear, s]));

  for (const s of house.childcare) {
    const no = skipMap.get(s.basisYear);
    const diff = no && s.household != null ? no.household - s.household : null;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${ym(s.fromAbs)} 〜 ${ym(s.toAbs)}</td>` +
      `<td>${s.basisYear}年</td>` +
      `<td>${s.household != null ? fmt(s.household) : '—'}</td>` +
      `<td>${no && no.household != null ? fmt(no.household) : '—'}</td>` +
      `<td>${diff == null ? '—' : diff > 0 ? `−${fmt(diff)}` : diff < 0 ? `+${fmt(-diff)}` : '0'}</td>`;
    tb.appendChild(tr);
  }

  const first = house.childcare[0];
  const firstNo = skipMap.get(first?.basisYear);
  const names = PEOPLE.map((p) => p.label).join('と');
  if (first && first.household != null && firstNo) {
    const d = firstNo.household - first.household;
    $('care-callout').innerHTML =
      `保育がはじまる ${ym(house.careStartAbs)} の保育料は、<strong>${first.basisYear}年の所得</strong>で決まります。` +
      `${names}を合わせた所得割額は <strong>${fmt(first.household)}円</strong>。` +
      (d > 0
        ? `父が育休を取らなかった場合は ${fmt(firstNo.household)}円 なので、<strong>${fmt(d)}円ぶん低い階層</strong>から始まります。`
        : '');
  } else {
    $('care-callout').textContent = '';
  }
}

// ── ふるさと納税 ──────────────────────────

function drawFurusato(house) {
  // 母の上限は父が育休を取っても取らなくても同じ（母の産休・育休は両方に入っている）。
  // 同じ数字を2列並べても読めないので、比較の列は父にだけ付ける。
  const thead = document.querySelector('#fs-table thead');
  const perCols = PEOPLE
    .map((p) => p.role === 'father'
      ? `<th scope="col">${p.label}<br><small>育休を取る</small></th>` +
        `<th scope="col">${p.label}<br><small>取らない</small></th>`
      : `<th scope="col">${p.label}</th>`)
    .join('');
  thead.innerHTML = `<tr><th scope="col">寄附する年</th>${perCols}</tr>`;

  const tb = document.querySelector('#fs-table tbody');
  tb.textContent = '';
  for (const r of house.years) {
    const cells = r.per
      .map((x) => {
        const take = `<td>${x.take ? fmt(x.take.furusatoTokureiCap) : '—'}</td>`;
        if (x.who !== 'father') return take;
        return take + `<td class="muted">${x.skip ? fmt(x.skip.furusatoTokureiCap) : '—'}</td>`;
      })
      .join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.year}年</td>${cells}`;
    tb.appendChild(tr);
  }

  // いちばん枠が縮む人と年を拾う
  let worst = null;
  for (const p of PEOPLE) {
    for (const y of p.years) {
      const no = p.skipYears.find((r) => r.year === y.year);
      if (!no) continue;
      const drop = no.furusatoTokureiCap - y.furusatoTokureiCap;
      if (!worst || drop > worst.drop) worst = { p, y, no, drop };
    }
  }
  if (worst && worst.drop > 0) {
    $('fs-callout').innerHTML =
      `いちばん縮むのは <strong>${worst.p.label}の${worst.y.year}年</strong>。` +
      `特例分の上限が ${fmt(worst.no.furusatoTokureiCap)}円 から ` +
      `<strong>${fmt(worst.y.furusatoTokureiCap)}円</strong> になります。` +
      `この年に例年どおり寄附すると、控除しきれない分がそのまま自己負担になります。`;
  } else {
    $('fs-callout').textContent = '';
  }
}

// ── 統計：男性はどのくらい取っているか ──
//
// このツールの目的が「父が育休を取りやすくすること」なので、男性だけを出す。
// 比べて優劣をつけるためではなく、「自分だけじゃない」を知るためのもの。
// 平均との比較は出さない。

function drawStats(house) {
  const T = RULES.toukei;
  const father = PEOPLE.find((p) => p.role === 'father');
  const r = T.rates.male;
  const up = (r.rate - r.prev).toFixed(1);

  $('stat-rates').innerHTML =
    `<div class="tile">` +
    `<div class="tile-label">男性の育休取得率</div>` +
    `<div class="tile-value">${r.rate}<span class="unit">%</span></div>` +
    `<div class="tile-sub">前年度 ${r.prev}% から ${up} ポイント上昇。` +
    `有期契約労働者では ${r.fixedTerm}%</div>` +
    `</div>`;

  const share = shareUpTo(RULES, 'male', father.leaveMonths);
  const idx = durationBucketIndex(RULES, father.leaveMonths);
  const b = T.durationBuckets[idx];
  $('stat-callout').innerHTML =
    `<strong>${father.label}の${father.leaveMonths}か月は「${b.label}」の区分</strong>です。` +
    `取った男性のうち ${b.male}% がこの区分で、これと同じか短い区分の人が ${share}% います。`;

  // 期間の分布の注記
  const m = T.durationBuckets;
  const maleUnder1m = (m[0].male + m[1].male + m[2].male).toFixed(1);
  const maleUnder3m = (Number(maleUnder1m) + m[3].male).toFixed(1);
  $('stat-dur-note').innerHTML =
    `男性は<strong>${maleUnder1m}% が1か月未満</strong>、${maleUnder3m}% が3か月未満です。` +
    `「長く取らないといけない」という思い込みが、いちばん外れているところかもしれません。`;

  const host = $('stat-charts');
  host.textContent = '';
  drawDurationChart(host, father);

  $('stat-source').innerHTML =
    `出典：<a href="${T.surveyUrl}" target="_blank" rel="noopener">${T.surveyOrg}「${T.surveyName}」</a>` +
    `（${T.publishedOn} 公表）事業所調査 結果概要。` +
    `取得率は調査対象期間に配偶者が出産した男性のうち育休を開始した人の割合、` +
    `期間の分布は前年度に育休を終えて復職した人の割合です。四捨五入のため合計が100.0にならないことがあります。`;
}

function drawDurationChart(host, person) {
  const T = RULES.toukei;

  const h3 = document.createElement('h4');
  h3.className = 'sub-title';
  h3.textContent = '男性の取得期間';
  host.appendChild(h3);

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap sub';
  host.appendChild(wrap);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '男性の育児休業の取得期間の分布');
  wrap.appendChild(svg);

  const W = Math.max(320, Math.round(wrap.clientWidth || 760));
  const narrow = W < 560;
  const bs = T.durationBuckets;
  const rowH = narrow ? 22 : 24;
  const M = { top: 8, right: narrow ? 44 : 56, bottom: 8, left: narrow ? 108 : 132 };
  const H = M.top + M.bottom + rowH * bs.length;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const pw = W - M.left - M.right;

  const maxV = Math.max(...bs.map((b) => b.male));
  const mine = durationBucketIndex(RULES, person.leaveMonths);

  bs.forEach((b, i) => {
    const y = M.top + rowH * i;
    const v = b.male;
    const w = maxV > 0 ? (v / maxV) * pw : 0;
    const isMine = i === mine;

    svg.appendChild(el('text', {
      class: 'axis-text' + (isMine ? ' mine' : ''),
      x: M.left - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end',
    }, b.label));

    svg.appendChild(el('path', {
      class: isMine ? 'bar-mine' : 'bar-1',
      d: barPathH(M.left, y + 4, Math.max(w, 1), rowH - 10),
    }));

    // バーが長いと外側のラベルが右端からはみ出すので、内側に入れて右寄せにする。
    const label = `${v.toFixed(1)}%`;
    const labelW = label.length * 6.5;
    const inside = w > pw - labelW - 10;
    svg.appendChild(el('text', {
      class: 'bar-value ' + (inside ? 'inside' : 'outside') + (isMine ? ' mine' : ''),
      x: inside ? M.left + w - 6 : M.left + w + 6,
      y: y + rowH / 2 + 4,
      'text-anchor': inside ? 'end' : 'start',
    }, label));

    if (isMine) {
      svg.appendChild(el('text', {
        class: 'mine-tag', x: M.left + 6, y: y + rowH / 2 + 4,
      }, `${person.label}はここ`));
    }
  });
}

// 右端だけ丸めた横向きの棒
function barPathH(x, y, w, h, r = 4) {
  const rr = Math.min(r, h / 2, Math.max(0, w));
  if (w <= 0) return '';
  return `M${x},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr}
          L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x},${y + h} Z`;
}

// ── 所得制限の整理 ────────────────────────

function drawLimits(house) {
  const tb = document.querySelector('#limit-table tbody');
  tb.textContent = '';
  for (const r of RULES.shotokuSeigen) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${r.name}</td>` +
      `<td>${r.has ? '<strong>変わる</strong>' : '<span class="muted">変わらない</span>'}</td>` +
      `<td class="wrap">${r.has ? r.basis : ''}<span class="covers">${r.note}（${r.source}）</span></td>`;
    tb.appendChild(tr);
  }

  // 育休を取ったことで新しく配偶者控除の対象になる年を拾う
  const hits = [];
  for (const y of house.years) {
    for (const d of y.spouseDeduction || []) {
      hits.push({ year: y.year, ...d });
    }
  }
  if (hits.length) {
    const h = hits[0];
    const name = h.kind === 'kojo' ? '配偶者控除' : '配偶者特別控除';
    $('spouse-callout').innerHTML =
      `<strong>${h.year}年は、${h.holder}が${name}を受けられる見込みです。</strong>` +
      `${h.target}の所得が下がって要件に入るためで、育休を取らなければ対象になりません。` +
      `${h.holder}側の所得税と住民税が下がります。` +
      `<strong>控除額はここでは出していません</strong>——令和8年分の控除額の表が国税庁にまだ出ておらず、` +
      `推測で作らないためです。国税庁の表でご確認ください。`;
  } else {
    $('spouse-callout').textContent = '';
  }
}

// ── 会社側のしくみ ────────────────────────

function drawCompany() {
  const k = RULES.kaisha;
  const courses = k.joseikin.courses.map((c) =>
    `<li><strong>${c.name}</strong>${c.amountNote ? `<span class="amt">${c.amountNote}</span>` : ''}` +
    `<div class="app-note">${c.about}</div></li>`
  ).join('');

  $('co-list').innerHTML =
    `<h3 class="sub-title">${k.joseikin.name}</h3>` +
    `<p class="note">${k.joseikin.note}</p>` +
    `<ul class="apps">${courses}</ul>` +
    `<h3 class="sub-title">${k.ninshou.name}</h3>` +
    `<p class="note">${k.ninshou.note}</p>` +
    `<h3 class="sub-title">${k.kouhyou.name}</h3>` +
    `<p class="note">${k.kouhyou.note}</p>`;

  $('co-source').innerHTML =
    `出典：<a href="${k.joseikin.url}" target="_blank" rel="noopener">${k.joseikin.org}「${k.joseikin.name}」</a>、` +
    `<a href="${k.ninshou.url}" target="_blank" rel="noopener">${k.ninshou.name}</a>。` +
    `<strong>税金が安くなるしくみについては書いていません</strong>——` +
    `認定を受けた会社への上乗せがあるという話はありますが、` +
    `いま見直しの途中で、確かな資料で確認できなかったためです。`;
}

// ── 法律で守られていること ─────────────────

function drawProtection() {
  const h = RULES.hogo;
  $('hogo-list').innerHTML =
    `<ul class="apps">` +
    h.items.map((it) =>
      `<li><div class="app-head"><strong>${it.head}</strong></div>` +
      `<div class="app-note">${it.body}</div>` +
      `<div class="app-who">${it.law}</div></li>`
    ).join('') +
    `</ul>`;
  $('hogo-source').innerHTML =
    `出典：<a href="${h.sourceUrl}" target="_blank" rel="noopener">${h.source}</a>`;
}

// ── 申請の一覧 ────────────────────────────

function appItemHtml(it) {
  const due = it.deadline
    ? `<span class="due">${dateJa(it.deadline)}まで</span>`
    : `<span class="due soft">期限は個別</span>`;
  return `<li><div class="app-head"><strong>${it.what}</strong>${due}</div>` +
    `<div class="app-who">${it.who}</div>` +
    `<div class="app-note">${it.note}</div></li>`;
}

function drawApplications(house) {
  const host = $('app-list');
  host.textContent = '';

  PEOPLE.forEach((p) => {
    const box = document.createElement('div');
    box.className = 'app-person';
    const items = p.applications.items.map(appItemHtml).join('');
    const span = p.role === 'mother'
      ? `産休 ${ym(p.offStartAbs)}〜、育休 ${ym(p.leaveStartAbs)}〜${ym(p.returnAbs - 1)}`
      : `育休 ${ym(p.leaveStartAbs)}〜${ym(p.returnAbs - 1)}`;
    box.innerHTML = `<h3 class="sub-title">${p.label}（${span}）</h3><ul class="apps">${items}</ul>`;
    host.appendChild(box);
  });

  // 世帯で1回だけのもの
  const box = document.createElement('div');
  box.className = 'app-person';
  box.innerHTML =
    `<h3 class="sub-title">世帯で1回</h3>` +
    `<ul class="apps">${house.applications.household.map(appItemHtml).join('')}</ul>`;
  host.appendChild(box);
}

// ── 表 ────────────────────────────────

function drawTables(house) {
  // 年ごと
  const thead = document.querySelector('#year-table thead');
  const perCols = PEOPLE.map((p) => `<th scope="col">${p.label}の<br><small>支払金額</small></th>`).join('');
  thead.innerHTML =
    `<tr><th scope="col">年</th>${perCols}` +
    `<th scope="col">給付金・手当金<br><small>非課税</small></th>` +
    `<th scope="col">所得税<br><small>世帯</small></th>` +
    `<th scope="col">住民税<br><small>翌年6月から</small></th>` +
    `<th scope="col">所得割額<br><small>保育料の基準</small></th></tr>`;

  const yb = document.querySelector('#year-table tbody');
  yb.textContent = '';
  for (const r of house.years) {
    const perCells = r.per.map((x) => `<td>${x.take ? fmt(x.take.paid) : '—'}</td>`).join('');
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${r.year}年</td>${perCells}` +
      `<td>${r.benefit + r.teate ? fmt(r.benefit + r.teate) : '—'}</td>` +
      `<td>${fmt(r.incomeTax)}</td>` +
      `<td>${fmt(r.residentTax)}</td>` +
      `<td>${fmt(r.shotokuwari)}</td>`;
    yb.appendChild(tr);
  }

  // 月ごと
  const payByAbs = new Map();
  for (const p of PEOPLE) {
    for (const q of p.payments.payments) {
      payByAbs.set(q.payAbs, (payByAbs.get(q.payAbs) || 0) + q.amount);
    }
  }

  const mb = document.querySelector('#month-table tbody');
  mb.textContent = '';
  for (const m of house.months) {
    const cells = perOf(m, 'take');
    const gross = cells.reduce((a, x) => a + x.c.gross, 0);
    const shaho = cells.reduce((a, x) => a + x.c.shaho, 0);
    const tax = cells.reduce((a, x) => a + x.c.incomeTax, 0);
    const paid = payByAbs.get(m.abs) || 0;
    const who = cells.filter((x) => x.c.onLeave).map((x) => x.label).join('・');
    const tr = document.createElement('tr');
    if (m.onLeave) tr.className = 'on-leave';
    tr.innerHTML =
      `<td>${m.year}年${m.month}月${who ? `（${who}が休み）` : ''}</td>` +
      `<td>${fmt(gross)}</td>` +
      `<td>${m.benefit + m.teate ? fmt(m.benefit + m.teate) : '—'}</td>` +
      `<td>${paid ? `<strong>${fmt(paid)}</strong>` : '—'}</td>` +
      `<td>${fmt(shaho)}</td>` +
      `<td>${fmt(tax)}</td>` +
      `<td>${fmt(m.residentTax)}</td>` +
      `<td>${fmt(m.takeNet)}</td>`;
    mb.appendChild(tr);
  }

  // 入金の表
  const pb = document.querySelector('#pay-table tbody');
  pb.textContent = '';
  const rows = PEOPLE.flatMap((p) =>
    p.payments.payments.map((q) => ({ label: p.label, q }))
  ).sort((a, b) => a.q.payAbs - b.q.payAbs);
  for (const { label, q } of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${label}</td>` +
      `<td>${ym(q.payAbs)}ごろ</td>` +
      `<td>${q.covers.map((c) => `${c.from.month}/${c.from.day}〜${c.to.month}/${c.to.day}`).join('・')}</td>` +
      `<td>${fmt(q.amount)}</td>`;
    pb.appendChild(tr);
  }
}

// ── 文章の部分 ────────────────────────────

function drawProse(house) {
  const mother = PEOPLE.find((p) => p.role === 'mother');
  const father = PEOPLE.find((p) => p.role === 'father');
  const sn = house.snapshot;

  // ── ふたりとも家にいるあいだ、世帯の手取りはこのくらい ──
  //
  // 父の育休は生まれた日から始まるので、そのあいだ母は産後休業中。
  // この重なっている時期の世帯の手取りが、いちばん先に知りたいところ。
  const overlap = house.months.filter(
    (m) => m.take.father.onIkukyu && m.take.mother.onLeave
  );
  const avg = (arr, f) => (arr.length ? Math.round(arr.reduce((a, m) => a + f(m), 0) / arr.length) : 0);

  const cards = [];
  if (overlap.length) {
    const now = sn.normalNet;
    const during = avg(overlap, (m) => m.takeNetExBonus);
    const withoutFather = avg(overlap, (m) => m.skipNetExBonus);
    const ratio = now > 0 ? Math.round((during / now) * 1000) / 10 : null;
    cards.push(
      `<div class="hero-card wide">` +
      `<div class="hc-who">ふたりとも家にいるあいだ（月あたり・ボーナス除く）</div>` +
      `<div class="hc-main"><span class="hc-yen">${fmt(during)}<span class="hc-unit">円</span></span>` +
      (ratio != null ? `<span class="hc-ratio">ふだんの ${ratio}%</span>` : '') + `</div>` +
      `<div class="hc-sub">` +
      `${father.label}が育休を取らないと ${fmt(withoutFather)}円 です。` +
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
      `<div class="hc-who">${mother.label}（産休中）</div>` +
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
      `<div class="hc-who">${father.label}（育休中）</div>` +
      `<div class="hc-main"><span class="hc-yen">${fmt(fAvg)}<span class="hc-unit">円</span></span></div>` +
      `<div class="hc-sub">育児休業給付。` +
      (withShusseigo
        ? `はじめの28日は出生後休業支援給付金が上乗せされて <b>80%（手取り10割相当）</b>です。`
        : `給付率は67%です。`) +
      `</div></div>`
    );
  }
  $('hero-cards').innerHTML = cards.join('');

  // ── 先に知っておくと落ち着けること ──
  const facts = [];

  // 【このツールの要】父が取ると、母の給付も増える
  if (house.shusseigo.take.mother > 0 && house.shusseigo.skip.mother === 0) {
    const mGain = house.months.reduce((a, m) => a + m.take.mother.shusseigo, 0);
    const fGain = house.months.reduce((a, m) => a + m.take.father.shusseigo, 0);
    facts.push({
      tag: 'ふたり分',
      head: `${father.label}が取ると、${mother.label}の給付も増えます`,
      body: `13%の上乗せは<b>ふたりとも14日以上取ることが条件</b>なので、${father.label}が取らないと` +
        `${mother.label}のぶんも出ません。ふたり合わせて <b>${fmt(mGain + fGain)}円</b>` +
        `（${mother.label} ${fmt(mGain)}円 ／ ${father.label} ${fmt(fGain)}円）。`,
      good: true,
    });
  }

  // 入金の空白。母は産休から数えるので、ここがいちばん長い。
  const g = mother.payments;
  if (g.firstPayment) {
    const fromOff = g.firstPayment.payAbs - mother.offStartAbs;
    facts.push({
      tag: '振り込み',
      head: `育児休業給付の最初の振り込みは ${ym(g.firstPayment.payAbs)}ごろ`,
      body: `${mother.label}が産休に入る ${ym(mother.offStartAbs)} から数えると <b>${fromOff}か月</b>あきます。` +
        `そのあいだお給料も止まっているので、ここは貯金でしのぐことになります。`,
      warn: true,
    });
  }

  const ms = house.months;
  // 給与も社会保険料も所得税もゼロなのに住民税だけ引かれる月を、人ごとに探す。
  // 世帯の合計と個人のゼロを混ぜると「誰の話か」が分からなくなる。
  let trap = null;
  for (const m of ms) {
    const who = perOf(m, 'take').find(
      (x) => x.c.onLeave && x.c.gross === 0 && x.c.shaho === 0 && x.c.residentTax > 0
    );
    if (who) { trap = { m, who }; break; }
  }
  if (trap) {
    facts.push({
      tag: '住民税',
      head: '休んでいるあいだも住民税は払い続けます',
      body: `${trap.m.year}年${trap.m.month}月の${trap.who.label}は、お給料も社会保険料もゼロですが、` +
        `住民税だけは <b>${fmt(trap.who.c.residentTax)}円</b> 引かれます。前の年の収入にかかる税だからです。`,
    });
  }

  let dropIdx = -1, dropAmt = 0;
  for (let i = 1; i < ms.length; i++) {
    const d = ms[i - 1].residentTax - ms[i].residentTax;
    if (d > dropAmt) { dropAmt = d; dropIdx = i; }
  }
  if (dropIdx > 0 && dropAmt > 1000) {
    facts.push({
      tag: '住民税',
      head: `${ms[dropIdx].year}年${ms[dropIdx].month}月から住民税が下がります`,
      body: `月 ${fmt(ms[dropIdx - 1].residentTax)}円 が <b>${fmt(ms[dropIdx].residentTax)}円</b> に。` +
        `収入が下がったぶんが、1年おくれて返ってきます。`,
      good: true,
    });
  }

  const d = house.summary.diff;
  facts.push({
    tag: '3年で見ると',
    head: `${father.label}が${sn.fatherLeaveMonths}か月取ると、ふたり合わせて ` +
      `${d < 0 ? man(Math.abs(d)) + ' 少なくなります' : man(d) + ' 多くなります'}`,
    body: `${ym(house.timeline.startAbs)}から${house.summary.monthsShown}か月ぶんの合計です。` +
      `取ると ${fmt(house.summary.takeTotal)}円、取らないと ${fmt(house.summary.skipTotal)}円。`,
  });

  $('key-facts').innerHTML = facts.map((f) =>
    `<div class="fact${f.warn ? ' warn' : ''}${f.good ? ' good' : ''}">` +
    `<div class="fact-tag">${f.tag}</div>` +
    `<div class="fact-head">${f.head}</div>` +
    `<div class="fact-body">${f.body}</div></div>`
  ).join('');

  // ── 3年ぶんの動きの下の一文 ──
  //
  // ここは線の読み方だけを書く。「なぜ住民税だけ引かれ続けるのか」は
  // 上のカードに一度だけ置いてあるので、ここでは繰り返さない。
  const bottom = ms.reduce((a, m) => (m.takeNetExBonus < a.takeNetExBonus ? m : a));
  const parts = [
    `いちばん低くなるのは ${bottom.year}年${bottom.month}月で、ふたり合わせて ${fmt(bottom.takeNetExBonus)}円です。`,
  ];
  if (dropIdx > 0 && dropAmt > 1000) {
    parts.push(`${ms[dropIdx].year}年${ms[dropIdx].month}月に一段上がるのは、住民税が下がるためです。`);
  }
  const bottomIdx = ms.indexOf(bottom);
  const back = ms.slice(bottomIdx + 1).find((m) => m.takeNetExBonus >= sn.normalNet);
  if (back) {
    parts.push(`ふだんの水準に戻るのは ${back.year}年${back.month}月ごろです。`);
  }
  $('net-callout').textContent = parts.join('');

  // ── 振り込みの呼びかけ ──
  if (g.firstPayment) {
    const fromOff = g.firstPayment.payAbs - mother.offStartAbs;
    $('pay-callout').innerHTML =
      `${mother.label}は ${ym(mother.offStartAbs)} に産休、${ym(mother.leaveStartAbs)} に育休へ入り、` +
      `育児休業給付の最初の振り込みは <strong>${ym(g.firstPayment.payAbs)}ごろ</strong>、` +
      `${fmt(g.firstPayment.amount)}円です（育休に入ってから ${g.gapMonths}か月）。` +
      `産休に入ってからだと ${fromOff}か月です。` +
      `<strong>この空白のあいだの生活費</strong>は、手元に用意しておくと安心です。`;
  } else {
    $('pay-callout').textContent = '';
  }

  // ── 書類に載る年収が使われる場面 ──
  const perWorst = PEOPLE.map((p) => {
    const w = p.years.reduce((a, c) => (c.paid < a.paid ? c : a));
    const no = p.skipYears.find((r) => r.year === w.year);
    return { p, w, no };
  });
  $('who-list').innerHTML =
    perWorst.map(({ p, w, no }) =>
      `<li><strong>住宅ローンの審査（${p.label}）</strong>。${w.year + 1}年に申し込むと、` +
      `いちばん新しい源泉徴収票は ${w.year}年分の <strong>${man(w.paid)}</strong> です` +
      (p.role === 'father'
        ? `（育休を取らなければ ${man(no ? no.paid : 0)}）。`
        : `。産休と育休で下がるので、父が育休を取るかどうかとは関係ありません。`) +
      `</li>`
    ).join('') +
    `<li><strong><a href="#care-h">保育料</a></strong>。ふたりの住民税を足した数字で段階が決まります。</li>` +
    `<li><strong>児童手当は収入で変わりません</strong>（2024年10月に所得制限がなくなりました）。` +
    `ほかの制度は<a href="#lim-h">収入で変わるもの、変わらないもの</a>にまとめています。</li>`;

  // ── 健康診断・団信の出典 ──
  $('kenshin-source').innerHTML =
    `出典：<a href="${RULES.kenshin.sourceUrl}" target="_blank" rel="noopener">${RULES.kenshin.sourceName}</a>、` +
    `<a href="${RULES.danshin.sourceUrl}" target="_blank" rel="noopener">${RULES.danshin.sourceName}</a>`;

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
    '令和8年度の改正でふえた基礎控除の分は、この差には反映されない前提です。'
  );
  $('unverified').innerHTML = `<strong>確かめきれていないこと</strong>：${unverified.join(' ')}`;

  $('rules-version').textContent =
    `${RULES.version} 版です。${RULES.validUntil} を過ぎたら、数字を確認し直す必要があります。`;
  $('sources').innerHTML = SOURCES.map((s) =>
    `<li><a href="${s.url}" target="_blank" rel="noopener">${s.label}</a>` +
    `<span class="org">（${s.org}）</span><span class="covers">${s.covers}</span></li>`
  ).join('');

  // ── 保育をはじめる月 ──
  const c = fromAbs(house.careStartAbs);
  $('care-start').value = `${c.year}-${String(c.month).padStart(2, '0')}`;
  const def = fromAbs(house.defaultCareStartAbs);
  $('care-start-note').textContent =
    `そのままだと、あとに復帰するほうに合わせて ${def.year}年${def.month}月からになります`;
}

// ── 起動 ──────────────────────────────

function render() {
  const config = readConfig();
  const house = simulateHousehold(RULES, config);
  PEOPLE = peopleOf(house);
  drawProse(house);
  drawNetChart(house);
  drawPayChart(house);
  drawPaidCharts(house);
  drawCare(house);
  drawFurusato(house);
  drawStats(house);
  drawLimits(house);
  drawCompany();
  drawProtection();
  drawApplications(house);
  drawTables(house);
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'care-start') {
    const [y, m] = e.target.value.split('-').map(Number);
    if (y && m) careStartOverride = toAbs(y, m);
  }
  // 出産予定日や父の月数を変えると保育の開始も動くので、手で変えた分は解除する
  if (e.target.id === 'birth-date' || e.target.id === 'father-months') {
    careStartOverride = null;
  }
  if (e.target.closest('.person') || e.target.id === 'birth-date' || e.target.id === 'care-start') {
    render();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.closest('.person') || e.target.id === 'birth-date') render();
});
$('care-reset').addEventListener('click', () => {
  careStartOverride = null;
  render();
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
  document.querySelectorAll('.tip').forEach((t) => { t.hidden = true; });
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

render();
revealHash();
void childcareBasisYear;
