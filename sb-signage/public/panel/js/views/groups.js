// Grupos de telas: playlist do grupo e membros gerenciados num só lugar.
import { api } from '../api.js';
import { state, load, playlistById } from '../state.js';
import { esc, icon, toast, toastError, openDialog, confirmDialog, promptDialog, openMenu, plural } from '../ui.js';

async function createGroup() {
  const name = await promptDialog({ title: 'Novo grupo', label: 'Nome do grupo', placeholder: 'Ex.: Vitrines', submitText: 'Criar' });
  if (!name) return;
  try {
    const g = await api('/groups', { method: 'POST', body: { name } });
    await load('groups');
    toast('Grupo criado.');
    membersDialog(g);
  } catch (err) { toastError(err); }
}

async function membersDialog(group) {
  if (!state.devices.length) return toast('Pareie uma tela antes de montar grupos.', 'info');
  await openDialog({
    title: `Telas do grupo — ${group.name}`,
    submitText: 'Salvar membros',
    body: `
      <p class="muted">Telas sem playlist própria passam a exibir a playlist do grupo. Uma tela pertence a um grupo por vez.</p>
      <div class="list card" style="max-height:50vh;overflow:auto">
        ${state.devices.map((d) => {
          const other = d.groupId && d.groupId !== group.id ? state.groups.find((g) => g.id === d.groupId) : null;
          return `<label class="list-item check" style="cursor:pointer">
            <input type="checkbox" name="member" value="${d.id}" ${d.groupId === group.id ? 'checked' : ''} />
            <span class="grow">${esc(d.name)}</span>
            ${other ? `<span class="badge">hoje em ${esc(other.name)}</span>` : ''}
            <span class="dot ${d.online ? 'dot-ok' : ''}"></span>
          </label>`;
        }).join('')}
      </div>`,
    async onSubmit(form) {
      const chosen = new Set([...form.querySelectorAll('[name=member]:checked')].map((c) => c.value));
      const changes = state.devices.filter((d) => chosen.has(d.id) !== (d.groupId === group.id));
      for (const d of changes) {
        await api(`/devices/${d.id}`, { method: 'PATCH', body: { groupId: chosen.has(d.id) ? group.id : null } });
      }
      await load('devices');
      toast(changes.length ? `${plural(changes.length, 'tela atualizada', 'telas atualizadas')}.` : 'Nada mudou.');
    }
  });
}

export default {
  title: 'Grupos',
  subtitle: () => 'Aplique uma playlist a várias telas de uma vez',
  deps: ['groups', 'devices', 'device-status', 'playlists'],
  actions: () => `<button class="btn btn-primary" data-action="new">${icon('plus')}Novo grupo</button>`,

  enter(root, { signal, actions }) {
    actions.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="new"]')) createGroup();
    }, { signal });

    root.addEventListener('change', async (e) => {
      if (e.target.dataset.act !== 'playlist') return;
      const id = e.target.closest('[data-id]').dataset.id;
      try {
        await api(`/groups/${id}`, { method: 'PATCH', body: { playlistId: e.target.value || null } });
        toast('Playlist do grupo atualizada.');
      } catch (err) { toastError(err); }
    }, { signal });

    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="new"]')) return createGroup();
      const btn = e.target.closest('[data-act]');
      const cardEl = e.target.closest('[data-id]');
      if (!btn || !cardEl) return;
      const g = state.groups.find((x) => x.id === cardEl.dataset.id);
      if (!g) return;
      if (btn.dataset.act === 'members') return membersDialog(g);
      if (btn.dataset.act === 'menu') {
        openMenu(btn, [
          { icon: 'monitor', label: 'Gerenciar telas', onClick: () => membersDialog(g) },
          { icon: 'pencil', label: 'Renomear', onClick: async () => {
            const name = await promptDialog({ title: 'Renomear grupo', label: 'Nome do grupo', value: g.name });
            if (name) await api(`/groups/${g.id}`, { method: 'PATCH', body: { name } }).catch(toastError);
          } },
          '-',
          { icon: 'trash-2', label: 'Excluir grupo', danger: true, onClick: async () => {
            const ok = await confirmDialog({
              title: 'Excluir grupo',
              message: `Excluir <b>${esc(g.name)}</b>? As telas continuam pareadas, só deixam de herdar a playlist do grupo.`,
              confirmText: 'Excluir', danger: true
            });
            if (ok) await api(`/groups/${g.id}`, { method: 'DELETE' }).catch(toastError);
          } }
        ]);
      }
    }, { signal });
  },

  render(root) {
    if (!state.groups.length) {
      root.innerHTML = `<div class="empty">${icon('boxes')}<h3>Nenhum grupo</h3>
        <p>Grupos aplicam uma playlist a várias telas de uma vez (ex.: "Vitrines", "Recepção").</p>
        <button class="btn btn-primary" data-action="new">${icon('plus')}Novo grupo</button></div>`;
      return;
    }
    root.innerHTML = `<div class="grid grid-cards">${state.groups.map((g) => {
      const members = state.devices.filter((d) => d.groupId === g.id);
      const inheriting = members.filter((d) => !d.playlistId);
      const pl = playlistById(g.playlistId);
      return `<article class="card" data-id="${g.id}">
        <div class="card-head">
          ${icon('boxes')}<h2 class="truncate">${esc(g.name)}</h2>
          <button class="btn btn-ghost btn-icon btn-sm" data-menu data-act="menu" aria-label="Mais ações">${icon('ellipsis-vertical')}</button>
        </div>
        <div class="card-body stack">
          <label class="field"><span>Playlist do grupo</span>
            <select data-act="playlist" data-key="gpl-${g.id}">
              <option value="">— nenhuma —</option>
              ${state.playlists.map((p) => `<option value="${p.id}" ${g.playlistId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></label>
          <div>
            <div class="row" style="margin-bottom:8px"><span class="field-label grow">${plural(members.length, 'tela', 'telas')}</span>
              <button class="btn btn-sm" data-act="members">${icon('monitor')}Gerenciar</button></div>
            <div class="row row-wrap">${members.map((d) => `<span class="badge"><span class="dot ${d.online ? 'dot-ok' : ''}"></span>${esc(d.name)}${d.playlistId ? ' · playlist própria' : ''}</span>`).join('') || '<span class="subtle small">Nenhuma tela no grupo.</span>'}</div>
          </div>
          ${pl && members.length ? `<p class="small subtle">${plural(inheriting.length, 'tela exibe', 'telas exibem')} "${esc(pl.name)}" por herança.</p>` : ''}
        </div>
      </article>`;
    }).join('')}</div>`;
  }
};
