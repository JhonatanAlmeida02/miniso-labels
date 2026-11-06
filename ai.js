// Camada de IA: o resto do app fala com "turno(ia, ...)" e não sabe qual provedor está por trás.
// O histórico das conversas fica sempre no formato do Claude (text / tool_use / tool_result);
// aqui ele é traduzido para o Gemini quando preciso. Campos extras que só o Gemini usa
// (gsig = thought signature, gid = id da chamada) são removidos antes de enviar ao Claude.
import { turnoProdiginho } from './prodiginho.js';
import { turnoGroq, promptCurto, MODELO_GROQ } from './groq.js';
import { TOOLS } from './lib.js';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';

const MODELO_CLAUDE = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
// Modelos 2.5 tinham desligamento previsto para 16/10/2026; por isso o padrão é da série 3.
// Troque com GEMINI_MODEL se o Google mudar os nomes (veja os modelos em aistudio.google.com).
// Cadeia de modelos: quando um estoura o limite (por minuto ou por dia), o app passa sozinho para o próximo.
// GEMINI_MODELS = lista separada por vírgula, na ordem de preferência; GEMINI_MODEL (se existir) vai na frente.
// Um nome que não existe (404) é pulado. Modelos "Lite" têm limite diário bem maior no plano gratuito.
const CADEIA_PADRAO = 'gemini-3-flash-preview,gemini-3.8-flash,gemini-3.6-flash,gemini-3.1-flash-lite,gemini-3.5-flash-lite';
const MODELOS_GEMINI = [...new Set([process.env.GEMINI_MODEL, ...(process.env.GEMINI_MODELS || CADEIA_PADRAO).split(',')].map((s) => (s || '').trim()).filter(Boolean))];
const MODELO_GEMINI = MODELOS_GEMINI[0];
const bloqueados = new Map(); // modelo -> até quando (ms) não adianta tentar
let ultimoModeloGemini = null;
const msAteMeiaNoitePacifico = () => { // a cota diária do Google zera à meia-noite do Pacífico
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date());
  const g = (t) => Number(p.find((x) => x.type === t).value) % 24;
  return Math.max(60000, (24 * 3600 - (g('hour') * 3600 + g('minute') * 60 + g('second'))) * 1000 + 30000);
};
const CHAVE_GEMINI = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const BASE_GEMINI = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const dormir = (ms, signal) => new Promise((ok, no) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); no(new Error('abortado')); }, { once: true });
});

// ---------- quais IAs estão configuradas ----------
export function listarIAs() {
  const l = [];
  if (claude) l.push({ id: 'claude', nome: 'Claude', modelo: MODELO_CLAUDE, descricao: 'IA completa e paga (créditos da Anthropic). Lê NF e PDF, cadastra produtos e segue todas as regras.' });
  if (CHAVE_GEMINI) l.push({ id: 'gemini', nome: 'Gemini', modelo: MODELO_GEMINI, descricao: 'IA completa do Google. Plano gratuito com limite de uso; o Google pode usar o conteúdo enviado.' });
  if (process.env.GROQ_API_KEY) l.push({ id: 'groq', nome: 'Groq', modelo: MODELO_GROQ, descricao: 'IA rápida com plano gratuito de limite baixo (cerca de 8 mil tokens por minuto): serve para consultas curtas. Não lê NF em PDF/imagem.' });
  l.push({ id: 'prodiginho', nome: 'Prodiginho (gratuito)', modelo: 'regras internas', descricao: 'Assistente criado pela Prodigy, sem IA externa e sem custo. Consulta as bases (SKUs, estoque, localização, cadastros incompletos), mas não lê NF nem cadastra.' });
  return l;
}
export function iaPadrao() {
  const l = listarIAs();
  const p = String(process.env.IA_PADRAO || '').toLowerCase();
  return (l.find((x) => x.id === p) || l[0])?.id || null;
}
export function iaValida(id) {
  const l = listarIAs();
  return l.find((x) => x.id === String(id || '').toLowerCase())?.id || iaPadrao();
}

