// Autenticação das requisições: sessão de usuário (painel) e credencial de tela (player).
//
// Painel: X-Auth-Token → accounts.validateSession → req.session { user, org, role }.
// Rotas de negócio exigem uma organização ativa (req.orgId) e uma permissão do papel.
// Player: X-Device-Token → tela pelo hash da credencial → req.device (com orgId).
const { can } = require('./accounts');
const { hashToken } = require('./util');
const { deviceFrom } = require('./repo');

// o que um usuário com senha provisória ainda pode fazer antes de trocá-la
const ALLOWED_WITH_TEMP_PASSWORD = new Set(['/me', '/account/password', '/logout', '/organizations']);

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function createAuth({ db, accounts, notify }) {
  // A equipe GrupoSB (console) age como dono em qualquer organização.
  const effectiveRole = (s) => s.role || (s.user.platformAdmin && s.org ? 'owner' : null);

  async function requireSession(req, _res, next) {
    const session = await accounts.validateSession(req.headers['x-auth-token']);
    if (!session) throw httpError(401, 'não autenticado');
    session.role = effectiveRole(session);
    req.session = session;
    if (session.user.mustChangePassword && !ALLOWED_WITH_TEMP_PASSWORD.has(req.path)) {
      throw httpError(403, 'troque a senha provisória para continuar', { mustChangePassword: true });
    }
    next();
  }

  // Organização ativa obrigatória; ações que alteram dados ficam registradas na auditoria.
  function requireOrg(req, res, next) {
    const orgId = req.session?.org?.id;
    if (!orgId) throw httpError(409, 'selecione uma organização');
    req.orgId = orgId;
    req.notify = {
      sync: () => notify.sync(orgId),
      panel: (event, payload) => notify.panel(orgId, event, payload)
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const action = `${req.method} ${req.route?.path || req.path}`;
        db.withOrg(orgId, (tx) => tx.query(
          'INSERT INTO audit_log (org_id, user_id, action, target) VALUES ($1, $2, $3, $4)',
          [orgId, req.session.user.id, action, req.params?.id || null]
        )).catch((err) => console.error('[auditoria]', err.message));
      });
    }
    next();
  }

  // allow('content.write') → sessão + organização + papel suficiente
  function allow(permission) {
    return [requireSession, requireOrg, (req, _res, next) => {
      if (!can(req.session.role, permission)) throw httpError(403, 'seu papel não permite esta ação');
      next();
    }];
  }

  async function findDevice(token) {
    if (!token) return null;
    const row = await db.system(async (tx) => (await tx.query(
      'SELECT * FROM devices WHERE token_hash = $1', [hashToken(token)]
    )).rows[0]);
    return row ? { ...deviceFrom(row), orgId: row.org_id } : null;
  }

  async function requireDevice(req, _res, next) {
    const device = await findDevice(req.headers['x-device-token']);
    if (!device) throw httpError(401, 'tela não autorizada');
    req.device = device;
    next();
  }

  return { requireSession, requireOrg, allow, requireDevice, findDevice, effectiveRole };
}

module.exports = { createAuth, httpError };
