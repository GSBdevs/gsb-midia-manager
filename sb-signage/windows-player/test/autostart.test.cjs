// Vigia: argumentos da tarefa e criação/remoção real no Agendador do Windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createArgs, TASK } = require('../autostart.cjs');

test('tarefa do vigia: a cada minuto, abrindo o player com --watchdog', () => {
  const a = createArgs('C:\Program Files\SB\SB Signage Player.exe');
  assert.deepEqual(a.slice(0, 6), ['/Create', '/F', '/SC', 'MINUTE', '/MO', '1']);
  assert.equal(a[a.indexOf('/TN') + 1], TASK);
  assert.equal(a[a.indexOf('/TR') + 1], '"C:\Program Files\SB\SB Signage Player.exe" --watchdog');
});

test('o Agendador aceita a tarefa sem administrador', { skip: process.platform !== 'win32' }, () => {
  const name = 'SB Signage Player (teste do vigia)';
  const args = createArgs('C:\Windows\System32\whoami.exe');
  args[args.indexOf('/TN') + 1] = name;
  try {
    execFileSync('schtasks.exe', args, { windowsHide: true });
    const info = execFileSync('schtasks.exe', ['/Query', '/TN', name, '/FO', 'LIST', '/V'], { windowsHide: true }).toString('latin1');
    assert.match(info, /whoami\.exe" --watchdog/);
  } finally {
    execFileSync('schtasks.exe', ['/Delete', '/F', '/TN', name], { windowsHide: true });
  }
});
