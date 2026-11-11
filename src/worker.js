// HelpInk — Worker da Cloudflare
// - Serve o site estático (pasta public/) pelo binding ASSETS
// - Expõe a API /api/* que lê e grava no banco D1 (binding DB)
// - Identifica o usuário pelo token do Cloudflare Access (Cf-Access-Jwt-Assertion),
//   verificando assinatura, emissor (equipe), audiência (AUD) e validade.

const COLS = new Set(['meta', 'clients', 'sessions', 'personal', 'stock', 'buys']);
const MAX_UPS = 200, MAX_DELS = 200;      // por requisição (o app divide em lotes)
const ROWS_PER_INSERT = 25;               // 4 parâmetros por linha → 100 (limite do D1)
const IDS_PER_DELETE = 98;                // + user_id e col = 100 parâmetros
const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;    // IDs vão para atributos HTML no app: só caracteres seguros
const MAX_BODY = 4 * 1024 * 1024;         // 4 MB por requisição
const MAX_RECORD = 64 * 1024;             // 64 KB por registro (um cliente, uma sessão…)
const MAX_RECORDS_PER_USER = 50000;       // teto de linhas por usuário

// Perfil do estúdio: só campos conhecidos; foto apenas como imagem embutida (data URL) JPEG/PNG/WebP de até ~50 KB
const RE_PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const META_KEYS = { studio: v => typeof v === 'string' && v.length <= 80, named: v => typeof v === 'boolean',
  photo: v => v === '' || (typeof v === 'string' && v.length <= 70000 && RE_PHOTO.test(v)),
  cor: v => v === '' || /^(estencil|tradicional|jade|tinta|rosa|grafite)$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(v),
  fundo: v => v === '' || ['neutro', 'tingido', 'quente'].includes(v), cantos: v => v === '' || ['suave', 'reto', 'redondo'].includes(v) };
const okMeta = d => Object.keys(d).every(k => META_KEYS[k] && META_KEYS[k](d[k]));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer'
    }
  });

