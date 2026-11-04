// Telas: busca/filtros, o que está no ar, playlist, configurações e comandos remotos.
import { api } from '../api.js';
import { state, load, deviceIssues, basePlaylistOf, mediaById, groupById, thumbUrl } from '../state.js';
import {
  esc, icon, toast, toastError, openDialog, confirmDialog, promptDialog, openMenu, fmtAgo, fmtSize, plural
} from '../ui.js';

const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const ui = { search: '', filter: 'all', group: '' };

function matches(dev) {
  if (ui.search && !dev.name.toLowerCase().includes(ui.search.toLowerCase())) return false;
  if (ui.group && dev.groupId !== ui.group) return false;
  if (ui.filter === 'online') return dev.online;
  if (ui.filter === 'offline') return !dev.online;
  if (ui.filter === 'issues') return deviceIssues(dev).some((i) => i.kind !== 'info');
  return true;
}

function dayChecks(name, selected) {
  return `<div class="days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `
    <label><input type="checkbox" name="${name}" value="${d}" ${selected.includes(d) ? 'checked' : ''} /><span>${DAY_NAMES[d]}</span></label>`).join('')}</div>`;
}

function card(dev) {
  const s = dev.status || {};
  const m = s.mediaId ? mediaById(s.mediaId) : null;
  const thumb = dev.online && !s.poweredOff ? thumbUrl(m) : null;
  const { playlist, source } = basePlaylistOf(dev);
  const group = groupById(dev.groupId);
  const issues = deviceIssues(dev);

  let preview;
  if (!dev.online) preview = icon('wifi-off');
  else if (s.emergency) preview = icon('siren');
  else if (s.poweredOff) preview = icon('power');
  else preview = thumb ? '' : icon('tv');

  const chips = [
    group && `<span class="badge">${icon('boxes')}${esc(group.name)}</span>`,
    dev.orientation && `<span class="badge">${icon('rotate-cw')}${dev.orientation}°</span>`,
    dev.muted ? `<span class="badge">${icon('volume-x')}mudo</span>` : dev.volume < 100 && `<span class="badge">${icon('volume-2')}${dev.volume}%</span>`,
    (dev.overlay?.ticker || dev.overlay?.showClock) && `<span class="badge">${icon('type')}rodapé</span>`,
    dev.powerSchedule && `<span class="badge">${icon('power')}${dev.powerSchedule.on}–${dev.powerSchedule.off}</span>`
  ].filter(Boolean).join('');

  const storage = s.storageQuota
    ? `<div class="storage"><div class="row"><span class="grow">Armazenamento</span><span>${fmtSize(s.storageUsage)} de ${fmtSize(s.storageQuota)}${s.persisted === false ? ' · não persistente' : ''}</span></div>
       <div class="meter"><i style="width:${Math.min(100, Math.round((s.storageUsage / s.storageQuota) * 100))}%"></i></div></div>`
    : '';

  return `
  <article class="card screen-card" data-id="${dev.id}">
    <div class="screen-preview" ${thumb ? `style="background-image:url('${esc(thumb)}')"` : ''}>
      ${preview}
      <div class="overlay-top">
        ${dev.online ? '<span class="badge badge-ok"><span class="dot dot-ok"></span>online</span>' : `<span class="badge badge-danger">offline · ${esc(fmtAgo(dev.lastSeenAt))}</span>`}
        ${s.emergency ? `<span class="badge badge-danger">${icon('siren')}emergência</span>` : ''}
        ${issues.filter((i) => i.text !== 'offline').map((i) => `<span class="badge badge-${i.kind === 'warn' ? 'warn' : i.kind === 'danger' ? 'danger' : 'info'}">${esc(i.text)}</span>`).join('')}
      </div>
      ${dev.online && s.playing ? `<div class="now">Exibindo <b>${esc(s.playing)}</b></div>` : ''}
    </div>
    <div class="screen-body">
      <div class="screen-title">
        <h3 class="truncate" title="${esc(dev.name)}">${esc(dev.name)}</h3>
        <button class="btn btn-ghost btn-icon btn-sm" data-act="identify" title="Identificar na TV">${icon('scan-eye')}</button>
        <button class="btn btn-ghost btn-icon btn-sm" data-act="settings" title="Configurar tela">${icon('settings')}</button>
        <button class="btn btn-ghost btn-icon btn-sm" data-menu data-act="menu" aria-label="Mais ações">${icon('ellipsis-vertical')}</button>
      </div>
      ${chips ? `<div class="screen-meta">${chips}</div>` : ''}
      <label class="screen-row field">
        <span>Playlist ${source && source !== 'tela' ? `<span class="subtle">· herdada do ${esc(source)}</span>` : ''}</span>
        <select data-act="playlist" data-key="pl-${dev.id}">
          <option value="">${group?.playlistId ? `— herdar do grupo (${esc(playlist?.name || '?')}) —` : '— nenhuma —'}</option>
          ${state.playlists.map((p) => `<option value="${p.id}" ${dev.playlistId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      ${storage}
    </div>
  </article>`;
}

async function command(dev, type, okMsg) {
  try {
    const r = await api(`/devices/${dev.id}/command`, { method: 'POST', body: { type } });
    toast(r.delivered ? okMsg : 'Tela offline — comando não entregue.', r.delivered ? 'ok' : 'warn');
  } catch (err) { toastError(err); }
}

export async function pairDialog() {
  await openDialog({
    title: 'Parear nova tela',
    submitText: 'Vincular',
    body: `
      <ol class="muted" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">
        <li>Na TV, abra <code>${esc(location.origin)}/player</code> (ou o app do player).</li>
        <li>Um código de 6 caracteres aparece na tela.</li>
        <li>Digite o código abaixo e dê um nome à tela.</li>
      </ol>
      <label class="field"><span>Código exibido na TV</span>
        <input name="code" maxlength="6" placeholder="ABC123" required autocomplete="off"
          style="text-transform:uppercase;font-family:var(--font-mono);font-size:20px;letter-spacing:6px;height:48px" /></label>
      <label class="field"><span>Nome da tela</span><input name="name" maxlength="80" placeholder="Ex.: Recepção" /></label>`,
    async onSubmit(form) {
      await api('/devices/claim', { method: 'POST', body: { code: form.code.value, name: form.name.value } });
      toast('Tela vinculada — ela começa a sincronizar em segundos.');
    }
  });
}

async function settingsDialog(dev) {
  const ps = dev.powerSchedule;
  await openDialog({
    title: `Configurar — ${dev.name}`,
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>Grupo</span>
          <select name="groupId"><option value="">— sem grupo —</option>
            ${state.groups.map((g) => `<option value="${g.id}" ${dev.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
          </select></label>
        <label class="field"><span>Orientação</span>
          <select name="orientation">
            ${[[0, 'Paisagem (0°)'], [90, 'Retrato (90°)'], [180, 'Invertida (180°)'], [270, 'Retrato invertido (270°)']]
              .map(([v, l]) => `<option value="${v}" ${(dev.orientation || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <label class="field"><span>Volume <b data-vol>${dev.volume ?? 100}%</b></span>
          <input name="volume" type="range" min="0" max="100" step="5" value="${dev.volume ?? 100}" /></label>
        <label class="check" style="align-self:end;height:var(--control-h)"><input name="muted" type="checkbox" ${dev.muted ? 'checked' : ''} />Sem som (mudo)</label>
      </div>
      <fieldset class="fieldset"><legend>Rodapé (letreiro e relógio)</legend>
        <label class="field"><span>Texto do letreiro</span>
          <input name="ticker" maxlength="500" value="${esc(dev.overlay?.ticker || '')}" placeholder="Vazio = sem letreiro" /></label>
        <label class="check"><input name="showClock" type="checkbox" ${dev.overlay?.showClock ? 'checked' : ''} />Mostrar relógio</label>
      </fieldset>
      <fieldset class="fieldset"><legend>Agenda de energia</legend>
        <label class="check"><input name="powerEnabled" type="checkbox" ${ps ? 'checked' : ''} />A tela fica preta fora deste horário</label>
        <div class="form-grid">
          <label class="field"><span>Liga</span><input name="on" type="time" value="${ps?.on || '08:00'}" /></label>
          <label class="field"><span>Desliga</span><input name="off" type="time" value="${ps?.off || '22:00'}" /></label>
        </div>
        ${dayChecks('powerDays', ps ? ps.days : [0, 1, 2, 3, 4, 5, 6])}
        <p class="field-hint">Horários no fuso do servidor (${esc(state.overview?.timezone || '')}). Desligar a TV de verdade (HDMI-CEC) exige o player Android.</p>
      </fieldset>`,
    onOpen(dlg) {
      dlg.querySelector('[name=volume]').addEventListener('input', (e) => {
        dlg.querySelector('[data-vol]').textContent = `${e.target.value}%`;
      });
    },
    async onSubmit(form) {
      const days = [...form.querySelectorAll('[name=powerDays]:checked')].map((c) => +c.value);
      if (form.powerEnabled.checked && !days.length) throw new Error('Selecione ao menos um dia na agenda de energia.');
      await api(`/devices/${dev.id}`, {
        method: 'PATCH',
        body: {
          groupId: form.groupId.value || null,
          orientation: +form.orientation.value,
          volume: +form.volume.value,
          muted: form.muted.checked,
          overlay: { ticker: form.ticker.value.trim(), showClock: form.showClock.checked },
          powerSchedule: form.powerEnabled.checked ? { on: form.on.value, off: form.off.value, days } : null
        }
      });
      toast('Configurações aplicadas — a tela atualiza em segundos.');
    }
  });
}

export default {
  title: 'Telas',
  subtitle: () => {
    const online = state.devices.filter((d) => d.online).length;
    return `${plural(state.devices.length, 'tela pareada', 'telas pareadas')} · ${online} online`;
  },
  deps: ['devices', 'device-status', 'playlists', 'groups', 'media', 'schedules'],
  actions: () => `<button class="btn btn-primary" data-action="pair">${icon('plus')}Parear tela</button>`,

  enter(root, { signal, actions, rerender }) {
    actions.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="pair"]')) pairDialog();
    }, { signal });

    root.addEventListener('input', (e) => {
      if (e.target.dataset.key === 'screen-search') {
        ui.search = e.target.value;
        rerender();
      }
    }, { signal });

    root.addEventListener('change', async (e) => {
      if (e.target.dataset.key === 'screen-group') {
        ui.group = e.target.value;
        rerender();
        return;
      }
      if (e.target.dataset.act !== 'playlist') return;
      const id = e.target.closest('[data-id]').dataset.id;
      try {
        await api(`/devices/${id}`, { method: 'PATCH', body: { playlistId: e.target.value || null } });
        toast('Playlist atualizada — a tela sincroniza em segundos.');
      } catch (err) { toastError(err); }
    }, { signal });

    root.addEventListener('click', async (e) => {
      const filter = e.target.closest('[data-filter]');
      if (filter) {
        ui.filter = filter.dataset.filter;
        rerender();
        return;
      }
      if (e.target.closest('[data-action="pair"]')) return pairDialog();
      const btn = e.target.closest('[data-act]');
      const cardEl = e.target.closest('[data-id]');
      if (!btn || !cardEl) return;
      const dev = state.devices.find((d) => d.id === cardEl.dataset.id);
      if (!dev) return;
      if (btn.dataset.act === 'identify') return command(dev, 'identify', 'O nome aparece na TV por 8 segundos.');
      if (btn.dataset.act === 'settings') return settingsDialog(dev);
      if (btn.dataset.act === 'menu') {
        openMenu(btn, [
          { icon: 'settings', label: 'Configurar', onClick: () => settingsDialog(dev) },
          { icon: 'pencil', label: 'Renomear', onClick: async () => {
            const name = await promptDialog({ title: 'Renomear tela', label: 'Nome da tela', value: dev.name });
            if (name) await api(`/devices/${dev.id}`, { method: 'PATCH', body: { name } }).catch(toastError);
          } },
          { icon: 'scan-eye', label: 'Identificar na TV', onClick: () => command(dev, 'identify', 'O nome aparece na TV por 8 segundos.') },
          { icon: 'refresh-cw', label: 'Recarregar player', onClick: () => command(dev, 'reload', 'Player recarregando.') },
          { icon: 'eraser', label: 'Limpar cache e baixar de novo', onClick: () => command(dev, 'clear-cache', 'Cache limpo — a tela vai baixar o conteúdo de novo.') },
          '-',
          { icon: 'trash-2', label: 'Remover tela', danger: true, onClick: async () => {
            const ok = await confirmDialog({
              title: 'Remover tela',
              message: `Remover <b>${esc(dev.name)}</b>? O player volta para a tela de pareamento e as regras de agenda dela são apagadas.`,
              confirmText: 'Remover', danger: true
            });
            if (ok) {
              await api(`/devices/${dev.id}`, { method: 'DELETE' }).catch(toastError);
              load('devices', 'schedules').catch(() => {});
            }
          } }
        ]);
      }
    }, { signal });
  },

  render(root) {
    const devs = state.devices;
    if (!devs.length) {
      root.innerHTML = `<div class="empty">${icon('tv')}<h3>Nenhuma tela pareada</h3>
        <p>Abra <code>${esc(location.origin)}/player</code> na TV — um código aparece na tela.</p>
        <button class="btn btn-primary" data-action="pair">${icon('plus')}Parear tela</button></div>`;
      return;
    }
    const counts = {
      all: devs.length,
      online: devs.filter((d) => d.online).length,
      offline: devs.filter((d) => !d.online).length,
      issues: devs.filter((d) => deviceIssues(d).some((i) => i.kind !== 'info')).length
    };
    const list = devs.filter(matches).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'pt-BR'));
    root.innerHTML = `
      <div class="toolbar">
        <label class="input-search">${icon('search')}<span class="sr-only">Buscar telas</span>
          <input type="search" placeholder="Buscar tela…" value="${esc(ui.search)}" data-key="screen-search" /></label>
        <div class="segmented">
          ${[['all', 'Todas'], ['online', 'Online'], ['offline', 'Offline'], ['issues', 'Com alerta']].map(([k, l]) =>
            `<button type="button" data-filter="${k}" class="${ui.filter === k ? 'active' : ''}">${l} <span class="count">${counts[k]}</span></button>`).join('')}
        </div>
        ${state.groups.length ? `<select data-key="screen-group" aria-label="Filtrar por grupo">
          <option value="">Todos os grupos</option>
          ${state.groups.map((g) => `<option value="${g.id}" ${ui.group === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>` : ''}
      </div>
      ${list.length ? `<div class="grid grid-cards">${list.map(card).join('')}</div>`
        : `<div class="empty">${icon('search')}<h3>Nenhuma tela neste filtro</h3></div>`}`;
  }
};
