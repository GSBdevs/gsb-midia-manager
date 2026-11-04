// Login/logout do painel.
const { createLimiter } = require('../util');

module.exports = function sessionRoutes(router, { auth, requireAuth, store, limiters }) {
  // 10 falhas por IP a cada 15 min. Com TRUST_PROXY desligado, o IP vem do socket e não pode ser forjado.
  const failures = createLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  limiters.push(failures);

  router.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (failures.blocked(ip)) {
      return res.status(429).json({ error: 'muitas tentativas — aguarde alguns minutos' });
    }
    if (!auth.checkPassword(req.body?.password)) {
      failures.hit(ip);
      return res.status(401).json({ error: 'senha incorreta' });
    }
    failures.reset(ip);
    res.json({ token: auth.createSession() });
  });

  router.post('/logout', (req, res) => {
    auth.revokeSession(req.headers['x-auth-token']);
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (_req, res) => {
    const s = store.data.settings;
    res.json({
      ok: true,
      defaultPassword: auth.usingDefaultPassword,
      branding: {
        brandName: s.brandName, accent: s.accent, theme: s.theme, density: s.density,
        logoUrl: s.logo ? `/branding/${s.logo}` : null
      }
    });
  });
};