// Lê o corpo JSON respeitando o limite de tamanho
async function readJson(req) {
  const len = +req.headers.get('content-length') || 0;
  if (len > MAX_BODY) return { tooBig: true };
  const text = await req.text();
  if (text.length > MAX_BODY) return { tooBig: true };
  try { return { body: JSON.parse(text) }; } catch { return { body: null }; }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Só HTTPS: a ficha leva dados de saúde e CPF, que nunca podem trafegar sem criptografia.
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      if (req.method === 'GET' || req.method === 'HEAD') { url.protocol = 'https:'; return Response.redirect(url.toString(), 301); }
      return json({ error: 'Use o endereço com https://' }, 403);
    }
    // Rotas públicas da ficha do cliente (sem login; acesso só com o link secreto)
    if (url.pathname.startsWith('/assinar/api/')) {
      try { return await publicForm(req, env, ctx, url); }
      catch (e) { console.error(e); return json({ error: 'Erro no servidor' }, 500); }
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    let email;
    try {
      email = await identify(req, env, url);
    } catch (e) {
      console.warn('login recusado:', e.message); // o motivo fica só no log, não na resposta
      return json({ error: 'Não autorizado. Entre de novo.' }, 401);
    }

    try {
      // Proteção contra envio a partir de outros sites (vale para tudo que altera dados)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.get('origin');
        if (origin && origin !== url.origin) return json({ error: 'Origem não permitida' }, 403);
      }
      if (req.method === 'POST' && !(req.headers.get('content-type') || '').includes('application/json'))
        return json({ error: 'Content-Type inválido' }, 415);

      const acc = await account(env, email);

      if (url.pathname === '/api/me' && req.method === 'GET') return json(acc);

      if (url.pathname === '/api/signup' && req.method === 'POST') {
        if (acc.status !== 'none') return json({ error: 'Cadastro já enviado' }, 409);
        const { body: b0, tooBig } = await readJson(req);
        if (tooBig) return json({ error: 'Requisição grande demais' }, 413);
        const b = b0 && typeof b0 === 'object' ? b0 : {};
        const clean = (v, n) => String(v || '').trim().slice(0, n);
        const nome = clean(b.nome, 80), estudio = clean(b.estudio, 80), telefone = clean(b.telefone, 30);
        if (!nome) return json({ error: 'Informe seu nome' }, 400);
        await env.DB.prepare('INSERT INTO users (email, nome, estudio, telefone) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING')
          .bind(email, nome, estudio, telefone).run();
        return json(await account(env, email));
      }

      if (url.pathname.startsWith('/api/admin/')) {
        if (!acc.admin) return json({ error: 'Apenas administradores' }, 403);
        if (url.pathname === '/api/admin/users' && req.method === 'GET') {
          const { results } = await env.DB.prepare(
            `SELECT u.email, u.nome, u.estudio, u.telefone, u.status, u.created_at, u.decided_at,
               (SELECT COUNT(*) FROM records r WHERE r.user_id = u.email AND r.col = 'clients') AS clientes,
               (SELECT COUNT(*) FROM records r WHERE r.user_id = u.email AND r.col = 'sessions') AS sessoes
             FROM users u
             ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, u.created_at DESC`
          ).all();
          return json({ users: results.map(u => ({ ...u, admin: isAdmin(env, u.email) })) });
        }
        if (url.pathname === '/api/admin/users' && req.method === 'POST') {
          const { body: b0, tooBig } = await readJson(req);
          if (tooBig) return json({ error: 'Requisição grande demais' }, 413);
          const b = b0 && typeof b0 === 'object' ? b0 : {};
          const target = String(b.email || '').toLowerCase();
          if (!target || isAdmin(env, target)) return json({ error: 'Usuário inválido' }, 400);
          if (b.action === 'approve' || b.action === 'reject') {
            const r = await env.DB.prepare('UPDATE users SET status = ?, decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE email = ?')
              .bind(b.action === 'approve' ? 'approved' : 'rejected', email, target).run();
            if (!r.meta || !r.meta.changes) return json({ error: 'Usuário não encontrado' }, 404);
          } else if (b.action === 'remove') {
            // Remove só o pedido/cadastro (a pessoa poderá pedir de novo). Os dados dela, se houver, são mantidos.
            await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(target).run();
          } else return json({ error: 'Ação inválida' }, 400);
          return json({ ok: true });
        }
        return json({ error: 'Não encontrado' }, 404);
      }

      // Daqui em diante, só contas aprovadas
      if (acc.status !== 'approved')
        return json({ error: 'Sua conta ainda não foi aprovada.', code: 'not_approved', status: acc.status }, 403);

      if (url.pathname === '/api/forms' || url.pathname === '/api/forms/doc') return await ownerForms(req, env, url, email);
      if (url.pathname === '/api/agenda') return await ownerAgenda(req, env, email);
      if (url.pathname === '/api/data' && req.method === 'GET') {
        const { results } = await env.DB
          .prepare('SELECT col, id, data FROM records WHERE user_id = ?')
          .bind(email).all();
        return json({ email, rows: results.map(r => ({ col: r.col, id: r.id, data: JSON.parse(r.data) })) });
      }

      if (url.pathname === '/api/sync' && req.method === 'POST') {
        const { body, tooBig } = await readJson(req);
        if (tooBig) return json({ error: 'Requisição grande demais' }, 413);
        if (!body || typeof body !== 'object') return json({ error: 'JSON inválido' }, 400);
        const ups = Array.isArray(body.ups) ? body.ups : [], dels = Array.isArray(body.dels) ? body.dels : [];
        if (ups.length > MAX_UPS || dels.length > MAX_DELS) return json({ error: 'Lote grande demais' }, 413);

        const okKey = r => r && typeof r === 'object' && COLS.has(r.col) && typeof r.id === 'string' && RE_ID.test(r.id);
        const rows = [];
        for (const r of ups) {
          if (!okKey(r) || !r.data || typeof r.data !== 'object' || Array.isArray(r.data))
            return json({ error: 'Registro inválido' }, 400);
          if (r.col === 'meta' && !okMeta(r.data)) return json({ error: 'Perfil inválido' }, 400);
          const data = JSON.stringify(r.data);
          if (data.length > MAX_RECORD) return json({ error: 'Registro grande demais' }, 413);
          rows.push([email, r.col, r.id, data]);
        }
        if (rows.length) {
          const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?').bind(email).first();
          if (c && c.n + rows.length > MAX_RECORDS_PER_USER) return json({ error: 'Limite de registros da conta atingido' }, 413);
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

/* ---------------- Ficha de anamnese e assinatura eletrônica ---------------- */

const FORM_TTL_DAYS = 7;
const TERM_VERSION = '2026-11-v2'; // v2: a ficha é por sessão e lista as tatuagens do dia
const enc = new TextEncoder();
const hex = u8 => [...u8].map(x => x.toString(16).padStart(2, '0')).join('');
const b64 = u8 => { let s = ''; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };
const b64url = u8 => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async str => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)));
const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const newId = () => hex(crypto.getRandomValues(new Uint8Array(8)));
const nowIso = () => new Date().toISOString();
const brt = iso => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' });
const h = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const RE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
// E-mail parcial para o documento entregue ao cliente (o completo fica só no banco): jo***@gm***.com
const maskEmail = e => {
  const [u, d = ''] = String(e || '').split('@'), dot = d.lastIndexOf('.');
  const m = s => s.slice(0, 2) + '***';
  return u ? m(u) + '@' + (dot > 0 ? m(d.slice(0, dot)) + d.slice(dot) : m(d)) : '';
};

