// Aparência (marca, cor, tema, logo) e conta do administrador.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const LOGO_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
const HEX_RE = /^#[0-9a-f]{6}$/i;
const THEMES = ['dark', 'light', 'system'];
const DENSITIES = ['comfortable', 'compact'];

module.exports = function settingsRoutes(router, { store, dirs, notify, auth, requireAuth }) {
  const d = store.data;

  function publicBranding() {
    const s = d.settings;
    return {
      brandName: s.brandName,
      accent: s.accent,
      theme: s.theme,
      density: s.density,
      logoUrl: s.logo ? `/branding/${s.logo}` : null
    };
  }

  // Público: a tela de login e a de pareamento do player mostram a marca antes de autenticar.
  router.get('/branding', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(publicBranding());
  });

  router.patch('/settings', requireAuth, (req, res) => {
    const b = req.body || {};
    const s = d.settings;
    if (typeof b.brandName === 'string') s.brandName = b.brandName.trim().slice(0, 60) || 'SB Mídias';
    if ('accent' in b) {
      if (!HEX_RE.test(b.accent || '')) return res.status(400).json({ error: 'cor inválida (use #RRGGBB)' });
      s.accent = b.accent.toLowerCase();
    }
    if ('theme' in b) {
      if (!THEMES.includes(b.theme)) return res.status(400).json({ error: 'tema inválido' });
      s.theme = b.theme;
    }
    if ('density' in b) {
      if (!DENSITIES.includes(b.density)) return res.status(400).json({ error: 'densidade inválida' });
      s.density = b.density;
    }
    store.save();
    notify.panel('settings-changed', publicBranding());
    notify.sync(); // players mostram a marca no pareamento/standby
    res.json(publicBranding());
  });

  const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    defParamCharset: 'utf8'
  });

  router.post('/settings/logo', requireAuth, logoUpload.single('logo'), (req, res) => {
    const file = req.file;
    const ext = path.extname(file?.originalname || '').slice(1).toLowerCase();
    if (!file || !LOGO_EXT.has(ext)) return res.status(415).json({ error: 'use PNG, JPG, WEBP ou SVG (até 2 MB)' });
    const name = `logo-${crypto.createHash('sha1').update(file.buffer).digest('hex').slice(0, 12)}.${ext === 'jpeg' ? 'jpg' : ext}`;
    fs.writeFileSync(path.join(dirs.branding, name), file.buffer);
    const old = d.settings.logo;
    d.settings.logo = name;
    if (old && old !== name) fs.rm(path.join(dirs.branding, old), { force: true }, () => {});
    store.save();
    notify.panel('settings-changed', publicBranding());
    notify.sync();
    res.json(publicBranding());
  });

  router.delete('/settings/logo', requireAuth, (_req, res) => {
    if (d.settings.logo) fs.rm(path.join(dirs.branding, d.settings.logo), { force: true }, () => {});
    d.settings.logo = null;
    store.save();
    notify.panel('settings-changed', publicBranding());
    notify.sync();
    res.json(publicBranding());
  });

  router.post('/account/password', requireAuth, (req, res) => {
    try {
      const token = auth.changePassword(req.body?.current, req.body?.next);
      res.json({ ok: true, token });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });
};
