// HelpInk — Worker da Cloudflare
// - Serve o site estático (pasta public/) pelo binding ASSETS
// - Expõe a API /api/* que lê e grava no banco D1 (binding DB)
// - Identifica o usuário pelo token do Cloudflare Access (Cf-Access-Jwt-Assertion),
//   verificando assinatura, emissor (equipe), audiência (AUD) e validade.

const COLS = new Set(['meta', 'clients', 'sessions', 'personal', 'stock', 'buys']);
const MAX_UPS = 200, MAX_DELS = 200;      // por requisição (o app divide em lotes)
const ROWS_PER_INSERT = 25;               // 4 parâmetros por linha → 100 (limite do D1)
const IDS_PER_DELETE = 98;                // + user_id e col = 100 parâmetros

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    let email;
    try {
      email = await identify(req, env, url);
    } catch (e) {
      return json({ error: 'Não autorizado: ' + e.message }, 401);
    }

    try {
      if (url.pathname === '/api/data' && req.method === 'GET') {
        const { results } = await env.DB
          .prepare('SELECT col, id, data FROM records WHERE user_id = ?')
          .bind(email).all();
        return json({ email, rows: results.map(r => ({ col: r.col, id: r.id, data: JSON.parse(r.data) })) });
      }

      if (url.pathname === '/api/sync' && req.method === 'POST') {
        // Proteção contra envio a partir de outros sites
        if (!(req.headers.get('content-type') || '').includes('application/json'))
          return json({ error: 'Content-Type inválido' }, 415);
        const origin = req.headers.get('origin');
        if (origin && origin !== url.origin) return json({ error: 'Origem não permitida' }, 403);

        const body = await req.json().catch(() => null);
        if (!body) return json({ error: 'JSON inválido' }, 400);
        const ups = Array.isArray(body.ups) ? body.ups : [], dels = Array.isArray(body.dels) ? body.dels : [];
        if (ups.length > MAX_UPS || dels.length > MAX_DELS) return json({ error: 'Lote grande demais' }, 413);

        const okKey = r => r && COLS.has(r.col) && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64;
        const rows = [];
        for (const r of ups) {
          if (!okKey(r) || !r.data || typeof r.data !== 'object') return json({ error: 'Registro inválido' }, 400);
          rows.push([email, r.col, r.id, JSON.stringify(r.data)]);
        }
        const delBy = {};
        for (const r of dels) {
          if (!okKey(r)) return json({ error: 'Exclusão inválida' }, 400);
          (delBy[r.col] = delBy[r.col] || []).push(r.id);
        }

        const stmts = [];
        for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
          const part = rows.slice(i, i + ROWS_PER_INSERT);
          stmts.push(env.DB.prepare(
            'INSERT INTO records (user_id, col, id, data) VALUES ' + part.map(() => '(?, ?, ?, ?)').join(', ') +
            ' ON CONFLICT (user_id, col, id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP'
          ).bind(...part.flat()));
        }
        for (const col in delBy) {
          const ids = delBy[col];
          for (let i = 0; i < ids.length; i += IDS_PER_DELETE) {
            const part = ids.slice(i, i + IDS_PER_DELETE);
            stmts.push(env.DB.prepare(
              `DELETE FROM records WHERE user_id = ? AND col = ? AND id IN (${part.map(() => '?').join(', ')})`
            ).bind(email, col, ...part));
          }
        }
        if (stmts.length) await env.DB.batch(stmts); // tudo ou nada
        return json({ ok: true });
      }

      return json({ error: 'Não encontrado' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'Erro no servidor' }, 500);
    }
  }
};

/* ---------------- Cloudflare Access ---------------- */

async function identify(req, env, url) {
  // Desenvolvimento local (wrangler dev): DEV_EMAIL vem do arquivo .dev.vars, que não é publicado.
  if (env.DEV_EMAIL && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return env.DEV_EMAIL.toLowerCase();

  const team = (env.ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
  const auds = (env.ACCESS_AUD || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!/^https:\/\/[\w-]+\.cloudflareaccess\.com$/.test(team) || !auds.length)
    throw new Error('ACCESS_TEAM_DOMAIN / ACCESS_AUD não configurados');

  const token = req.headers.get('cf-access-jwt-assertion') ||
    (/(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get('cookie') || '') || [])[1];
  if (!token) throw new Error('sem token do Access');

  const payload = await verifyJwt(token, team);
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== team) throw new Error('emissor inválido');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some(a => auds.includes(a))) throw new Error('audiência inválida');
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) throw new Error('token expirado');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) throw new Error('token ainda não válido');
  if (!payload.email) throw new Error('token sem e-mail');
  return String(payload.email).toLowerCase();
}

let certCache = { team: '', keys: [], at: 0 };
async function accessKeys(team, force) {
  if (!force && certCache.team === team && Date.now() - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch(team + '/cdn-cgi/access/certs');
  if (!r.ok) throw new Error('não foi possível obter as chaves do Access');
  const { keys } = await r.json();
  certCache = { team, keys: keys || [], at: Date.now() };
  return certCache.keys;
}

const b64u = s => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const dec = b => JSON.parse(new TextDecoder().decode(b));

async function verifyJwt(token, team) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('token malformado');
  const [h, p, s] = parts;
  const header = dec(b64u(h));
  if (header.alg !== 'RS256') throw new Error('algoritmo inválido');
  let jwk = (await accessKeys(team)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(team, true)).find(k => k.kid === header.kid); // chaves rotacionadas
  if (!jwk) throw new Error('chave desconhecida');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p));
  if (!ok) throw new Error('assinatura inválida');
  return dec(b64u(p));
}
