// Usuários da organização ativa. Sem envio de e-mail por enquanto: o administrador cadastra
// a pessoa e recebe uma senha provisória (mostrada uma vez), trocada no primeiro acesso.
const crypto = require('crypto');
const { ROLES } = require('../accounts');
const { httpError } = require('../auth');

// sem caracteres que se confundem ao ditar ou digitar (0/O, 1/l/I)
const TEMP_CHARSET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function tempPassword(length = 10) {
  let s = '';
  for (let i = 0; i < length; i++) s += TEMP_CHARSET[crypto.randomInt(TEMP_CHARSET.length)];
  return s;
}

const ms = (d) => (d == null ? null : new Date(d).getTime());

module.exports = function userRoutes(router, { accounts, auth }) {
  const manage = auth.allow('users.manage');
  const rank = (role) => ROLES.indexOf(role);

  // Admin gerencia até admin; só o dono mexe em donos (promover, rebaixar, remover).
  function assertCanTouch(actorRole, targetRole, newRole = null) {
    if (actorRole === 'owner') return;
    if (targetRole === 'owner' || newRole === 'owner') throw httpError(403, 'só um dono pode alterar donos');
  }

  async function member(orgId, userId) {
    const role = await accounts.roleIn(orgId, userId);
    if (!role) throw httpError(404, 'usuário não encontrado nesta organização');
    return role;
  }

  router.get('/users', manage, async (req, res) => {
    const rows = await accounts.listMembers(req.orgId);
    res.json(rows.map((u) => ({
      id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled,
      lastLoginAt: ms(u.last_login_at), me: u.id === req.session.user.id
    })));
  });

  // Cadastra (ou adiciona, se o e-mail já tem conta em outra organização).
  router.post('/users', manage, async (req, res) => {
    const { email, name, role } = req.body || {};
    if (!ROLES.includes(role)) throw httpError(400, 'papel inválido');
    assertCanTouch(req.session.role, null, role);

    const existing = await accounts.findUserByEmail(email);
    if (existing) {
      if (await accounts.roleIn(req.orgId, existing.id)) throw httpError(409, 'esta pessoa já faz parte da organização');
      await accounts.setMembership(req.orgId, existing.id, role);
      return res.json({ id: existing.id, email: existing.email, existing: true, tempPassword: null });
    }
    const password = tempPassword();
    const user = await accounts.createUser({ email, name, password, mustChangePassword: true });
    await accounts.setMembership(req.orgId, user.id, role);
    res.json({ id: user.id, email: user.email, existing: false, tempPassword: password });
  });

  router.patch('/users/:id', manage, async (req, res) => {
    const role = req.body?.role;
    if (!ROLES.includes(role)) throw httpError(400, 'papel inválido');
    const current = await member(req.orgId, req.params.id);
    assertCanTouch(req.session.role, current, role);
    await accounts.setMembership(req.orgId, req.params.id, role); // recusa tirar o último dono
    res.json({ ok: true });
  });

  router.delete('/users/:id', manage, async (req, res) => {
    const current = await member(req.orgId, req.params.id);
    assertCanTouch(req.session.role, current);
    await accounts.removeMembership(req.orgId, req.params.id); // recusa remover o último dono
    res.json({ ok: true });
  });

  // Nova senha provisória. Quem também acessa outras organizações (revenda) só pode ter a
  // senha redefinida pela equipe da plataforma: um cliente não tranca o acesso do parceiro aos demais.
  router.post('/users/:id/reset-password', manage, async (req, res) => {
    const current = await member(req.orgId, req.params.id);
    assertCanTouch(req.session.role, current);
    if (req.params.id === req.session.user.id) throw httpError(400, 'para a sua própria senha, use Minha conta');
    if (!req.session.user.platformAdmin && (await accounts.membershipCount(req.params.id)) > 1) {
      throw httpError(403, 'esta pessoa acessa outras organizações; peça a redefinição à equipe da plataforma');
    }
    const password = tempPassword();
    await accounts.setPassword(req.params.id, password, { mustChange: true });
    res.json({ ok: true, tempPassword: password });
  });
};
