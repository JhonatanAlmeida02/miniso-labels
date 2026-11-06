import './env.js';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atualizarBases, verificarSyncProdutos } from './actions.js';
import * as memoria from './aprendizado.js';
import { turno, escalar, listarIAs, iaPadrao, iaValida } from './ai.js';
import { DATA, readJSON, writeJSON, TOOLS, runTool, uploadMeta, sheetRows, loadBase, loadTable } from './lib.js';

const PORT = process.env.PORT || 3000;
const SYSTEM_MD = fs.readFileSync(path.resolve('prompts/system.md'), 'utf8');

const CHATS_DIR = path.join(DATA, 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });


// ---------- identificação simples (sem senha): só o nome, guardado em cookie ----------
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => { try { return [k, decodeURIComponent(v.join('='))]; } catch { return [k, '']; } }));
}
function auth(req, res, next) {
  const nome = String(parseCookies(req).u || '').trim().slice(0, 60);
  if (!nome) return res.status(401).json({ erro: 'Informe seu nome' });
  const chave = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  req.user = { nome, id: crypto.createHash('sha256').update(chave).digest('hex').slice(0, 16) };
  next();
}

const app = express();
app.set('trust proxy', 1); // atrás do proxy da hospedagem (HTTPS)
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ---------- código de acesso opcional (recomendado ao hospedar na internet) ----------
// Se CODIGO_ACESSO estiver definido, só entra quem digitar o código. Vazio = sem código.
const CODIGO = process.env.CODIGO_ACESSO || '';
const seloAcesso = () => crypto.createHmac('sha256', CODIGO).update('tiny-chat-acesso').digest('hex');
const iguais = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const tentativas = new Map();
function muitasTentativas(ip) {
  const agora = Date.now(), lista = (tentativas.get(ip) || []).filter((t) => agora - t < 15 * 60e3);
  lista.push(agora); tentativas.set(ip, lista);
  return lista.length > 10;
}

app.get('/healthz', (_req, res) => res.send('ok'));

