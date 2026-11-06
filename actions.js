// Atualiza as bases do Tiny sob demanda: dispara os workflows de sync do repositório tiny-erp (GitHub Actions),
// espera terminarem e devolve. É chamado pelo servidor antes de consultar as bases, no máximo uma vez por pergunta.
//
// Ligado quando existe GITHUB_TOKEN_ACTIONS (token Fine-grained SÓ do tiny-erp: Actions = Read and write,
// Contents = Read-only). Desligue com ATUALIZAR_AO_PERGUNTAR=0.
// Proteções: uma execução por vez (várias pessoas perguntando juntas dividem o mesmo disparo), intervalo mínimo
// entre disparos e teto por hora, para não torrar minutos do GitHub nem a cota de requisições do Tiny.
import { loadTable } from './lib.js';

const REPO = () => process.env.GITHUB_REPO || 'JhonatanAlmeida02/tiny-erp';
const API = () => (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
const TOKEN = () => process.env.GITHUB_TOKEN_ACTIONS || '';
const NOMES = () => String(process.env.ACTION_WORKFLOWS || 'Sync Produtos,Sync Estoque').split(',').map((s) => s.trim()).filter(Boolean);
const COOLDOWN = () => Number(process.env.ACTION_COOLDOWN_MIN || 5) * 60 * 1000;
const TIMEOUT = () => Number(process.env.ACTION_TIMEOUT_S || 180) * 1000;
const POLL = () => Number(process.env.ACTION_POLL_MS || 4000);
const TETO_HORA = () => Number(process.env.ACTION_MAX_POR_HORA || 20);
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const H = () => ({ 'User-Agent': 'tiny-chat', Accept: 'application/vnd.github+json', Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' });

export const ativo = () => !!TOKEN() && process.env.ATUALIZAR_AO_PERGUNTAR !== '0';

let emAndamento = null, ultimo = null; // ultimo = { quando, resultado }
const disparos = [];

async function gh(pathname, opts = {}) {
  const r = await fetch(`${API()}/repos/${REPO()}${pathname}`, { headers: H(), signal: AbortSignal.timeout(20000), ...opts });
  return r;
}

async function acharWorkflows() {
  const r = await gh('/actions/workflows?per_page=100');
  if (!r.ok) throw new Error(`não consegui listar os workflows (GitHub ${r.status})`);
  const todos = (await r.json()).workflows || [];
  const norm = (s) => String(s).toLowerCase();
  return NOMES().map((nome) => {
    const w = todos.find((x) => norm(x.name) === norm(nome)) || todos.find((x) => norm(x.name).includes(norm(nome)) || norm(x.path).includes(norm(nome)));
    if (!w) throw new Error(`workflow "${nome}" não encontrado no ${REPO()} (nomes existentes: ${todos.map((x) => x.name).join(', ') || 'nenhum'})`);
    return w;
  });
}

async function rodar(w) {
  const t0 = Date.now() - 15000; // tolera diferença de relógio entre este servidor e o GitHub
  let d = await gh(`/actions/workflows/${w.id}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  if (d.status >= 500) { await dorme(2500); d = await gh(`/actions/workflows/${w.id}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) }); } // erro do GitHub: tenta mais uma vez
  if (d.status === 422) throw new Error(`o workflow "${w.name}" não aceita disparo manual (falta "workflow_dispatch" no .yml)`);
  if (d.status === 403 || d.status === 404) throw new Error(`sem permissão para disparar "${w.name}" (GitHub ${d.status}): confira as permissões do GITHUB_TOKEN_ACTIONS`);
  if (!d.ok) throw new Error(`falha ao disparar "${w.name}" (GitHub ${d.status})`);
  const fim = Date.now() + TIMEOUT();
  let runId = null;
  while (Date.now() < fim) {
    await dorme(POLL());
    const r = await gh(`/actions/workflows/${w.id}/runs?event=workflow_dispatch&per_page=5`);
    if (!r.ok) continue;
    const runs = ((await r.json()).workflow_runs || []).filter((x) => new Date(x.created_at).getTime() >= t0);
    const run = (runId && runs.find((x) => x.id === runId)) || runs[0];
    if (!run) continue;
    runId = run.id;
    if (run.status === 'completed') {
      if (run.conclusion === 'success') return { nome: w.name, segundos: Math.round((Date.now() - t0 - 15000) / 1000) };
      throw new Error(`o workflow "${w.name}" terminou com falha (${run.conclusion})`);
    }
  }
  throw new Error(`o workflow "${w.name}" não terminou em ${Math.round(TIMEOUT() / 1000)}s`);
}

