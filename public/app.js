// VALORANT 戦績サイトの画面。ビルド不要の素の ES モジュール。

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, opt) {
  const r = await fetch("/api" + path, opt);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { status: r.status });
  return body;
}

const state = {
  /** いま表示しているプレイヤー。トップページでは null。 */
  player: null,
  filters: { queue: "competitive", season: "", agent: "", map: "", last: "" },
  metric: "hs",
  syncing: false,
};

// ---------- 表示用の変換 ----------

const QUEUES = {
  competitive: "コンペティティブ", unrated: "アンレート", swiftplay: "スイフトプレイ", spikerush: "スパイクラッシュ",
  deathmatch: "デスマッチ", hurm: "チームデスマッチ", ggteam: "エスカレーション", premier: "Premier",
  custom5v5: "カスタム（5vs5）", custom: "カスタム（その他）", skirmish_2v2: "スカーミッシュ",
};
const TIER_GROUPS = ["アイアン", "ブロンズ", "シルバー", "ゴールド", "プラチナ", "ダイヤ", "アセンダント", "イモータル"];
function tierName(id) {
  if (id == null || id < 3) return "ランクなし";
  if (id >= 27) return "レディアント";
  return `${TIER_GROUPS[Math.floor((id - 3) / 3)]} ${((id - 3) % 3) + 1}`;
}
const TIER_SHORT = ["鉄", "銅", "銀", "金", "プラ", "ダイヤ", "アセ", "イモ"];
const tierShort = (id) => (id >= 27 ? "レディ" : id < 3 ? "" : `${TIER_SHORT[Math.floor((id - 3) / 3)]}${((id - 3) % 3) + 1}`);
/** ランク推移の目盛り: ランクが切り替わる 100 RR ごとの境界に線を引く。 */
function tierTicks(lo, hi) {
  const step = Math.max(1, Math.ceil((hi - lo) / 100 / 5)) * 100;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out.length ? out : null;
}
const RESULTS = { Elimination: "殲滅", Detonate: "爆破", Defuse: "解除" };
const div = (a, b) => (b ? a / b : null);
const pct = (v, d = 1) => (v == null ? "—" : (v * 100).toFixed(d) + "%");
const num = (v, d = 0) => (v == null ? "—" : v.toFixed(d));
const signed = (v) => (v == null ? "—" : (v > 0 ? "+" : "") + v);
const dateFmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
const seasonLabel = (s) => String(s).replace(/^e(\d+)a(\d+)$/, "E$1 A$2");
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** そのプレイヤーの戦績ページへのリンク先。未登録の人は開いたときに検索・登録される。 */
const findHref = (name, tag) => `#/find/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
const playerHref = (puuid) => `#/player/${puuid}`;

function agentCell(name, id, tag) {
  const img = id
    ? `<img src="https://media.valorant-api.com/agents/${esc(id)}/displayicon.png" alt="" loading="lazy" onerror="this.remove()">`
    : "";
  const label = `${esc(name ?? "—")}${tag ? `<span class="muted">#${esc(tag)}</span>` : ""}`;
  return `<span class="agent">${img}${tag ? `<a class="plink" href="${esc(findHref(name, tag))}" title="このプレイヤーの戦績を見る">${label}</a>` : label}</span>`;
}
function rankBadge(tier, rr) {
  if (tier == null) return "";
  const img = `<img src="https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/${tier}/smallicon.png" alt="" onerror="this.remove()">`;
  return `<span class="rank">${img}${esc(tierName(tier))}${rr == null ? "" : ` <span class="muted">${rr} RR</span>`}</span>`;
}

/** 合計行（全体、エージェント別、マップ別で共通）から割合系の指標を求める。 */
function derive(t) {
  const shots = t.headshots + t.bodyshots + t.legshots;
  return {
    winrate: div(t.wins, t.wins + t.losses),
    kd: div(t.kills, t.deaths),
    acs: div(t.score, t.rounds),
    // ダメージが記録されている試合のラウンドだけで割る（カスタムなどは記録が無い）
    adr: div(t.damage_dealt, t.dmg_rounds),
    hs: div(t.headshots, shots),
    body: div(t.bodyshots, shots),
    leg: div(t.legshots, shots),
    kast: div(t.kast_rounds, t.rounds),
  };
}

// ---------- ツールチップ ----------

const tip = $("#tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - r.width - 8)) + "px";
  tip.style.top = Math.max(8, y - r.height - 12) + "px";
}
const hideTip = () => (tip.hidden = true);

// ---------- 折れ線グラフ ----------

/**
 * 1系列の折れ線グラフを描く。points: [{ y, tip(HTML), x(軸ラベル) }]
 * 系列は1本だけなので凡例は置かず、カードの見出しが系列名を兼ねる。
 */
function lineChart(el, points, { fmt, avg, yLabel, ticks } = {}) {
  el.innerHTML = "";
  if (points.length < 2) {
    el.innerHTML = `<div class="empty">グラフにするには2試合以上のデータが必要です</div>`;
    return;
  }
  const W = Math.max(320, el.clientWidth);
  const H = 220;
  const m = { t: 12, r: 14, b: 24, l: 46 };
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1;
  lo -= pad; hi += pad;
  const sx = (i) => m.l + (i / (points.length - 1)) * (W - m.l - m.r);
  const sy = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  let g = "";
  const tickValues = (ticks && ticks(lo, hi)) || [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3);
  for (const v of tickValues) {
    g += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}"/>
          <text x="${m.l - 8}" y="${sy(v) + 4}" text-anchor="end">${esc(yLabel ? yLabel(v) : fmt(v))}</text>`;
  }
  const nLabels = Math.min(points.length, W < 520 ? 3 : 5);
  for (let k = 0; k < nLabels; k++) {
    const i = Math.round((k / (nLabels - 1)) * (points.length - 1));
    const anchor = k === 0 ? "start" : k === nLabels - 1 ? "end" : "middle";
    g += `<text x="${sx(i)}" y="${H - 6}" text-anchor="${anchor}">${esc(points[i].x)}</text>`;
  }
  if (avg != null) {
    g += `<line class="avg" x1="${m.l}" x2="${W - m.r}" y1="${sy(avg)}" y2="${sy(avg)}"/>
          <text x="${W - m.r}" y="${sy(avg) - 5}" text-anchor="end">平均 ${esc(fmt(avg))}</text>`;
  }
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const dots = points.length <= 60
    ? points.map((p, i) => `<circle class="dot" cx="${sx(i)}" cy="${sy(p.y)}" r="3.5"/>`).join("")
    : "";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">
    ${g}<path class="line" d="${d}"/>${dots}
    <line class="cross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <circle class="dot hover" r="5.5" visibility="hidden"/>
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>
  </svg>`;
  const svg = $("svg", el), cross = $(".cross", el), hover = $(".hover", el);
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (points.length - 1))));
    cross.setAttribute("x1", sx(i)); cross.setAttribute("x2", sx(i)); cross.setAttribute("visibility", "visible");
    hover.setAttribute("cx", sx(i)); hover.setAttribute("cy", sy(points[i].y)); hover.setAttribute("visibility", "visible");
    showTip(points[i].tip, ev.clientX, box.top + (sy(points[i].y) / H) * box.height);
  };
  const leave = () => { cross.setAttribute("visibility", "hidden"); hover.setAttribute("visibility", "hidden"); hideTip(); };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", leave);
}