function cpfOk(c) {
  c = String(c || '').replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i);
    if ((s * 10) % 11 % 10 !== +c[n]) return false;
  }
  return true;
}
// Sessões vêm do app (registro livre em JSON): tudo que sai daqui é revalidado e cortado.
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/, RE_HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SES_ST = ['Pendente', 'Confirmado', 'Concluído'];
const cut = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const todayBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // Brasília (sem horário de verão)
const fmtDate = d => d.split('-').reverse().join('/');
const sessTats = s => (Array.isArray(s.tatuagens) && s.tatuagens.length ? s.tatuagens : [s]).slice(0, 30)
  .map(t => ({ desc: cut(t && t.desc, 300), estilo: cut(t && t.estilo, 40), cm: Math.max(0, Math.min(1000, +(t && t.cm) || 0)) }))
  .filter(t => t.desc);
const procOf = s => ({ data: RE_DATE.test(s.data || '') ? s.data : '', hora: RE_HM.test(s.hora || '') ? s.hora : '', tatuagens: sessTats(s) });
const fmtCpf = c =>String(c).replace(/\D/g, '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

const QUESTIONS = [
  { id: 'alergia', q: 'Tem alguma alergia (látex, metais, tintas, pomadas, anestésicos, medicamentos ou outra)?', det: 'Quais?' },
  { id: 'medicamentos', q: 'Usa algum medicamento contínuo ou está em tratamento médico?', det: 'Quais?' },
  { id: 'anticoagulante', q: 'Tomou anticoagulante, AAS/aspirina ou anti-inflamatório nos últimos 7 dias?', det: 'Qual e quando?' },
  { id: 'diabetes', q: 'Tem diabetes?', det: 'Tipo e se está controlada' },
  { id: 'cardiaco', q: 'Tem pressão alta, problema cardíaco ou usa marca-passo?', det: 'Qual?' },
  { id: 'coagulacao', q: 'Tem hemofilia ou outro problema de coagulação ou cicatrização?', det: 'Qual?' },
  { id: 'queloide', q: 'Tem tendência a queloide ou cicatrizes elevadas?', det: 'Onde/quando?' },
  { id: 'pele', q: 'Tem doença de pele (dermatite, psoríase, vitiligo, micose) na região a ser tatuada?', det: 'Qual?' },
  { id: 'infecciosa', q: 'Tem alguma doença infectocontagiosa (ex.: hepatite, HIV) ou imunidade baixa?', det: 'Se quiser, descreva', opt: true },
  { id: 'epilepsia', q: 'Tem epilepsia ou já teve convulsões ou desmaios (inclusive com agulhas ou sangue)?', det: 'Quando?' },
  { id: 'gestante', q: 'Está grávida ou amamentando?' },
  { id: 'alcool', q: 'Consumiu bebida alcoólica ou drogas nas últimas 24 horas?', det: 'O quê?' }
];

function buildTerm(studio, proc) {
  const s = studio || 'o estúdio', n = proc ? proc.tatuagens.length : 0;
  const escopo = proc
    ? `Este termo vale somente para ${n === 1 ? 'a tatuagem listada' : 'as ' + n + ' tatuagens listadas'} em "Procedimento"${proc.data ? ', na sessão de ' + fmtDate(proc.data) : ''}. O desenho, o tamanho e o local de cada uma são combinados com o(a) tatuador(a) antes do início do procedimento. Outra tatuagem ou outra sessão exige uma nova ficha.`
    : 'O desenho, o tamanho e o local da tatuagem serão combinados com o(a) tatuador(a) antes do início do procedimento.';
  return {
    version: TERM_VERSION,
    proc: proc || null,
    questions: QUESTIONS,
    text: [
      `Declaro que fui informado(a) por ${s} de que a tatuagem é um procedimento que perfura a pele com agulhas e deposita pigmento de forma permanente, e de que sua remoção é difícil, cara e pode deixar marcas.`,
      'Fui informado(a) dos possíveis riscos, entre eles: dor, sangramento, inchaço, infecção, reação alérgica a pigmentos ou materiais, cicatrização irregular, formação de queloide e variação de cor ou traço conforme o tipo de pele, a região do corpo e os cuidados posteriores.',
      'Comprometo-me a seguir as orientações de cuidados passadas pelo estúdio e, em caso de sinais de infecção ou reação alérgica, a procurar atendimento médico e avisar o estúdio.',
      'Estou ciente de que omitir ou prestar informações falsas sobre minha saúde pode aumentar os riscos do procedimento e será considerado na apuração de eventual responsabilidade.',
      escopo,
      'Declaro não estar sob efeito de álcool ou drogas no momento do procedimento e estar em plenas condições de consentir.'
    ],
    decls: [
      { id: 'riscos', req: true, t: 'Li e entendi o termo acima, incluindo os riscos e os cuidados necessários antes e depois do procedimento.' },
      { id: 'verdade', req: true, t: 'As informações pessoais e de saúde que prestei nesta ficha são verdadeiras e completas. Comprometo-me a avisar o estúdio se algo mudar antes do procedimento.' },
      { id: 'lgpd', req: true, t: `Autorizo ${s} a tratar meus dados pessoais e de saúde informados nesta ficha exclusivamente para avaliar e realizar o procedimento e para o exercício regular de direitos, mantendo-os por até 5 anos após o atendimento (LGPD, art. 11, I).` },
      { id: 'imagem', req: false, t: '(Opcional) Autorizo o uso de fotos da tatuagem, sem identificação do meu rosto, no portfólio e nas redes sociais do estúdio.' }
    ],
    privacy: `${s} é responsável (controlador) pelos dados desta ficha, que são armazenados com segurança pelo sistema HelpInk (operador). Os dados de saúde são usados apenas para avaliar e realizar o procedimento e para o exercício regular de direitos, e ficam guardados por até 5 anos após o atendimento. Você pode pedir acesso, correção ou informações sobre seus dados diretamente ao estúdio.`
  };
}

const age = (iso, now) => {
  const b = new Date(iso + 'T00:00:00Z'), n = new Date(now);
  let a = n.getUTCFullYear() - b.getUTCFullYear();
  if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a--;
  return a;
};
const validDate = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};