// ---------- CLAUDE ----------
function limparParaClaude(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const content = m.content
        .filter((b) => (b.type === 'text' && b.text) || b.type === 'tool_use')
        .map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} }));
      return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(sem resposta)' }] };
    }
    return m;
  });
}

async function turnoClaude({ system, messages, tools, signal, onText }) {
  const stream = claude.messages.stream({
    model: MODELO_CLAUDE,
    max_tokens: 16000,
    system: [
      { type: 'text', text: system.fixo, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: system.variavel },
    ],
    tools,
    messages: limparParaClaude(messages),
  }, { signal });
  stream.on('text', onText);
  const msg = await stream.finalMessage();
  const blocks = msg.content
    .filter((b) => b.type === 'text' || b.type === 'tool_use')
    .map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input }));
  return { blocks, usaFerramenta: msg.stop_reason === 'tool_use' };
}

// ---------- GEMINI ----------
// Esquema das ferramentas: o Gemini aceita só um subconjunto do JSON Schema.
function esquemaGemini(s) {
  if (!s || typeof s !== 'object') return { type: 'STRING' };
  let tipo = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  tipo = String(tipo || (s.properties ? 'object' : 'string')).toUpperCase();
  const out = { type: tipo };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (tipo === 'ARRAY') out.items = esquemaGemini(s.items || { type: 'string' });
  if (tipo === 'OBJECT' && s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, esquemaGemini(v)]));
    const req = (s.required || []).filter((k) => k in out.properties);
    if (req.length) out.required = req;
  }
  return out;
}
const declaracao = (t) => {
  const d = { name: t.name, description: t.description };
  const p = esquemaGemini(t.input_schema);
  if (p.properties && Object.keys(p.properties).length) d.parameters = p;
  return d;
};

const comoObjeto = (conteudo) => {
  let v = conteudo;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = { result: v }; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v };
};

export function paraGemini(messages) {
  const chamadas = {}; // tool_use id -> { name, gid }
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'text') {
          if (!b.text && !b.gsig) continue;
          parts.push({ text: b.text || '', ...(b.gsig ? { thoughtSignature: b.gsig } : {}) });
        } else if (b.type === 'tool_use') {
          chamadas[b.id] = { name: b.name, gid: !!b.gid };
          parts.push({
            functionCall: { name: b.name, args: b.input || {}, ...(b.gid ? { id: b.id } : {}) },
            ...(b.gsig ? { thoughtSignature: b.gsig } : {}),
          });
        }
      }
      if (parts.length) out.push({ role: 'model', parts });
    } else {
      const blocos = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      const parts = [];
      for (const b of blocos) {
        if (b.type === 'text') { if (b.text) parts.push({ text: b.text }); }
        else if (b.type === 'image' || b.type === 'document') parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
        else if (b.type === 'tool_result') {
          const c = chamadas[b.tool_use_id] || { name: 'ferramenta', gid: false };
          parts.push({ functionResponse: { name: c.name, response: comoObjeto(b.content), ...(c.gid ? { id: b.tool_use_id } : {}) } });
        }
      }
      if (parts.length) out.push({ role: 'user', parts });
    }
  }
  return out;
}

function erroGemini(status, corpo, modelo = MODELO_GEMINI) {
  let msg = corpo;
  try { msg = JSON.parse(corpo).error?.message || corpo; } catch {}
  msg = String(msg).replace(/\s+/g, ' ').slice(0, 300);
  if (status === 429) return `Limite do plano gratuito do Gemini atingido (muitas requisições por minuto ou por dia). Aguarde um pouco ou troque a IA no seletor. (${msg})`;
  if (status === 400 && /api key/i.test(msg)) return `A chave do Gemini (GEMINI_API_KEY) é inválida. (${msg})`;
  if (status === 401 || status === 403) return `O Gemini recusou o acesso. Confira a chave GEMINI_API_KEY e se o serviço está disponível na sua região. (${msg})`;
  if (status === 404) return `Modelo "${modelo}" não encontrado. Defina GEMINI_MODEL com outro modelo disponível no Google AI Studio (ex.: gemini-3.1-flash-lite). (${msg})`;
  return `Gemini respondeu com erro ${status}: ${msg}`;
}