app.post('/api/entrar', (req, res) => {
  if (!CODIGO) return res.json({ ok: true });
  if (muitasTentativas(req.ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  if (!iguais(req.body?.codigo ?? '', CODIGO)) return res.status(401).json({ erro: 'Código incorreto.' });
  res.setHeader('Set-Cookie', `acesso=${seloAcesso()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!CODIGO || req.path === '/entrar') return next();
  if (iguais(parseCookies(req).acesso || '', seloAcesso())) return next();
  res.status(401).json({ erro: 'Informe o código de acesso.', precisa_codigo: true });
});

app.get('/api/me', auth, (req, res) => res.json({ nome: req.user.nome, ias: listarIAs(), padrao: iaPadrao() }));

// ---------- chats ----------
const chatFile = (uid, id) => path.join(CHATS_DIR, uid, id + '.json');
const validId = (id) => /^[a-f0-9]{16}$/.test(id);
function loadChat(uid, id) { return validId(id) ? readJSON(chatFile(uid, id), null) : null; }
function saveChat(uid, chat) {
  fs.mkdirSync(path.join(CHATS_DIR, uid), { recursive: true });
  chat.atualizado = new Date().toISOString();
  writeJSON(chatFile(uid, chat.id), chat);
}

app.get('/api/chats', auth, (req, res) => {
  const dir = path.join(CHATS_DIR, req.user.id);
  const list = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJSON(path.join(dir, f), null)).filter(Boolean)
        .map((c) => ({ id: c.id, titulo: c.titulo, atualizado: c.atualizado }))
    : [];
  list.sort((a, b) => b.atualizado.localeCompare(a.atualizado));
  res.json(list);
});

app.post('/api/chats', auth, (req, res) => {
  const chat = { id: crypto.randomBytes(8).toString('hex'), titulo: 'Nova conversa', messages: [] };
  saveChat(req.user.id, chat);
  res.json({ id: chat.id, titulo: chat.titulo });
});

app.delete('/api/chats/:id', auth, (req, res) => {
  if (validId(req.params.id)) fs.rmSync(chatFile(req.user.id, req.params.id), { force: true });
  res.json({ ok: true });
});

// Converte o histórico da API em bolhas para a interface
function toUI(messages) {
  const out = [];
  let cur = null;
  const results = {};
  for (const m of messages) if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') results[b.tool_use_id] = b.content;
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      if (blocks.some((b) => b.type === 'tool_result')) continue;
      cur = null;
      out.push({ role: 'user', text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), files: blocks.filter((b) => b.type === 'file_ref').map((b) => ({ id: b.id, name: b.name })) });
    } else {
      if (!cur) { cur = { role: 'assistant', segs: [] }; out.push(cur); }
      for (const b of m.content) {
        if (b.type === 'text' && b.text) cur.segs.push({ t: 'text', text: b.text });
        if (b.type === 'tool_use') {
          cur.segs.push({ t: 'tool', name: b.name });
          {
            try { const r = JSON.parse(results[b.id]); if (r.url && r.nome) cur.segs.push({ t: 'file', nome: r.nome, url: r.url, linhas: r.linhas }); } catch {}
          }
        }
      }
    }
  }
  return out;
}

app.get('/api/chats/:id', auth, (req, res) => {
  const c = loadChat(req.user.id, req.params.id);
  if (!c) return res.status(404).json({ erro: 'Conversa não encontrada' });
  res.json({ id: c.id, titulo: c.titulo, mensagens: toUI(c.messages), processando: ativos.has(chaveAtivo(req.user.id, c.id)) });
});

// ---------- anexos ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 6 } });

function saveUpload(userId, f) {
  const id = crypto.randomBytes(12).toString('hex');
  const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
  fs.writeFileSync(path.join(DATA, 'uploads', id), f.buffer);
  writeJSON(path.join(DATA, 'uploads', id + '.json'), { owner: userId, name, mime: f.mimetype });
  return { id, name, mime: f.mimetype };
}

function expandFile(b) {
  const m = uploadMeta(b.id);
  if (!m) return [{ type: 'text', text: `[Anexo "${b.name}" não está mais disponível]` }];
  const buf = fs.readFileSync(path.join(DATA, 'uploads', b.id));
  const head = { type: 'text', text: `[Anexo: "${m.name}" | arquivo_id=${b.id}]` };
  if (/^image\/(png|jpe?g|gif|webp)$/.test(m.mime)) return [head, { type: 'image', source: { type: 'base64', media_type: m.mime === 'image/jpg' ? 'image/jpeg' : m.mime, data: buf.toString('base64') } }];
  if (m.mime === 'application/pdf' || /\.pdf$/i.test(m.name)) return [head, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }];
  if (/\.(xlsx?|csv|tsv)$/i.test(m.name)) {
    try {
      const { abas, aba, rows } = sheetRows(buf);
      const prev = rows.slice(0, 60).map((r) => r.join('\t')).join('\n');
      return [{ type: 'text', text: `${head.text}\nAbas: ${abas.join(', ')} | aba lida: ${aba} | ${rows.length} linhas. Prévia (60 primeiras; use ler_anexo para o restante):\n${prev}` }];
    } catch (e) { return [{ type: 'text', text: `${head.text}\n(não consegui ler: ${e.message})` }]; }
  }
  return [{ type: 'text', text: `${head.text}\n${buf.toString('utf8').slice(0, 20000)}` }];
}

const expand = (messages) =>
  messages.map((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? { role: 'user', content: m.content.flatMap((b) => (b.type === 'file_ref' ? expandFile(b) : [b])) }
      : m
  );

// conversas em processamento (continuam mesmo que a pessoa saia da tela)
const ativos = new Map();
const chaveAtivo = (uid, cid) => `${uid}:${cid}`;

app.post('/api/chats/:id/parar', auth, (req, res) => {
  const ac = ativos.get(chaveAtivo(req.user.id, req.params.id));
  if (ac) ac.abort();
  res.json({ ok: !!ac });
});

// ---------- envio de mensagem (SSE) ----------
app.post('/api/chats/:id/messages', auth, upload.array('files', 6), async (req, res) => {
  const chat = loadChat(req.user.id, req.params.id);
  if (!chat) return res.status(404).json({ erro: 'Conversa não encontrada' });
  const text = String(req.body.text || '').trim();
  if (ativos.has(chaveAtivo(req.user.id, chat.id))) return res.status(409).json({ erro: 'Esta conversa ainda está processando o pedido anterior. Aguarde terminar ou clique em Parar.' });
  if (!text && !(req.files || []).length) return res.status(400).json({ erro: 'Mensagem vazia' });
  const files = (req.files || []).map((f) => saveUpload(req.user.id, f));
  const ia = iaValida(req.body.ia);
  if (!ia) return res.status(500).json({ erro: 'Nenhuma IA configurada no servidor (defina ANTHROPIC_API_KEY ou GEMINI_API_KEY).' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let desconectado = false;
  const send = (ev, data) => { if (desconectado || res.writableEnded) return; try { res.write(`data: ${JSON.stringify({ ev, data })}\n\n`); } catch {} };
  // sinal de vida: evita que o proxy da hospedagem derrube a conexão enquanto a IA "pensa"
  const batida = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 10000);
  res.on('close', () => { desconectado = true; clearInterval(batida); });

  const content = [...files.map((f) => ({ type: 'file_ref', id: f.id, name: f.name })), ...(text ? [{ type: 'text', text }] : [])];
  const base = [...chat.messages, { role: 'user', content }];
  const added = [{ role: 'user', content }];
  if (chat.titulo === 'Nova conversa') chat.titulo = (text || files[0]?.name || 'Conversa').slice(0, 60);

  // Sair da tela NÃO interrompe o processamento: ele termina e fica salvo na conversa. Só o botão Parar cancela.
  const ac = new AbortController();
  const aborted = () => ac.signal.aborted;
  ativos.set(chaveAtivo(req.user.id, chat.id), ac);

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' });
  const system = { fixo: SYSTEM_MD, variavel: `Data/hora atual: ${agora} (America/Sao_Paulo).` };

  let avisoBase = null, iaAtual = ia;
  const T0 = Date.now(), tempos = [];
  const marca = (rotulo, ini) => tempos.push(`${rotulo} ${((Date.now() - ini) / 1000).toFixed(1)}s`);
  let terminouComResposta = false;
  try {
    for (let i = 0; i < 15 && !aborted(); i++) {
      const tm = Date.now();
      const argsTurno = { system, messages: expand([...base, ...added.slice(1)]), tools: TOOLS, signal: ac.signal, usuario: req.user.nome, onText: (t) => send('text', t) };
      let r = await turno(iaAtual, argsTurno);
      // O Prodiginho continua responsável por responder. IA externa apenas interpreta
      // pedidos desconhecidos dentro de turnoProdiginho; nunca troca de provedor aqui.
      marca(`${iaAtual}#${i + 1}`, tm);
      const blocks = r.blocks;
      if (!r.usaFerramenta) { added.push({ role: 'assistant', content: blocks }); terminouComResposta = true; break; }
      const results = [];
      // Prodiginho: só dispara Sync Produtos quando o último sucesso tem mais de 30 min.
      // Estoque tem seu próprio agendamento de 15 min; nunca é disparado por esta checagem.
      if (!avisoBase && blocks.some((x) => x.type === 'tool_use' && FERRAMENTAS_BASE.has(x.name))) {
        const ta = Date.now();
        if (iaAtual === 'prodiginho') {
          avisoBase = await verificarSyncProdutos();
          marca('verificar sync produtos', ta);
        } else {
          send('tool', { name: 'atualizar_bases' });
          avisoBase = await atualizarBases().catch((e) => ({ ok: false, mensagem: `Não consegui atualizar as bases: ${e.message}` })) || { mensagem: null };
          marca('atualizar bases', ta);
        }
        // Não anunciar uma consulta de histórico normal como uma atualização.
        if (avisoBase?.atualizou) send('tool', { name: 'sync_produtos' });
      }
      for (const b of blocks.filter((x) => x.type === 'tool_use')) {
        send('tool', { name: b.name });
        let out, err = false; const tt = Date.now();
        try { out = await runTool(b.name, b.input, { userId: req.user.id }); } catch (e) { out = { erro: e.message }; err = true; }
        marca(b.name, tt);
        if (out && typeof out === 'object' && avisoBase?.mensagem && FERRAMENTAS_BASE.has(b.name)) out.aviso_atualizacao = avisoBase.mensagem;
        if (out && out.url && out.nome) send('file', { nome: out.nome, url: out.url, linhas: out.linhas });
        // aprendizado automático: IA completa resolveu com UMA consulta à base sem erro -> o Prodiginho reaproveita depois
        if (iaAtual !== 'prodiginho' && !err && !out?.erro && i === 0 && blocks.filter((x) => x.type === 'tool_use').length === 1 && APRENDE.has(b.name) && text && !files.length && !JSON.stringify(b.input).includes('arquivo_id')) {
          memoria.aprenderAuto(text, { name: b.name, input: b.input }, req.user.nome).catch(() => {});
        }
        // o Prodiginho aprendeu a frase com a IA interpretadora: só guarda se a consulta deu certo
        if (r.aprender && !err && !out?.erro && !(out?.linhas === 0) && !(out?.total_encontrado === 0)) for (const ap of [].concat(r.aprender)) memoria.aprenderAuto(ap.frase, ap.chamada, req.user.nome).catch(() => {});
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 30000), ...(err ? { is_error: true } : {}) });
      }
      added.push({ role: 'assistant', content: blocks }, { role: 'user', content: results });
    }
    if (!terminouComResposta && !aborted()) {
      const mensagem = 'A consulta atingiu o limite de etapas antes de produzir uma resposta final. Tente dividir o pedido em partes menores.';
      send('text', `\n\n⚠️ ${mensagem}`);
      added.push({ role: 'assistant', content: [{ type: 'text', text: mensagem }] });
    }
    console.log(`[tempo] ${req.user.nome} ${((Date.now() - T0) / 1000).toFixed(1)}s total | ${tempos.join(' | ')}`);
    send('done', { segundos: Math.round((Date.now() - T0) / 100) / 10 });
  } catch (e) {
    if (!aborted()) {
      const mensagem = e.message || 'Falha ao consultar o modelo';
      send('error', { mensagem });
      added.push({ role: 'assistant', content: [{ type: 'text', text: `⚠️ Não consegui concluir o pedido: ${mensagem}` }] });
    }
  } finally {
    // só persiste histórico consistente (termina em resposta do assistente)
    const tail = added.slice(1);
    while (tail.length && !(tail[tail.length - 1].role === 'assistant' && !tail[tail.length - 1].content.some((b) => b.type === 'tool_use'))) tail.pop();
    chat.messages.push(added[0], ...tail);
    saveChat(req.user.id, chat);
    ativos.delete(chaveAtivo(req.user.id, chat.id));
    try { res.end(); } catch {}
  }
});

