// Login por e-mail, primeiro acesso, sessão, troca de organização e senha do próprio usuário.
const fs = require('fs');
const path = require('path');
const { createLimiter } = require('../util');
const { can, PERMISSIONS } = require('../accounts');
const { importFromJson, copyLegacyLogs } = require('../db/import-json');
const { httpError } = require('../auth');
const { migrate: migrateLegacy } = require('../store');
const repo = require('../repo');

module.exports = function sessionRoutes(router, ctx) {
  const { db, accounts, auth, dirs, config, limiters } = ctx;
  const { requireSession } = auth;

  // 10 falhas por IP a cada 15 min. Com TRUST_PROXY desligado, o IP vem do socket e não pode ser forjado.
  const failures = createLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  limiters.push(failures);
  const guard = (req) => {
    if (failures.blocked(req.ip || 'unknown')) throw httpError(429, 'muitas tentativas — aguarde alguns minutos');
  };

  router.post('/login', async (req, res) => {
    guard(req);
    try {
      const r = await accounts.login(req.body?.email, req.body?.password);
      failures.reset(req.ip || 'unknown');
      res.json({ token: r.token, mustChangePassword: r.mustChangePassword });
    } catch (err) {
      if (err.status === 401) failures.hit(req.ip || 'unknown');
      throw err;
    }
  });

  router.post('/logout', async (req, res) => {
    const token = req.headers['x-auth-token'];
    if (token) await accounts.logout(token);
    res.json({ ok: true });
  });

  router.get('/me', requireSession, async (req, res) => {
    const s = req.session;
    const organizations = await accounts.accessibleOrganizations(s.user);
    let branding = null;
    if (s.org) {
      const { settings } = await db.withOrg(s.org.id, (tx) => repo.getSettings(tx));
      branding = { ...settings, logoUrl: settings.logo ? `/branding/${settings.logo}` : null };
      delete branding.logo;
    }
    res.json({
      ok: true,
      user: s.user,
      org: s.org,
      role: s.role,
      permissions: s.role ? Object.keys(PERMISSIONS).filter((p) => can(s.role, p)) : [],
      organizations: organizations.map(({ id, name, role }) => ({ id, name, role })),
      branding
    });
  });

  router.post('/account/password', requireSession, async (req, res) => {
    const { current, next } = req.body || {};
    await accounts.changePassword(req.session.user.id, current, next);
    // as sessões do usuário caem (inclusive esta); a nova continua na mesma organização
    res.json({ ok: true, token: await accounts.createSession(req.session.user.id, req.session.org?.id || null) });
  });

  router.patch('/account', requireSession, async (req, res) => {
    await accounts.updateProfile(req.session.user.id, { name: req.body?.name });
    res.json({ ok: true });
  });

  router.get('/organizations', requireSession, async (req, res) => {
    res.json(await accounts.accessibleOrganizations(req.session.user));
  });

  router.post('/organizations/switch', requireSession, async (req, res) => {
    const s = await accounts.switchOrganization(req.headers['x-auth-token'], String(req.body?.orgId || ''));
    res.json({ ok: true, org: s.org });
  });

  // Nova organização (cliente): só a equipe GrupoSB. Quem cria entra como dono e
  // depois cadastra o responsável do cliente na tela Usuários.
  router.post('/organizations', requireSession, async (req, res) => {
    if (!req.session.user.platformAdmin) throw httpError(403, 'só a equipe da plataforma cria organizações');
    const org = await accounts.createOrganization({ name: req.body?.name });
    await accounts.setMembership(org.id, req.session.user.id, 'owner');
    await accounts.audit(org.id, req.session.user.id, 'org.create', org.id, { name: org.name });
    res.json(org);
  });

  // ---------- primeiro acesso ----------
  const legacyFile = path.join(config.dataDir, 'data.json');

  function legacySummary() {
    try {
      const data = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      return {
        devices: (data.devices || []).length,
        media: (data.media || []).length,
        playlists: (data.playlists || []).length,
        brandName: data.settings?.brandName || null
      };
    } catch {
      return null;
    }
  }

  router.get('/setup', async (_req, res) => {
    const needed = (await accounts.countUsers()) === 0;
    res.json({ needed, legacy: needed ? legacySummary() : null });
  });

  // Cria a primeira organização e a primeira conta (administra a instalação).
  // Com importLegacy, leva junto o conteúdo e as telas pareadas do data.json; o arquivo não é alterado.
  router.post('/setup', async (req, res) => {
    guard(req);
    if ((await accounts.countUsers()) > 0) throw httpError(409, 'esta instalação já foi configurada');
    const b = req.body || {};
    const owner = { orgName: String(b.orgName || '').trim(), ownerEmail: b.email, ownerName: b.name || '', ownerPassword: b.password };
    if (String(b.password || '').length < 8) throw httpError(400, 'a senha precisa de ao menos 8 caracteres');

    let org;
    let user;
    let imported = null;
    if (b.importLegacy && fs.existsSync(legacyFile)) {
      // migrate(): arquivos da v1 (credenciais em texto) chegam no formato atual, só com hash
      const data = migrateLegacy(JSON.parse(fs.readFileSync(legacyFile, 'utf8')));
      const r = await importFromJson(db, accounts, data, { ...owner, platformAdmin: true });
      ({ org, owner: user } = r);
      imported = { ...r.counts, logs: copyLegacyLogs(dirs.logs, org.id) };
    } else {
      if (!owner.orgName) throw httpError(400, 'informe o nome da empresa');
      org = await accounts.createOrganization({ name: owner.orgName });
      user = await accounts.createUser({
        email: owner.ownerEmail, name: owner.ownerName, password: owner.ownerPassword, platformAdmin: true
      });
      await accounts.setMembership(org.id, user.id, 'owner');
    }
    await accounts.audit(org.id, user.id, 'setup', org.id, { imported: !!imported });
    await db.system((tx) => tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]));
    res.json({ token: await accounts.createSession(user.id, org.id), imported });
  });
};