// ---------- 共通UI ----------

const qs = () => {
  const p = new URLSearchParams({ puuid: state.player.puuid });
  for (const [k, v] of Object.entries(state.filters)) if (v) p.set(k, v);
  return p.toString();
};

function renderPlayer() {
  const p = state.player;
  const [, overview, matches] = $("#tabs").children;
  // 概要と試合一覧はプレイヤーごとのページなので、誰も選んでいないトップページでは出さない
  overview.hidden = matches.hidden = !p;
  if (!p) return ($("#player").innerHTML = "");
  const cur = p.rank?.current, peak = p.rank?.peak;
  $("#player").innerHTML = `
    <span class="name">${esc(p.name)}<span class="tag">#${esc(p.tag)}</span></span>
    ${cur ? rankBadge(cur.tier?.id, cur.rr) : ""}
    ${peak?.tier ? `<span class="muted">最高 ${esc(tierName(peak.tier.id))}（${esc(seasonLabel(peak.season?.short ?? ""))}）</span>` : ""}`;
  overview.href = playerHref(p.puuid);
  matches.href = playerHref(p.puuid) + "/matches";
}

function renderFilters(options) {
  const f = state.filters;
  const opts = (kind) => options.filter((o) => o.kind === kind);
  const sel = (key, label, items) =>
    `<label>${label}<select name="${key}">${items
      .map(([v, t]) => `<option value="${esc(v)}"${String(f[key]) === String(v) ? " selected" : ""}>${esc(t)}</option>`)
      .join("")}</select></label>`;
  const queues = opts("queue").map((o) => [o.value, `${QUEUES[o.value] ?? o.value}（${o.n}）`]);
  if (!queues.some(([v]) => v === f.queue) && f.queue !== "all") queues.unshift([f.queue, QUEUES[f.queue] ?? f.queue]);
  const form = $("#filters");
  form.hidden = false;
  form.innerHTML =
    sel("queue", "モード", [...queues, ["all", "通常マッチの合計（カスタムを除く）"]]) +
    sel("season", "アクト", [["", "すべて"], ...opts("season").map((o) => [o.value, seasonLabel(o.value)])]) +
    sel("agent", "エージェント", [["", "すべて"], ...opts("agent").map((o) => [o.value, o.value]).sort((a, b) => a[1].localeCompare(b[1]))]) +
    sel("map", "マップ", [["", "すべて"], ...opts("map").map((o) => [o.value, o.value]).sort((a, b) => a[1].localeCompare(b[1]))]) +
    sel("last", "範囲", [["", "全期間"], ["10", "直近10試合"], ["20", "直近20試合"], ["50", "直近50試合"]]);
}
$("#filters").addEventListener("change", (e) => {
  state.filters[e.target.name] = e.target.value;
  route();
});

// ---------- トップページ ----------

function viewTop() {
  $("#filters").hidden = true;
  $("#view").innerHTML = `
    <section class="card hero">
      <h1>プレイヤーを検索</h1>
      <form class="formrow" id="top-search">
        <input type="text" name="riot_id" placeholder="Riot ID（例: name#tag）" autocomplete="off" maxlength="60" aria-label="Riot ID で検索">
        <button class="btn primary">検索</button>
      </form>
      <p class="muted">Riot ID を入力すると、その人の戦績を取り込んで表示します。一度検索した人のデータは保存され、次からはすぐに開けます。</p>
    </section>`;
}

// ---------- 概要 ----------

const METRICS = {
  hs: { label: "HS%", get: (m) => div(m.headshots, m.headshots + m.bodyshots + m.legshots), fmt: (v) => pct(v, 0), tot: (d) => d.hs },
  acs: { label: "ACS", get: (m) => div(m.score, m.rounds), fmt: (v) => num(v), tot: (d) => d.acs },
  kd: { label: "K/D", get: (m) => div(m.kills, Math.max(1, m.deaths)), fmt: (v) => num(v, 2), tot: (d) => d.kd },
  adr: { label: "ADR", get: (m) => div(m.damage_dealt, m.dmg_rounds), fmt: (v) => num(v), tot: (d) => d.adr },
  kast: { label: "KAST", get: (m) => div(m.kast_rounds, m.rounds), fmt: (v) => pct(v, 0), tot: (d) => d.kast },
};