async function executar() {
  const agora = Date.now();
  while (disparos.length && agora - disparos[0] > 3600000) disparos.shift();
  if (disparos.length >= TETO_HORA()) return { ok: false, usouCache: true, mensagem: `Limite de ${TETO_HORA()} atualizações por hora atingido; usei a base que já estava carregada.` };
  disparos.push(agora);
  try {
    const ws = await acharWorkflows();
    const feitos = await Promise.all(ws.map(rodar));
    await Promise.all(['produtos', 'estoque'].map((t) => loadTable(t, 'fresco')));
    return { ok: true, mensagem: `Bases atualizadas agora pelo Action (${feitos.map((f) => `${f.nome}: ${f.segundos}s`).join(', ')}).` };
  } catch (e) {
    // não deixa a pergunta sem resposta: segue com a base que já estava carregada e avisa
    await Promise.all(['produtos', 'estoque'].map((t) => loadTable(t, 'fresco').catch(() => {})));
    return { ok: false, usouCache: true, mensagem: `Não consegui atualizar as bases agora: ${e.message}. Usei a última versão disponível.` };
  }
}

// Atualiza as bases (ou reaproveita uma atualização recente / em andamento).
export async function atualizarBases() {
  if (!ativo()) return null;
  if (emAndamento) return emAndamento; // alguém já está atualizando: todo mundo espera o mesmo resultado
  if (ultimo && !ultimo.resultado.ok && Date.now() - ultimo.quando < 60000) return { ...ultimo.resultado, reaproveitada: true };
  if (ultimo && ultimo.resultado.ok && Date.now() - ultimo.quando < COOLDOWN()) {
    const min = Math.max(1, Math.round((Date.now() - ultimo.quando) / 60000));
    return { ok: ultimo.resultado.ok, mensagem: `Bases atualizadas pelo Action há ${min} min (intervalo mínimo entre atualizações: ${COOLDOWN() / 60000} min).`, reaproveitada: true };
  }
  emAndamento = executar().then((r) => { ultimo = { quando: Date.now(), resultado: r }; return r; }).finally(() => { emAndamento = null; });
  return emAndamento;
}

// ---------- PRODIGINHO: Sync Produtos somente se o último sucesso tiver mais de N minutos ----------
// Consulta o histórico real do GitHub Actions, não a idade do cache local.
// Faz no máximo uma checagem remota por intervalo e compartilha verificações em andamento.
let checagemProdutos = null;
let ultimoCheckProdutos = null;
let ultimaTentativaProdutos = 0;
const LIMITE_PRODUTOS_MS = () => Math.max(1, Number(process.env.PRODIGINHO_PRODUTOS_MIN || 30)) * 60000;
const CHECK_PRODUTOS_MS = () => Math.max(1000, Number(process.env.PRODIGINHO_CHECK_MS || 30000));
const RETRY_PRODUTOS_MS = () => Math.max(60000, Number(process.env.PRODIGINHO_RETRY_MS || 120000));