async function turnoGemini({ system, messages, tools, signal, onText }) {
  const corpo = {
    systemInstruction: { parts: [{ text: `${system.fixo}\n\n${system.variavel}` }] },
    contents: paraGemini(messages),
    tools: [{ functionDeclarations: tools.map(declaracao) }],
    generationConfig: { maxOutputTokens: 16000 },
  };
  const esperas = [4000, 12000];
  let resp, usado = null;
  const motivos = [];
  const agora = () => Date.now();
  const candidatos = () => MODELOS_GEMINI.filter((m) => (bloqueados.get(m) || 0) <= agora());
  let fila = candidatos();
  if (!fila.length) { // todos bloqueados: tenta o que libera primeiro (a tela mostra o erro real se ainda estiver cheio)
    fila = [[...MODELOS_GEMINI].sort((x, y) => (bloqueados.get(x) || 0) - (bloqueados.get(y) || 0))[0]];
  }
  for (const modelo of fila) {
    // assinatura de raciocínio é específica do modelo que a gerou: ao trocar de modelo, usa a assinatura "neutra" do Google
    const trocou = ultimoModeloGemini && ultimoModeloGemini !== modelo;
    const conteudo = trocou ? JSON.parse(JSON.stringify(corpo.contents), (k, v) => (k === 'thoughtSignature' ? 'skip_thought_signature_validator' : v)) : corpo.contents;
    const url = `${BASE_GEMINI}/models/${encodeURIComponent(modelo)}:streamGenerateContent?alt=sse`;
    let ok = false;
    for (let tentativa = 0; ; tentativa++) {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': CHAVE_GEMINI },
        body: JSON.stringify({ ...corpo, contents: conteudo }),
        signal,
      });
      if (resp.ok) { ok = true; break; }
      const txt = await resp.text();
      if (resp.status === 429) {
        const diario = /per.?day|daily|PerDay/i.test(txt);
        bloqueados.set(modelo, agora() + (diario ? msAteMeiaNoitePacifico() : 65000));
        motivos.push(`${modelo}: limite ${diario ? 'do dia' : 'por minuto'}`);
        console.log(`[gemini] ${modelo} sem cota (${diario ? 'diária' : 'por minuto'}); tentando o próximo modelo`);
        break;
      }
      if (resp.status === 404) { bloqueados.set(modelo, agora() + 3600000); motivos.push(`${modelo}: não existe`); console.log(`[gemini] modelo ${modelo} não encontrado; pulando`); break; }
      // servidor ocupado: tenta de novo no mesmo modelo; se insistir, vai para o próximo
      if ([500, 503].includes(resp.status)) {
        if (tentativa < esperas.length) { await dormir(esperas[tentativa], signal); continue; }
        motivos.push(`${modelo}: servidor ocupado`); break;
      }
      throw new Error(erroGemini(resp.status, txt, modelo));
    }
    if (ok) { usado = modelo; break; }
  }
  if (!usado) throw new Error(`Todos os modelos do Gemini estão sem cota agora (${motivos.join('; ') || 'sem detalhes'}). A cota diária zera por volta das 5h (horário de Brasília). Troque a IA no seletor (Prodiginho, Groq ou Claude) ou aguarde.`);
  if (usado !== ultimoModeloGemini) console.log(`[gemini] usando o modelo ${usado}`);
  ultimoModeloGemini = usado;

  const blocks = [];
  let motivo = '', bloqueio = '';
  const leitor = resp.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const tratar = (j) => {
    if (j.promptFeedback?.blockReason) bloqueio = j.promptFeedback.blockReason;
    const cand = j.candidates?.[0];
    if (!cand) return;
    if (cand.finishReason) motivo = cand.finishReason;
    for (const p of cand.content?.parts || []) {
      if (p.thought === true) continue; // resumo de raciocínio: não mostrar
      if (p.functionCall) {
        const gid = !!p.functionCall.id;
        blocks.push({
          type: 'tool_use', id: p.functionCall.id || 'g_' + crypto.randomBytes(6).toString('hex'),
          name: p.functionCall.name, input: p.functionCall.args || {},
          ...(gid ? { gid: true } : {}), ...(p.thoughtSignature ? { gsig: p.thoughtSignature } : {}),
        });
      } else if (typeof p.text === 'string') {
        if (p.text) onText(p.text);
        const ult = blocks[blocks.length - 1];
        // junta pedaços de texto seguidos, mas nunca mistura partes que carregam assinatura
        if (ult && ult.type === 'text' && !ult.gsig && !p.thoughtSignature) ult.text += p.text;
        else blocks.push({ type: 'text', text: p.text, ...(p.thoughtSignature ? { gsig: p.thoughtSignature } : {}) });
      } else if (p.thoughtSignature) {
        const ult = blocks[blocks.length - 1];
        if (ult && !ult.gsig) ult.gsig = p.thoughtSignature;
        else blocks.push({ type: 'text', text: '', gsig: p.thoughtSignature });
      }
    }
  };
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = buf.match(/\r?\n\r?\n/))) {
      const evento = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
      const dados = evento.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!dados || dados === '[DONE]') continue;
      try { tratar(JSON.parse(dados)); } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    }
  }
  const util = blocks.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text));
  if (!util) {
    if (bloqueio) throw new Error(`O Gemini bloqueou a requisição (${bloqueio}). Reformule o pedido ou troque a IA.`);
    throw new Error(`O Gemini não devolveu resposta${motivo ? ` (motivo: ${motivo})` : ''}. Tente de novo ou troque a IA.`);
  }
  return { blocks, usaFerramenta: blocks.some((b) => b.type === 'tool_use') };
}