function breakdownTable(rows, first, firstCell) {
  if (!rows.length) return `<div class="empty">データがありません</div>`;
  return `<div class="tablewrap"><table>
    <thead><tr><th>${first}</th><th>試合</th><th class="l">勝率</th><th>K/D</th><th>ACS</th><th>ADR</th><th>HS%</th><th>KAST</th><th>FB</th><th>FD</th></tr></thead>
    <tbody>${rows.map((r) => {
      const d = derive(r);
      return `<tr><td>${firstCell(r)}</td><td>${r.games}</td>
        <td class="l">${pct(d.winrate, 0)}<span class="bar"><i style="width:${(d.winrate ?? 0) * 100}%"></i></span></td>
        <td>${num(d.kd, 2)}</td><td>${num(d.acs)}</td><td>${num(d.adr)}</td><td>${pct(d.hs)}</td><td>${pct(d.kast, 0)}</td>
        <td>${r.fk}</td><td>${r.fd}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

async function viewOverview() {
  const [stats, matches, mmr] = await Promise.all([
    api("/stats?" + qs()),
    api("/matches?limit=200&" + qs()),
    api("/mmr?puuid=" + state.player.puuid),
  ]);
  renderFilters(stats.options);
  const t = stats.totals;
  if (!t || !t.games) {
    $("#view").innerHTML = `<div class="card empty">${state.syncing ? "試合データを取り込んでいます。少しずつ表示されます…" : "この条件に当てはまる試合がありません"}</div>`;
    return;
  }
  const d = derive(t);
  const rb = matches.some((m) => m.round_based);
  const rbOnly = (html) => (rb ? html : "—");
  const tile = (k, v, s) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const shots = t.headshots + t.bodyshots + t.legshots;

  $("#view").innerHTML = `
    <section class="tiles">
      ${tile("勝率", pct(d.winrate), `${t.wins}勝 ${t.losses}敗${t.draws ? ` ${t.draws}分` : ""}（${t.games}試合）`)}
      ${tile("K/D", num(d.kd, 2), `${t.kills} / ${t.deaths} / ${t.assists}`)}
      ${tile("ACS", rbOnly(num(d.acs)), "1ラウンドあたりの戦闘スコア")}
      ${tile("ADR", rbOnly(num(d.adr)), !rb ? "" : !t.dmg_rounds ? "このモードはダメージの記録なし" : t.dmg_rounds < t.rounds ? "ダメージの記録がない試合を除いて計算" : "1ラウンドあたりのダメージ")}
      ${tile("HS%", shots ? pct(d.hs) : "—", shots ? `命中 ${shots} 発のうち頭 ${t.headshots} 発` : "このモードは命中部位の記録なし")}
      ${tile("KAST", rbOnly(pct(d.kast, 0)), "キル・アシスト・生存・トレードのいずれかがあったラウンド")}
      ${tile("FB（先制キル）", rbOnly(String(t.fk)), rb ? `1試合 ${num(t.fk / t.games, 1)} 回 ・ 取った時のラウンド勝率 ${pct(div(t.fk_wins, t.fk), 0)}` : "")}
      ${tile("FD（先制デス）", rbOnly(String(t.fd)), rb ? `1試合 ${num(t.fd / t.games, 1)} 回 ・ された時のラウンド勝率 ${pct(div(t.fd_wins, t.fd), 0)}` : "")}
    </section>

    <section class="grid">
      <div class="card c7">
        <h2><span>試合ごとの推移 <small>古い順・${matches.length}試合</small></span>
          <span class="seg" id="metric">${Object.entries(METRICS).map(([k, m]) => `<button type="button" data-m="${k}" class="${k === state.metric ? "on" : ""}">${m.label}</button>`).join("")}</span></h2>
        <div class="chart" id="trend"></div>
      </div>
      <div class="card c5">
        <h2><span>ランク推移 <small>コンペティティブ</small></span></h2>
        <div class="chart" id="rr"></div>
      </div>
    </section>

    <section class="grid">
      <div class="card c4">
        <h2>命中部位</h2>
        ${shots ? `<div class="stack">
            <i style="flex:${t.headshots};background:var(--series-1)"></i><i style="flex:${t.bodyshots};background:var(--series-2)"></i><i style="flex:${t.legshots};background:var(--series-3)"></i>
          </div>
          <div class="legend">
            <span><i class="sw" style="background:var(--series-1)"></i>頭 <b>${pct(d.hs)}</b></span>
            <span><i class="sw" style="background:var(--series-2)"></i>胴 <b>${pct(d.body)}</b></span>
            <span><i class="sw" style="background:var(--series-3)"></i>脚 <b>${pct(d.leg)}</b></span>
          </div>` : `<div class="empty">記録なし</div>`}
      </div>
      <div class="card c4">
        <h2>攻守別</h2>
        ${rb ? `<div class="tablewrap"><table>
          <thead><tr><th></th><th>ラウンド</th><th>勝率</th><th>K/D</th></tr></thead>
          <tbody>
            <tr><td>攻め</td><td>${t.atk_rounds}</td><td>${pct(div(t.atk_wins, t.atk_rounds), 0)}</td><td>${num(div(t.atk_kills, t.atk_deaths), 2)}</td></tr>
            <tr><td>守り</td><td>${t.def_rounds}</td><td>${pct(div(t.def_wins, t.def_rounds), 0)}</td><td>${num(div(t.def_kills, t.def_deaths), 2)}</td></tr>
            <tr><td>ピストル</td><td>${t.pistol_rounds}</td><td>${pct(div(t.pistol_wins, t.pistol_rounds), 0)}</td><td>—</td></tr>
          </tbody></table></div>` : `<div class="empty">ラウンド制のモードのみ</div>`}
      </div>
      <div class="card c4">
        <h2>ラウンド内の動き</h2>
        ${rb ? `<dl class="kv">
          <dt>マルチキル（2 / 3 / 4 / 5）</dt><dd>${t.mk2} / ${t.mk3} / ${t.mk4} / ${t.mk5}</dd>
          <dt>クラッチ成功</dt><dd>${t.clutch_wins}<small>${t.clutch_attempts} 回中${stats.clutches.length ? " ・ " + stats.clutches.map((c) => `1v${esc(c.vs)}×${c.n}`).join(" ") : ""}</small></dd>
          <dt>トレードキル</dt><dd>${t.trade_kills}<small>味方の仇を5秒以内に取った</small></dd>
          <dt>トレードされたデス</dt><dd>${t.traded_deaths}<small>デスの ${pct(div(t.traded_deaths, t.deaths), 0)}</small></dd>
          <dt>設置 / 解除</dt><dd>${t.plants} / ${t.defuses}</dd>
        </dl>` : `<div class="empty">ラウンド制のモードのみ</div>`}
      </div>
    </section>

    <section class="grid">
      <div class="card c12"><h2>エージェント別</h2>${breakdownTable(stats.byAgent, "エージェント", (r) => agentCell(r.agent, r.agent_id))}</div>
      <div class="card c12"><h2>マップ別</h2>${breakdownTable(stats.byMap, "マップ", (r) => esc(r.map))}</div>
      <div class="card c6"><h2>武器別キル</h2>${weaponTable(stats.weapons, t.kills)}</div>
      <div class="card c6"><h2>一緒に遊んだ人 <small>同じパーティーだった試合</small></h2>${mateTable(stats.teammates)}</div>
    </section>`;

  const asc = [...matches].reverse();
  const drawTrend = () => {
    const mt = METRICS[state.metric];
    const usable = asc.filter((m) => mt.get(m) != null && (rb ? m.round_based : true));
    lineChart($("#trend"), usable.map((m) => ({
      y: mt.get(m),
      x: dayFmt.format(m.started_at).slice(5),
      tip: `<b>${esc(mt.fmt(mt.get(m)))}</b> ${mt.label}<br>${esc(dateFmt.format(m.started_at))} ・ ${esc(m.map)} ・ ${esc(m.agent)}<br>${m.won === 1 ? "勝ち" : m.won === 0 ? "負け" : "引き分け"} ${m.rounds_won}-${m.rounds_lost} ・ ${m.kills}/${m.deaths}/${m.assists}`,
    })), { fmt: mt.fmt, avg: mt.tot(d) });
  };
  drawTrend();
  $("#metric").addEventListener("click", (e) => {
    const k = e.target.dataset?.m;
    if (!k) return;
    state.metric = k;
    for (const b of $("#metric").children) b.classList.toggle("on", b.dataset.m === k);
    drawTrend();
  });

  const drawRr = () =>
    lineChart($("#rr"), mmr.filter((h) => h.elo != null).map((h) => ({
      y: h.elo,
      x: dayFmt.format(h.date).slice(5),
      tip: `<b>${esc(tierName(h.tier))}</b> ${h.rr} RR<br>${esc(dateFmt.format(h.date))} ・ ${esc(h.map ?? "")}<br>増減 ${esc(signed(h.rr_change))}`,
    })), { fmt: (v) => num(v), yLabel: (v) => tierShort(Math.round(v / 100) + 3), ticks: tierTicks });
  drawRr();
  onResize = () => { drawTrend(); drawRr(); };
}

function weaponTable(rows, totalKills) {
  if (!rows.length) return `<div class="empty">データがありません</div>`;
  const max = rows[0].kills;
  return `<div class="tablewrap"><table><thead><tr><th>武器</th><th class="l">キル</th><th>割合</th></tr></thead><tbody>
    ${rows.slice(0, 12).map((w) => `<tr><td>${esc(w.weapon)}</td>
      <td class="l">${w.kills}<span class="bar"><i style="width:${(w.kills / max) * 100}%"></i></span></td>
      <td>${pct(div(w.kills, totalKills), 0)}</td></tr>`).join("")}</tbody></table></div>`;
}
function mateTable(rows) {
  if (!rows.length) return `<div class="empty">パーティーで遊んだ試合がありません</div>`;
  return `<div class="tablewrap"><table><thead><tr><th>プレイヤー</th><th>試合</th><th class="l">勝率</th><th>勝敗</th></tr></thead><tbody>
    ${rows.slice(0, 12).map((m) => {
      const wr = div(m.wins, m.wins + m.losses);
      return `<tr><td>${esc(m.name)}<span class="muted">#${esc(m.tag)}</span></td><td>${m.games}</td>
        <td class="l">${pct(wr, 0)}<span class="bar"><i style="width:${(wr ?? 0) * 100}%"></i></span></td><td>${m.wins}勝 ${m.losses}敗</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

// ---------- 試合一覧 ----------

const resultCell = (won) => `<span class="res ${won === 1 ? "w" : won === 0 ? "l" : ""}">${won === 1 ? "勝ち" : won === 0 ? "負け" : "—"}</span>`;

async function viewMatches() {
  const [stats, matches] = await Promise.all([api("/stats?" + qs()), api("/matches?limit=500&" + qs())]);
  renderFilters(stats.options);
  if (!matches.length) {
    $("#view").innerHTML = `<div class="card empty">この条件に当てはまる試合がありません</div>`;
    return;
  }
  $("#view").innerHTML = `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th>結果</th><th class="l">日時</th><th class="l">マップ</th><th class="l">エージェント</th><th>スコア</th><th>K / D / A</th><th>ACS</th><th>HS%</th><th>KAST</th><th>FB</th><th>FD</th><th>RR</th></tr></thead>
    <tbody>${matches.map((m) => {
      const shots = m.headshots + m.bodyshots + m.legshots;
      const r = m.round_based;
      return `<tr class="click" data-id="${esc(m.match_id)}">
        <td>${resultCell(m.won)}</td><td class="l">${esc(dateFmt.format(m.started_at))}</td><td class="l">${esc(m.map)}</td>
        <td class="l">${agentCell(m.agent, m.agent_id)}</td><td>${r ? `${m.rounds_won} - ${m.rounds_lost}` : "—"}</td>
        <td>${m.kills} / ${m.deaths} / ${m.assists}</td><td>${r ? num(div(m.score, m.rounds)) : "—"}</td>
        <td>${shots ? pct(m.headshots / shots, 0) : "—"}</td><td>${r ? pct(div(m.kast_rounds, m.rounds), 0) : "—"}</td>
        <td>${r ? m.fk : "—"}</td><td>${r ? m.fd : "—"}</td><td>${m.rr_change == null ? `<span class="muted">—</span>` : esc(signed(m.rr_change))}</td></tr>`;
    }).join("")}</tbody></table></div></div>`;
  $("#view tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) location.hash = "#/match/" + tr.dataset.id;
  });
}

// ---------- 試合詳細 ----------

async function viewMatch(id) {
  $("#filters").hidden = true;
  const m = await api("/match/" + id);
  const me = m.players.find((p) => p.puuid === state.player?.puuid);
  const myTeam = me?.team ?? Object.keys(m.score)[0];
  const teams = [...new Set(m.players.map((p) => p.team))].sort((a, b) => (a === myTeam ? -1 : b === myTeam ? 1 : 0));
  const rb = !!m.round_based;
  const enemy = teams.find((t) => t !== myTeam);

  const board = (team) => {
    const rows = m.players.filter((p) => p.team === team);
    const label = !rb ? "参加者" : team === myTeam ? "自チーム" : "相手チーム";
    return `<div class="card c12"><h2>${label}${rb ? ` <small>${m.score[team] ?? 0} ラウンド獲得</small>` : ""}</h2>
      <div class="tablewrap"><table>
      <thead><tr><th>プレイヤー</th><th class="l">ランク</th><th>ACS</th><th>K / D / A</th><th>+/-</th><th>ADR</th><th>HS%</th><th>KAST</th><th>FB</th><th>FD</th><th>3K+</th><th>クラッチ</th></tr></thead>
      <tbody>${rows.map((p) => {
        const shots = p.headshots + p.bodyshots + p.legshots;
        return `<tr class="${p.puuid === me?.puuid ? "me" : ""}">
          <td>${agentCell(p.name, p.agent_id, p.tag)}</td>
          <td class="l">${esc(tierName(p.tier))}</td><td>${rb ? num(div(p.score, p.rounds)) : "—"}</td>
          <td>${p.kills} / ${p.deaths} / ${p.assists}</td><td>${esc(signed(p.kills - p.deaths))}</td>
          <td>${rb ? num(div(p.damage_dealt, p.dmg_rounds)) : "—"}</td><td>${shots ? pct(p.headshots / shots, 0) : "—"}</td>
          <td>${rb ? pct(div(p.kast_rounds, p.rounds), 0) : "—"}</td><td>${rb ? p.fk : "—"}</td><td>${rb ? p.fd : "—"}</td>
          <td>${rb ? p.mk3 + p.mk4 + p.mk5 : "—"}</td><td>${rb ? p.clutch_wins : "—"}</td></tr>`;
      }).join("")}</tbody></table></div></div>`;
  };

  $("#view").innerHTML = `
    <a class="back" href="${state.player ? playerHref(state.player.puuid) + "/matches" : "#/"}">← ${state.player ? "試合一覧" : "トップ"}</a>
    <div class="mhead">
      ${me ? resultCell(me.won) : ""}
      ${rb ? `<span class="score">${m.score[myTeam] ?? 0} - ${m.score[enemy] ?? 0}</span>` : ""}
      <span><b>${esc(m.map)}</b> ・ ${esc(QUEUES[m.queue] ?? m.queue_name ?? m.queue)}</span>
      <span class="muted">${esc(dayFmt.format(m.started_at))} ${esc(dateFmt.format(m.started_at).split(" ").pop())} ・ ${Math.round(m.game_length_ms / 60000)}分 ・ ${esc(seasonLabel(m.season))}</span>
    </div>
    <section class="grid">
      ${rb ? `<div class="card c12"><h2>ラウンド <small>下線の色: 自チームが取った / 落とした ・ クリックでキルの流れを表示</small></h2>
        <div class="rounds" id="rounds"></div><ul class="feed" id="feed"></ul></div>` : ""}
      ${teams.map(board).join("")}
    </section>`;

  if (!rb || !m.detail?.rounds?.length) return;
  const players = m.detail.players.map((puuid) => m.players.find((p) => p.puuid === puuid));
  const who = (i) => {
    const p = players[i];
    if (!p) return `<span class="muted">不明</span>`;
    const cls = p.puuid === me?.puuid ? "mine" : p.team === myTeam ? "ally" : "enemy";
    return `<span class="who"><span class="${cls}">${esc(p.name)}</span> <span class="muted">${esc(p.agent ?? "")}</span></span>`;
  };
  const roundsEl = $("#rounds");
  roundsEl.innerHTML = m.detail.rounds.map((r, i) =>
    `${i === 12 || (i >= 24 && i % 2 === 0) ? `<span class="gap"></span>` : ""}<button type="button" data-i="${i}" class="${r.winner === myTeam ? "w" : "l"}" title="${r.winner === myTeam ? "獲得" : "失点"}"><b>${i + 1}</b>${esc(RESULTS[r.result] ?? "他")}</button>`).join("");
  const show = (i) => {
    const r = m.detail.rounds[i];
    for (const b of roundsEl.querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.i) === i);
    const side = r.role ? (r.winner === myTeam ? r.role : r.role === "Attacker" ? "Defender" : "Attacker") : "";
    const events = r.kills.map((k) => ({ t: k.t, html: k.k === k.v || k.k < 0
      ? `${who(k.v)} <span class="pill">${esc(k.w === "Spike" ? "スパイクで死亡" : k.w === "Fall" ? "落下死" : "自滅")}</span>`
      : `${who(k.k)} <span class="pill">${esc(k.w)}</span> ${who(k.v)}` }));
    const firstReal = r.kills.findIndex((k) => k.k >= 0 && k.k !== k.v && players[k.k]?.team !== players[k.v]?.team);
    if (firstReal >= 0) events[firstReal].html += ` <span class="pill">FB</span>`;
    if (r.plant) events.push({ t: r.plant.t, html: `${who(r.plant.by)} がスパイクを設置${r.plant.site ? `（${esc(r.plant.site)}）` : ""}` });
    if (r.defuse) events.push({ t: r.defuse.t, html: `${who(r.defuse.by)} がスパイクを解除` });
    events.sort((a, b) => a.t - b.t);
    $("#feed").innerHTML =
      `<li><span class="muted">第${i + 1}ラウンド ・ ${side === "Attacker" ? "攻め" : side === "Defender" ? "守り" : ""} ・ ${r.winner === myTeam ? "獲得" : "失点"}（${esc(RESULTS[r.result] ?? "その他")}）</span></li>` +
      (events.map((e) => `<li><span class="t">${clock(e.t)}</span>${e.html}</li>`).join("") || `<li class="muted">キルの記録なし</li>`);
  };
  roundsEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (b) show(Number(b.dataset.i));
  });
  show(0);
}