// Valida o que o cliente enviou. Devolve { errors, clean }.
function validateSign(term, d, now) {
  const errors = [], str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  if (!d || typeof d !== 'object') return { errors: ['Dados inválidos.'] };
  const c = {
    nome: str(d.nome, 120), cpf: str(d.cpf, 20).replace(/\D/g, ''), nasc: str(d.nasc, 10),
    tel: str(d.tel, 30), email: str(d.email, 120), obs: str(d.obs, 1000), assinatura: str(d.assinatura, 120)
  };
  if (c.nome.split(' ').filter(Boolean).length < 2) errors.push('Informe seu nome completo.');
  if (!cpfOk(c.cpf)) errors.push('CPF inválido.');
  if (!validDate(c.nasc) || c.nasc > now.slice(0, 10) || age(c.nasc, now) > 120) errors.push('Data de nascimento inválida.');
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) errors.push('E-mail inválido.');
  c.menor = validDate(c.nasc) && age(c.nasc, now) < 18;
  if (c.menor) {
    const r = d.resp && typeof d.resp === 'object' ? d.resp : {};
    c.resp = { nome: str(r.nome, 120), cpf: str(r.cpf, 20).replace(/\D/g, ''), parentesco: str(r.parentesco, 40) };
    if (c.resp.nome.split(' ').filter(Boolean).length < 2) errors.push('Informe o nome completo do responsável legal.');
    if (!cpfOk(c.resp.cpf) || c.resp.cpf === c.cpf) errors.push('CPF do responsável legal inválido.');
    if (!c.resp.parentesco) errors.push('Informe o parentesco do responsável legal.');
  }
  const ans = d.answers && typeof d.answers === 'object' ? d.answers : {};
  c.answers = {};
  for (const q of term.questions) {
    const a = ans[q.id] && typeof ans[q.id] === 'object' ? ans[q.id] : {};
    const v = a.v === 'sim' || a.v === 'nao' ? a.v : '';
    const det = q.det ? str(a.d, 500) : '';
    if (!v) errors.push('Responda: ' + q.q);
    else if (v === 'sim' && q.det && !q.opt && det.length < 2) errors.push('Detalhe a resposta: ' + q.q);
    c.answers[q.id] = { v, d: v === 'sim' ? det : '' };
  }
  const dec = d.decls && typeof d.decls === 'object' ? d.decls : {};
  c.decls = {};
  for (const x of term.decls) {
    c.decls[x.id] = dec[x.id] === true;
    if (x.req && !c.decls[x.id]) errors.push('Marque a declaração: ' + x.t.slice(0, 60) + '…');
  }
  const signer = c.menor ? (c.resp || {}).nome : c.nome;
  if (!c.assinatura || normName(c.assinatura) !== normName(signer))
    errors.push(`Para assinar, digite o nome completo ${c.menor ? 'do responsável legal' : ''} exatamente como informado acima.`.replace('  ', ' '));
  return { errors, clean: c };
}