// ---------- entrada única ----------
function traduzirErro(ia, e) {
  const msg = String(e?.message || e);
  if (ia === 'claude' && /credit balance|billing|insufficient/i.test(msg)) {
    const outra = listarIAs().some((x) => x.id !== 'claude');
    return 'Os créditos da API do Claude acabaram.' + (outra ? ' Troque para outra IA no seletor da barra lateral.' : ' Adicione crédito em Billing, no Console da Anthropic.');
  }
  if (ia === 'claude' && /rate.?limit|overloaded|429|529/i.test(msg)) return 'O Claude está com limite de uso ou sobrecarregado. Tente de novo em instantes ou troque a IA. (' + msg.slice(0, 160) + ')';
  if (ia === 'groq') {
    if (/Groq 429/.test(msg) && /per day|daily|TPD|RPD/i.test(msg)) return 'O limite diário gratuito do Groq acabou (zera à meia-noite UTC, 21h em Brasília). Troque para outra IA no seletor.';
    if (/Groq 429|rate.?limit/i.test(msg)) return 'O Groq está no limite por minuto do plano gratuito. Espere cerca de um minuto, peça algo mais curto ou troque a IA. (' + msg.slice(0, 160) + ')';
    if (/Groq 413|too large|reduce your message/i.test(msg)) return 'O pedido ficou grande demais para o limite do Groq gratuito. Comece uma conversa nova ou peça algo menor. (' + msg.slice(0, 160) + ')';
    if (/decommission|model_not_found|does not exist|not.?found/i.test(msg)) return `O modelo "${MODELO_GROQ}" não está disponível na sua conta Groq. Troque a variável GROQ_MODEL (veja os modelos em console.groq.com). (` + msg.slice(0, 120) + ')';
    if (/Groq 401|invalid api key/i.test(msg)) return 'A chave do Groq (GROQ_API_KEY) foi recusada. Confira se foi colada inteira, sem espaços.';
  }
  return msg;
}