// ---------- チーム分け ----------

const ROLES = { duelist: "デュエリスト", initiator: "イニシエーター", controller: "コントローラー", sentinel: "センチネル" };
const team = { players: [], maps: [], selected: new Set(), guests: [], pairs: [], result: null, variant: 0, flip: 0, map: null, msg: "", failed: [], adding: false };
/** まとめて追加できる人数の上限と、新規登録どうしの間隔（外部 API のレート制限に収めるため）。 */
const TEAM_ADD_MAX = 20;
const TEAM_ADD_GAP_MS = 6000;
try {
  const saved = JSON.parse(localStorage.getItem("team") ?? "{}");
  team.selected = new Set(saved.selected ?? []);
  team.guests = saved.guests ?? [];
  team.pairs = Array.isArray(saved.pairs) ? saved.pairs : [];
} catch {}
const saveTeam = () => {
  try { localStorage.setItem("team", JSON.stringify({ selected: [...team.selected], guests: team.guests, pairs: team.pairs })); } catch {}
};
/** いま選ばれている参加者（登録者は puuid、ゲストは guest:<番号> が id）。ペアの指定に使う。 */
const teamPeople = () => [
  ...team.players.filter((p) => team.selected.has(p.id)).map((p) => ({ id: p.id, label: p.name + (p.tag ? "#" + p.tag : "") })),
  ...team.guests.map((g, k) => ({ id: `guest:${k}`, label: `${g.name}（ゲスト）` })),
];
/** 参加者から外れた人を含む指定は消す。 */
const prunePairs = () => {
  const ids = new Set(teamPeople().map((p) => p.id));
  team.pairs = team.pairs.filter((p) => ids.has(p.a) && ids.has(p.b));
};
const PAIR_MAX = 20;
const teamRank = (p) =>
  p.guest ? tierName(p.tier) : p.tier == null ? (p.basis === "level" ? `ランクなし（Lv${p.level}）` : "ランクなし（仮）") : p.estimated ? `${tierName(p.tier)}（過去）` : `${tierName(p.tier)} ${p.rr ?? 0}RR`;