// Documento final (HTML autocontido). O SHA-256 deste texto é a "impressão digital" entregue ao cliente.
function buildDoc(f, term, c, ev) {
  const row = (k, v) => `<tr><th>${h(k)}</th><td>${h(v)}</td></tr>`;
  const ans = term.questions.map(q => {
    const a = c.answers[q.id];
    return `<tr><td>${h(q.q)}</td><td>${a.v === 'sim' ? 'Sim' : 'Não'}</td><td>${h(a.d)}</td></tr>`;
  }).join('');
  const signer = c.menor ? c.resp : c;
  let n = 0;
  const H = t => `<h2>${++n}. ${h(t)}</h2>`;
  const p = term.proc;
  const proc = p ? `${H('Procedimento')}
<table>${row('Data da sessão', p.data ? fmtDate(p.data) + (p.hora ? ' às ' + p.hora : '') : '—')}${row('Tatuagens', p.tatuagens.length)}</table>
<ol>${p.tatuagens.map(t => `<li>${h(t.desc)}${[t.estilo, t.cm ? t.cm + ' cm' : ''].filter(Boolean).length ? ' (' + h([t.estilo, t.cm ? t.cm + ' cm' : ''].filter(Boolean).join(', ')) + ')' : ''}</li>`).join('')}</ol>` : '';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Ficha de anamnese - ${h(c.nome)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;max-width:780px;margin:24px auto;padding:0 16px;color:#111;line-height:1.45}h1{font-size:20px}h2{font-size:16px;margin-top:26px;border-bottom:1px solid #bbb;padding-bottom:4px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top;font-size:14px}th{width:34%;background:#f5f5f5}.small{font-size:12px;color:#444}</style></head>
<body>
<h1>Ficha de anamnese e termo de consentimento para tatuagem</h1>
<table>${row('Estúdio', f.studio)}${row('Ficha nº', f.id)}${row('Versão do termo', term.version)}</table>
${proc}
${H('Dados do cliente')}
<table>${row('Nome completo', c.nome)}${row('CPF', fmtCpf(c.cpf))}${row('Data de nascimento', c.nasc.split('-').reverse().join('/'))}${row('Telefone', c.tel)}${row('E-mail', c.email)}</table>
${c.menor ? `<h2>Responsável legal (cliente menor de 18 anos)</h2><table>${row('Nome completo', c.resp.nome)}${row('CPF', fmtCpf(c.resp.cpf))}${row('Parentesco', c.resp.parentesco)}</table>` : ''}
${H('Anamnese')}
<table><tr><th>Pergunta</th><th style="width:12%">Resposta</th><th>Detalhes</th></tr>${ans}</table>
<p><b>Outras observações:</b> ${h(c.obs) || '—'}</p>
${H('Termo de consentimento')}
<ol>${term.text.map(t => `<li>${h(t)}</li>`).join('')}</ol>
${H('Declarações')}
<ul>${term.decls.map(x => `<li>[${c.decls[x.id] ? 'X' : ' '}] ${h(x.t)}</li>`).join('')}</ul>
${H('Aviso de privacidade')}
<p>${h(term.privacy)}</p>
${H('Assinatura eletrônica')}
<p>Assinado eletronicamente por <b>${h(signer.nome)}</b> (CPF ${h(fmtCpf(signer.cpf))})${c.menor ? ', responsável legal' : ''}, que digitou o próprio nome completo como assinatura: <b>${h(c.assinatura)}</b>.</p>
<p>Data e hora: <b>${h(brt(ev.signed_at))}</b> (horário de Brasília) — ${h(ev.signed_at)} (UTC).</p>
${H('Registro de evidências')}
<table>${row('Link criado em', brt(f.created_at) + ' — pela conta ' + maskEmail(f.owner))}${row('Link válido até', brt(f.expires_at))}${row('Link aberto pela primeira vez em', ev.opened ? brt(ev.opened.at) + ' — IP ' + ev.opened.ip : '—')}${row('Assinado em', brt(ev.signed_at))}${row('IP de quem assinou', ev.ip)}${row('País (aproximado)', ev.country)}${row('Navegador / dispositivo', ev.ua)}</table>
<p class="small">Documento gerado automaticamente pelo sistema HelpInk no momento da assinatura. Assinatura eletrônica nos termos do art. 10, §2º, da MP 2.200-2/2001. O código SHA-256 deste arquivo foi exibido ao signatário no momento da assinatura e registrado pelo sistema; qualquer alteração no arquivo, por menor que seja, muda esse código. O código também foi enviado a um serviço público de carimbo do tempo (OpenTimestamps).</p>
</body></html>
`;
}

async function stampOts(env, id, digest) {
  const magic = [0x00, ...enc.encode('OpenTimestamps'), 0x00, 0x00, ...enc.encode('Proof'), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94];
  for (const cal of ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org']) {
    try {
      const r = await fetch(cal + '/digest', { method: 'POST', body: digest, headers: { accept: 'application/vnd.opentimestamps.v1' } });
      if (!r.ok) continue;
      const ts = new Uint8Array(await r.arrayBuffer());
      if (!ts.length || ts.length > 8192) continue;
      const file = new Uint8Array([...magic, 0x01, 0x08, ...digest, ...ts]); // arquivo .ots (SHA-256 do documento)
      await env.DB.prepare('UPDATE forms SET ots = ? WHERE id = ? AND ots IS NULL').bind(b64(file), id).run();
      return;
    } catch (e) { console.error('ots', e); }
  }
}

// Rotas públicas: /assinar/api/form (abrir) e /assinar/api/sign (assinar). Só o link (token) dá acesso.
async function publicForm(req, env, ctx, url) {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405);
  if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Content-Type inválido' }, 415);
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'Origem não permitida' }, 403);
  const len = +req.headers.get('content-length') || 0;
  if (len > 64 * 1024) return json({ error: 'Requisição grande demais' }, 413);
  const text = await req.text();
  if (text.length > 64 * 1024) return json({ error: 'Requisição grande demais' }, 413);
  let body; try { body = JSON.parse(text); } catch { return json({ error: 'JSON inválido' }, 400); }
  const invalid = () => json({ error: 'Link inválido. Peça um novo link ao estúdio.' }, 404);
  if (!body || typeof body.t !== 'string' || !RE_TOKEN.test(body.t)) return invalid();
  if (url.pathname === '/assinar/api/agenda') return publicAgenda(env, body.t, invalid);
  const f = await env.DB.prepare('SELECT * FROM forms WHERE token_hash = ?').bind(hex(await sha256(body.t))).first();
  if (!f) return invalid();
  const now = nowIso();
  const expired = f.status === 'cancelled' || (f.status === 'pending' && f.expires_at < now);
  const ip = req.headers.get('cf-connecting-ip') || 'desconhecido';
  const ua = (req.headers.get('user-agent') || 'desconhecido').slice(0, 300);
  const country = (req.cf && req.cf.country) || 'desconhecido';

  if (url.pathname === '/assinar/api/form') {
    if (f.status === 'signed') return json({ status: 'signed', studio: f.studio, signed_at: f.signed_at, doc_hash: f.doc_hash });
    if (expired) return json({ status: 'expired', studio: f.studio });
    if (!f.opened_at)
      await env.DB.prepare('UPDATE forms SET opened_at = ?, evidence = ? WHERE id = ? AND opened_at IS NULL')
        .bind(now, JSON.stringify({ opened: { at: now, ip, ua, country } }), f.id).run();
    return json({ status: 'pending', studio: f.studio, hint: f.client_hint, expires_at: f.expires_at, term: JSON.parse(f.term) });
  }

  if (url.pathname === '/assinar/api/sign') {
    if (f.status === 'signed') return json({ error: 'Esta ficha já foi assinada.' }, 409);
    if (expired) return json({ error: 'Este link expirou. Peça um novo link ao estúdio.' }, 410);
    if (f.attempts >= 30) return json({ error: 'Muitas tentativas. Peça um novo link ao estúdio.' }, 429);
    await env.DB.prepare('UPDATE forms SET attempts = attempts + 1 WHERE id = ?').bind(f.id).run();
    const term = JSON.parse(f.term);
    const { errors, clean } = validateSign(term, body.data, now);
    if (errors.length) return json({ error: 'Confira os dados.', errors }, 400);
    const prev = f.evidence ? JSON.parse(f.evidence) : {};
    const ev = { opened: prev.opened || null, signed_at: now, ip, ua, country, term_version: term.version };
    const doc = buildDoc(f, term, clean, ev);
    const digest = await sha256(doc), docHash = hex(digest);
    const r = await env.DB.prepare(
      `UPDATE forms SET status = 'signed', signed_at = ?, answers = ?, doc = ?, doc_hash = ?, evidence = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(now, JSON.stringify(clean), doc, docHash, JSON.stringify(ev), f.id).run();
    if (!r.meta || !r.meta.changes) return json({ error: 'Esta ficha já foi assinada.' }, 409);
    if (ctx && ctx.waitUntil) ctx.waitUntil(stampOts(env, f.id, digest));
    return json({ status: 'signed', studio: f.studio, signed_at: now, doc, doc_hash: docHash });
  }
  return json({ error: 'Não encontrado' }, 404);
}