async function verificarProdutosAgora() {
  if (!TOKEN()) return { ok: false, usouCache: true, mensagem: 'Não há GITHUB_TOKEN_ACTIONS: não foi possível verificar a última sincronização dos produtos.' };
  const nomes = String(process.env.PRODIGINHO_WORKFLOW_PRODUTOS || 'Sync Produtos').trim();
  const r = await gh('/actions/workflows?per_page=100');
  if (!r.ok) throw new Error(`não foi possível listar os workflows (GitHub ${r.status})`);
  const workflows = (await r.json()).workflows || [];
  const normalizar = (s) => String(s).toLowerCase().trim();
  const w = workflows.find((v) => normalizar(v.name) === normalizar(nomes))
    || workflows.find((v) => normalizar(v.name).includes(normalizar(nomes)));
  if (!w) throw new Error(`workflow de produtos "${nomes}" não encontrado`);

  // O filtro success inclui execuções agendadas e manuais.
  const [sr, lr] = await Promise.all([
    gh(`/actions/workflows/${w.id}/runs?status=success&per_page=1`),
    gh(`/actions/workflows/${w.id}/runs?per_page=5`),
  ]);
  if (!sr.ok || !lr.ok) throw new Error(`não foi possível consultar o histórico do Action (GitHub ${!sr.ok ? sr.status : lr.status})`);
  const sucesso = (await sr.json()).workflow_runs?.[0];
  const recentes = (await lr.json()).workflow_runs || [];
  const terminado = sucesso ? Date.parse(sucesso.updated_at || sucesso.run_started_at || sucesso.created_at) : NaN;
  const idade = Number.isFinite(terminado) ? Date.now() - terminado : Infinity;
  const mins = Number.isFinite(idade) ? Math.max(0, Math.floor(idade / 60000)) : null;
  if (idade <= LIMITE_PRODUTOS_MS()) {
    return { ok: true, atualizou: false, ultimaSincronizacao: sucesso.updated_at, idadeMinutos: mins, mensagem: null };
  }

  // Um Action agendado ou disparado por outra pessoa já está processando: não cria um concorrente.
  if (recentes.some((v) => ['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(v.status))) {
    return { ok: true, atualizou: false, usouCache: true, ultimaSincronizacao: sucesso?.updated_at || null, mensagem: 'Sync Produtos já está em execução no GitHub. Consulta realizada com a última base disponível.' };
  }
  if (Date.now() - ultimaTentativaProdutos < RETRY_PRODUTOS_MS()) {
    return { ok: false, atualizou: false, usouCache: true, ultimaSincronizacao: sucesso?.updated_at || null, mensagem: 'Sync Produtos ainda está dentro do intervalo de proteção após uma tentativa recente. Usei a última base disponível.' };
  }
  ultimaTentativaProdutos = Date.now();
  const resultado = await rodar(w);
  // Lê o CSV pela API após conclusão, para evitar o atraso da CDN raw do GitHub.
  const base = await loadTable('produtos', 'fresco');
  if (!base.rows?.length || base.aviso) {
    return { ok: false, atualizou: true, usouCache: true, mensagem: `O Action ${resultado.nome} terminou, mas a nova base não pôde ser confirmada. ${base.aviso || ''}`.trim() };
  }
  return { ok: true, atualizou: true, mensagem: `Produtos sincronizados pelo GitHub Actions (${resultado.nome}) e base recarregada.` };
}

export async function verificarSyncProdutos() {
  if (process.env.PRODIGINHO_SYNC_PRODUTOS === '0') return null;
  if (checagemProdutos) return checagemProdutos;
  if (ultimoCheckProdutos && Date.now() - ultimoCheckProdutos.quando < CHECK_PRODUTOS_MS()) return ultimoCheckProdutos.resultado;
  checagemProdutos = verificarProdutosAgora().catch((e) => ({ ok: false, usouCache: true, mensagem: `Não consegui conferir/sincronizar os produtos: ${e.message}. Usei a última base disponível.` }))
    .then((resultado) => { ultimoCheckProdutos = { quando: Date.now(), resultado }; return resultado; })
    .finally(() => { checagemProdutos = null; });
  return checagemProdutos;
}