/** レートの内訳（数字にカーソルを合わせたときに出す）。 */
function ratingDetail(p) {
  const base = p.basis === "level" ? `ランクの記録なし・アカウントレベル ${p.level} から算出`
    : p.basis === "average" ? "ランクもレベルも不明・参加者の平均で仮置き"
    : p.current == null ? `現在ランクなし・過去の実績 ${p.proven} から算出`
    : p.proven != null && p.proven > p.current ? `現在 ${p.current} を過去の実績 ${p.proven} の側へ寄せた値` : `現在 ${p.current}`;
  const sign = (n) => (n >= 0 ? "+" : "") + n;
  const rr = p.trend ? ` ＋ RRの増減 ${sign(p.rrAdj)}（直近 ${p.trend.n} 試合。勝ち平均 +${p.trend.w} / 負け平均 ${p.trend.l}）` : "";
  return `ランク由来 ${p.base}（${base}）${rr} ＋ 成績補正 ${sign(p.adj)}（直近 ${p.samples} 試合。エージェントと相手のランク帯から見込まれる成績との差）`;
}
const teamSize = () => team.selected.size + team.guests.length;
const pickMap = (except) => {
  const pool = team.maps.length > 1 ? team.maps.filter((m) => m !== except) : team.maps;
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
};

function teamResultHtml() {
  const r = team.result;
  if (!r) return `<div class="empty">参加者を2人以上選んで「チーム分けする」を押してください</div>`;
  const o = r.options[team.variant % r.options.length];
  const by = new Map(r.players.map((p) => [p.id, p]));
  const [atk, def] = team.flip ? [o.b, o.a] : [o.a, o.b];
  const block = (label, ids) => {
    const members = ids.map((id) => by.get(id)).sort((x, y) => y.rating - x.rating);
    const avg = Math.round(members.reduce((a, p) => a + p.rating, 0) / members.length);
    return `<div class="team"><h3>${label}<small>${members.length}人 ・ 平均 ${avg}</small></h3><ul>${members.map((p) =>
      `<li><span>${esc(p.name)}${p.tag ? `<span class="muted">#${esc(p.tag)}</span>` : ` <span class="pill">ゲスト</span>`}</span>
           <span>${esc(teamRank(p))} ・ ${esc(ROLES[p.role] ?? "ロール不明")} ・ ${p.rating}</span></li>`).join("")}</ul></div>`;
  };
  return `
    ${r.pairsSatisfied === false ? `<p class="msg">ペアの指定をすべて満たす分け方がないため、指定なしで分けています。</p>` : ""}
    <p class="summary">${team.map ? `マップ: <b>${esc(team.map)}</b> ・ ` : ""}${atk.length === def.length
      ? `戦力差（1人あたり） <b>${o.diff}</b>`
      : `人数が違うので合計の戦力で釣り合わせています（合計の差 <b>${o.sumDiff}</b>）`}
      <span class="muted">（案 ${(team.variant % r.options.length) + 1}/${r.options.length}）</span></p>
    ${block("アタッカー側", atk)}${block("ディフェンダー側", def)}
    <div class="actions">
      <button type="button" class="btn" data-act="reroll"${r.options.length < 2 ? " disabled" : ""}>振り直し</button>
      <button type="button" class="btn" data-act="remap"${team.maps.length < 2 ? " disabled" : ""}>マップ変更</button>
      <button type="button" class="btn" data-act="flip">攻守を入れ替え</button>
      <button type="button" class="btn" data-act="copy">結果をコピー</button>
    </div>`;
}