const studioOf = async (env, email) => {
  const meta = await env.DB.prepare(`SELECT data FROM records WHERE user_id = ? AND col = 'meta' AND id = 'profile'`).bind(email).first();
  return String((meta && JSON.parse(meta.data).studio) || 'Estúdio').slice(0, 80);
};
const recordOf = (env, email, col, id) =>
  env.DB.prepare('SELECT data FROM records WHERE user_id = ? AND col = ? AND id = ?').bind(email, col, id).first();

// Agenda do cliente (pública, só com o link): próximas sessões, sem valores nem dados de saúde.
async function publicAgenda(env, token, invalid) {
  const a = await env.DB.prepare('SELECT owner, client_id FROM agenda WHERE token = ?').bind(token).first();
  if (!a) return invalid();
  const cli = await recordOf(env, a.owner, 'clients', a.client_id);
  if (!cli) return invalid(); // cliente apagado: o link deixa de funcionar
  const { results } = await env.DB.prepare(
    `SELECT data FROM records WHERE user_id = ? AND col = 'sessions' AND json_extract(data, '$.cid') = ? AND json_extract(data, '$.data') >= ?`
  ).bind(a.owner, a.client_id, todayBR()).all();
  const sessions = results.map(r => JSON.parse(r.data))
    .filter(s => RE_DATE.test(s.data || '') && s.status !== 'Cancelado')
    .map(s => ({
      data: s.data, hora: RE_HM.test(s.hora || '') ? s.hora : '', fim: RE_HM.test(s.fim || '') ? s.fim : '',
      status: SES_ST.includes(s.status) ? s.status : 'Pendente', tatuagens: sessTats(s).map(t => t.desc)
    }))
    .sort((x, y) => (x.data + x.hora).localeCompare(y.data + y.hora)).slice(0, 50);
  const hint = cut(JSON.parse(cli.data).nome, 120).split(' ')[0].slice(0, 40);
  return json({ studio: await studioOf(env, a.owner), hint, sessions });
}

