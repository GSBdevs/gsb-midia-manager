// Contas da versão multiusuário: organizações (clientes), usuários, papéis e sessões.
//
// Papéis por organização (do maior para o menor):
//   owner  — tudo, inclusive excluir a organização e transferir a posse
//   admin  — usuários, telas, configurações e conteúdo
//   editor — conteúdo: mídias, playlists e agenda
//   viewer — só leitura
// A equipe GrupoSB (is_platform_admin) usa o console central; não precisa ser membro.
const crypto = require('crypto');
const { hashToken, newToken } = require('./util');

const ROLES = ['viewer', 'editor', 'admin', 'owner'];
const PERMISSIONS = {
  'content.read': 'viewer',
  'content.write': 'editor', // mídias, playlists, agenda
  'devices.write': 'admin',  // parear, configurar e remover telas
  'settings.write': 'admin', // marca e preferências
  'users.manage': 'admin',   // convidar, mudar papel, remover
  'org.delete': 'owner'
};

const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;

function can(role, permission) {
  const needed = PERMISSIONS[permission];
  if (!needed) throw new Error(`permissão desconhecida: ${permission}`);
  return ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 32).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = Buffer.from(crypto.scryptSync(String(password || ''), salt, 32).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugify(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'cliente';
}

class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function createAccounts(db) {
  async function createOrganization({ name }) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new AccountError('nome da organização obrigatório');
    return db.system(async (tx) => {
      let slug = slugify(clean);
      for (let i = 2; (await tx.query('SELECT 1 FROM organizations WHERE slug = $1', [slug])).rows.length; i++) {
        slug = `${slugify(clean)}-${i}`;
      }
      const org = (await tx.query(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug, status', [clean, slug]
      )).rows[0];
      await tx.query('INSERT INTO org_settings (org_id) VALUES ($1)', [org.id]);
      return org;
    });
  }

  async function createUser({ email, name = '', password, passwordHash, mustChangePassword = false, platformAdmin = false }) {
    const mail = normalizeEmail(email);
    if (!EMAIL_RE.test(mail)) throw new AccountError('e-mail inválido');
    if (!passwordHash && String(password || '').length < MIN_PASSWORD) {
      throw new AccountError(`a senha precisa de ao menos ${MIN_PASSWORD} caracteres`);
    }
    return db.system(async (tx) => {
      if ((await tx.query('SELECT 1 FROM users WHERE email = $1', [mail])).rows.length) {
        throw new AccountError('e-mail já cadastrado', 409);
      }
      return (await tx.query(
        `INSERT INTO users (email, name, password_hash, must_change_password, is_platform_admin)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, must_change_password, is_platform_admin`,
        [mail, String(name).trim().slice(0, 80), passwordHash || hashPassword(password), mustChangePassword, platformAdmin]
      )).rows[0];
    });
  }

  async function setMembership(orgId, userId, role) {
    if (!ROLES.includes(role)) throw new AccountError('papel inválido');
    return db.system(async (tx) => {
      if (role !== 'owner') await assertNotLastOwner(tx, orgId, userId);
      await tx.query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [orgId, userId, role]
      );
    });
  }

  async function removeMembership(orgId, userId) {
    return db.system(async (tx) => {
      await assertNotLastOwner(tx, orgId, userId);
      await tx.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
      await tx.query('DELETE FROM user_sessions WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
    });
  }

  // uma organização nunca fica sem dono
  async function assertNotLastOwner(tx, orgId, userId) {
    const owners = (await tx.query(
      "SELECT user_id FROM memberships WHERE org_id = $1 AND role = 'owner'", [orgId]
    )).rows.map((r) => r.user_id);
    if (owners.length === 1 && owners[0] === userId) {
      throw new AccountError('a organização precisa de ao menos um dono');
    }
  }

  async function listMembers(orgId) {
    return db.system(async (tx) => (await tx.query(
      `SELECT u.id, u.email, u.name, m.role, u.last_login_at, u.disabled
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 ORDER BY u.name, u.email`, [orgId]
    )).rows);
  }

  async function organizationsOf(userId) {
    return db.system(async (tx) => (await tx.query(
      `SELECT o.id, o.name, o.slug, o.status, m.role
         FROM memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1 ORDER BY o.name`, [userId]
    )).rows);
  }

  /** Login por e-mail e senha. Abre na primeira organização ativa do usuário. */
  async function login(email, password) {
    const user = await db.system(async (tx) => (await tx.query(
      'SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]
    )).rows[0]);
    // mesma resposta para e-mail inexistente e senha errada: não revela quem tem conta
    if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
      throw new AccountError('e-mail ou senha incorretos', 401);
    }
    const orgs = (await organizationsOf(user.id)).filter((o) => o.status === 'active');
    if (!orgs.length && !user.is_platform_admin) throw new AccountError('usuário sem acesso a nenhuma organização', 403);
    const token = newToken();
    const now = Date.now();
    await db.system(async (tx) => {
      await tx.query(
        'INSERT INTO user_sessions (token_hash, user_id, org_id, expires_at) VALUES ($1, $2, $3, $4)',
        [hashToken(token), user.id, orgs[0]?.id || null, new Date(now + SESSION_MAX_MS)]
      );
      await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    });
    return { token, mustChangePassword: user.must_change_password, organizations: orgs };
  }

  /**
   * Sessão válida → { user, org, role }. Sessão ociosa por 7 dias ou com 30 dias expira.
   * Organização suspensa ou papel removido derrubam o acesso na hora.
   */
  async function validateSession(token) {
    if (!token) return null;
    return db.system(async (tx) => {
      const row = (await tx.query(
        `SELECT s.id AS session_id, s.last_seen_at, s.expires_at, s.org_id,
                u.id AS user_id, u.email, u.name, u.disabled, u.is_platform_admin, u.must_change_password,
                o.name AS org_name, o.status AS org_status, m.role
           FROM user_sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN organizations o ON o.id = s.org_id
           LEFT JOIN memberships m ON m.org_id = s.org_id AND m.user_id = s.user_id
          WHERE s.token_hash = $1`, [hashToken(token)]
      )).rows[0];
      if (!row || row.disabled) return null;
      const now = Date.now();
      if (new Date(row.expires_at).getTime() < now || now - new Date(row.last_seen_at).getTime() > SESSION_IDLE_MS) {
        await tx.query('DELETE FROM user_sessions WHERE id = $1', [row.session_id]);
        return null;
      }
      if (row.org_id && (row.org_status !== 'active' || !row.role) && !row.is_platform_admin) return null;
      if (now - new Date(row.last_seen_at).getTime() > 60_000) {
        await tx.query('UPDATE user_sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
      }
      return {
        sessionId: row.session_id,
        user: { id: row.user_id, email: row.email, name: row.name, platformAdmin: row.is_platform_admin, mustChangePassword: row.must_change_password },
        org: row.org_id ? { id: row.org_id, name: row.org_name } : null,
        role: row.role || null
      };
    });
  }

  /** Troca a organização ativa da sessão (usuário de várias organizações, ex.: revenda). */
  async function switchOrganization(token, orgId) {
    const session = await validateSession(token);
    if (!session) throw new AccountError('não autenticado', 401);
    const member = (await organizationsOf(session.user.id)).find((o) => o.id === orgId && o.status === 'active');
    if (!member && !session.user.platformAdmin) throw new AccountError('sem acesso a essa organização', 403);
    await db.system((tx) => tx.query('UPDATE user_sessions SET org_id = $1 WHERE id = $2', [orgId, session.sessionId]));
    return validateSession(token);
  }

  async function logout(token) {
    await db.system((tx) => tx.query('DELETE FROM user_sessions WHERE token_hash = $1', [hashToken(token)]));
  }

  async function changePassword(userId, current, next) {
    if (String(next || '').length < MIN_PASSWORD) throw new AccountError(`a senha precisa de ao menos ${MIN_PASSWORD} caracteres`);
    return db.system(async (tx) => {
      const user = (await tx.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0];
      if (!user || !verifyPassword(current, user.password_hash)) throw new AccountError('senha atual incorreta', 403);
      await tx.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [hashPassword(next), userId]);
      await tx.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]); // derruba as outras sessões
    });
  }

  async function audit(orgId, userId, action, target = null, details = {}) {
    await db.withOrg(orgId, (tx) => tx.query(
      'INSERT INTO audit_log (org_id, user_id, action, target, details) VALUES ($1, $2, $3, $4, $5)',
      [orgId, userId, action, target, JSON.stringify(details)]
    ));
  }

  return {
    createOrganization, createUser, setMembership, removeMembership, listMembers, organizationsOf,
    login, validateSession, switchOrganization, logout, changePassword, audit
  };
}

module.exports = { createAccounts, can, hashPassword, verifyPassword, slugify, ROLES, PERMISSIONS, AccountError };