function teamResultText() {
  const r = team.result, o = r.options[team.variant % r.options.length];
  const by = new Map(r.players.map((p) => [p.id, p]));
  const [atk, def] = team.flip ? [o.b, o.a] : [o.a, o.b];
  const block = (label, ids) => {
    const members = ids.map((id) => by.get(id)).sort((x, y) => y.rating - x.rating);
    const avg = Math.round(members.reduce((a, p) => a + p.rating, 0) / members.length);
    return [`${label}（平均 ${avg}）`, ...members.map((p) => `・${p.name}${p.tag ? "#" + p.tag : ""}（${teamRank(p)} / ${ROLES[p.role] ?? "ロール不明"}）`)].join("\n");
  };
  return [`【チーム分け】${team.map ? `マップ: ${team.map}` : ""}`, block("アタッカー側", atk), block("ディフェンダー側", def)].join("\n");
}

function renderTeams() {
  const n = teamSize();
  const people = teamPeople();
  const labelOf = new Map(people.map((x) => [x.id, x.label]));
  $("#view").innerHTML = `
    <section class="grid">
      <div class="card c7">
        <h2><span>参加者を選ぶ</span><small>${n} / 10 人を選択中</small></h2>
        <form class="formrow" id="team-add">
          <textarea name="riot_ids" rows="2" maxlength="1500" placeholder="Riot ID で追加（例: name#tag）&#10;複数人は改行かカンマで区切ってまとめて追加できます" aria-label="Riot ID（複数可）"${team.adding ? " disabled" : ""}></textarea>
          <button class="btn"${team.adding ? " disabled" : ""}>追加</button>
        </form>
        <div class="msg" id="team-msg">${esc(team.msg)}${team.failed.length ? `<ul class="fails">${team.failed.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}</div>
        ${team.players.length ? `<div class="tablewrap"><table>
          <thead><tr><th></th><th class="l">プレイヤー</th><th class="l">ランク</th><th class="l">ロール</th><th>レート</th><th></th></tr></thead>
          <tbody>${team.players.map((p) => `<tr class="pick" data-id="${esc(p.id)}">
            <td><input type="checkbox" ${team.selected.has(p.id) ? "checked" : ""} aria-label="${esc(p.name)} を選ぶ"></td>
            <td class="l">${esc(p.name)}<span class="muted">#${esc(p.tag)}</span></td>
            <td class="l">${esc(teamRank(p))}</td><td class="l">${esc(ROLES[p.role] ?? "不明")}</td>
            <td title="${esc(ratingDetail(p))}">${p.rating}</td>
            <td><a class="plink muted" href="${esc(findHref(p.name, p.tag))}">戦績</a>
              ${p.removable ? `<button type="button" class="btn small" data-act="remove">削除</button>` : ""}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="empty">まだ誰も登録されていません。上の欄に Riot ID を入れて追加してください</div>`}

        <div class="sub">ゲスト<small>Riot ID を使わず、名前とランクを手入力する</small></div>
        <form class="formrow" id="team-guest">
          <input type="text" name="name" placeholder="名前" maxlength="24" aria-label="ゲストの名前">
          <select name="tier" aria-label="ランク">${Array.from({ length: 25 }, (_, k) => k + 3).map((t) => `<option value="${t}"${t === 13 ? " selected" : ""}>${tierName(t)}</option>`).join("")}</select>
          <select name="role" aria-label="ロール"><option value="">ロール不明</option>${Object.entries(ROLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          <button class="btn">追加</button>
        </form>
        ${team.guests.length ? `<div class="tablewrap"><table><tbody>${team.guests.map((g, k) => `<tr>
          <td>${esc(g.name)} <span class="pill">ゲスト</span></td><td class="l">${esc(tierName(g.tier))}</td>
          <td class="l">${esc(ROLES[g.role] ?? "ロール不明")}</td><td>${(g.tier - 3) * 100 + 50}</td>
          <td><button type="button" class="btn small" data-act="guest-remove" data-k="${k}">削除</button></td></tr>`).join("")}</tbody></table></div>` : ""}
      </div>
      <div class="card c5">
        <h2><span>チーム分け</span>
          <button type="button" class="btn primary" data-act="split"${n < 2 || n > 10 ? " disabled" : ""}>チーム分けする</button></h2>
        ${people.length >= 2 ? `
        <div class="sub">ペアの指定<small>同じチームにしたい2人・分けたい2人（指定を満たす分け方の中から選びます）</small></div>
        <form class="formrow" id="team-pair">
          <select name="a" aria-label="1人目">${people.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join("")}</select>
          <select name="b" aria-label="2人目">${people.map((x, k) => `<option value="${esc(x.id)}"${k === 1 ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select>
          <select name="mode" aria-label="指定の種類"><option value="together">同じチームに</option><option value="apart">別のチームに</option></select>
          <button class="btn"${team.pairs.length >= PAIR_MAX ? " disabled" : ""}>指定する</button>
        </form>
        ${team.pairs.length ? `<ul class="pairs">${team.pairs.map((x, k) => `<li><span>${esc(labelOf.get(x.a) ?? "?")} と ${esc(labelOf.get(x.b) ?? "?")} を<b>${x.mode === "together" ? "同じチームに" : "別のチームに"}</b></span>
          <button type="button" class="btn small" data-act="pair-remove" data-k="${k}">削除</button></li>`).join("")}</ul>` : ""}` : ""}
        <div id="team-result">${teamResultHtml()}</div>
        <p class="muted" style="font-size:12px;margin:14px 0 0">レート = ランク（現在のランクと過去の実績から算出）＋ 直近の成績による補正（最大±300）。戦力差は、参加者の平均から大きく離れた人ほど強く効くものとして計算します。レートの数字にカーソルを合わせると内訳が出ます。追加した人の試合は順次取り込まれ、補正とロールに反映されます。</p>
      </div>
    </section>`;
}

async function viewTeams() {
  $("#filters").hidden = true;
  const d = await api("/team/players");
  team.players = d.players;
  team.maps = d.maps;
  const ids = new Set(d.players.map((p) => p.id));
  for (const id of [...team.selected]) if (!ids.has(id)) team.selected.delete(id);
  renderTeams();
}

const changed = () => { team.result = null; prunePairs(); saveTeam(); renderTeams(); };

/** 入力欄の文字列を Riot ID の一覧にする。改行・カンマ・読点で区切り、重複は除く（名前には空白を含められる）。 */
function parseRiotIds(text) {
  const seen = new Set();
  return text.split(/[\n,、，]+/).map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
}

/** Riot ID を順番に登録する。登録済みの人は即座に、新規の人は間隔を空けて1人ずつ処理する。 */
async function addPlayers(ids) {
  const skipped = ids.length - TEAM_ADD_MAX;
  ids = ids.slice(0, TEAM_ADD_MAX);
  team.adding = true;
  team.failed = [];
  let added = 0;
  const onTeams = () => location.hash === "#/teams";
  const show = (msg) => { team.msg = msg; if (onTeams()) renderTeams(); };
  for (const [k, riotId] of ids.entries()) {
    const label = ids.length > 1 ? `（${k + 1} / ${ids.length} 人目）` : "";
    show(`「${riotId}」を検索しています…${label}`);
    for (let attempt = 0; ; attempt++) {
      try {
        const { player, fresh } = await api("/team/players", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ riot_id: riotId }) });
        team.players = team.players.some((p) => p.id === player.id) ? team.players.map((p) => (p.id === player.id ? player : p)) : [...team.players, player];
        if (teamSize() < 10 || team.selected.has(player.id)) team.selected.add(player.id);
        added++;
        if (fresh && k < ids.length - 1) {
          show(`${player.name}#${player.tag} を追加しました。次の人を検索します…${label}`);
          await wait(TEAM_ADD_GAP_MS);
        }
        break;
      } catch (err) {
        // 回数制限に当たったら少し待ってやり直す。それ以外（見つからない等）は次の人へ進む
        if (err.status === 429 && attempt < 2) {
          show(`API の回数制限に達しました。30秒待って再開します…${label}`);
          await wait(30000);
          continue;
        }
        team.failed.push(`${riotId}: ${err.message}`);
        break;
      }
    }
  }
  team.adding = false;
  team.msg = `${added} 人を追加しました` + (team.failed.length ? `。${team.failed.length} 人は追加できませんでした` : "") + (skipped > 0 ? `。一度に追加できるのは ${TEAM_ADD_MAX} 人までです（残り ${skipped} 人は未処理）` : "");
  team.result = null;
  saveTeam();
  if (onTeams()) renderTeams();
}