const FERRAMENTAS_BASE = new Set(['info_base', 'buscar_produtos', 'consultar_tabela', 'exportar_consulta', 'conferir_skus', 'cadastros_incompletos', 'resumo_base', 'consulta_estoque']);

const APRENDE = new Set(['buscar_produtos', 'exportar_consulta', 'consultar_tabela', 'conferir_skus', 'cadastros_incompletos', 'resumo_base', 'consulta_estoque']);

app.get('/api/outputs/:file', auth, (req, res) => {
  const f = path.basename(req.params.file);
  const p = path.join(DATA, 'outputs', req.user.id, f);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.download(p, f.replace(/^[a-f0-9]{8}-/, ''));
});

app.get('/api/base', auth, async (req, res) => {
  const b = await loadBase();
  res.json({ origem: b.origem, aviso: b.aviso, linhas: b.rows.length, atualizacao: b.commit });
});

const iasOn = listarIAs();
// mantém as bases quentes: a 1ª pergunta do dia não espera o download do GitHub
const aquecer = () => ['produtos', 'estoque'].forEach((t) => loadTable(t, true).catch(() => {}));
setTimeout(aquecer, 1000); setInterval(aquecer, 9 * 60 * 1000).unref();
app.listen(PORT, () => console.log(`Tiny Chat em http://localhost:${PORT}  (IAs: ${iasOn.length ? iasOn.map((x) => `${x.nome} ${x.modelo}`).join(', ') + '; padrão: ' + iaPadrao() : 'NENHUMA — defina ANTHROPIC_API_KEY ou GEMINI_API_KEY'}${CODIGO ? ', com código de acesso' : ', SEM código de acesso'})`));
