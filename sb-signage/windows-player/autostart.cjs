// Vigia (watchdog) em processo separado: uma tarefa agendada do Windows tenta abrir o player a
// cada minuto. Se ele já estiver aberto, a nova instância sai na hora (instância única).
// Cobre o que a recuperação interna não cobre: o processo principal morto, ou o player que não
// abriu no login. Tarefa do próprio usuário: não precisa de administrador.
const { execFile } = require('node:child_process');

const TASK = 'SB Mídias (vigia)';
const LEGACY_TASK = 'SB Signage Player (vigia)'; // versão 2.0.1

function createArgs(exe) {
  return ['/Create', '/F', '/SC', 'MINUTE', '/MO', '1', '/TN', TASK, '/TR', `"${exe}" --watchdog`];
}

function run(args) {
  return new Promise((resolve) => {
    execFile('schtasks.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: String(stderr || stdout || err?.message || '').trim() });
    });
  });
}

const ensureWatchdog = (exe) => run(createArgs(exe));
const removeWatchdog = () => run(['/Delete', '/F', '/TN', TASK]);
const queryWatchdog = () => run(['/Query', '/TN', TASK, '/FO', 'LIST']);
const removeLegacyWatchdog = () => run(['/Delete', '/F', '/TN', LEGACY_TASK]);

module.exports = { TASK, createArgs, ensureWatchdog, removeWatchdog, removeLegacyWatchdog, queryWatchdog };