export async function turno(ia, args) {
  try {
    if (ia === 'prodiginho') return await turnoProdiginho({ ...args, interpretarComIA: (texto, anterior, contexto) => interpretarPedido(texto, anterior, args.signal, contexto) });
    if (ia === 'groq') return await turnoGroq({ ...args, system: { ...args.system, fixo: promptCurto(args.system.fixo) } });
    return ia === 'gemini' ? await turnoGemini(args) : await turnoClaude(args);
  } catch (e) {
    if (args.signal?.aborted) throw e;
    const novo = new Error(traduzirErro(ia, e));
    novo.cause = e;
    throw novo;
  }
}

// ---------- Prodiginho pede ajuda a uma IA quando não entende ----------
// PRODIGINHO_ESCALA = IAs a tentar, em ordem (padrão "gemini,groq": só as gratuitas; coloque "claude" para permitir a paga; "off" desliga).
// Fallback apenas de interpretação: a IA não executa ferramentas e nunca assume a conversa.
export function iasDeEscala() {
  const cfg = (process.env.PRODIGINHO_ESCALA ?? 'groq,gemini').trim().toLowerCase();
  if (!cfg || cfg === 'off' || cfg === '0') return [];
  const ok = new Set(listarIAs().map((x) => x.id));
  return [...new Set(cfg.split(',').map((s) => s.trim()).filter((id) => ['groq', 'gemini'].includes(id) && ok.has(id)))];
}
export async function escalar(args, { pular = [] } = {}) {
  const erros = [];
  for (const id of iasDeEscala().filter((x) => !pular.includes(x))) {
    try {
      const r = await turno(id, args);
      const nome = listarIAs().find((x) => x.id === id)?.nome || id;
      return { ia: id, nome, r };
    } catch (e) {
      if (args.signal?.aborted) throw e;
      erros.push(`${id}: ${String(e.message).slice(0, 120)}`);
      console.log(`[escala] ${id} falhou: ${e.message}`);
    }
  }
  return { ia: null, erros };
}

