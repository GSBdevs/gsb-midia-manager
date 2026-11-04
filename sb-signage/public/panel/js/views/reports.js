// Relatórios de exibição (proof-of-play): período, tela, gráfico por dia, ranking e CSV.
import { api, downloadFile } from '../api.js';
import { state } from '../state.js';
import { esc, icon, toastError, fmtDur, fmtLong, fmtNum } from '../ui.js';

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function presetRange(preset) {
  const to = new Date();
  const from = new Date();
  if (preset === '7d') from.setDate(to.getDate() - 6);
  if (preset === '30d') from.setDate(to.getDate() - 29);
  return { from: isoDay(from), to: isoDay(to) };
}

const ui = { preset: '7d', ...presetRange('7d'), deviceId: '', group: 'media' };
let report = null;
let loading = false;

async function fetchReport(rerender) {
  loading = true;
  rerender();
  try {
    const q = new URLSearchParams({ from: ui.from, to: ui.to, ...(ui.deviceId ? { deviceId: ui.deviceId } : {}) });
    report = await api(`/logs?${q}`);
  } catch (err) {
    toastError(err);
  } finally {
    loading = false;
    rerender();
  }
}

function grouped() {
  if (!report) return [];
  if (ui.group === 'pair') return report.rows;
  const key = ui.group === 'media' ? 'mediaId' : 'deviceId';
  const map = new Map();
  for (const r of report.rows) {
    const cur = map.get(r[key]) || { ...r, plays: 0, seconds: 0, screens: new Set() };
    cur.plays += r.plays;
    cur.seconds += r.seconds;
    cur.screens.add(ui.group === 'media' ? r.deviceId : r.mediaId);
    map.set(r[key], cur);
  }
  return [...map.values()].sort((a, b) => b.plays - a.plays);
}

function chart() {
  const days = report?.perDay || [];
  if (!days.length) return '';
  const max = Math.max(1, ...days.map((d) => d.plays));
  const label = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const step = Math.ceil(days.length / 15);
  return `<div class="bars" role="img" aria-label="Exibições por dia">${days.map((d) =>
    `<div class="bar" style="height:${Math.max(2, (d.plays / max) * 100)}%" title="${label(d.date)}: ${fmtNum(d.plays)} exibições · ${fmtLong(d.seconds)}"></div>`).join('')}</div>
    <div class="bars-labels">${days.map((d, i) => `<span>${i % step === 0 ? label(d.date) : ''}</span>`).join('')}</div>`;
}

export default {
  title: 'Relatórios',
  subtitle: () => 'Comprovação de exibição (proof-of-play) — útil para anunciantes',
  deps: ['devices'],
  actions: () => `<button class="btn" data-action="csv">${icon('download')}Exportar CSV</button>`,

  enter(root, { signal, actions, rerender }) {
    fetchReport(rerender);
    actions.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-action="csv"]')) return;
      const q = new URLSearchParams({ from: ui.from, to: ui.to, ...(ui.deviceId ? { deviceId: ui.deviceId } : {}) });
      try {
        await downloadFile(`/logs.csv?${q}`, `exibicoes-${ui.from}_${ui.to}.csv`);
      } catch (err) { toastError(err); }
    }, { signal });

    root.addEventListener('click', (e) => {
      const p = e.target.closest('[data-preset]');
      if (p) {
        ui.preset = p.dataset.preset;
        if (ui.preset !== 'custom') Object.assign(ui, presetRange(ui.preset));
        return fetchReport(rerender);
      }
      const g = e.target.closest('[data-group]');
      if (g) {
        ui.group = g.dataset.group;
        rerender();
      }
    }, { signal });

    root.addEventListener('change', (e) => {
      const k = e.target.dataset.key;
      if (k === 'rep-from' || k === 'rep-to') {
        ui[k === 'rep-from' ? 'from' : 'to'] = e.target.value;
        ui.preset = 'custom';
        fetchReport(rerender);
      } else if (k === 'rep-device') {
        ui.deviceId = e.target.value;
        fetchReport(rerender);
      }
    }, { signal });
  },

  render(root) {
    const rows = grouped();
    const mediaCount = report ? new Set(report.rows.map((r) => r.mediaId)).size : 0;
    const screenCount = report ? new Set(report.rows.map((r) => r.deviceId)).size : 0;

    root.innerHTML = `
      <div class="toolbar">
        <div class="segmented">${[['today', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['custom', 'Período']].map(([k, l]) =>
          `<button type="button" data-preset="${k}" class="${ui.preset === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <input type="date" value="${ui.from}" data-key="rep-from" aria-label="De" max="${ui.to}" />
        <span class="subtle">até</span>
        <input type="date" value="${ui.to}" data-key="rep-to" aria-label="Até" min="${ui.from}" />
        <select data-key="rep-device" aria-label="Tela">
          <option value="">Todas as telas</option>
          ${state.devices.map((d) => `<option value="${d.id}" ${ui.deviceId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        ${loading ? `<span class="muted">${icon('loader-circle', 'spin')}</span>` : ''}
      </div>

      <div class="kpis">
        <div class="card kpi"><div class="kpi-label">${icon('play')}Exibições</div><div class="kpi-value">${fmtNum(report?.totalPlays)}</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('clock')}Tempo no ar</div><div class="kpi-value" style="font-size:22px">${fmtLong(report?.totalSeconds)}</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('images')}Mídias exibidas</div><div class="kpi-value">${fmtNum(mediaCount)}</div></div>
        <div class="card kpi"><div class="kpi-label">${icon('monitor')}Telas</div><div class="kpi-value">${fmtNum(screenCount)}</div></div>
      </div>

      <section class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>Exibições por dia</h2><span class="subtle small">fuso ${esc(report?.timezone || '')}</span></div>
        <div class="card-body">${report?.totalPlays ? chart() : '<p class="muted">Sem exibições registradas no período.</p>'}</div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Detalhamento</h2>
          <div class="segmented">${[['media', 'Por mídia'], ['device', 'Por tela'], ['pair', 'Tela × mídia']].map(([k, l]) =>
            `<button type="button" data-group="${k}" class="${ui.group === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        </div>
        ${rows.length ? `<div class="table-wrap"><table class="table">
          <thead><tr>
            ${ui.group !== 'device' ? '<th>Mídia</th>' : ''}${ui.group !== 'media' ? '<th>Tela</th>' : ''}
            ${ui.group === 'media' ? '<th class="num">Telas</th>' : ui.group === 'device' ? '<th class="num">Mídias</th>' : ''}
            <th class="num">Exibições</th><th class="num">Tempo no ar</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            ${ui.group !== 'device' ? `<td>${esc(r.name)}</td>` : ''}${ui.group !== 'media' ? `<td>${esc(r.deviceName)}</td>` : ''}
            ${ui.group !== 'pair' ? `<td class="num">${r.screens.size}</td>` : ''}
            <td class="num">${fmtNum(r.plays)}</td><td class="num">${fmtDur(r.seconds)}</td></tr>`).join('')}</tbody>
        </table></div>` : `<div class="card-body"><p class="muted">Nada no período selecionado.</p></div>`}
      </section>`;
  }
};
