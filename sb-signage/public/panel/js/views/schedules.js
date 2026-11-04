// Agenda: linha do tempo semanal por tela + regras (dayparting).
import { api } from '../api.js';
import { state, load, basePlaylistOf, playlistById, deviceById } from '../state.js';
import { esc, icon, toast, toastError, openDialog, confirmDialog, plural } from '../ui.js';

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const ui = { deviceId: null };

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Trechos [início, fim) em minutos por dia da semana; janelas noturnas continuam no dia seguinte.
function segments(rule) {
  const out = [];
  const s = toMin(rule.start);
  const e = toMin(rule.end);
  for (const d of rule.days) {
    if (s === e) out.push({ day: d, from: 0, to: 1440 });
    else if (s < e) out.push({ day: d, from: s, to: e });
    else {
      out.push({ day: d, from: s, to: 1440 });
      out.push({ day: (d + 1) % 7, from: 0, to: e });
    }
  }
  return out;
}

function ruleDialog(defaults = {}) {
  if (!state.devices.length) return toast('Pareie uma tela antes de criar regras.', 'info');
  if (!state.playlists.length) return toast('Crie uma playlist antes de criar regras.', 'info');
  return openDialog({
    title: 'Nova regra de exibição',
    submitText: 'Adicionar regra',
    body: `
      <div class="form-grid">
        <label class="field"><span>Tela</span><select name="deviceId">
          ${state.devices.map((d) => `<option value="${d.id}" ${d.id === defaults.deviceId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Playlist</span><select name="playlistId">
          ${state.playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      </div>
      <div class="form-grid">
        <label class="field"><span>Início</span><input name="start" type="time" value="08:00" required /></label>
        <label class="field"><span>Fim</span><input name="end" type="time" value="12:00" required /></label>
        <label class="field"><span>Prioridade</span><input name="priority" type="number" min="0" max="99" value="0" /></label>
      </div>
      <div class="field"><span class="field-label">Dias (em que a janela começa)</span>
        <div class="days">${ORDER.map((d) => `<label><input type="checkbox" name="days" value="${d}" ${d >= 1 && d <= 5 ? 'checked' : ''} /><span>${DAYS[d]}</span></label>`).join('')}</div></div>
      <p class="field-hint">Fim antes do início cruza a meia-noite: "sexta 22:00 → 06:00" vai até sábado 06:00. Início igual ao fim = dia inteiro.
        Com regras sobrepostas, vence a de maior prioridade.</p>`,
    async onSubmit(form) {
      const days = [...form.querySelectorAll('[name=days]:checked')].map((c) => +c.value);
      await api('/schedules', {
        method: 'POST',
        body: {
          deviceId: form.deviceId.value, playlistId: form.playlistId.value, days,
          start: form.start.value, end: form.end.value, priority: form.priority.value
        }
      });
      ui.deviceId = form.deviceId.value;
      toast('Regra adicionada.');
    }
  });
}

function timeline(device) {
  const rules = state.schedules.filter((r) => r.deviceId === device.id);
  const segs = rules.flatMap((r) => segments(r).map((s) => ({ ...s, rule: r })));
  const base = basePlaylistOf(device);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return `
    <div class="timeline">
      ${ORDER.map((d) => `
        <span class="day">${DAYS[d]}</span>
        <div class="track" title="Fora das regras: ${esc(base.playlist?.name || 'nenhuma playlist')}">
          ${segs.filter((s) => s.day === d).map((s) => {
            const pl = playlistById(s.rule.playlistId);
            return `<span class="slot ${s.rule.priority % 2 ? 'alt' : ''}" style="left:${(s.from / 1440) * 100}%;width:${((s.to - s.from) / 1440) * 100}%"
              title="${esc(pl?.name || '?')} · ${s.rule.start}–${s.rule.end}${s.rule.priority ? ` · prioridade ${s.rule.priority}` : ''}">${esc(pl?.name || '?')}</span>`;
          }).join('')}
          ${d === now.getDay() ? `<span class="now-line" style="left:${(nowMin / 1440) * 100}%" title="agora"></span>` : ''}
        </div>`).join('')}
      <div class="hours">${['00', '03', '06', '09', '12', '15', '18', '21', '24'].map((h) => `<span>${h}h</span>`).join('')}</div>
    </div>
    <p class="small subtle" style="margin-top:12px">Fora das regras, a tela exibe <b>${esc(base.playlist?.name || 'nada (sem playlist)')}</b>${base.source && base.source !== 'tela' ? ` (do ${esc(base.source)})` : ''}.</p>`;
}

export default {
  title: 'Agenda',
  subtitle: () => `${plural(state.schedules.length, 'regra', 'regras')} de exibição por horário`,
  deps: ['schedules', 'devices', 'playlists', 'groups'],
  actions: () => `<button class="btn btn-primary" data-action="new">${icon('plus')}Nova regra</button>`,

  enter(root, { signal, actions, rerender }) {
    actions.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="new"]')) ruleDialog({ deviceId: ui.deviceId });
    }, { signal });
    root.addEventListener('change', (e) => {
      if (e.target.dataset.key === 'sched-device') {
        ui.deviceId = e.target.value;
        rerender();
      }
    }, { signal });
    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="new"]')) return ruleDialog({ deviceId: ui.deviceId });
      const del = e.target.closest('[data-del]');
      if (!del) return;
      const r = state.schedules.find((x) => x.id === del.dataset.del);
      const ok = await confirmDialog({
        title: 'Remover regra',
        message: `Remover a regra <b>${esc(playlistById(r?.playlistId)?.name || '')}</b> (${r?.start}–${r?.end})?`,
        confirmText: 'Remover', danger: true
      });
      if (ok) await api(`/schedules/${del.dataset.del}`, { method: 'DELETE' }).catch(toastError);
      load('schedules').catch(() => {});
    }, { signal });
  },

  render(root) {
    if (!state.devices.length) {
      root.innerHTML = `<div class="empty">${icon('calendar-clock')}<h3>Nenhuma tela pareada</h3><p>A agenda define o que cada tela exibe por dia e horário.</p></div>`;
      return;
    }
    if (!deviceById(ui.deviceId)) ui.deviceId = state.devices[0].id;
    const device = deviceById(ui.deviceId);
    const rows = [...state.schedules].sort((a, b) =>
      (deviceById(a.deviceId)?.name || '').localeCompare(deviceById(b.deviceId)?.name || '', 'pt-BR') || a.start.localeCompare(b.start));

    root.innerHTML = `
      <section class="card" style="margin-bottom:16px">
        <div class="card-head">
          <h2>Semana de</h2>
          <select data-key="sched-device" aria-label="Tela">${state.devices.map((d) =>
            `<option value="${d.id}" ${d.id === ui.deviceId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        </div>
        <div class="card-body">${timeline(device)}</div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Todas as regras</h2></div>
        ${rows.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Tela</th><th>Playlist</th><th>Dias</th><th>Horário</th><th class="num">Prioridade</th><th></th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${esc(deviceById(r.deviceId)?.name || '?')}</td>
            <td><b>${esc(playlistById(r.playlistId)?.name || '?')}</b></td>
            <td>${ORDER.filter((d) => r.days.includes(d)).map((d) => DAYS[d]).join(', ')}</td>
            <td class="mono">${r.start} → ${r.end}${r.start > r.end ? ' <span class="badge">+1 dia</span>' : ''}</td>
            <td class="num">${r.priority || 0}</td>
            <td class="num"><button class="btn btn-ghost btn-icon btn-sm" data-del="${r.id}" aria-label="Remover regra">${icon('trash-2')}</button></td>
          </tr>`).join('')}</tbody></table></div>`
          : `<div class="card-body"><div class="empty" style="padding:28px">${icon('calendar-clock')}<h3>Sem regras</h3>
             <p>Sem regras, cada tela exibe a própria playlist (ou a do grupo) o tempo todo.</p>
             <button class="btn btn-primary" data-action="new">${icon('plus')}Nova regra</button></div></div>`}
      </section>`;
  }
};