// ---------- IA como INTERPRETADORA do Prodiginho ----------
// A IA só traduz a frase em uma chamada de ferramenta (1 requisição curta, sem enviar resultados de volta); quem executa e
// escreve a resposta é o Prodiginho. Se as IAs estiverem sem cota, devolve null e o Prodiginho tenta resolver sozinho.
const OPS = ['igual', 'diferente', 'comeca', 'termina', 'contem', 'maior', 'maior_igual', 'menor', 'menor_igual', 'vazio', 'preenchido', 'zero_ou_vazio', 'tamanho_menor', 'tamanho_maior_igual'];
const FILTROS_I = { type: 'array', description: 'Condições combinadas com E', items: { type: 'object', properties: { coluna: { type: 'string' }, operador: { type: 'string', enum: OPS }, valor: { type: 'string' } }, required: ['coluna', 'operador'] } };
const FORMATO_I = { type: 'string', enum: ['xlsx', 'csv', 'pdf'], description: 'Só se o usuário pediu arquivo' };
function ferramentasInterprete() {
  const dos = (n) => TOOLS.find((t) => t.name === n);
  const l = ['buscar_produtos', 'exportar_consulta', 'consultar_tabela', 'gerar_etiquetas', 'gerar_catalogo', 'info_base'].map(dos).filter(Boolean);
  l.push(
    { name: 'consulta_estoque', description: 'Saldo de estoque por produto, ou VALOR do estoque (saldo x custo/venda). Filtros valem para a base de produtos.', input_schema: { type: 'object', properties: { filtros: FILTROS_I, saldo: { type: 'object', properties: { operador: { type: 'string', enum: ['maior', 'menor', 'menor_igual'] }, valor: { type: 'string' } } }, valor: { type: 'string', enum: ['custo', 'venda'] }, formato: FORMATO_I } } },
    { name: 'cadastros_incompletos', description: 'Cadastros com campo faltando.', input_schema: { type: 'object', properties: { campos: { type: 'array', items: { type: 'string', enum: ['ncm', 'gtin', 'peso', 'custo', 'localizacao'] } }, modo: { type: 'string', enum: ['qualquer', 'todos'] }, situacao: { type: 'string', enum: ['A', 'I', 'todas'] }, filtros: FILTROS_I, formato: FORMATO_I } } },
    { name: 'conferir_skus', description: 'Confere quais SKUs existem na base.', input_schema: { type: 'object', properties: { skus: { type: 'array', items: { type: 'string' } }, formato: FORMATO_I } } },
    { name: 'resumo_base', description: 'Resumo geral da base (totais por situação e tipo).', input_schema: { type: 'object', properties: {} } },
    { name: 'responder', description: 'Use só quando NÃO for um pedido às bases: resposta curta em português ou pergunta de esclarecimento.', input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] } },
  );
  return l;
}
const PROMPT_INTERPRETE = `Você é o INTERPRETADOR do Prodiginho, assistente de consultas do Tiny ERP da Prodigy. Sua única tarefa: ler a mensagem e chamar EXATAMENTE UMA ferramenta com os parâmetros certos. Não explique nada.
Base de produtos, colunas: id, nome, codigo (= SKU), unidade, localizacao, preco, preco_promocional, preco_custo, ncm, origem, gtin, peso_liquido, peso_bruto, situacao (A ativo, I inativo, E excluído), tipo_variacao (P pai, V variação, N normal), marca, categoria. Estoque: ferramenta consulta_estoque.
Regras:
- "valor do estoque / quanto vale o estoque": consulta_estoque com valor custo (ou venda se pedirem preço de venda). "saldo/estoque/quantidade": consulta_estoque.
- "sem NCM/GTIN/peso/custo/localização": cadastros_incompletos (situacao A, a menos que peçam inativos).
- Nome do produto: buscar_produtos (termo) para ver na tela, ou exportar_consulta (filtros nome contem) se pedirem arquivo/lista grande. pdf/csv/xlsx: parâmetro formato.
- Equivalências: M1=MG, CM=RM; nas medidas dos cartuchos (2 primeiros dígitos do modelo) 20=06, 25=08, 30=10, 12=35. Em valor com operador contem, use "a|b" para alternativas (ex.: "mg|m1").
- Catálogo/PDF visual com cor, fotos ou layout: gerar_catalogo (filtros por nome/marca; cor, com_preco só se pedirem).
- Etiquetas/código de barras: gerar_etiquetas; largura e altura em mm são OBRIGATÓRIAS e vêm do usuário (5 cm = 50 mm). Se faltarem, use responder e pergunte o tamanho.
- Use a "Conversa recente" para entender respostas curtas e continuações (ex.: o usuário respondeu só o tamanho da etiqueta, ou disse "agora faça da pen gts": repita o pedido anterior trocando só o que mudou).
- "Código de barras" / "gtin" de um produto pedido por nome = gerar_etiquetas (formato png se não houver tamanho).
- Se houver "Pedido anterior" e a mensagem for um ajuste ("só os ativos", "tire os sem sku", "agora em pdf"), devolva a ferramenta do pedido anterior já ajustada (mantenha os outros parâmetros).
- Cadastro de produto novo, NF, preço, custo ou localização para atualizar: responder dizendo que isso exige Claude ou Gemini no seletor.`;