$("#view").addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.id === "team-add") {
    e.preventDefault();
    if (team.adding) return;
    const ids = parseRiotIds(form.riot_ids.value);
    if (ids.length) addPlayers(ids);
  } else if (form.id === "team-guest") {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name || teamSize() >= 10) return;
    team.guests.push({ name, tier: Number(form.tier.value), role: form.role.value });
    changed();
  } else if (form.id === "team-pair") {
    e.preventDefault();
    const a = form.a.value, b = form.b.value, mode = form.mode.value;
    if (!a || !b || a === b) { team.msg = "ペアの指定は、別々の2人を選んでください。"; return renderTeams(); }
    // 同じ2人への指定は、新しいもので置き換える
    team.pairs = team.pairs.filter((x) => !((x.a === a && x.b === b) || (x.a === b && x.b === a)));
    if (team.pairs.length < PAIR_MAX) team.pairs.push({ a, b, mode });
    team.msg = "";
    changed();
  }
});

$("#view").addEventListener("keydown", (e) => {
  // Riot ID の入力欄: Enter で追加、Shift+Enter で改行
  if (e.target.name === "riot_ids" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

$("#view").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const row = e.target.closest("tr.pick");
  if (act === "remove" && row) {
    try {
      await api("/team/players/" + row.dataset.id, { method: "DELETE" });
      team.players = team.players.filter((p) => p.id !== row.dataset.id);
      team.selected.delete(row.dataset.id);
      team.msg = "";
    } catch (err) {
      team.msg = err.message;
    }
    return changed();
  }
  if (act === "guest-remove") {
    const k = Number(e.target.dataset.k);
    team.guests.splice(k, 1);
    // ゲストの id は並び順なので、消した人を含む指定を外し、後ろの人の番号を詰める
    const shift = (id) => (id.startsWith("guest:") && Number(id.slice(6)) > k ? `guest:${Number(id.slice(6)) - 1}` : id);
    team.pairs = team.pairs.filter((x) => x.a !== `guest:${k}` && x.b !== `guest:${k}`).map((x) => ({ ...x, a: shift(x.a), b: shift(x.b) }));
    return changed();
  }
  if (act === "pair-remove") {
    team.pairs.splice(Number(e.target.dataset.k), 1);
    return changed();
  }
  if (act === "split") {
    e.target.disabled = true;
    try {
      team.result = await api("/team/split", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...team.selected], guests: team.guests, pairs: team.pairs }) });
      team.variant = 0;
      team.flip = Math.random() < 0.5 ? 1 : 0;
      team.maps = team.result.maps;
      team.map = pickMap(null);
      team.msg = "";
    } catch (err) {
      team.result = null;
      team.msg = err.message;
    }
    return renderTeams();
  }
  if (act === "reroll") { team.variant++; return ($("#team-result").innerHTML = teamResultHtml()); }
  if (act === "remap") { team.map = pickMap(team.map); return ($("#team-result").innerHTML = teamResultHtml()); }
  if (act === "flip") { team.flip ^= 1; return ($("#team-result").innerHTML = teamResultHtml()); }
  if (act === "copy") {
    try {
      await navigator.clipboard.writeText(teamResultText());
      e.target.textContent = "コピーしました";
    } catch {
      e.target.textContent = "コピーできませんでした";
    }
    return;
  }
  if (row && !act && !e.target.closest("a")) {
    const id = row.dataset.id;
    if (team.selected.has(id)) team.selected.delete(id);
    else if (teamSize() < 10) team.selected.add(id);
    changed();
  }
});

