const $ = (id) => document.getElementById(id);

window.sbPlayer.current().then(({ server, version }) => {
  $('server').value = server;
  $('cancel').hidden = !server;
  $('version').textContent = `versão ${version}`;
});

$('cancel').addEventListener('click', () => window.sbPlayer.cancel());

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('save').disabled = true;
  $('msg').className = 'ok';
  $('msg').textContent = 'Conectando…';
  const result = await window.sbPlayer.save($('server').value);
  $('save').disabled = false;
  if (!result.ok) {
    $('msg').className = '';
    $('msg').textContent = result.error;
  }
});