// Link da agenda (com login): get devolve o link atual (ou cria), new troca o código, revoke desliga.
async function ownerAgenda(req, env, email) {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405);
  const { body, tooBig } = await readJson(req);
  if (tooBig) return json({ error: 'Requisição grande demais' }, 413);
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.client_id !== 'string' || !RE_ID.test(b.client_id)) return json({ error: 'Cliente inválido' }, 400);
  if (!(await recordOf(env, email, 'clients', b.client_id))) return json({ error: 'Cliente não encontrado. Aguarde salvar e tente de novo.' }, 404);
  if (b.action === 'revoke') {
    await env.DB.prepare('DELETE FROM agenda WHERE owner = ? AND client_id = ?').bind(email, b.client_id).run();
    return json({ ok: true });
  }
  if (b.action !== 'get' && b.action !== 'new') return json({ error: 'Ação inválida' }, 400);
  if (b.action === 'get') {
    const row = await env.DB.prepare('SELECT token, created_at FROM agenda WHERE owner = ? AND client_id = ?').bind(email, b.client_id).first();
    if (row) return json(row);
  }
  const row = { token: newToken(), created_at: nowIso() };
  await env.DB.prepare(`INSERT INTO agenda (owner, client_id, token, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner, client_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`)
    .bind(email, b.client_id, row.token, row.created_at).run();
  return json(row);
}