// ---------- 同期 ----------

function timeAgo(ts) {
  if (!ts) return "未同期";
  const min = Math.round((Date.now() - ts) / 60000);
  return min < 1 ? "たった今 更新" : min < 60 ? `${min}分前に更新` : min < 1440 ? `${Math.round(min / 60)}時間前に更新` : `${Math.round(min / 1440)}日前に更新`;
}
async function refreshStatus() {
  const s = await api("/status");
  // D1（無料プラン）の上限は 1データベース 500MB
  const usage = s.db_bytes ? ` ・ データ ${(s.db_bytes / 1e6).toFixed(0)} / 500 MB` : "";
  $("#sync-status").textContent = timeAgo(s.last_sync) + usage;
  return s;
}
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
/** 戦績の画面（概要・試合一覧）を表示中か。取り込み中に少しずつ再描画してよい画面。 */
const onStatsView = () => !/^#\/(teams|match\/|find\/)/.test(location.hash);

/**
 * 同期を進める。プレイヤーのページでは、新着を確認したうえで、その人の取り込み待ちが
 * 無くなるまで少しずつ（1回の呼び出しで2試合）取り込む。トップページでは1回だけ進める。
 */
async function drain() {
  if (state.syncing) return;
  state.syncing = true;
  const btn = $("#sync-btn"), banner = $("#banner");
  btn.disabled = true;
  const puuid = state.player?.puuid ?? "";
  const switched = () => (state.player?.puuid ?? "") !== puuid;
  try {
    for (let i = 0; i < 150; i++) {
      const r = await api("/sync?puuid=" + puuid, { method: "POST" });
      if (switched()) break;
      if (!puuid) break; // トップページ: 定期実行の代わりに1回進めるだけ
      if (r.rateLimited) {
        banner.hidden = false;
        banner.textContent = "API のレート制限に達しました。1分ほど待ってから再開します…";
        await wait(60000);
        continue;
      }
      // RIOT_IDS に書かれた本人は全履歴を取り込むので全体の残りを、検索した人はその人の分だけを見る
      const left = state.player.source === "config" ? r.pending : r.focusPending;
      if (r.processed > 0 && onStatsView()) await route();
      if (left === 0) break;
      banner.hidden = false;
      banner.textContent = `試合データを取り込み中です… 残り ${left} 試合`;
      await wait(5000);
    }
  } catch (e) {
    banner.hidden = false;
    banner.textContent = "同期に失敗しました: " + e.message;
    return;
  } finally {
    state.syncing = false;
    btn.disabled = false;
  }
  banner.hidden = true;
  // 途中で別のページに切り替えられていたら、そちらの同期を続けて始める
  if (switched()) return drain();
  refreshStatus();
  if (!puuid) return; // トップページは再描画しない（検索欄に入力中の文字を消さないため）
  await reloadPlayer();
  if (onStatsView()) route();
}
$("#sync-btn").addEventListener("click", () => drain());

// ---------- プレイヤーの切り替えと検索 ----------

/** ランクなど、表示中のプレイヤーの情報を取り直す。 */
async function reloadPlayer() {
  if (!state.player) return;
  const fresh = await api("/player/" + state.player.puuid).catch(() => null);
  if (fresh && fresh.puuid === state.player?.puuid) {
    state.player = fresh;
    renderPlayer();
  }
}
function setPlayer(p) {
  const switched = state.player?.puuid !== p?.puuid;
  state.player = p ?? null;
  // エージェントやマップの絞り込みは人ごとに候補が違うので、切り替えたら初期値に戻す
  if (switched) state.filters = { queue: "competitive", season: "", agent: "", map: "", last: "" };
  renderPlayer();
}
/** Riot ID からプレイヤーを探し、その人のページへ移動する。 */
async function find(riotId) {
  const banner = $("#banner");
  banner.hidden = false;
  banner.textContent = `「${riotId}」を検索しています…`;
  try {
    const p = await api("/players/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ riot_id: riotId }) });
    banner.hidden = true;
    const target = playerHref(p.puuid);
    if (location.hash === target) route();
    else if (location.hash.startsWith("#/find/")) location.replace(target);
    else location.hash = target;
  } catch (e) {
    banner.textContent = e.message;
    if (location.hash.startsWith("#/find/")) history.back();
  }
}
/** ヘッダーとトップページの検索欄で共通の送信処理。 */
function onSearch(e) {
  e.preventDefault();
  const input = e.target.riot_id;
  const riotId = input.value.trim();
  if (!riotId) return;
  input.value = "";
  input.blur();
  find(riotId);
}
$("#search").addEventListener("submit", onSearch);
$("#view").addEventListener("submit", (e) => { if (e.target.id === "top-search") onSearch(e); });

// ---------- ルーティング ----------

let onResize = null;
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => onResize?.(), 150); });

async function route() {
  hideTip();
  onResize = null;
  const hash = location.hash.replace(/^#/, "") || "/";
  const fm = hash.match(/^\/find\/([^/]+)\/([^/]+)$/);
  if (fm) return find(`${decodeURIComponent(fm[1])}#${decodeURIComponent(fm[2])}`);

  const pm = hash.match(/^\/player\/([0-9a-f-]{36})(\/matches)?$/);
  const page = pm ? (pm[2] ? "matches" : "overview") : hash === "/teams" ? "teams" : hash.startsWith("/match/") ? "match" : "top";
  const tab = page === "match" ? "matches" : page;

  try {
    // URL が指すプレイヤーに切り替える。試合詳細とチーム分けでは、直前に見ていた人のままにする
    const before = state.player?.puuid;
    if (pm && before !== pm[1]) setPlayer(await api("/player/" + pm[1]));
    else if (page === "top") setPlayer(null);
    if (state.player?.puuid !== before) drain();
  } catch (e) {
    $("#filters").hidden = true;
    $("#view").innerHTML = `<div class="card empty">${esc(e.message)}　<a class="plink" href="#/">トップへ</a></div>`;
    return;
  }
  for (const a of $("#tabs").children) a.classList.toggle("on", a.dataset.tab === tab);
  // トップページには大きな検索欄があるので、ヘッダーの検索欄は出さない
  $("#search").hidden = page === "top";

  try {
    if (page === "top") await viewTop();
    else if (page === "teams") await viewTeams();
    else if (page === "match") await viewMatch(hash.slice("/match/".length));
    else if (page === "matches") await viewMatches();
    else await viewOverview();
  } catch (e) {
    $("#view").innerHTML = `<div class="card empty">読み込みに失敗しました: ${esc(e.message)}</div>`;
  }
}
addEventListener("hashchange", () => { route(); scrollTo(0, 0); });

(async () => {
  renderPlayer();
  await route();
  refreshStatus();
  drain();
})();
