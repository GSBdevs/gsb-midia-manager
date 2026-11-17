// Usuários da organização ativa: cadastro com senha provisória, papel, redefinição e remoção.
import { api } from '../api.js';
import { state, ROLE_LABELS } from '../state.js';
import { esc, icon, toast, toastError, openDialog, confirmDialog, openMenu, fmtAgo } from '../ui.js';

const ROLE_HELP = {
  viewer: 'vê tudo, sem alterar',
  editor: 'mídias, playlists e agenda; troca a playlist das telas',
  admin: 'tudo do editor + telas, aparência e usuários',
  owner: 'tudo, inclusive outros donos'
};

let users = null;
let loading = null;

async function reload(rerender) {
  loading ??= api('/users').then((list) => { users = list; }).finally(() => { loading = null; });
  await loading;
  rerender();
}

// papéis que quem está logado pode atribuir (só o dono cria ou mexe em donos)
const assignable = () => (state.me?.role === 'owner' ? ['viewer', 'editor', 'admin', 'owner'] : ['viewer', 'editor', 'admin']);

function roleOptions(selected) {
  return assignable().map((r) =>
    `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABELS[r]} — ${ROLE_HELP[r]}</option>`).join('');
}

// Senha provisória aparece uma única vez: o servidor guarda só o hash.
function showTempPassword(email, password, intro) {
  return openDialog({
    title: 'Senha provisória',
    submitText: 'Pronto',
    cancelText: 'Fechar',
    body: `<p>${intro}</p>
      <div class="temp-password" data-temp>${esc(password)}</div>
      <p class="small muted">Envie para <b>${esc(email)}</b> por um canal seguro. Ela não será mostrada de novo;
        no primeiro acesso, a pessoa escolhe a própria senha.</p>`,
    footerLeft: `<button type="button" class="btn btn-ghost" data-copy-temp>${icon('copy')}Copiar</button>`,
    onOpen(dlg) {
      dlg.querySelector('[data-copy-temp]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(password); toast('Senha copiada.'); } catch { toast('Selecione e copie a senha.', 'info'); }
      });
    }
  });
}

async function addUser(rerender) {
  const result = await openDialog({
    title: 'Adicionar pessoa',
    submitText: 'Adicionar',
    body: `
      <label class="field"><span>E-mail</span><input name="email" type="email" required autofocus /></label>
      <label class="field"><span>Nome</span><input name="name" maxlength="80" /></label>
      <label class="field"><span>Papel</span><select name="role">${roleOptions('editor')}</select></label>
      <p class="small muted">Se a pessoa já tem conta em outra organização, ela só ganha acesso a esta, com a senha que já usa.</p>`,
    onSubmit: (form) => api('/users', {
      method: 'POST', body: { email: form.email.value, name: form.name.value, role: form.role.value }
    })
  });
  if (!result || result === true) return;
  await reload(rerender);
  if (result.tempPassword) {
    await showTempPassword(result.email, result.tempPassword, 'Conta criada. Esta é a senha do primeiro acesso:');
  } else {
    toast('Acesso concedido — a pessoa entra com a senha que já tem.');
  }
}

async function changeRole(user, rerender) {
  const role = await openDialog({
    title: `Papel de ${user.name || user.email}`,
    body: `<label class="field"><span>Papel</span><select name="role">${roleOptions(user.role)}</select></label>`,
    onSubmit: (form) => form.role.value
  });
  if (typeof role !== 'string' || role === user.role) return;
  try {
    await api(`/users/${user.id}`, { method: 'PATCH', body: { role } });
    toast('Papel atualizado — vale a partir da próxima ação da pessoa.');
    await reload(rerender);
  } catch (err) { toastError(err); }
}

async function resetPassword(user) {
  const ok = await confirmDialog({
    title: 'Redefinir senha',
    message: `Gerar uma nova senha provisória para <b>${esc(user.email)}</b>? A senha atual deixa de valer e as sessões abertas dessa pessoa são encerradas.`,
    confirmText: 'Gerar senha'
  });
  if (!ok) return;
  try {
    const r = await api(`/users/${user.id}/reset-password`, { method: 'POST' });
    await showTempPassword(user.email, r.tempPassword, 'Nova senha provisória:');
  } catch (err) { toastError(err); }
}

async function removeUser(user, rerender) {
  const ok = await confirmDialog({
    title: 'Remover acesso',
    message: `Remover <b>${esc(user.name || user.email)}</b> desta organização? A pessoa sai na hora. A conta continua existindo se ela tiver acesso a outras organizações.`,
    confirmText: 'Remover',
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/users/${user.id}`, { method: 'DELETE' });
    toast('Acesso removido.');
    await reload(rerender);
  } catch (err) { toastError(err); }
}

// admin não mexe em donos (o servidor também recusa)
const canTouch = (u) => !u.me && (state.me?.role === 'owner' || u.role !== 'owner');

function row(u) {
  return `<tr data-id="${esc(u.id)}">
    <td><div style="font-weight:600">${esc(u.name || '—')}${u.me ? ' <span class="badge">você</span>' : ''}</div>
      <div class="small muted">${esc(u.email)}</div></td>
    <td><span class="badge ${u.role === 'owner' ? 'badge-accent' : ''}">${esc(ROLE_LABELS[u.role] || u.role)}</span></td>
    <td class="small muted">${u.lastLoginAt ? esc(fmtAgo(u.lastLoginAt)) : 'nunca entrou'}</td>
    <td class="num">${canTouch(u)
      ? `<button class="btn btn-ghost btn-icon btn-sm" type="button" data-menu="user" aria-label="Ações">${icon('ellipsis-vertical')}</button>`
      : ''}</td>
  </tr>`;
}

export default {
  title: 'Usuários',
  subtitle: () => `Quem acessa ${state.me?.org?.name || 'esta organização'} e o que cada um pode fazer`,
  deps: ['me'],
  actions: () => `<button class="btn btn-primary" data-action="add">${icon('user-plus')}Adicionar pessoa</button>`,

  enter(root, { signal, actions, rerender }) {
    users = null;
    reload(rerender).catch(toastError);
    actions.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="add"]')) addUser(rerender).catch(toastError);
    }, { signal });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-menu="user"]');
      if (!btn) return;
      const user = users?.find((u) => u.id === btn.closest('[data-id]').dataset.id);
      if (!user) return;
      openMenu(btn, [
        { label: 'Mudar papel', icon: 'shield', onClick: () => changeRole(user, rerender) },
        { label: 'Redefinir senha', icon: 'key-round', onClick: () => resetPassword(user) },
        '-',
        { label: 'Remover acesso', icon: 'trash-2', danger: true, onClick: () => removeUser(user, rerender) }
      ]);
    }, { signal });
  },

  render(root) {
    if (!users) {
      root.innerHTML = `<div class="empty">${icon('loader-circle')}<h3>Carregando…</h3></div>`;
      return;
    }
    root.innerHTML = `
      <section class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Pessoa</th><th>Papel</th><th>Último acesso</th><th></th></tr></thead>
          <tbody>${users.map(row).join('')}</tbody>
        </table></div>
      </section>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2>${icon('shield')} Papéis</h2></div>
        <div class="list">${['viewer', 'editor', 'admin', 'owner'].map((r) =>
          `<div class="list-item"><b style="min-width:120px">${ROLE_LABELS[r]}</b><span class="grow muted">${ROLE_HELP[r]}</span></div>`).join('')}
        </div>
      </section>`;
  }
};
