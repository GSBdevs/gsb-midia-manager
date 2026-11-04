// Cliente da API do painel: token de sessão, erros padronizados, upload com progresso.
const TOKEN_KEY = 'sb_auth';

export const session = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* armazenamento indisponível */ }
  },
  clear() {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* armazenamento indisponível */ }
  }
};

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function expired() {
  window.dispatchEvent(new CustomEvent('auth-expired'));
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: {
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(session.token ? { 'X-Auth-Token': session.token } : {}),
        ...headers
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
    });
  } catch {
    throw new ApiError('sem conexão com o servidor', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login' && path !== '/account/password') {
    expired();
    throw new ApiError('sessão expirada — entre novamente', 401, data);
  }
  if (!res.ok) throw new ApiError(data.error || `erro ${res.status}`, res.status, data);
  return data;
}

// fetch não expõe progresso de envio; XHR sim.
export function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    if (session.token) xhr.setRequestHeader('X-Auth-Token', session.token);
    xhr.upload.onprogress = (e) => onProgress?.(e.lengthComputable ? e.loaded / e.total : null);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* resposta não-JSON */ }
      if (xhr.status === 401) {
        expired();
        return reject(new ApiError('sessão expirada', 401, data));
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `erro ${xhr.status}`, xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError('falha de rede no envio', 0));
    xhr.send(formData);
  });
}

// Baixa um arquivo autenticado (ex.: CSV) e entrega ao navegador.
export async function downloadFile(path, filename) {
  const res = await fetch('/api' + path, { headers: { 'X-Auth-Token': session.token || '' } });
  if (!res.ok) throw new ApiError('falha ao gerar o arquivo', res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