// Rotas do tatuador (com login): listar, criar link, novo link, cancelar, baixar documento.
async function ownerForms(req, env, url, email) {
  if (url.pathname === '/api/forms' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, client_id, session_id, status, created_at, expires_at, opened_at, signed_at, doc_hash, ots IS NOT NULL AS has_ots
       FROM forms WHERE owner = ? ORDER BY created_at DESC LIMIT 5000`
    ).bind(email).all();
    return json({ forms: results });
  }
  if (url.pathname === '/api/forms/doc' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const f = await env.DB.prepare(`SELECT id, doc, doc_hash, answers, ots, signed_at FROM forms WHERE id = ? AND owner = ? AND status = 'signed'`)
      .bind(id, email).first();
    if (!f) return json({ error: 'Ficha não encontrada' }, 404);
    return json({ id: f.id, doc: f.doc, doc_hash: f.doc_hash, answers: JSON.parse(f.answers), ots: f.ots, signed_at: f.signed_at });
  }
  if (url.pathname === '/api/forms' && req.method === 'POST') {
    const { body, tooBig } = await readJson(req);
    if (tooBig) return json({ error: 'Requisição grande demais' }, 413);
    const b = body && typeof body === 'object' ? body : {};
    const expires = new Date(Date.now() + FORM_TTL_DAYS * 864e5).toISOString();
    if (b.action === 'create') {
      // A ficha é de uma sessão (dia): o termo leva a data e as tatuagens daquela sessão.
      if (typeof b.session_id !== 'string' || !RE_ID.test(b.session_id)) return json({ error: 'Sessão inválida' }, 400);
      const ses = await recordOf(env, email, 'sessions', b.session_id);
      if (!ses) return json({ error: 'Sessão não encontrada. Aguarde salvar e tente de novo.' }, 404);
      const s = JSON.parse(ses.data), proc = procOf(s);
      if (!proc.tatuagens.length) return json({ error: 'Descreva as tatuagens da sessão antes de enviar a ficha.' }, 400);
      if (typeof s.cid !== 'string' || !RE_ID.test(s.cid)) return json({ error: 'A sessão não tem cliente.' }, 400);
      const cli = await recordOf(env, email, 'clients', s.cid);
      if (!cli) return json({ error: 'Cliente não encontrado. Aguarde salvar e tente de novo.' }, 404);
      const studio = await studioOf(env, email);
      const hint = String(JSON.parse(cli.data).nome || '').trim().split(/\s+/)[0].slice(0, 40);
      const token = newToken(), id = newId();
      await env.DB.prepare(
        `INSERT INTO forms (id, token_hash, owner, client_id, session_id, studio, client_hint, term, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, hex(await sha256(token)), email, s.cid, b.session_id, studio, hint, JSON.stringify(buildTerm(studio, proc)), nowIso(), expires).run();
      return json({ id, token, expires_at: expires });
    }
    if (b.action === 'relink' || b.action === 'cancel') {
      if (typeof b.id !== 'string' || !/^[0-9a-f]{16}$/.test(b.id)) return json({ error: 'Ficha inválida' }, 400);
      if (b.action === 'cancel') {
        const r = await env.DB.prepare(`UPDATE forms SET status = 'cancelled' WHERE id = ? AND owner = ? AND status = 'pending'`).bind(b.id, email).run();
        return r.meta && r.meta.changes ? json({ ok: true }) : json({ error: 'Só é possível cancelar fichas pendentes' }, 409);
      }
      // Novo link: atualiza também as tatuagens do termo, caso a sessão tenha mudado desde o envio.
      const f = await env.DB.prepare(`SELECT session_id, studio, term FROM forms WHERE id = ? AND owner = ? AND status = 'pending'`).bind(b.id, email).first();
      if (!f) return json({ error: 'Só é possível gerar link para fichas pendentes' }, 409);
      let term = f.term;
      if (f.session_id) {
        const ses = await recordOf(env, email, 'sessions', f.session_id);
        const proc = ses && procOf(JSON.parse(ses.data));
        if (proc && proc.tatuagens.length) term = JSON.stringify(buildTerm(f.studio, proc));
      }
      const token = newToken();
      const r = await env.DB.prepare(`UPDATE forms SET token_hash = ?, expires_at = ?, attempts = 0, term = ? WHERE id = ? AND owner = ? AND status = 'pending'`)
        .bind(hex(await sha256(token)), expires, term, b.id, email).run();
      return r.meta && r.meta.changes ? json({ id: b.id, token, expires_at: expires }) : json({ error: 'Só é possível gerar link para fichas pendentes' }, 409);
    }
    return json({ error: 'Ação inválida' }, 400);
  }
  return json({ error: 'Não encontrado' }, 404);
}

/* ---------------- Contas ---------------- */

// ADMIN_EMAILS: segredo do Worker (lista separada por vírgula). Administradores são aprovados automaticamente.
const isAdmin = (env, email) =>
  (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(email);

async function account(env, email) {
  const admin = isAdmin(env, email);
  let user = await env.DB.prepare('SELECT nome, estudio, telefone, status, created_at FROM users WHERE email = ?').bind(email).first();
  if (admin && (!user || user.status !== 'approved')) {
    await env.DB.prepare(`INSERT INTO users (email, status, decided_at, decided_by) VALUES (?, 'approved', CURRENT_TIMESTAMP, 'admin')
      ON CONFLICT (email) DO UPDATE SET status = 'approved'`).bind(email).run();
    user = await env.DB.prepare('SELECT nome, estudio, telefone, status, created_at FROM users WHERE email = ?').bind(email).first();
  }
  return { email, admin, status: user ? user.status : 'none', user: user || null };
}

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
  // Chave desconhecida: busca de novo (o Access troca as chaves de tempo em tempo), no máximo 1x por minuto
  if (!jwk && Date.now() - certCache.at > 60e3) jwk = (await accessKeys(team, true)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('chave desconhecida');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p));
  if (!ok) throw new Error('assinatura inválida');
  return dec(b64u(p));
}