// A IA não pode escolher ações de escrita, tabelas arbitrárias ou filtros desconhecidos.
// Rejeitamos a interpretação inteira quando ela contém parâmetros não autorizados.
const COLUNAS_LEITURA = new Set(['id','codigo','nome','localizacao','preco','preco_custo','preco_promocional','gtin','ncm','marca','categoria','situacao','tipo_variacao','peso_liquido','peso_bruto','unidade']);
const NOMES_INTERPRETE = new Set(['buscar_produtos','exportar_consulta','consultar_tabela','gerar_etiquetas','gerar_catalogo','info_base','consulta_estoque','cadastros_incompletos','conferir_skus','resumo_base']);
export function validarInterpretacao(chamada) {
  if (!chamada || !NOMES_INTERPRETE.has(chamada.name) || !chamada.input || typeof chamada.input !== 'object' || Array.isArray(chamada.input)) return null;
  const esquema = ferramentasInterprete().find((t) => t.name === chamada.name)?.input_schema;
  if (!esquema) return null;
  const valido = (obj, schema, depth = 0) => {
    if (depth > 8) return false;
    if (schema.type === 'array') return Array.isArray(obj) && obj.length <= 500 && obj.every((v) => valido(v, schema.items, depth + 1));
    if (schema.type === 'object') return obj !== null && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every((k) => Object.hasOwn(schema.properties || {}, k) && valido(obj[k], schema.properties[k], depth + 1)) && (schema.required || []).every((k) => Object.hasOwn(obj,k));
    if (schema.type === 'integer' || schema.type === 'number') return typeof obj === 'number' && Number.isFinite(obj);
    if (schema.type === 'boolean') return typeof obj === 'boolean';
    if (schema.type === 'string') return typeof obj === 'string' && obj.length <= 500 && (!schema.enum || schema.enum.includes(obj));
    return false;
  };
  if (!valido(chamada.input, esquema)) return null;
  const filtros = chamada.input.filtros || [];
  if (filtros.some((f) => !COLUNAS_LEITURA.has(f.coluna) || !OPS.includes(f.operador) || (f.valor != null && typeof f.valor !== 'string'))) return null;
  if (chamada.name === 'consultar_tabela' && !['produtos','estoque','produtos_tag','grupo_tag'].includes(chamada.input.tabela || 'produtos')) return null;
  if (chamada.name === 'gerar_etiquetas') {
    const x = chamada.input;
    if ((x.largura_mm != null && !(x.largura_mm > 0 && x.largura_mm <= 300)) || (x.altura_mm != null && !(x.altura_mm > 0 && x.altura_mm <= 300))) return null;
  }
  return { name: chamada.name, input: chamada.input };
}

export async function interpretarPedido(texto, anterior, signal, contexto = '') {
  const ids = iasDeEscala().filter((x) => x === 'gemini' || x === 'groq' || x === 'claude');
  if (!ids.length) return null;
  const conteudo = `${contexto ? `Conversa recente (do mais antigo para o mais novo):\n${String(contexto).slice(0, 2500)}\n\n` : ''}${anterior ? `Pedido anterior (ferramenta e parâmetros): ${JSON.stringify(anterior).slice(0, 1500)}\n` : ''}Mensagem atual do usuário: ${texto}`;
  const args = { system: { fixo: PROMPT_INTERPRETE, variavel: '' }, messages: [{ role: 'user', content: [{ type: 'text', text: conteudo }] }], tools: ferramentasInterprete(), signal, onText: () => {} };
  for (const id of ids) {
    try {
      const r = await (id === 'gemini' ? turnoGemini(args) : id === 'groq' ? turnoGroq(args) : turnoClaude(args));
      const uso = r.blocks.find((b) => b.type === 'tool_use');
      const nome = listarIAs().find((x) => x.id === id)?.nome || id;
      if (uso && uso.name === 'responder') return { nome, resposta: String(uso.input?.texto || '').trim() || null };
      if (uso) { const chamada = validarInterpretacao({ name: uso.name, input: uso.input || {} }); if (chamada) return { nome, chamada }; continue; }
      const txt = r.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return { nome, resposta: txt || null };
    } catch (e) {
      if (signal?.aborted) throw e;
      console.log(`[interprete] ${id} falhou: ${String(e.message).slice(0, 160)}`);
    }
  }
  return null;
}
