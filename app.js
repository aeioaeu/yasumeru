import { RULES, SOURCES } from './rules-2026.js';
import {
  simulateHousehold, householdApplications, childcareBasisYear,
  durationBucketIndex, shareUpTo, toAbs, fromAbs,
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

function readPerson(node) {
  const q = (cls) => node.querySelector(cls);
  const [y, m] = (q('.p-start').value || '2026-10').split('-').map(Number);
  return {
    label: (q('.p-label').value || '').trim() || 'ひとり',
    input: {
      // 統計の区分。取得率の統計を引くためだけに使う。
      sex: q('.p-sex').value,
      monthlySalary: Math.max(0, Number(q('.p-salary').value) || 0),
      annualBonus: Math.max(0, Number(q('.p-bonus').value) || 0),
      bonusMonths: [6, 12],
      leaveStartYear: y,
      leaveStartMonth: m,
      leaveMonths: Math.min(36, Math.max(1, Number(q('.p-months').value) || 1)),
      isOver40: q('.p-over40').checked,
      withShusseigo: q('.p-shusseigo').checked,
      bonusRateDuringLeave: Math.min(1, Math.max(0, (Number(q('.p-bonus-rate').value) || 0) / 100)),
    },
  };
}

function readConfig() {
  const nodes = [...document.querySelectorAll('.person')];
  const hasPartner = $('has-partner').checked;
  nodes[1].classList.toggle('disabled', !hasPartner);
  nodes[1].querySelectorAll('input:not(#has-partner)').forEach((el) => {
    el.disabled = !hasPartner;
  });

  const people = [readPerson(nodes[0])];
  if (hasPartner) people.push(readPerson(nodes[1]));
  return { people, careStartAbs: careStartOverride ?? undefined };
}

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

  const maxV = niceMax(Math.max(...ms.map((m) => Math.max(m.leaveNetExBonus, m.noLeaveNetExBonus))));
  const x = (i) => M.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v) => M.top + ph - (v / maxV) * ph;

  // 人ごとの育休期間の帯。重なるところは濃くなる。
  house.people.forEach((p) => {
    const x0 = x(Math.max(0, p.leaveStartAbs - startAbs));
    const x1 = x(Math.min(n - 1, p.returnAbs - startAbs));
    svg.appendChild(el('rect', {
      class: 'band', x: x0, y: M.top, width: Math.max(0, x1 - x0), height: ph,
    }));
  });
  svg.appendChild(el('text', {
    class: 'band-text', x: x(0) + 4, y: M.top - (narrow ? 34 : 40),
  }, house.people.length > 1 ? '育休の期間（濃いところはふたりとも）' : '育休の期間'));

  drawYAxis(svg, { M, pw, y, maxV, ticks: narrow ? 2 : 4, narrow });
  drawYearAxis(svg, { M, pw, ph, startAbs, n, x, narrow });

  // 注記
  const annos = [];
  house.people.forEach((p) => {
    if (p.input.leaveMonths > 6) {
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
  svg.appendChild(el('path', { class: 'line-2', d: line('noLeaveNetExBonus') }));
  svg.appendChild(el('path', { class: 'line-1', d: line('leaveNetExBonus') }));

  // 直接ラベル。上にいる側は線の上、下にいる側は線の下へ逃がす。
  let sepIdx = 0, sep = -1;
  ms.forEach((m, i) => {
    const d = Math.abs(m.leaveNetExBonus - m.noLeaveNetExBonus);
    if (d > sep) { sep = d; sepIdx = i; }
  });
  if (sep > 0) {
    const anchor = x(sepIdx) > M.left + pw * 0.7 ? 'end' : 'start';
    const ox = anchor === 'end' ? -8 : 8;
    const aHigher = ms[sepIdx].leaveNetExBonus >= ms[sepIdx].noLeaveNetExBonus;
    svg.appendChild(el('text', {
      class: 'series-label s1', x: x(sepIdx) + ox,
      y: y(ms[sepIdx].leaveNetExBonus) + (aHigher ? -10 : 20), 'text-anchor': anchor,
    }, '育休を取る'));
    svg.appendChild(el('text', {
      class: 'series-label s2', x: x(sepIdx) + ox,
      y: y(ms[sepIdx].noLeaveNetExBonus) + (aHigher ? 20 : -10), 'text-anchor': anchor,
    }, '働き続ける'));
  }

  svg.appendChild(el('circle', { class: 'dot-1', cx: x(n - 1), cy: y(ms[n - 1].leaveNetExBonus), r: 4 }));
  svg.appendChild(el('circle', { class: 'dot-2', cx: x(n - 1), cy: y(ms[n - 1].noLeaveNetExBonus), r: 4 }));

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
    const onLeaveNames = m.per.filter((p) => p.leave.onLeave).map((p) => p.label);
    tip.innerHTML =
      `<b>${m.year}年${m.month}月${onLeaveNames.length ? `（${onLeaveNames.join('・')}が育休中）` : ''}</b>` +
      `<div class="row s1"><span><i></i>育休を取る</span><span>${fmt(m.leaveNetExBonus)}円</span></div>` +
      `<div class="row s2"><span><i></i>取らずに働き続ける</span><span>${fmt(m.noLeaveNetExBonus)}円</span></div>` +
      (m.benefit > 0 ? `<div class="tip-note">給付金の発生 ${fmt(m.benefit)}円（入金は別のタイミング）</div>` : '') +
      `<div class="tip-note">住民税 ${fmt(m.residentTax)}円は${m.per[0].leave.residentTaxBaseYear}年の所得に対するもの</div>`;
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
    ...house.people.flatMap((p) => p.payments.payments.map((q) => q.payAbs)),
    startAbs
  );
  const n = lastPay - startAbs + 2;

  const allAmounts = house.people.flatMap((p) => p.payments.payments.map((q) => q.amount));
  const maxV = niceMax(Math.max(...allAmounts, 1));
  const x = (i) => M.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v) => M.top + ph - (v / maxV) * ph;

  drawYAxis(svg, { M, pw, y, maxV, ticks: 2, narrow });
  drawYearAxis(svg, { M, pw, ph, startAbs, n, x, narrow });

  const slot = pw / Math.max(1, n - 1);
  const count = house.people.length;
  const barW = Math.max(4, Math.min(18, slot / count - 2));

  const tip = $('pay-tip');

  house.people.forEach((p, pi) => {
    // 入金のない空白を示す帯
    if (pi === 0 && p.payments.firstPayment) {
      const gx0 = x(0);
      const gx1 = x(p.payments.firstPayment.payAbs - startAbs);
      svg.appendChild(el('rect', { class: 'gap-band', x: gx0, y: M.top, width: Math.max(0, gx1 - gx0), height: ph }));
      svg.appendChild(el('text', { class: 'band-text', x: gx0 + 4, y: M.top - 8 }, '入金なし'));
    }

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
  $('pay-legend').innerHTML = house.people
    .map((p, i) => `<span role="listitem"><i class="swatch p${i + 1}"></i>${p.label}</span>`)
    .join('');
}

// ── 源泉徴収票（人ごとの小さな棒グラフ） ──────

function drawPaidCharts(house) {
  const host = $('paid-charts');
  host.textContent = '';

  house.people.forEach((p, pi) => {
    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap sub';
    const h3 = document.createElement('h3');
    h3.className = 'sub-title';
    h3.textContent = p.label;
    host.appendChild(h3);
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

    const years = p.sim.leave.years;
    const noMap = new Map(p.sim.noLeave.years.map((r) => [r.year, r]));
    const maxV = niceMax(Math.max(...years.map((r) => r.paid), ...p.sim.noLeave.years.map((r) => r.paid)));
    const y = (v) => M.top + ph - (v / maxV) * ph;

    drawYAxis(svg, { M, pw, y, maxV, ticks: 2, narrow });

    const slot = pw / years.length;
    const barW = Math.max(6, Math.min(34, (slot - (narrow ? 18 : 26)) / 2 - 1));

    years.forEach((rowA, k) => {
      const rowB = noMap.get(rowA.year);
      const cx = M.left + slot * k + slot / 2;
      const x1 = cx - barW - 1;
      const x2 = cx + 1;
      svg.appendChild(el('path', { class: 'bar-1', d: barPath(x1, y(rowA.paid), barW, ph - (y(rowA.paid) - M.top)) }));
      svg.appendChild(el('path', { class: 'bar-2', d: barPath(x2, y(rowB.paid), barW, ph - (y(rowB.paid) - M.top)) }));

      svg.appendChild(el('text', {
        class: 'bar-value', x: x1 + barW / 2, y: y(rowA.paid) - 5,
      }, narrow ? manShort(rowA.paid) : man(rowA.paid)));
      if (!narrow) {
        svg.appendChild(el('text', {
          class: 'bar-value', x: x2 + barW / 2, y: y(rowB.paid) - 5,
        }, man(rowB.paid)));
      }
      svg.appendChild(el('text', {
        class: 'axis-text', x: cx, y: M.top + ph + 18, 'text-anchor': 'middle',
      }, narrow ? `'${String(rowA.year).slice(2)}` : `${rowA.year}年`));

      const hit = el('rect', { class: 'hit', x: cx - slot / 2, y: M.top, width: slot, height: ph });
      hit.addEventListener('mouseenter', () => {
        tip.innerHTML =
          `<b>${rowA.year}年・${p.label}の源泉徴収票</b>` +
          `<div class="row s1"><span><i></i>育休を取る</span><span>${fmt(rowA.paid)}円</span></div>` +
          `<div class="row s2"><span><i></i>取らずに働き続ける</span><span>${fmt(rowB.paid)}円</span></div>` +
          (rowA.benefit > 0
            ? `<div class="tip-note">この年の給付金 ${fmt(rowA.benefit)}円は非課税なので、この欄には入りません</div>`
            : '');
        placeTip(tip, svg, cx, W, 4);
      });
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.appendChild(hit);
    });
    void pi;
  });
}

// ── 保育料の表 ────────────────────────────

function drawCare(house) {
  const tb = document.querySelector('#care-table tbody');
  tb.textContent = '';
  const noMap = new Map(house.childcareNoLeave.map((s) => [s.basisYear, s]));

  for (const s of house.childcare) {
    const no = noMap.get(s.basisYear);
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
  const firstNo = noMap.get(first?.basisYear);
  const names = house.people.map((p) => p.label).join('と');
  if (first && first.household != null && firstNo) {
    const d = firstNo.household - first.household;
    $('care-callout').innerHTML =
      `保育がはじまる ${ym(house.careStartAbs)} の保育料は、<strong>${first.basisYear}年の所得</strong>で決まります。` +
      `${names}を合わせた所得割額は <strong>${fmt(first.household)}円</strong>。` +
      (d > 0
        ? `育休を取らなかった場合は ${fmt(firstNo.household)}円 なので、<strong>${fmt(d)}円ぶん低い階層</strong>から始まります。`
        : '');
  } else {
    $('care-callout').textContent = '';
  }
}

// ── ふるさと納税 ──────────────────────────

function drawFurusato(house) {
  const thead = document.querySelector('#fs-table thead');
  const perCols = house.people
    .map((p) => `<th scope="col">${p.label}<br><small>育休あり</small></th>` +
                `<th scope="col">${p.label}<br><small>育休なし</small></th>`)
    .join('');
  thead.innerHTML = `<tr><th scope="col">寄附する年</th>${perCols}</tr>`;

  const tb = document.querySelector('#fs-table tbody');
  tb.textContent = '';
  for (const r of house.years) {
    const cells = r.per
      .map((x) =>
        `<td>${x.leave ? fmt(x.leave.furusatoTokureiCap) : '—'}</td>` +
        `<td class="muted">${x.noLeave ? fmt(x.noLeave.furusatoTokureiCap) : '—'}</td>`)
      .join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.year}年</td>${cells}`;
    tb.appendChild(tr);
  }

  // いちばん枠が縮む人と年を拾う
  let worst = null;
  for (const p of house.people) {
    for (const y of p.sim.leave.years) {
      const no = p.sim.noLeave.years.find((r) => r.year === y.year);
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

// ── 統計：同じ立場の人はどのくらい取っているか ──

function drawStats(house) {
  const T = RULES.toukei;
  const sexName = { female: '女性', male: '男性' };

  // 取得率のタイル
  const tiles = house.people
    .filter((p) => p.input.sex)
    .map((p) => {
      const r = T.rates[p.input.sex];
      const up = (r.rate - r.prev).toFixed(1);
      return `<div class="tile">` +
        `<div class="tile-label">${p.label}（${sexName[p.input.sex]}）の育休取得率</div>` +
        `<div class="tile-value">${r.rate}<span class="unit">%</span></div>` +
        `<div class="tile-sub">前年度 ${r.prev}% から ${up} ポイント上昇。` +
        `有期契約労働者では ${r.fixedTerm}%</div>` +
        `</div>`;
    })
    .join('');
  $('stat-rates').innerHTML = tiles || '<p class="note">統計の区分を選ぶと、取得率が出ます。</p>';

  // 呼びかけ
  const lines = [];
  for (const p of house.people) {
    if (!p.input.sex) continue;
    const share = shareUpTo(RULES, p.input.sex, p.input.leaveMonths);
    const idx = durationBucketIndex(RULES, p.input.leaveMonths);
    const b = T.durationBuckets[idx];
    lines.push(
      `<strong>${p.label}の${p.input.leaveMonths}か月は「${b.label}」の区分</strong>です。` +
      `取った${sexName[p.input.sex]}のうち ${b[p.input.sex]}% がこの区分で、` +
      `これと同じか短い区分の人が ${share}% います。`
    );
  }
  $('stat-callout').innerHTML = lines.join('<br>');

  // 期間の分布の注記
  const m = T.durationBuckets;
  const maleUnder1m = (m[0].male + m[1].male + m[2].male).toFixed(1);
  const maleUnder3m = (Number(maleUnder1m) + m[3].male).toFixed(1);
  $('stat-dur-note').innerHTML =
    `男性は<strong>${maleUnder1m}% が1か月未満</strong>、${maleUnder3m}% が3か月未満です。` +
    `「長く取らないといけない」という思い込みが、いちばん外れているところかもしれません。` +
    `女性は「12か月〜18か月未満」が最も多くなっています。`;

  // 分布のチャート（人ごと）
  const host = $('stat-charts');
  host.textContent = '';
  const shown = house.people.filter((p) => p.input.sex);
  const seen = new Set();
  for (const p of shown) {
    if (seen.has(p.input.sex)) continue;
    seen.add(p.input.sex);
    drawDurationChart(host, p, sexName[p.input.sex]);
  }

  $('stat-source').innerHTML =
    `出典：<a href="${T.surveyUrl}" target="_blank" rel="noopener">${T.surveyOrg}「${T.surveyName}」</a>` +
    `（${T.publishedOn} 公表）事業所調査 結果概要。` +
    `取得率は調査対象期間に出産（配偶者が出産）した人のうち育休を開始した人の割合、` +
    `期間の分布は前年度に育休を終えて復職した人の割合です。四捨五入のため合計が100.0にならないことがあります。`;
}

function drawDurationChart(host, person, sexLabel) {
  const T = RULES.toukei;
  const sex = person.input.sex;

  const h3 = document.createElement('h4');
  h3.className = 'sub-title';
  h3.textContent = `${sexLabel}の取得期間`;
  host.appendChild(h3);

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap sub';
  host.appendChild(wrap);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${sexLabel}の育児休業の取得期間の分布`);
  wrap.appendChild(svg);

  const W = Math.max(320, Math.round(wrap.clientWidth || 760));
  const narrow = W < 560;
  const bs = T.durationBuckets;
  const rowH = narrow ? 22 : 24;
  const M = { top: 8, right: narrow ? 44 : 56, bottom: 8, left: narrow ? 108 : 132 };
  const H = M.top + M.bottom + rowH * bs.length;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const pw = W - M.left - M.right;

  const maxV = Math.max(...bs.map((b) => b[sex]));
  const mine = durationBucketIndex(RULES, person.input.leaveMonths);

  bs.forEach((b, i) => {
    const y = M.top + rowH * i;
    const v = b[sex];
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
    // 内側に置くときは面の色で抜く。
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

  house.people.forEach((p) => {
    const box = document.createElement('div');
    box.className = 'app-person';
    const items = p.applications.items.map(appItemHtml).join('');
    box.innerHTML = `<h3 class="sub-title">${p.label}（育休 ${ym(p.leaveStartAbs)}〜${ym(p.returnAbs - 1)}）</h3><ul class="apps">${items}</ul>`;
    host.appendChild(box);
  });

  // 世帯で1回だけのもの
  const box = document.createElement('div');
  box.className = 'app-person';
  box.innerHTML =
    `<h3 class="sub-title">世帯で1回</h3>` +
    `<ul class="apps">${householdApplications().map(appItemHtml).join('')}</ul>`;
  host.appendChild(box);
}

// ── 表 ────────────────────────────────

function drawTables(house) {
  // 年ごと
  const thead = document.querySelector('#year-table thead');
  const perCols = house.people.map((p) => `<th scope="col">${p.label}の<br><small>支払金額</small></th>`).join('');
  thead.innerHTML =
    `<tr><th scope="col">年</th>${perCols}` +
    `<th scope="col">給付金<br><small>非課税</small></th>` +
    `<th scope="col">所得税<br><small>世帯</small></th>` +
    `<th scope="col">住民税<br><small>翌年6月から</small></th>` +
    `<th scope="col">所得割額<br><small>保育料の基準</small></th></tr>`;

  const yb = document.querySelector('#year-table tbody');
  yb.textContent = '';
  for (const r of house.years) {
    const perCells = r.per.map((x) => `<td>${x.leave ? fmt(x.leave.paid) : '—'}</td>`).join('');
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${r.year}年</td>${perCells}` +
      `<td>${r.benefit ? fmt(r.benefit) : '—'}</td>` +
      `<td>${fmt(r.incomeTax)}</td>` +
      `<td>${fmt(r.residentTax)}</td>` +
      `<td>${fmt(r.shotokuwari)}</td>`;
    yb.appendChild(tr);
  }

  // 月ごと
  const payByAbs = new Map();
  for (const p of house.people) {
    for (const q of p.payments.payments) {
      payByAbs.set(q.payAbs, (payByAbs.get(q.payAbs) || 0) + q.amount);
    }
  }

  const mb = document.querySelector('#month-table tbody');
  mb.textContent = '';
  for (const m of house.months) {
    const gross = m.per.reduce((a, x) => a + x.leave.gross, 0);
    const shaho = m.per.reduce((a, x) => a + x.leave.shaho, 0);
    const tax = m.per.reduce((a, x) => a + x.leave.incomeTax, 0);
    const paid = payByAbs.get(m.abs) || 0;
    const tr = document.createElement('tr');
    if (m.onLeave) tr.className = 'on-leave';
    tr.innerHTML =
      `<td>${m.year}年${m.month}月${m.onLeave ? '（育休）' : ''}</td>` +
      `<td>${fmt(gross)}</td>` +
      `<td>${m.benefit ? fmt(m.benefit) : '—'}</td>` +
      `<td>${paid ? `<strong>${fmt(paid)}</strong>` : '—'}</td>` +
      `<td>${fmt(shaho)}</td>` +
      `<td>${fmt(tax)}</td>` +
      `<td>${fmt(m.residentTax)}</td>` +
      `<td>${fmt(m.leaveNet)}</td>`;
    mb.appendChild(tr);
  }

  // 入金の表
  const pb = document.querySelector('#pay-table tbody');
  pb.textContent = '';
  const rows = house.people.flatMap((p) =>
    p.payments.payments.map((q) => ({ label: p.label, q }))
  ).sort((a, b) => a.q.payAbs - b.q.payAbs);
  for (const { label, q } of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${label}</td>` +
      `<td>${ym(q.payAbs)}ごろ</td>` +
      `<td>${q.covers.map((c) => `${c.year}年${c.month}月`).join('・')}</td>` +
      `<td>${fmt(q.amount)}</td>`;
    pb.appendChild(tr);
  }
}

// ── 文章の部分 ────────────────────────────

function drawProse(house) {
  // ── 育休中の毎月の手取り（いちばん先に知りたいこと） ──
  $('hero-cards').innerHTML = house.people.map((p) => {
    const s = p.snapshot;
    if (!s || s.firstNet == null) return '';
    const late = s.lateNet != null
      ? `<div class="hc-late">7か月目からは <b>${fmt(s.lateNet)}円</b>（${s.lateRatio}%）になります</div>`
      : '';
    return `<div class="hero-card">` +
      `<div class="hc-who">${p.label}</div>` +
      `<div class="hc-main"><span class="hc-yen">${fmt(s.firstNet)}<span class="hc-unit">円</span></span>` +
      `<span class="hc-ratio">いまの ${s.firstRatio}%</span></div>` +
      `<div class="hc-sub">いまが ${fmt(s.beforeNet)}円 なので、${fmt(s.beforeNet - s.firstNet)}円 少なくなります。` +
      `給付金 ${fmt(s.firstBenefit)}円 が入り、社会保険料と所得税はかかりません。</div>` +
      late +
      `</div>`;
  }).join('');

  // ── 先に知っておくと落ち着けること ──
  const facts = [];

  const gapPerson = house.people.reduce(
    (a, b) => (b.payments.gapMonths > a.payments.gapMonths ? b : a)
  );
  if (gapPerson.payments.firstPayment) {
    facts.push({
      tag: '振り込み',
      head: `最初の振り込みは ${ym(gapPerson.payments.firstPayment.payAbs)}ごろ`,
      body: `${gapPerson.label}が育休に入ってから <b>${gapPerson.payments.gapMonths}か月</b>あきます。` +
        `そのあいだはお給料も止まっているので、ここは貯金でしのぐことになります。`,
      warn: true,
    });
  }

  const ms = house.months;
  const trap = ms.find((m) => m.onLeave && m.residentTax > 0 &&
    m.per.some((x) => x.leave.onLeave && x.leave.gross === 0));
  if (trap) {
    facts.push({
      tag: '住民税',
      head: '育休中も住民税は払い続けます',
      body: `${trap.year}年${trap.month}月は、お給料も社会保険料も所得税もゼロですが、` +
        `住民税だけは <b>${fmt(trap.residentTax)}円</b> 引かれます。` +
        `前の年の収入にかかる税なので、いま働いていなくても止まりません。`,
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
        `育休で収入が下がったぶんが、1年おくれてここで返ってきます。`,
      good: true,
    });
  }

  const d = house.summary.diff;
  facts.push({
    tag: '3年で見ると',
    head: `ふたり合わせて ${d < 0 ? man(Math.abs(d)) + ' 少なくなります' : man(d) + ' 多くなります'}`,
    body: `${ym(house.timeline.startAbs)}から${house.summary.monthsShown}か月ぶんの合計です。` +
      `育休を取ると ${fmt(house.summary.leaveTotal)}円、取らずに働き続けると ${fmt(house.summary.noLeaveTotal)}円。`,
  });

  $('key-facts').innerHTML = facts.map((f) =>
    `<div class="fact${f.warn ? ' warn' : ''}${f.good ? ' good' : ''}">` +
    `<div class="fact-tag">${f.tag}</div>` +
    `<div class="fact-head">${f.head}</div>` +
    `<div class="fact-body">${f.body}</div></div>`
  ).join('');

  // ── 3年ぶんの動きの下の一文 ──
  let text = '';
  if (trap) {
    const names = trap.per.filter((x) => x.leave.onLeave).map((x) => x.label).join('・');
    text += `${trap.year}年${trap.month}月は${names}が育休中で、その分のお給料も社会保険料も所得税もゼロです。` +
      `それでも住民税はふたり合わせて ${fmt(trap.residentTax)}円 引かれ続けます。前の年の収入にかかる税だからです。`;
  }
  if (dropIdx > 0 && dropAmt > 1000) {
    text += ` 下がるのは ${ms[dropIdx].year}年${ms[dropIdx].month}月から。` +
      `ふたり合わせて月 ${fmt(ms[dropIdx - 1].residentTax)}円 が ${fmt(ms[dropIdx].residentTax)}円 になります。`;
  }
  $('net-callout').textContent = text;

  // ── 振り込みの呼びかけ ──
  if (gapPerson.payments.firstPayment) {
    const g = gapPerson.payments;
    $('pay-callout').innerHTML =
      `${gapPerson.label}が育休に入るのは ${ym(gapPerson.leaveStartAbs)}。` +
      `最初の振り込みは <strong>${ym(g.firstPayment.payAbs)}ごろ</strong>で ${fmt(g.firstPayment.amount)}円です。` +
      `<strong>それまでの${g.gapMonths}か月は振り込みがありません。</strong>` +
      `お給料も止まっているので、この期間ぶんは手元に用意しておくと安心です。`;
  } else {
    $('pay-callout').textContent = '';
  }

  // ── 書類に載る年収が使われる場面 ──
  const perWorst = house.people.map((p) => {
    const w = p.sim.leave.years.reduce((a, c) => (c.paid < a.paid ? c : a));
    const no = p.sim.noLeave.years.find((r) => r.year === w.year);
    return { p, w, no };
  });
  $('who-list').innerHTML =
    perWorst.map(({ p, w, no }) =>
      `<li><strong>住宅ローンの審査（${p.label}）</strong>。${w.year + 1}年に申し込むと、` +
      `いちばん新しい源泉徴収票は ${w.year}年分の <strong>${man(w.paid)}</strong> です` +
      `（育休を取らなければ ${man(no ? no.paid : 0)}）。</li>`
    ).join('') +
    `<li><strong>保育料</strong>。ふたりの住民税を足した数字で段階が決まります。下にまとめています。</li>` +
    `<li><strong>児童手当は収入で変わりません</strong>（2024年10月に所得制限がなくなりました）。</li>`;

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
  if (e.target.closest('.person') || e.target.id === 'has-partner' || e.target.id === 'care-start') {
    render();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.closest('.person') || e.target.id === 'has-partner') render();
});
$('care-reset').addEventListener('click', () => {
  careStartOverride = null;
  render();
});

let resizeTimer;
window.addEventListener('resize', () => {
  document.querySelectorAll('.tip').forEach((t) => { t.hidden = true; });
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

// 保育の開始を人の育休に合わせて動かすとき、上書きを解除する
for (const cls of ['.p-start', '.p-months']) {
  document.querySelectorAll(cls).forEach((n) =>
    n.addEventListener('change', () => { careStartOverride = null; })
  );
}

render();
void childcareBasisYear;
