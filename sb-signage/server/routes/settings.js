// Aparência da organização (marca, cor, tema, logo).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { httpError } = require('../auth');
const repo = require('../repo');

const LOGO_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
const HEX_RE = /^#[0-9a-f]{6}$/i;
const THEMES = ['dark', 'light', 'system'];
const DENSITIES = ['comfortable', 'compact'];

const DEFAULT_BRANDING = { brandName: 'SB Mídias', accent: '#ffd60a', theme: 'dark', density: 'comfortable', logoUrl: null };

function publicBranding(s) {
  return { brandName: s.brandName, accent: s.accent, theme: s.theme, density: s.density, logoUrl: s.logo ? `/branding/${s.logo}` : null };
}

module.exports = function settingsRoutes(router, { db, dirs, auth }) {
  const write = auth.allow('settings.write');

  // Público: a tela de login e a de pareamento do player mostram a marca antes de autenticar.
  // Com um único cliente (instalação local), é a marca dele; com vários, a marca padrão.
  router.get('/branding', async (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    const orgs = await db.system(async (tx) => (await tx.query('SELECT id FROM organizations LIMIT 2')).rows);
    if (orgs.length !== 1) return res.json(DEFAULT_BRANDING);
    const { settings } = await db.withOrg(orgs[0].id, (tx) => repo.getSettings(tx));
    res.json(publicBranding(settings));
  });

  // Altera as configurações numa transação e avisa painel e players da organização.
  // Nada de outra consulta ao banco dentro da transação: o PGlite tem uma conexão só.
  async function change(req, res, mutate) {
    const { settings, old } = await db.withOrg(req.orgId, async (tx) => {
      const { settings: s } = await repo.getSettings(tx);
      const before = { ...s };
      mutate(s);
      await repo.updateSettings(tx, s);
      return { settings: s, old: before };
    });
    if (old.logo && old.logo !== settings.logo) await removeLogoIfUnused(old.logo, req.orgId);
    const branding = publicBranding(settings);
    req.notify.panel('settings-changed', branding);
    req.notify.sync(); // players mostram a marca no pareamento/standby
    res.json(branding);
  }

  router.patch('/settings', write, (req, res) => change(req, res, (s) => {
    const b = req.body || {};
    if (typeof b.brandName === 'string') s.brandName = b.brandName.trim().slice(0, 60) || 'SB Mídias';
    if ('accent' in b) {
      if (!HEX_RE.test(b.accent || '')) throw httpError(400, 'cor inválida (use #RRGGBB)');
      s.accent = b.accent.toLowerCase();
    }
    if ('theme' in b) {
      if (!THEMES.includes(b.theme)) throw httpError(400, 'tema inválido');
      s.theme = b.theme;
    }
    if ('density' in b) {
      if (!DENSITIES.includes(b.density)) throw httpError(400, 'densidade inválida');
      s.density = b.density;
    }
  }));

  const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    defParamCharset: 'utf8'
  });

  router.post('/settings/logo', write, logoUpload.single('logo'), (req, res) => {
    const file = req.file;
    const ext = path.extname(file?.originalname || '').slice(1).toLowerCase();
    if (!file || !LOGO_EXT.has(ext)) throw httpError(415, 'use PNG, JPG, WEBP ou SVG (até 2 MB)');
    // nome pelo conteúdo: dois clientes com a mesma logo compartilham o arquivo, então a antiga
    // só é apagada se nenhuma outra organização ainda a usa
    const name = `logo-${crypto.createHash('sha1').update(file.buffer).digest('hex').slice(0, 12)}.${ext === 'jpeg' ? 'jpg' : ext}`;
    fs.writeFileSync(path.join(dirs.branding, name), file.buffer);
    return change(req, res, (s) => { s.logo = name; });
  });

  router.delete('/settings/logo', write, (req, res) => change(req, res, (s) => { s.logo = null; }));

  async function removeLogoIfUnused(logo, orgId) {
    const used = await db.system(async (tx) => (await tx.query(
      'SELECT 1 FROM org_settings WHERE logo = $1 AND org_id <> $2 LIMIT 1', [logo, orgId]
    )).rows.length);
    if (!used) fs.rm(path.join(dirs.branding, logo), { force: true }, () => {});
  }
};
