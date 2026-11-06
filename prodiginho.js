// PRODIGINHO — o assistente gratuito do Agente Tiny ERP.
//
// Ele usa regras locais primeiro; opcionalmente pede a Groq/Gemini apenas a interpretação de pedidos desconhecidos e consulta
// as bases do Tiny com as ferramentas internas do app. Por isso não gasta crédito, não tem limite de uso e
// responde sempre do mesmo jeito. O custo é ser literal: só faz o que está no menu abaixo.
//
// Para ensinar uma frase nova, veja a função entender(). Para mudar os textos, veja os compor*().
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as memoria from './aprendizado.js';
import { sinonimos, corrigir, aplicarGlossario, equivalentes, fracaoConhecida } from './entendimento.js';
import { DATA, nomeDeCor } from './lib.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const hojeISO = hoje;
const idp = (tag = '') => 'p_' + tag + crypto.randomBytes(5).toString('hex');
const n = (v) => Number(v || 0).toLocaleString('pt-BR');

function referencias() {
  try { return JSON.parse(fs.readFileSync(new URL('./config/referencias.json', import.meta.url), 'utf8')); } catch { return {}; }
}

// ---------- formatação ----------
const cel = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '—';
const tabela = (cab, linhas) => `| ${cab.join(' | ')} |\n|${cab.map(() => '---').join('|')}|\n${linhas.map((l) => `| ${l.map(cel).join(' | ')} |`).join('\n')}`;
const dataBR = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : 'data desconhecida');
const linhaBase = (b) => b
  ? `*Base do Tiny: ${n(b.linhas)} itens, atualizada em ${dataBR(b.atualizacao)} (${b.origem || 'origem desconhecida'}).*${b.aviso ? `\n\n⚠️ ${b.aviso}` : ''}`
  : '';
const alt = (x) => equivalentes(x).join('|');
const fmtT = (termos) => termos.map((x) => { const e = equivalentes(x); return e.length > 1 ? `${x} (ou ${e.slice(1).join(', ')})` : x; }).join(' ');
const SIT = { A: 'Ativo', I: 'Inativo', E: 'Excluído' };

const DICA_ENSINAR = `Não entendi esse pedido. 🙂 Mas eu aprendo: me diga o que você queria, com um pedido que eu já saiba fazer, e eu guardo para a equipe toda.

\`ensinar: <pedido que eu já entendo>\` (vale para a frase que você acabou de escrever)
Ou, com outras palavras: \`ensinar: "o que falta de ncm" = ativos sem NCM\`

Digite **ajuda** para ver tudo o que eu sei fazer.`;

const AJUDA = `Oi! Eu sou o **Prodiginho**, o assistente gratuito da Prodigy. Consulto as bases do Tiny por regras locais. Se não entender, posso pedir à Groq/Gemini apenas para interpretar a pergunta (sujeito às cotas gratuitas).

**O que eu faço**
- **Conferir SKUs:** cole uma lista de SKUs ou anexe uma planilha (xlsx, xls ou csv) e eu digo quais já existem no Tiny. Ex.: \`conferir 2000000011731 7891234567890\`
- **Buscar produtos** por nome, SKU ou marca. Ex.: \`buscar cartucho 1218RS\`
- **Localização e estoque.** Ex.: \`produtos da localização B com estoque\` ou \`estoque da localização B001 maior que 10\`
- **Cadastros incompletos.** Ex.: \`ativos sem NCM ou sem GTIN\` ou \`cadastros incompletos\`
- **Próximo SKU e próximo pai.** Ex.: \`qual o próximo SKU?\`
- **Resumo da base.** Ex.: \`resumo da base\`
- **Colunas de uma base.** Ex.: \`colunas do estoque\`
- **Ensinar:** \`ensinar: "frase" = pedido que eu já sei fazer\`. Eu guardo e passo a entender. \`o que você aprendeu?\` lista; \`esquecer "frase"\` apaga.
- **Formato do arquivo:** por padrão gero **xlsx**. Acrescente \`em pdf\` ou \`em csv\` ao pedido. Ex.: \`produtos da localização B com estoque em pdf\`

**O que eu não faço** (para isso, troque para Claude ou Gemini no seletor da barra lateral): ler NF ou Invoice em PDF/imagem, cadastrar produtos novos, atualizar custo ou preço e montar a planilha de localização. Também não entendo frases soltas: peça de forma direta, como nos exemplos.`;

// ---------- entender o pedido ----------
function lerUsuario(content) {
  const blocos = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const anexos = [], textos = [];
  for (const b of blocos) {
    if (b.type !== 'text') continue;
    const m = b.text.match(/^\[Anexo: "(.*)" \| arquivo_id=([a-f0-9]{24})\]/);
    if (m) anexos.push({ nome: m[1], id: m[2] }); else textos.push(b.text);
  }
  return { texto: textos.join('\n').trim(), anexos };
}

export const PARADAS = new Set(('de da do das dos em na no nas nos com sem para por que o a os as um uma e ou me voce vc favor pode poderia quero queria preciso '
  + 'gostaria lista listar liste mostrar mostre mostra ver veja buscar busque busca procurar procure pesquisar pesquise consultar consulte achar ache '
  + 'produto produtos item itens todos todas todo toda cadastro cadastros cadastrado cadastrados sku skus codigo codigos exportar exporte planilha arquivo baixar excel xlsx '
  + 'estoque saldo total geral soma somado inteiro tem temos tenho ha sobrou resta pdf csv xlsx excel procura confere traz traga mostra exporta maior menor acima abaixo zerado zerada ativo ativos inativo inativos localizacao localizacoes qual quais quanto quantos').split(' '));

const extrairSkus = (texto) => [...new Set(texto.split(/[\s,;|]+/).map((x) => x.replace(/^["'(]+|["')]+$/g, '')).filter((x) => /^\d{4,}$/.test(x)))];
const termosDe = (t) => t.split(/[^a-z0-9.,-]+/).map((x) => x.replace(/^[.,-]+|[.,-]+$/g, '')).filter((x) => x && !PARADAS.has(x) && !/^\d+$/.test(x) || /^\d{3,}$/.test(x));

const CAMPOS_FALTA = {
  ncm: /(sem|falta\w*|faltando|nao tem|vazi\w*)\s+(o\s+)?ncm|ncm\s+(vazi|ausente|faltando|em branco)/,
  gtin: /(sem|falta\w*|faltando|nao tem|vazi\w*)\s+(o\s+)?(gtin|ean|codigo de barras)|(gtin|ean)\s+(vazi|ausente|faltando|em branco)/,
  peso: /(sem|falta\w*|faltando|nao tem)\s+(o\s+)?peso|peso\s+(zerad|vazi|em branco)/,
  custo: /(sem|falta\w*|faltando|nao tem)\s+(o\s+)?(preco de )?custo|(preco de )?custo\s+(zerad|vazi|em branco)/,
  localizacao: /(sem|falta\w*|faltando|nao tem)\s+(a\s+)?localizac/,
  marca: /(sem|falta\w*|faltando|nao tem)\s+(a\s+)?marca/,
  categoria: /(sem|falta\w*|faltando|nao tem)\s+(a\s+)?categoria/,
};
const ROTULO = { ncm: 'NCM', gtin: 'GTIN', peso: 'peso', custo: 'preço de custo', localizacao: 'localização', marca: 'marca', categoria: 'categoria' };

const LOC_RE = /localizac\w*\s+((?:(?:de|da|do|em|na|no|nas|nos|com|a|o|igual|exata|comecando|comecam|comeca|iniciando|iniciam|inicia|que|seja)\s+)*)([a-z0-9][a-z0-9._-]*)/;
const NAO_LOC = new Set(['estoque', 'saldo', 'produtos', 'produto', 'ativos', 'ativo', 'inativos', 'sem', 'com', 'e', 'ou', 'maior', 'menor', 'acima', 'abaixo', 'zerado', 'zerada', 'vazia', 'preenchida', 'que', 'tem', 'tenha']);


// ---------- etiquetas com código de barras ----------
const toMM = (v, un, doisValores) => { const x = parseFloat(String(v).replace(',', '.')); if (un === 'mm') return x; if (un === 'cm') return x * 10; return (doisValores ? x <= 30 : x <= 30) ? x * 10 : x; };
function lerTamanho(t) {
  const N = '(\\d{1,3}(?:[.,]\\d+)?)';
  const dep = '[\\s:=]*(?:de\\s+)?';
  const lar = t.match(new RegExp(`(?:largura|larg)${dep}(?<![\\d.,])${N}\\s*(cm|mm)?`)) || t.match(new RegExp(`(?<![\\d.,])${N}\\s*(cm|mm)?\\s*(?:de\\s+)?(?:largura|larg)`));
  const alt = t.match(new RegExp(`(?:altura|alt)${dep}(?<![\\d.,])${N}\\s*(cm|mm)?`)) || t.match(new RegExp(`(?<![\\d.,])${N}\\s*(cm|mm)?\\s*(?:de\\s+)?(?:altura|alt)`));
  if (lar && alt) return { largura: toMM(lar[1], lar[2]), altura: toMM(alt[1], alt[2]) };
  const par = t.match(new RegExp(`(?<![\\d.,])${N}\\s*(cm|mm)?\\s*(?:x|por)\\s*${N}(?![\\d])\\s*(cm|mm)?`));
  if (par) { const un = par[4] || par[2]; return { largura: toMM(par[1], un, true), altura: toMM(par[3], un, true) }; }
  return null;
}

const GENERICAS_ET = /^(etiquetas?|imagem|imagens|png|jpg|jpeg|zip|pdf|foto|fotos|figura|desenho|gtin|ean|barras?|codigos?|tamanho|largura|altura|gerar|gere|gera|criar|crie|preciso|quero|nome|sku|produto|produtos|todos|todas|cada|vezes|com|pelo|pela|por|nos?|nas?|me|passa|passe|manda|mande|mostra|mostre|traz|traga|dar|dê|agora|tambem|mesmo|mesma|coisa|faca|faz|repete|repita|pra|para|pro|so|apenas|um|uma|pdf|unico)$/;
// tira de um texto (já normalizado) as medidas e quantidades: "5cm x 4cm", "largura 5cm", "x 20", "10 etiquetas de cada"
function tirarMedidas(t) {
  return t
    .replace(/(?<![\d.,])\d+(?:[.,]\d+)?\s*(?:cm|mm)?\s*(?:x|por)\s*\d+(?:[.,]\d+)?\s*(?:cm|mm)?/g, ' ')
    .replace(/\b(?:largura|larg|altura|alt)\s*(?:de\s*)?\d+(?:[.,]\d+)?\s*(?:cm|mm)?/g, ' ')
    .replace(/(?<![\d.,])\d+(?:[.,]\d+)?\s*(?:cm|mm)\b/g, ' ')
    .replace(/\bx\s*\d+\b|\b\d+\s*(?:etiquetas?|copias?|vezes|de cada|por produto|por sku|cada)\b|\bquantidade\s*(?:de\s*)?\d+/g, ' ');
}

function planoEtiquetas(texto, t, anexos, forcarImagem = false) {
  const tam = lerTamanho(t);
  const planilha = anexos.find((a) => /\.(xlsx?|csv|tsv|txt)$/i.test(a.nome));
  // SKU com quantidade: "2000000011731 x 20", "2000000011731:20", "2000000011731*20"
  const itens = [], comQtd = new Set();
  for (const m of texto.matchAll(/(?<![\d])(\d{4,})\s*(?:x|\*|:)\s*(\d{1,4})(?![\d])/gi)) { itens.push({ sku: m[1], quantidade: Number(m[2]) }); comQtd.add(m[1]); }
  const skus = extrairSkus(texto).filter((s) => !comQtd.has(s));
  const mq = t.match(/(\d{1,4})\s*(?:etiquetas?|copias?|vezes)?\s*(?:de cada|por produto|por sku|cada)/) || t.match(/quantidade\s*(?:de\s*)?(\d{1,4})/);
  const quantidade = mq ? Number(mq[1]) : undefined;
  let filtros, fromAnterior = false;
  const loc = t.match(LOC_RE);
  if (!itens.length && !skus.length && !planilha && loc && !NAO_LOC.has(loc[2])) filtros = [{ coluna: 'localizacao', operador: 'comeca', valor: loc[2] }];
  if (!itens.length && !skus.length && !planilha && !filtros && /\b(desse|desses|dessa|dessas|deles|delas|dele|dela|esse resultado|resultado|ultima busca|busca anterior|anterior|da lista|dessa lista)\b/.test(t)) { const fa = filtrosDoAnterior(ANTERIOR); if (fa?.length) { filtros = fa; fromAnterior = true; } }
  // por NOME: "etiquetas dos cartuchos 1218RS 5cm x 4cm", "imagem do gtin da pen aston preta"
  let porNome = null;
  if (!itens.length && !skus.length && !planilha && !filtros) {
    const resto = tirarMedidas(t);
    const termos = termosDe(resto).filter((x) => !GENERICAS_ET.test(x));
    if (termos.length) {
      porNome = termos;
      filtros = termos.map((x) => ({ coluna: 'nome', operador: 'contem', valor: alt(x) }));
      if (!/\binativ|todos os status|todas as situacoes/.test(t)) filtros.push({ coluna: 'situacao', operador: 'igual', valor: 'A' });
    }
  }
  if (!itens.length && !skus.length && !planilha && !filtros) return { resposta: 'De quais produtos são as etiquetas? Informe os SKUs (com a quantidade se quiser, por exemplo `2000000011731 x 20`), o nome (`etiquetas dos cartuchos 1218RS 5cm x 4cm`), anexe uma planilha com SKU e quantidade, ou peça por localização (`etiquetas da localização B001`).' };
  const imagem = forcarImagem || /\b(imagem|imagens|png|foto|figura|desenho)\b/.test(t);
  if (!tam && !imagem) return { resposta: 'Qual o **tamanho** da etiqueta? Escreva a largura e a altura, por exemplo `5cm x 4cm` ou `100x50mm`. Eu não escolho o tamanho por você.' };
  if (tam && !(tam.largura >= 20 && tam.largura <= 300 && tam.altura >= 15 && tam.altura <= 300)) return { resposta: `Tamanho fora do que eu consigo gerar (${tam.largura} x ${tam.altura} mm). Use largura de 20 a 300 mm e altura de 15 a 300 mm.` };
  const input = {
    ...(tam ? { largura_mm: tam.largura, altura_mm: tam.altura } : {}), ...(imagem ? { formato: 'png' } : {}),
    ...(itens.length ? { itens } : {}), ...(skus.length ? { skus } : {}), ...(filtros ? { filtros } : {}),
    ...(planilha ? { arquivo_id: planilha.id } : {}), ...(quantidade ? { quantidade } : {}),
    ...(/\b(um pdf (so|unico)|1 pdf (so|unico)|pdf unico|tudo (em|num) (um )?(pdf|arquivo)|tudo junto|arquivo unico)\b/.test(t) ? { pdf_unico: true } : {}),
    com_nome: /\bcom (o )?nome\b|\bnome do produto\b/.test(t), com_sku: /\bcom (o )?sku\b|\bsku na etiqueta\b/.test(t),
    usar_sku_sem_gtin: !/\b(so|somente|apenas) (o )?(gtin|ean)\b|\b(nao|sem) (usar|use|gerar|gere) (o )?sku\b|\bnao (quero|usar) sku\b/.test(t),
    nome_arquivo: imagem ? `codigos_de_barras_${hoje()}` : `etiquetas_${Math.round(tam.largura)}x${Math.round(tam.altura)}mm_${hoje()}`,
  };
  const qtd = itens.length + skus.length;
  const origem = planilha ? `da planilha **${planilha.nome}**` : filtros ? (porNome ? `dos produtos ativos com **${fmtT(porNome)}** no nome` : fromAnterior ? 'do **resultado anterior**' : `da localização **${filtros[0].valor.toUpperCase()}**`) : `de **${qtd}** SKU(s)`;
  if (imagem) return { entendi: `gerar a **imagem (PNG)** do código de barras ${origem}`, chamada: { name: 'gerar_etiquetas', input } };
  return { entendi: `gerar etiquetas ${origem}, tamanho **${tam.largura} x ${tam.altura} mm**${quantidade ? `, ${quantidade} por produto` : ''}`, chamada: { name: 'gerar_etiquetas', input } };
}

function entender(texto, anexos, pedidoCompleto) {
  const t = norm(texto);
  const skus = extrairSkus(texto);
  const planilha = anexos.some((a) => /\.(xlsx?|csv|tsv|txt)$/i.test(a.nome));
  const outroAnexo = anexos.length && !planilha;
  const id = (name, input) => ({ name, input });

  if (!t && !anexos.length) return { resposta: AJUDA };
  if (/^(obrigad[oa]|valeu|vlw|brigad[oa]|show|top|legal|perfeito|blz|beleza|ok|certo|entendi|massa|joia)\b/.test(t) && t.split(' ').length <= 4) return { resposta: 'De nada! 🙂 Se precisar de mais alguma consulta, PDF ou etiqueta, é só pedir.' };
  if (/^(tchau|ate mais|ate logo|flw|falou)\b/.test(t)) return { resposta: 'Até mais! 👋' };
  if (/^(oi|ola|opa|e ai|bom dia|boa tarde|boa noite|ajuda|help|menu|\?)\b/.test(t) || /\b(o que (voce|vc) (faz|sabe|pode)|como (voce )?(funciona|usar|uso)|ajuda)\b/.test(t)) return { resposta: AJUDA };

  // catálogo em PDF formatado: "catálogo dos perfumes sem preço, cabeçalho vermelho, com imagens, fonte 10, linha de 30mm"
  if (/\bcatalog\w*/.test(t) && !anexos.length) {
    let corTxt = null;
    { const mc = t.match(/\b(?:cor|cores|cabecalho|fundo|faixas?|tema|titulo)\s+(?:de\s+|do\s+|da\s+|em\s+)?(?:cor\s+)?([a-z]+(?:\s+(?:escur\w+|clar\w+))?)/) || t.match(/\b(?:em|na cor|de cor)\s+([a-z]+(?:\s+(?:escur\w+|clar\w+))?)\b/);
      if (mc) { const [pal, mod] = mc[1].split(/\s+/); if (nomeDeCor(pal)) corTxt = mod ? `${pal} ${mod}` : pal; }
      if (!corTxt) for (const w of t.split(/[^a-z]+/)) if (w.length > 3 && nomeDeCor(w) && !/^(ouro)$/.test(w)) { const i = t.indexOf(w); const md = t.slice(i + w.length).match(/^\s+(escur\w+|clar\w+)/); corTxt = md ? `${w} ${md[1]}` : w; break; } }
    const corN = corTxt;
    const hex = t.match(/#[0-9a-f]{6}\b/);
    const fonte = t.match(/\bfonte\s*(?:de\s*|tamanho\s*)?(\d{1,2})\b/);
    const altura = t.match(/\b(?:altura|linhas?)\s*(?:da\s*linha\s*)?(?:de\s*|=\s*)?(\d{1,3})\s*mm\b/) || t.match(/\b(\d{1,3})\s*mm\s*(?:de altura|por linha|a linha)\b/);
    const semPreco = /\b(sem|nao (?:quero|coloque|mostre|incluir?))\s+(?:o\s+)?(?:preco|valor)/.test(t);
    const comPreco = !semPreco && /\b(com|mostrando|incluindo)\s+(?:o\s+)?(?:preco|valor)/.test(t);
    const semImg = /\bsem\s+(?:as\s+)?(?:imagens?|fotos?)\b/.test(t);
    const GEN_CAT = /^(catalogos?|pdf|gerar|gere|gera|criar|crie|faca|fazer|quero|preciso|me|de|dos?|das?|da|um|uma|com|sem|cabecalho|titulo|cor|preco|valor|imagens?|fotos?|fonte|altura|linhas?|mm|em|na|no|nas|nos|e|a|o|as|os|pdf|formatado|bonito|colorido|escur\w*|clar\w*|cor|tamanho|\d+|todos|todas|produtos?)$/;
    const termos = termosDe(t.replace(/#[0-9a-f]{6}\b/g, ' ')).filter((x) => !GEN_CAT.test(x) && !(corN && corN.split(' ')[0] === x));
    if (!termos.length) return { resposta: 'De quais produtos é o catálogo? Por exemplo: `catálogo dos perfumes sem preço, cabeçalho vermelho, com imagens`.' };
    const sing = (x) => (/^[a-z]{3,}s$/.test(x) ? x.slice(0, -1) : x);
    const filtros = termos.map((x) => ({ coluna: 'nome', operador: 'contem', valor: alt(sing(x)) }));
    const input = { filtros, titulo: `Catálogo ${termos.join(' ').toUpperCase()}`, ...(hex ? { cor: hex[0] } : corN ? { cor: corN } : {}), com_preco: comPreco, com_imagem: !semImg, ...(fonte ? { fonte_pt: Number(fonte[1]) } : {}), ...(altura ? { altura_linha_mm: Number(altura[1]) } : {}) };
    return { entendi: `gerar o **catálogo em PDF** de **${termos.join(' ')}**${corN ? `, cor ${corN}` : ''}, ${comPreco ? 'com' : 'sem'} preço, ${semImg ? 'sem' : 'com'} imagens`, chamada: id('gerar_catalogo', input) };
  }
  // só uma medida, sem produto (e sem pergunta pendente): não é busca
  if (!skus.length && !anexos.length && lerTamanho(t) && termosDe(tirarMedidas(t)).filter((x) => !GENERICAS_ET.test(x)).length === 0) {
    return { resposta: 'Esse é um tamanho de etiqueta. 🙂 Para qual **produto**? Por exemplo: `etiquetas dos cartuchos 1218RS 5cm x 4cm`.' };
  }
  // "me dê o código de barras do produto X" (sinônimos já trocaram "código de barras" por gtin): gera a imagem do código de barras
  if (/\b(gtin|ean)\b/.test(t) && /\b(me (de|da|passa|manda|mostra|traz)|quero|preciso|gerar|gere|gera|criar|crie|mostra|mostre|traga|traz|passa|manda)\b/.test(t) && !/\b(sem|falt\w*|vazi\w*|incomplet\w*|quantos|quais|qual|pdf|csv|xlsx|planilha)\b/.test(t)) return planoEtiquetas(texto, t, anexos, true);
  if (/\betiquetas?\b/.test(t) || /^(imagem|imagens|png)\b/.test(t) || (/\b(imagem|imagens|png|foto|fotos)\b/.test(t) && /\b(gtin|ean|barras?|codigos?|gerar|gere|gera|criar|crie|quero|preciso)\b/.test(t))) return planoEtiquetas(texto, t, anexos);

  const colunas = t.match(/\bcolunas?\b.*?\b(estoque|produtos?|tags?|grupos?)\b|\b(estoque|produtos?|tags?|grupos?)\b.*?\bcolunas?\b/);
  if (colunas) {
    const alvo = colunas[1] || colunas[2];
    const tabelaNome = /estoque/.test(alvo) ? 'estoque' : /tag/.test(alvo) ? 'produtos_tag' : /grupo/.test(alvo) ? 'grupo_tag' : 'produtos';
    return { entendi: `ver as colunas da base **${tabelaNome}**`, chamada: id('consultar_tabela', { tabela: tabelaNome, limite: 2 }) };
  }

  if (/\b(proximo|proxima|ultimo|ultima|maior)\s+(sku|pai|codigo)/.test(t) || /sequencia (de )?(sku|interna)/.test(t)) {
    return { entendi: 'calcular o próximo SKU e o próximo pai', chamada: id('info_base', {}) };
  }

  const faltando = Object.keys(CAMPOS_FALTA).filter((k) => CAMPOS_FALTA[k].test(t));
  if (faltando.length || /incomplet/.test(t)) {
    const input = {
      campos: faltando.length ? faltando : undefined,
      modo: faltando.length && !/\bou\b/.test(t) ? 'todos' : 'qualquer',
      situacao: /inativ/.test(t) ? 'I' : /todas as situacoes|todos os status|inclusive inativ/.test(t) ? 'todas' : 'A',
      nome_arquivo: `cadastros_incompletos_${hoje()}`,
    };
    const quais = faltando.length ? faltando.map((k) => ROTULO[k]).join(input.modo === 'todos' ? ' e ' : ' ou ') : 'qualquer campo importante (NCM, GTIN, peso, custo, localização)';
    return { entendi: `listar cadastros ${input.situacao === 'I' ? 'inativos' : input.situacao === 'todas' ? 'de todas as situações' : 'ativos'} com falta de ${quais}`, chamada: id('cadastros_incompletos', input) };
  }

  if (/\bresumo\b|visao geral|quantos (produtos|itens|cadastros|skus)|total de (produtos|itens)|situacao da base/.test(t)) {
    return { entendi: 'resumir a base de produtos', chamada: id('resumo_base', {}) };
  }

  const verboConferir = /confer|exist|cadastrad|ja tem|ja esta|verific|consta|encontr/.test(t);
  if ((skus.length || planilha) && (verboConferir || (planilha && !/estoque|saldo|localizac/.test(t)))) {
    const input = planilha ? { arquivo_id: anexos.find((a) => /\.(xlsx?|csv|tsv|txt)$/i.test(a.nome)).id, nome_arquivo: `conferencia_skus_${hoje()}` } : { skus, nome_arquivo: `conferencia_skus_${hoje()}` };
    return { entendi: planilha ? `conferir os SKUs da planilha **${anexos.find((a) => /\.(xlsx?|csv|tsv|txt)$/i.test(a.nome)).nome}**` : `conferir **${skus.length}** SKU(s) informado(s)`, chamada: id('conferir_skus', input) };
  }

  if (/estoque|saldo|localizac/.test(t)) return planoEstoqueLocal(t);

  if (skus.length && termosDe(t).length === 0) {
    return { entendi: `conferir **${skus.length}** SKU(s) informado(s)`, chamada: id('conferir_skus', { skus, nome_arquivo: `conferencia_skus_${hoje()}` }) };
  }
  if (outroAnexo && !t) {
    return { escalar: true, resposta: 'Eu só leio planilhas e CSV (xlsx, xls, csv). PDF e imagem, como NF e Invoice, precisam do **Claude** ou do **Gemini**: troque no seletor da barra lateral.' };
  }

  const termo = termosDe(t);
  if (!termo.length) return { naoEntendi: true, resposta: DICA_ENSINAR };
  if (/exportar|exporte|planilha|arquivo|baixar|excel|xlsx/.test(t)) {
    return { entendi: `exportar produtos com **${fmtT(termo)}** no nome`, chamada: id('exportar_consulta', { nome_arquivo: `produtos_${termo.join('_')}_${hoje()}`, filtros: termo.map((x) => ({ coluna: 'nome', operador: 'contem', valor: alt(x) })), colunas: ['id', 'codigo', 'nome', 'localizacao', 'situacao'], amostra_linhas: 15 }) };
  }
  return { entendi: `buscar produtos por **${fmtT(termo)}**`, chamada: id('buscar_produtos', { termo: termo.map(alt).join(' '), exibir: termo.join(' '), limite: 25 }) };
}

function planoEstoqueLocal(t) {
  const filtros = [], partes = [];
  // "valor de custo do estoque", "quanto vale o estoque", "valor do estoque a preço de venda": saldo x preço
  const pedeValor = /valor\s+(de\s+|do\s+|da\s+|em\s+)?(custo|venda|estoque|saldo)|quanto\s+(vale|custa|valem)|custo\s+(total\s+)?(do|de|em)\s+(estoque|saldo)|(estoque|saldo)\s+(em|a|ao|no)\s+(valor|custo|reais|r\$)|capital\s+(parado|em estoque)|patrimonio/.test(t);
  if (pedeValor && /estoque|saldo|vale|capital|patrimonio/.test(t)) {
    const venda = /venda|vendendo/.test(t) && !/custo/.test(t);
    const f = [], pt = [];
    if (/inativ/.test(t)) { f.push({ coluna: 'situacao', operador: 'igual', valor: 'I' }); pt.push('inativos'); }
    else if (/\bativ/.test(t)) { f.push({ coluna: 'situacao', operador: 'igual', valor: 'A' }); pt.push('ativos'); }
    const lm = t.match(LOC_RE);
    if (lm && !NAO_LOC.has(lm[2])) { f.push({ coluna: 'localizacao', operador: 'comeca', valor: lm[2] }); pt.push(`localização começando com **${lm[2].toUpperCase()}**`); }
    const tr = termosDe(t.replace(LOC_RE, ' ').replace(/\b(valor|custo|venda|vale|custa|valem|quanto|total|geral|reais|capital|parado|patrimonio)\b/g, ' '));
    for (const x of tr) f.push({ coluna: 'nome', operador: 'contem', valor: alt(x) });
    if (tr.length) pt.push(`nome com **${fmtT(tr)}**`);
    return { entendi: `calcular o **valor ${venda ? 'de venda' : 'de custo'}** do estoque (saldo × preço ${venda ? 'de venda' : 'de custo'})${pt.length ? ' de ' + pt.join(', ') : ' de todos os produtos'}`, chamada: { name: 'consulta_estoque', input: { filtros: f, valor: venda ? 'venda' : 'custo', nome_arquivo: `valor_estoque_${venda ? 'venda' : 'custo'}_${hoje()}` } } };
  }
  // "saldo total do estoque", "estoque geral": soma de tudo, sem filtro
  if (/(saldo|estoque)\s+(total|geral)|total\s+(do|de|em)\s+(saldo|estoque)|quanto\s+(tem|temos|ha)\s+(de|em)\s+estoque/.test(t) && !/localizac|ativ|inativ/.test(t) && termosDe(t).length === 0) {
    return { entendi: 'somar o saldo de **todo** o estoque', chamada: { name: 'consulta_estoque', input: { filtros: [], nome_arquivo: `estoque_total_${hoje()}` } } };
  }
  if (/inativ/.test(t)) { filtros.push({ coluna: 'situacao', operador: 'igual', valor: 'I' }); partes.push('inativos'); }
  else if (/\bativ/.test(t)) { filtros.push({ coluna: 'situacao', operador: 'igual', valor: 'A' }); partes.push('ativos'); }

  let loc = null;
  const m = t.match(LOC_RE);
  if (m && !NAO_LOC.has(m[2])) {
    const exata = /\b(exata|igual)\b/.test(t);
    loc = m[2];
    filtros.push({ coluna: 'localizacao', operador: exata ? 'igual' : 'comeca', valor: loc });
    partes.push(`localização ${exata ? 'igual a' : 'começando com'} **${loc.toUpperCase()}**`);
  }

  const usaEstoque = /estoque|saldo/.test(t);
  let saldo = null, mm;
  if ((mm = t.match(/(?:estoque|saldo)\s*(?:\w+\s+){0,2}?(maior|acima|superior|mais)\s*(?:de|que|do que)?\s*(\d+)/))) saldo = { operador: 'maior', valor: mm[2] };
  else if ((mm = t.match(/(?:estoque|saldo)\s*(?:\w+\s+){0,2}?(menor|abaixo|inferior|menos)\s*(?:de|que|do que)?\s*(\d+)/))) saldo = { operador: 'menor', valor: mm[2] };
  else if (/sem estoque|estoque zerad|saldo zerad|estoque zero|saldo zero|\bzerad/.test(t)) saldo = { operador: 'menor_igual', valor: '0' };
  else if (/com estoque|em estoque|tem estoque|tenha estoque|saldo positivo|estoque positivo|disponive/.test(t)) saldo = { operador: 'maior', valor: '0' };
  if (saldo) partes.push(`saldo ${({ maior: 'maior que', menor: 'menor que', menor_igual: 'zerado (≤ 0)' })[saldo.operador]}${saldo.operador === 'menor_igual' ? '' : ` ${saldo.valor}`}`);

  const termo = termosDe(t.replace(LOC_RE, ' '));
  for (const x of termo) filtros.push({ coluna: 'nome', operador: 'contem', valor: alt(x) });
  if (termo.length) partes.push(`nome com **${fmtT(termo)}**`);

  if (!loc && !termo.length && !saldo) {
    return { resposta: 'De qual produto ou localização? Por exemplo: `estoque da localização B001`, `produtos da localização B com estoque` ou `estoque cartucho 1218RS`.' };
  }
  const rotulo = (loc || termo.join('_') || 'estoque').replace(/[^a-z0-9]+/g, '_');
  if (usaEstoque) {
    return { entendi: `consultar o estoque de produtos: ${partes.join(', ')}`, chamada: { name: 'consulta_estoque', input: { filtros, saldo: saldo || undefined, nome_arquivo: `estoque_${rotulo}_${hoje()}` } } };
  }
  return {
    entendi: `listar produtos: ${partes.join(', ')}`,
    chamada: { name: 'exportar_consulta', input: { nome_arquivo: `produtos_${rotulo}_${hoje()}`, filtros, colunas: ['id', 'codigo', 'nome', 'localizacao', 'situacao'], ordenar_por: 'localizacao', amostra_linhas: 15 } },
  };
}

// ---------- compor a resposta final ----------
function compor(name, entrada, r, pedido) {
  if (!r) return 'Não recebi o resultado da consulta. Tente de novo.';
  if (r.erro && name === 'gerar_etiquetas' && r.ignorados?.length) return `**Não gerei nenhuma etiqueta**\n\n${tabela(['SKU', 'Motivo'], r.ignorados.map((x) => [x.sku, x.motivo]))}\n\nSe você pediu só GTIN, tire essa restrição para eu usar o SKU nos produtos sem GTIN. Para um GTIN que não está na base, digite o número completo (8, 12, 13 ou 14 dígitos com dígito verificador válido) que eu gero mesmo assim.`;
  if (r.erro) return `Não consegui concluir: ${r.erro}`;

  if (name === 'info_base') {
    const ref = referencias();
    const sobre = (re) => pedido.match(re)?.[1];
    const skuRef = BigInt(sobre(/(20000000\d{5})/) || ref.ultimo_sku_informado || 0);
    const paiRef = Number(sobre(/\bpai\b\D{0,15}(\d{4})(?!\d)/) || ref.ultimo_pai_informado || 0);
    const skuBase = BigInt(r.maior_sku_sequencia_interna_na_base || 0);
    const paiBase = Number(r.maior_pai_4_digitos_na_base || 0);
    const skuMax = skuBase > skuRef ? skuBase : skuRef, paiMax = Math.max(paiBase, paiRef);
    return `**Próximos códigos**\n\n${tabela(['', 'Maior na base do Tiny', 'Último informado', 'Próximo a usar'], [
      ['SKU (sequência interna)', r.maior_sku_sequencia_interna_na_base || '—', String(skuRef || '—'), `**${skuMax + 1n}**`],
      ['Produto pai (4 dígitos)', r.maior_pai_4_digitos_na_base || '—', String(paiRef || '—'), `**${paiMax + 1}**`],
    ])}\n\nRegra: o próximo é o **maior** entre a base do Tiny e o último valor informado, mais 1. Para informar outro último valor, escreva por exemplo \`último sku 2000000011740\` ou \`último pai 9240\`, ou edite \`config/referencias.json\`.\n\n${linhaBase({ linhas: r.total_linhas, atualizacao: r.ultima_atualizacao_arquivo, origem: r.origem, aviso: r.aviso })}`;
  }

  if (name === 'conferir_skus') {
    const t = [['Já existem no Tiny', n(r.existem)], ['Não existem', n(r.nao_existem)]];
    let out = `**Conferência de SKUs**\n\nOrigem: ${r.origem}. ${n(r.total_informado)} SKU(s) informado(s)${r.duplicados_removidos ? ` (${n(r.duplicados_removidos)} repetido(s) ignorado(s))` : ''}.\n\n${tabela(['Resultado', 'Quantidade'], t)}`;
    if (r.amostra_existem.length) out += `\n\n**Já cadastrados**${r.existem > r.amostra_existem.length ? ` (primeiros ${r.amostra_existem.length} de ${n(r.existem)})` : ''}\n\n${tabela(['SKU', 'ID Tiny', 'Nome', 'Localização', 'Situação'], r.amostra_existem.map((x) => [x[0], x[1], x[2], x[3], SIT[x[4]] || x[4]]))}`;
    if (r.nao_encontrados.length) out += `\n\n**Não existem no Tiny**${r.nao_existem > r.nao_encontrados.length ? ` (primeiros ${r.nao_encontrados.length} de ${n(r.nao_existem)})` : ''}\n\n\`${r.nao_encontrados.join(', ')}\``;
    return `${out}\n\nA planilha completa, com o status de cada SKU, está no arquivo acima.\n\n${linhaBase(r.base)}`;
  }

  if (name === 'cadastros_incompletos') {
    let out = `**Cadastros incompletos** (${r.situacao === 'A' ? 'ativos' : r.situacao === 'I' ? 'inativos' : 'todas as situações'}, critério: ${r.criterio})\n\n${n(r.total_com_falta)} de ${n(r.total_avaliados)} cadastros com falta de: ${r.campos.join(', ')}.\n\n${tabela(['Campo', 'Cadastros com falta'], Object.entries(r.por_campo).map(([k, v]) => [k, n(v)]))}`;
    if (r.amostra.length) out += `\n\n**Primeiros ${r.amostra.length}**\n\n${tabela(['SKU', 'Nome', 'Falta'], r.amostra)}`;
    if (r.campos_sem_coluna.length) out += `\n\n⚠️ Não avaliei ${r.campos_sem_coluna.join(', ')}: a base não tem a coluna correspondente.`;
    return `${out}\n\nProdutos *pai* são avaliados só no NCM, porque não levam GTIN, peso, custo nem localização. A lista completa está no arquivo acima.\n\n${linhaBase(r.base)}`;
  }

  if (name === 'resumo_base') {
    const lin = (o, m = {}) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => [m[k] || k, n(v)]);
    return `**Resumo da base de produtos**\n\nTotal: **${n(r.total)}** cadastros, dos quais **${n(r.ativos)}** ativos.\n\n${tabela(['Situação', 'Quantidade'], lin(r.por_situacao, SIT))}\n\n${tabela(['Tipo', 'Quantidade'], lin(r.por_tipo, { P: 'Pai (P)', V: 'Variação (V)', N: 'Normal (N)' }))}\n\n**Cadastros ativos com falta de dado**\n\n${tabela(['Campo', 'Quantidade'], lin(r.ativos_com_falta))}\n\nPara ver a lista de um deles, peça por exemplo \`ativos sem NCM\`.\n\n${linhaBase(r.base)}`;
  }

  if (name === 'consulta_estoque' && r.valor_tipo) {
    const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    let out = `**Valor do estoque a preço de ${r.valor_tipo === 'venda' ? 'venda' : 'custo'}**\n\n**${brl(r.valor_total)}** em **${n(r.total)}** produto(s), com saldo somado de **${n(r.saldo_total_soma)}** unidades.`;
    if (r.amostra.length) out += `\n\nMaiores valores:\n\n${tabela(['SKU', 'Nome', 'Saldo', 'Preço', 'Valor'], r.amostra.map((x) => [x[0], x[1], n(x[2]), brl(x[3]), brl(x[4])]))}`;
    if (r.com_saldo_sem_preco) out += `\n\n⚠️ **${n(r.com_saldo_sem_preco)}** produto(s) têm saldo mas **preço ${r.valor_tipo === 'venda' ? 'de venda' : 'de custo'} zerado** na base; eles entram com valor 0, então o total está subestimado.`;
    if (r.sem_registro_de_estoque) out += `\n\n⚠️ ${n(r.sem_registro_de_estoque)} produto(s) sem registro na base de estoque (saldo 0).`;
    return `${out}\n\nA lista completa está no arquivo acima.\n\n${linhaBase(r.base)}\n\n${linhaBase(r.estoque).replace('Base do Tiny', 'Base de estoque')}`;
  }
  if (name === 'consulta_estoque') {
    let out = `**Consulta de estoque**\n\n**${n(r.total)}** produto(s) encontrado(s). Saldo somado: **${n(r.saldo_total_soma)}**.`;
    if (r.amostra.length) out += `\n\n${tabela(['SKU', 'Nome', 'Localização', 'Saldo'], r.amostra)}${r.total > r.amostra.length ? `\n\n*Mostrando ${r.amostra.length} de ${n(r.total)}.*` : ''}`;
    if (r.sem_registro_de_estoque) out += `\n\n⚠️ ${n(r.sem_registro_de_estoque)} produto(s) não têm registro na base de estoque e foram tratados como saldo 0.`;
    return `${out}\n\nA lista completa está no arquivo acima. Estoque lido das colunas \`${r.estoque.coluna_produto}\` (produto) e \`${r.estoque.coluna_saldo}\` (saldo); depósitos diferentes são somados.\n\n${linhaBase(r.base)}\n\n${linhaBase(r.estoque).replace('Base do Tiny', 'Base de estoque')}`;
  }

  if (name === 'gerar_catalogo') {
    if (r.erro) return `**Não gerei o catálogo**\n\n${r.erro}`;
    if (!r.produtos) return `**Catálogo**\n\n${r.aviso || 'Nenhum produto com esses critérios.'}`;
    let out = `**Catálogo gerado**\n\n**${n(r.produtos)}** produto(s), cabeçalho na cor \`${r.cor}\`${r.agrupado_por ? `, agrupado por ${r.agrupado_por}` : ''}. O PDF está acima.`;
    if (r.com_imagem) out += `\n\n🖼️ Fotos: **${n(r.com_foto)}** com imagem, **${n(r.sem_foto)}** sem (coluna \`${r.coluna_imagem}\`).${Object.keys(r.motivos_sem_foto || {}).length ? ' Motivos: ' + Object.entries(r.motivos_sem_foto).map(([k, v]) => `${k} (${v})`).join('; ') + '.' : ''}`;
    if (r.aviso_imagem) out += `\n\n⚠️ ${r.aviso_imagem}`;
    return `${out}\n\n${linhaBase(r.base)}`;
  }
  if (name === 'gerar_etiquetas' && r.imagens !== undefined) {
    const foraB = r.fora_da_base ? `\n\nℹ️ ${n(r.fora_da_base)} código(s) **não estão na base**: gerei o código de barras só com o número que você digitou.` : '';
    let out = `**Imagem do código de barras**\n\n**${n(r.imagens)}** imagem(ns) PNG ${r.imagens > 1 ? 'no ZIP acima (um arquivo por produto)' : 'acima'}. Origem: ${r.origem}.${foraB}`;
    if (r.usou_sku_como_barras) out += `\n\n⚠️ **Atenção:** ${n(r.usou_sku_como_barras)} imagem(ns) usam o **SKU** como código de barras (Code 128), porque o produto **não tem GTIN**: ${(r.sku_como_barras || []).slice(0, 20).join(', ')}${(r.sku_como_barras || []).length > 20 ? ', ...' : ''}.`;
    if (r.total_ignorados) out += `\n\n**Sem imagem para ${n(r.total_ignorados)} item(ns)**\n\n${tabela(['SKU', 'Motivo'], r.ignorados.map((x) => [x.sku, x.motivo]))}`;
    return out;
  }
  if (name === 'gerar_etiquetas') {
    const onde = r.formato === 'zip' ? `uma por página, em **${n(r.pdfs)} PDFs** (um por produto, com a descrição do item no nome) dentro do ZIP acima. Se preferir tudo em um arquivo só, peça \`em um pdf só\`.` : 'uma por página, no PDF acima.';
    let out = `**Etiquetas geradas**\n\n**${n(r.etiquetas)}** etiqueta(s) de **${n(r.produtos)}** produto(s), tamanho **${r.tamanho_mm} mm**, ${onde} Origem: ${r.origem}.${r.fora_da_base ? `\n\nℹ️ ${n(r.fora_da_base)} etiqueta(s) usam GTIN **que não está na base** (número digitado por você).` : ''}`;
    out += `\n\nImprima em **tamanho real (100%)**, sem "ajustar à página", e configure na impressora o mesmo tamanho de etiqueta. Faça um teste com poucas antes de imprimir tudo.`;
    if (r.usou_sku_como_barras) out += `\n\n⚠️ **Atenção:** ${n(r.usou_sku_como_barras)} etiqueta(s) usam o **SKU** como código de barras (Code 128), porque o produto **não tem GTIN**: ${(r.sku_como_barras || []).slice(0, 20).join(', ')}${(r.sku_como_barras || []).length > 20 ? ', ...' : ''}. Esse código só serve para uso interno (o leitor lê, mas não é um EAN oficial).`;
    if (r.total_ignorados) out += `\n\n**Não gerei etiqueta para ${n(r.total_ignorados)} item(ns)**${r.total_ignorados > r.ignorados.length ? ` (mostrando ${r.ignorados.length})` : ''}\n\n${tabela(['SKU', 'Motivo'], r.ignorados.map((x) => [x.sku, x.motivo]))}\n\n`;
    return out;
  }
  if (name === 'exportar_consulta') {
    if (!r.linhas) return 'Não encontrei nenhum produto com esses critérios.';
    return `**${n(r.linhas)}** produto(s) encontrado(s).\n\n${tabela(['ID Tiny', 'SKU', 'Nome', 'Localização', 'Situação'], r.amostra.map((x) => [x[0], x[1], x[2], x[3], SIT[x[4]] || x[4]]))}${r.linhas > r.amostra.length ? `\n\n*Mostrando ${r.amostra.length} de ${n(r.linhas)}.*` : ''}\n\nA lista completa está no arquivo acima.`;
  }

  if (name === 'buscar_produtos') {
    if (!r.total_encontrado) return `Não encontrei nada para **${entrada.exibir || entrada.termo}**. Digite **ajuda** para ver o que eu sei fazer. Se queria outra coisa, me ensine: \`ensinar: <pedido que eu já entendo>\`.`;
    return `**${n(r.total_encontrado)}** produto(s) encontrado(s)${r.total_encontrado > r.retornados ? `, mostrando ${r.retornados}` : ''}.\n\n${tabela(['SKU', 'Nome', 'Localização', 'Preço de custo', 'Situação'], r.produtos.map((p) => [p.codigo, p.nome, p.localizacao, p.preco_custo, SIT[p.situacao] || p.situacao]))}${r.total_encontrado > r.retornados ? '\n\nPara receber tudo em planilha, peça por exemplo: `exportar ' + (entrada.exibir || entrada.termo) + '`.' : ''}`;
  }

  if (name === 'consultar_tabela') {
    return `**Colunas da base** \`${r.tabela}\` (${n(r.total_encontrado)} linhas)\n\n${r.todas_as_colunas.map((c) => `\`${c}\``).join(', ')}\n\n${r.linhas.length ? `Exemplo de linha:\n\n${tabela(['Coluna', 'Valor'], r.todas_as_colunas.map((c) => [c, (r.linhas[0] || [])[r.colunas_retornadas.indexOf(c)] ?? '']))}` : ''}`;
  }
  return 'Pronto.';
}

// ---------- entrada: o laço do servidor chama isto a cada rodada ----------
export async function turnoProdiginho({ messages, onText, usuario = 'alguém', interpretarComIA = null }) {
  const ult = messages[messages.length - 1];
  const blocos = Array.isArray(ult.content) ? ult.content : [{ type: 'text', text: String(ult.content) }];

  // 2ª rodada: as ferramentas já rodaram; é só montar a resposta
  if (blocos.some((b) => b.type === 'tool_result')) {
    const idxAssist = messages.length - 2;
    const usos = (messages[idxAssist]?.content || []).filter((b) => b.type === 'tool_use');
    const resultados = Object.fromEntries(blocos.filter((b) => b.type === 'tool_result').map((b) => {
      let c = b.content; try { c = JSON.parse(c); } catch { c = { erro: String(c) }; }
      return [b.tool_use_id, c];
    }));
    let pedido = '';
    for (let i = idxAssist - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && !(Array.isArray(messages[i].content) && messages[i].content.some((b) => b.type === 'tool_result'))) { pedido = lerUsuario(messages[i].content).texto; break; }
    }
    // busca feita pelas regras que voltou vazia: provavelmente entendi errado; a IA reinterpreta com o contexto da conversa
    if (interpretarComIA && usos.length === 1 && /^p_[0-9a-f]{10}$/.test(usos[0].id) && ['buscar_produtos', 'exportar_consulta'].includes(usos[0].name)) {
      const r0 = resultados[usos[0].id];
      const vazio = r0 && !r0.erro && ((usos[0].name === 'buscar_produtos' && !r0.total_encontrado) || (usos[0].name === 'exportar_consulta' && !r0.linhas));
      if (vazio) {
        const ctx2 = contextoRecente(messages.slice(0, idxAssist));
        const it = await interpretarComIA(pedido, null, ctx2).catch(() => null);
        const igual = it?.chamada && it.chamada.name === usos[0].name && JSON.stringify(it.chamada.input) === JSON.stringify(usos[0].input);
        if (it?.chamada && PERMITIDAS.has(it.chamada.name) && !igual) {
          if (!it.chamada.input.nome_arquivo) it.chamada.input.nome_arquivo = `${it.chamada.name}_${hoje()}`;
          const aviso = `Não achei nada com a minha busca, então pedi ao **${it.nome}** para reinterpretar o pedido: ${rotuloChamada(it.chamada)}.\n\n`;
          onText(aviso);
          return { blocks: [{ type: 'text', text: aviso }, { type: 'tool_use', id: idp('ia_'), name: it.chamada.name, input: it.chamada.input }], usaFerramenta: true, aprender: [{ frase: pedido, chamada: { name: it.chamada.name, input: it.chamada.input } }] };
        }
      }
    }
    const texto = usos.map((u) => compor(u.name, u.input, resultados[u.id], pedido) + (resultados[u.id]?.aviso_atualizacao ? `\n\n*${resultados[u.id].aviso_atualizacao}*` : '')).join('\n\n');
    onText(texto);
    return { blocks: [{ type: 'text', text: texto }], usaFerramenta: false };
  }

  // 1ª rodada: entender o pedido
  const lido = lerUsuario(ult.content);
  const anexos = lido.anexos;
  let texto = lido.texto;
  // resposta a uma pergunta minha ("Qual o tamanho?"): junta com o pedido que ficou pendente
  let mesclado = false;
  {
    const pend = anexos.length ? null : perguntaPendente(messages);
    if (pend) {
      const tx = norm(texto), nPal = tx.split(/\s+/).filter(Boolean).length;
      const novoPedido = /^(buscar|busque|resumo|estoque|saldo|conferir|exportar|ativos|inativos|ensinar|esquecer|o que|oi|ola|ajuda|valor)\b/.test(tx);
      if (!novoPedido && nPal <= 12 && (pend.tipo !== 'tamanho' || lerTamanho(tx))) { texto = `${pend.original} ${lido.texto}`; mesclado = true; }
    }
  }
  const resp = (t) => { onText(t); return { blocks: [{ type: 'text', text: t }], usaFerramenta: false }; };

  // --- ensinar / esquecer / listar o que foi aprendido ---
  const tn = norm(texto);
  let mt;
  if ((mt = texto.match(/^\s*ensin\w*\s*:?\s*["“'‘](.+?)["”'’]\s*=\s*(.+)$/is))) return resp(await ensinar(mt[1].trim(), mt[2].trim(), usuario));
  if ((mt = texto.match(/^\s*ensin\w*\s*:?\s*([^=]+)$/is)) && !/^["“]/.test(mt[1].trim())) {
    const ant = frasePendente(messages);
    if (!ant) return resp('Para ensinar, escreva a frase e o que ela significa: `ensinar: "frase" = pedido que eu já entendo`.');
    return resp(await ensinar(ant, mt[1].trim(), usuario));
  }
  if ((mt = texto.match(/^\s*esquec\w*\s*:?\s*["“'‘](.+?)["”'’]\s*$/is))) {
    const r = await memoria.esquecer(mt[1]);
    return resp(r.ok ? `Pronto, esqueci **${mt[1].trim()}**.${avisoGravacao(r)}` : `Não achei a frase "${mt[1].trim()}" entre as que aprendi. Digite \`o que você aprendeu?\` para ver a lista.`);
  }
  if (/\b(o que (voce )?(nao entendeu|nao sabe|ficou sem resposta)|frases pendentes|duvidas)\b/.test(tn)) return resp(listaDuvidas());
  if (/\b(o que (voce )?(ja )?aprendeu|frases aprendidas|o que (voce )?sabe de novo|o que a ia (te )?(ensinou|interpretou)|revisar (o )?aprendizado)\b/.test(tn)) return resp(await listaAprendida());

  // --- seguimento: só pediu o formato ("me dê o pdf") -> refaz o último pedido nesse formato ---
  {
    const fmtSeg = formatoDe(tn, anexos.length > 0);
    if (fmtSeg && tn && !anexos.length && soFormato(tn)) {
      const ant = ultimoPedido(messages);
      if (!ant) return resp('Não tenho um pedido anterior nesta conversa para gerar em ' + fmtSeg.toUpperCase() + '. Peça a consulta e o formato juntos, por exemplo: `ativos sem NCM em pdf`.');
      const c = paraArquivo(ant, fmtSeg);
      const aviso = `Entendi: refazer o pedido anterior (**${ant.name === 'buscar_produtos' ? 'buscar ' + (ant.input.exibir || ant.input.termo) : ant.name.replace(/_/g, ' ')}**) em **${fmtSeg.toUpperCase()}**.\n\n`;
      onText(aviso);
      return { blocks: [{ type: 'text', text: aviso }, { type: 'tool_use', id: idp(), name: c.name, input: c.input }], usaFerramenta: true };
    }
  }

  // --- ajuste do pedido anterior: "só os ativos", "e na localização C", "agora só com estoque" ---
  {
    const ant = ultimoPedido(messages);
    const ref = ant && !anexos.length ? (excluirDoAnterior(tn, ant) || refinar(tn, ant)) : null;
    if (ref) {
      const aviso = `Entendi: ajustar o pedido anterior (**${ref.rotulo}**).\n\n`;
      onText(aviso);
      return { blocks: [{ type: 'text', text: aviso }, { type: 'tool_use', id: idp(), name: ref.chamada.name, input: ref.chamada.input }], usaFerramenta: true };
    }
  }

  // --- "agora faça da pen gts, 10cm x 15cm": mesmo pedido, outro produto/tamanho ---
  {
    const ant = ultimoPedido(messages);
    const mp = ant && !anexos.length ? mudarProduto(tn, ant) : null;
    if (mp) {
      const aviso = `Entendi: ${mp.rotulo}.\n\n`;
      onText(aviso);
      return { blocks: [{ type: 'text', text: aviso }, { type: 'tool_use', id: idp(), name: mp.chamada.name, input: mp.chamada.input }], usaFerramenta: true };
    }
  }

  // --- entender (o que foi ensinado vale primeiro; "parecida" só se as regras não entenderem) ---
  const re = await memoria.reescrever(texto).catch(() => null);
  const usar = re && re.modo === 'exata' ? re.texto : texto;
  // sinônimos ("rua B" = localização B) e correção de digitação com o vocabulário da base ("estoqe" = estoque)
  let nota = '';
  const gl = aplicarGlossario(usar);
  if (gl.usado) { nota += ` (glossário: "${gl.usado.frase}" = "${gl.usado.pedido}")`; }
  const sin = sinonimos(gl.texto);
  const cor = await corrigir(sin.texto, { ignorar: PARADAS }).catch(() => ({ texto: sin.texto, trocas: [] }));
  const trocas = [...sin.trocas.filter((x) => !/^(pdf|falta|faltam|faltando)/.test(x)), ...cor.trocas];
  const auto = anexos.length ? null : await memoria.chamadaAprendida(texto).catch(() => null);
  ANTERIOR = anexos.length ? null : ultimoPedido(messages);
  let plano = auto ? { entendi: auto.modelo ? `repetir o modelo que aprendi sozinho ("${auto.modelo}") com os seus dados (**${auto.chamada.name.replace(/_/g, ' ')}**)` : `repetir o que aprendi sozinho com "${auto.frase}" (**${auto.chamada.name.replace(/_/g, ' ')}**)`, chamada: auto.chamada, origemAuto: true } : entender(cor.texto, anexos, usar);
  if (trocas.length) nota += ` (entendi ${trocas.slice(0, 4).map((x) => `"${x.replace('→', '" como "')}"`).join(', ')})`;
  if (re && re.modo === 'exata') nota += ` (aprendido: "${re.aprendida}")`;
  if (mesclado) nota += ' (juntei com o seu pedido anterior)';
  // "buscar produtos por <frase solta>": se a maioria das palavras não existe na base, é uma frase que não entendi
  if (!auto && plano.chamada?.name === 'buscar_produtos' && !anexos.length) {
    const ps = String(plano.chamada.input.exibir || plano.chamada.input.termo || '').split(/\s+/).filter(Boolean);
    if (ps.length >= 3 && (await fracaoConhecida(ps).catch(() => 1)) < 0.5) plano = { naoEntendi: true, resposta: DICA_ENSINAR };
  }
  if (plano.naoEntendi && re && re.modo === 'parecida') { plano = entender(re.texto, anexos, re.texto); nota = ` (pelo que aprendi com "${re.aprendida}")`; }
  // ainda não entendi: uma IA só INTERPRETA a frase (1 chamada curta) e eu executo e respondo. Sem cota, sigo sozinho.
  let aprender = null;
  if (plano.naoEntendi && !plano.escalar && !anexos.length && interpretarComIA) {
    const it = await interpretarComIA(texto, ultimoPedido(messages), contextoRecente(messages)).catch(() => null);
    if (it?.chamada && PERMITIDAS.has(it.chamada.name)) {
      if (!it.chamada.input.nome_arquivo) it.chamada.input.nome_arquivo = `${it.chamada.name}_${hoje()}`;
      plano = { entendi: `${rotuloChamada(it.chamada)}`, chamada: it.chamada };
      nota += ` (frase interpretada pelo ${it.nome})`;
      // Só permite aprendizado automático de pedidos autossuficientes, sem referência à conversa anterior.
      const dependente = /\b(esse|essa|isso|aquele|aquela|dele|dela|desses|dessas|anterior|agora|mesmo|mesma|tambem|e os|e as)\b/i.test(texto);
      if (!dependente && !anexos.length && !JSON.stringify(it.chamada.input).includes('arquivo_id')) aprender = [{ frase: texto, chamada: { name: it.chamada.name, input: it.chamada.input } }];
      plano.origemIA = true;
    } else if (it?.resposta) plano = { resposta: it.resposta, interpretada: true };
    else plano.semEscala = true; // nenhuma IA respondeu agora: resolve sozinho (sem pedir ajuda de novo)
  }
  if (plano.naoEntendi) registrarDuvida(texto);
  const t = norm(texto);
  const fmt = formatoDe(t, anexos.length > 0);
  if (plano.chamada && fmt) {
    plano.chamada = paraArquivo(plano.chamada, fmt);
    plano.entendi += ` (arquivo em **${fmt.toUpperCase()}**)`;
  }
  if (plano.resposta) { onText(plano.resposta); return { blocks: [{ type: 'text', text: plano.resposta }], usaFerramenta: false }; }
  const aviso = `Entendi: ${plano.entendi}${nota}.\n\n`;
  onText(aviso);
  return { blocks: [{ type: 'text', text: aviso }, { type: 'tool_use', id: idp(plano.origemIA ? 'ia_' : plano.origemAuto ? 'au_' : ''), name: plano.chamada.name, input: plano.chamada.input }], usaFerramenta: true, ...(aprender ? { aprender } : {}) };
}

const PERMITIDAS = new Set(['buscar_produtos', 'exportar_consulta', 'consultar_tabela', 'gerar_etiquetas', 'gerar_catalogo', 'info_base', 'consulta_estoque', 'cadastros_incompletos', 'conferir_skus', 'resumo_base']);
const rotuloChamada = (c) => `**${c.name.replace(/_/g, ' ')}**${c.input?.formato ? ` (arquivo em ${String(c.input.formato).toUpperCase()})` : ''}`;

// ---------- frases que ele não entendeu (para você revisar e ensinar) ----------
const ARQ_DUVIDAS = () => new URL(`file://${DATA}/duvidas.json`);
function registrarDuvida(texto) {
  try {
    const f = ARQ_DUVIDAS(); let d = {};
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    const k = norm(texto).slice(0, 150); if (!k) return;
    d[k] = { frase: texto.slice(0, 150), vezes: (d[k]?.vezes || 0) + 1, ultima: new Date().toISOString() };
    const chaves = Object.keys(d); if (chaves.length > 300) delete d[chaves.sort((a, b) => d[a].ultima.localeCompare(d[b].ultima))[0]];
    fs.writeFileSync(f, JSON.stringify(d));
  } catch {}
}
function listaDuvidas() {
  let d = {}; try { d = JSON.parse(fs.readFileSync(ARQ_DUVIDAS(), 'utf8')); } catch {}
  const l = Object.values(d).sort((a, b) => b.vezes - a.vezes).slice(0, 30);
  if (!l.length) return 'Não tenho nenhuma frase pendente: tudo o que me pediram eu entendi (ou ainda ninguém perguntou algo que eu não soubesse).';
  return `**Frases que eu não entendi** (mais repetidas primeiro)\n\n${tabela(['Frase', 'Vezes'], l.map((x) => [x.frase, x.vezes]))}\n\nPara ensinar uma: \`ensinar: "frase" = pedido que eu já entendo\`. Esta lista fica na memória do servidor e some quando o Render reinicia.`;
}

// ---------- conversa: "agora em pdf", "me dê o pdf" reaproveitam o pedido anterior ----------
const FERRAMENTAS_ARQUIVO = ['exportar_consulta', 'conferir_skus', 'cadastros_incompletos', 'consulta_estoque'];
const formatoDe = (t, temAnexo) => (/\bpdf\b/.test(t) ? 'pdf' : /\bcsv\b/.test(t) && !temAnexo ? 'csv' : /\b(xlsx|excel|planilha)\b/.test(t) ? 'xlsx' : null);

function paraArquivo(chamada, fmt) {
  const c = { name: chamada.name, input: JSON.parse(JSON.stringify(chamada.input)) };
  if (c.name === 'buscar_produtos') {
    return { name: 'exportar_consulta', input: { nome_arquivo: `produtos_${hojeISO()}`, filtros: String(c.input.termo || '').split(' ').filter(Boolean).map((x) => ({ coluna: 'nome', operador: 'contem', valor: x })), colunas: ['id', 'codigo', 'nome', 'localizacao', 'situacao'], amostra_linhas: 15, formato: fmt } };
  }
  if (FERRAMENTAS_ARQUIVO.includes(c.name)) c.input.formato = fmt;
  // etiquetas têm formato próprio (PDF/ZIP/PNG): "em pdf" não muda nada
  return c;
}

// último pedido que o Prodiginho executou nesta conversa (ignora o turno atual)
let ANTERIOR = null; // pedido anterior da conversa, lido pelo entender() (atribuído logo antes dele, sem await no meio)

// filtros equivalentes ao pedido anterior (para reaproveitar em etiquetas, ajustes etc.)
function filtrosDoAnterior(ant) {
  if (!ant) return null;
  if (Array.isArray(ant.input?.filtros)) return JSON.parse(JSON.stringify(ant.input.filtros));
  if (ant.name === 'buscar_produtos' && ant.input?.termo) return String(ant.input.termo).split(/\s+/).filter(Boolean).map((x) => ({ coluna: 'nome', operador: 'contem', valor: x }));
  return null;
}

// "tire desse pdf os produtos sem sku e com sku menor que 12": remove linhas do pedido anterior e refaz no mesmo formato
function excluirDoAnterior(tn, ant) {
  if (!/^(tire|tira|retire|remova|remove|exclua|exclui|elimine|desconsidere|tirar|remover|excluir)\b/.test(tn)) return null;
  if (!(ant.name === 'buscar_produtos' || ant.name === 'cadastros_incompletos' || ant.name === 'exportar_consulta' || ant.name === 'consulta_estoque')) return null;
  const manter = [], rot = [];
  if (/\bsem\s+(sku|codigo)\b/.test(tn)) { manter.push({ coluna: 'codigo', operador: 'preenchido' }); rot.push('sem SKU'); }
  const mn = tn.match(/\b(sku|codigo)\b[^0-9]*?\b(menor|menos|abaixo|inferior|ate)\b[^0-9]*?(\d{1,3})/);
  if (mn) { manter.push({ coluna: 'codigo', operador: 'tamanho_maior_igual', valor: mn[3] }); rot.push(`SKU com menos de ${mn[3]} dígitos`); }
  const mx = tn.match(/\b(sku|codigo)\b[^0-9]*?\b(maior|mais|acima|superior)\b[^0-9]*?(\d{1,3})/);
  if (mx) { manter.push({ coluna: 'codigo', operador: 'tamanho_menor', valor: String(Number(mx[3]) + 1) }); rot.push(`SKU com mais de ${mx[3]} dígitos`); }
  for (const [re, col, nome] of [[/\bsem\s+ncm\b/, 'ncm', 'sem NCM'], [/\bsem\s+gtin\b/, 'gtin', 'sem GTIN']]) if (re.test(tn) && ant.name !== 'cadastros_incompletos') { manter.push({ coluna: col, operador: 'preenchido' }); rot.push(nome); }
  if (/\binativos?\b/.test(tn)) { manter.push({ coluna: 'situacao', operador: 'igual', valor: 'A' }); rot.push('inativos'); }
  if (!manter.length) return null;
  const c = ant.name === 'buscar_produtos'
    ? { name: 'exportar_consulta', input: { nome_arquivo: `produtos_${hojeISO()}`, filtros: filtrosDoAnterior(ant) || [], colunas: ['id', 'codigo', 'nome', 'localizacao', 'situacao'], amostra_linhas: 15 } }
    : { name: ant.name, input: JSON.parse(JSON.stringify(ant.input)) };
  c.input.filtros = [...(c.input.filtros || []), ...manter];
  return { chamada: c, rotulo: `removendo ${rot.join(' e ')}` };
}

// ajustes curtos sobre o pedido anterior
function refinar(tn, ant) {
  const palavras = tn.split(/[^a-z0-9]+/).filter(Boolean);
  if (!palavras.length || palavras.length > 7 || !/^(e|so|somente|apenas|agora|mas|filtra|filtrar|tira|tire)\b/.test(tn)) return null;
  const livres = new Set('e so somente apenas agora mas filtra filtrar tira tire ativos ativo inativos inativo rua corredor prateleira setor bloco localizacao estoque sem com zerado zerados zerada tem em produtos produto'.split(' '));
  const lm = tn.match(LOC_RE) || tn.match(/\b(?:rua|corredor|prateleira|setor|bloco)\s+([a-z0-9][a-z0-9._-]*)/);
  const valorLoc = lm ? lm[lm.length - 1] : null;
  if (palavras.some((w) => !PARADAS.has(w) && !livres.has(w) && w !== valorLoc)) return null; // tem assunto novo: não é só um ajuste
  const copia = () => JSON.parse(JSON.stringify(ant.input));
  const comoExportar = () => (ant.name === 'buscar_produtos'
    ? { name: 'exportar_consulta', input: { nome_arquivo: `produtos_${hojeISO()}`, filtros: filtrosDoAnterior(ant) || [], colunas: ['id', 'codigo', 'nome', 'localizacao', 'situacao'], amostra_linhas: 15 } }
    : { name: ant.name, input: copia() });
  const sit = tn.match(/\b(inativos?|ativos?)\b/);
  const loc = tn.match(LOC_RE) || tn.match(/\b(?:rua|corredor|prateleira|setor|bloco)\s+([a-z0-9][a-z0-9._-]*)/);
  const est = /\b(sem estoque|zerad\w*)\b/.test(tn) ? 'menor_igual' : /\b(com estoque|em estoque|tem estoque)\b/.test(tn) ? 'maior' : null;
  if (sit && !loc) {
    const v = sit[1].startsWith('in') ? 'I' : 'A';
    if (ant.name === 'cadastros_incompletos') { const c = { name: ant.name, input: copia() }; c.input.situacao = v; return { chamada: c, rotulo: `só ${v === 'A' ? 'ativos' : 'inativos'}` }; }
    if (ant.name === 'buscar_produtos' || Array.isArray(ant.input?.filtros)) {
      const c = comoExportar(); c.input.filtros = (c.input.filtros || []).filter((f) => f.coluna !== 'situacao'); c.input.filtros.push({ coluna: 'situacao', operador: 'igual', valor: v });
      return { chamada: c, rotulo: `só ${v === 'A' ? 'ativos' : 'inativos'}` };
    }
  }
  if (loc && (ant.name === 'buscar_produtos' || Array.isArray(ant.input?.filtros))) {
    const valor = loc[loc.length - 1];
    if (valor && !NAO_LOC.has(valor)) {
      const c = comoExportar(); c.input.filtros = (c.input.filtros || []).filter((f) => f.coluna !== 'localizacao'); c.input.filtros.push({ coluna: 'localizacao', operador: 'comeca', valor });
      return { chamada: c, rotulo: `localização começando com ${valor.toUpperCase()}` };
    }
  }
  if (est && ant.name === 'consulta_estoque') { const c = { name: ant.name, input: copia() }; c.input.saldo = { operador: est, valor: '0' }; return { chamada: c, rotulo: est === 'maior' ? 'só com estoque' : 'só sem estoque' }; }
  return null;
}

// resumo curto das últimas mensagens, para a IA interpretadora entender respostas curtas e continuações
function contextoRecente(messages, max = 6) {
  const linhas = [];
  for (const m of messages.slice(0, -1)) {
    const blocos = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    if (blocos.some((b) => b.type === 'tool_result')) continue;
    const txt = blocos.filter((b) => b.type === 'text').map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim();
    const usos = blocos.filter((b) => b.type === 'tool_use').map((b) => `[${b.name} ${JSON.stringify(b.input).slice(0, 200)}]`).join(' ');
    if (m.role === 'user') { if (txt) linhas.push(`Usuário: ${txt.slice(0, 220)}`); }
    else linhas.push(`Prodiginho: ${txt.slice(0, 220)} ${usos}`.trim());
  }
  return linhas.slice(-max).join('\n');
}

// o Prodiginho perguntou o tamanho / os produtos das etiquetas e a mensagem atual é a resposta
function perguntaPendente(messages) {
  const m = messages[messages.length - 2];
  if (!m || m.role !== 'assistant') return null;
  const blocos = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
  if (blocos.some((b) => b.type === 'tool_use')) return null;
  const txt = blocos.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  const tipo = /Qual o \*\*tamanho\*\*/.test(txt) ? 'tamanho' : /De quais produtos são as etiquetas/.test(txt) ? 'produtos' : null;
  if (!tipo) return null;
  for (let j = messages.length - 3; j >= 0; j--) {
    const u = messages[j];
    if (u.role === 'user' && !(Array.isArray(u.content) && u.content.some((b) => b.type === 'tool_result'))) return { tipo, original: lerUsuario(u.content).texto };
  }
  return null;
}

// "agora faça da pen gts, 10cm x 15cm": repete o pedido anterior trocando o produto (e o tamanho, se vier outro)
function mudarProduto(tn, ant) {
  if (!ant || !/^(agora|tambem|e|o mesmo|mesma coisa|faca|faz|gere|gera|repete|repita)\b/.test(tn)) return null;
  if (!['gerar_etiquetas', 'buscar_produtos', 'exportar_consulta', 'consulta_estoque', 'cadastros_incompletos'].includes(ant.name)) return null;
  const termos = termosDe(tirarMedidas(tn)).filter((x) => !GENERICAS_ET.test(x));
  if (!termos.length || termos.length > 6) return null;
  const tam = lerTamanho(tn);
  const nomeF = termos.map((x) => ({ coluna: 'nome', operador: 'contem', valor: alt(x) }));
  const c = { name: ant.name, input: JSON.parse(JSON.stringify(ant.input)) };
  if (ant.name === 'buscar_produtos') { c.input.termo = termos.map(alt).join(' '); c.input.exibir = termos.join(' '); }
  else {
    const mantem = (c.input.filtros || []).filter((f) => f.coluna === 'situacao');
    c.input.filtros = [...mantem, ...nomeF];
    if (ant.name === 'gerar_etiquetas') {
      delete c.input.skus; delete c.input.itens; delete c.input.arquivo_id;
      if (!mantem.length && !/\binativ/.test(tn)) c.input.filtros.push({ coluna: 'situacao', operador: 'igual', valor: 'A' });
      if (tam && tam.largura >= 20 && tam.largura <= 300 && tam.altura >= 15 && tam.altura <= 300) { c.input.largura_mm = tam.largura; c.input.altura_mm = tam.altura; }
    }
  }
  const tipo = { gerar_etiquetas: 'etiquetas', buscar_produtos: 'busca', exportar_consulta: 'lista', consulta_estoque: 'estoque', cadastros_incompletos: 'cadastros incompletos' }[ant.name];
  return { chamada: c, rotulo: `repetir o pedido de ${tipo} para **${fmtT(termos)}**${tam && ant.name === 'gerar_etiquetas' ? `, tamanho ${tam.largura} x ${tam.altura} mm` : ''}` };
}

// a mensagem anterior do usuário não deu certo ("não entendi" / "não encontrei") e esta é uma nova tentativa parecida
function fraseFalhaAnterior(messages, texto) {
  const m = messages[messages.length - 2];
  if (!m || m.role !== 'assistant') return null;
  const blocos = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
  const txt = blocos.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  if (!/Não entendi esse pedido|Não encontrei nada para|Não encontrei nenhum produto/.test(txt)) return null;
  let ant = null;
  for (let j = messages.length - 3; j >= 0; j--) { const u = messages[j]; if (u.role === 'user' && !(Array.isArray(u.content) && u.content.some((b) => b.type === 'tool_result'))) { ant = lerUsuario(u.content).texto; break; } }
  if (!ant || norm(ant) === norm(texto)) return null;
  const toks = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !PARADAS.has(x)));
  const a = toks(ant), b = toks(texto);
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter >= 2 && inter / (a.size + b.size - inter || 1) >= 0.3 ? ant : null;
}

function ultimoPedido(messages) {
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const uso = m.content.find((b) => b.type === 'tool_use' && (FERRAMENTAS_ARQUIVO.includes(b.name) || b.name === 'buscar_produtos' || b.name === 'gerar_etiquetas'));
    if (uso) return { name: uso.name, input: uso.input };
  }
  return null;
}

// a mensagem só fala do formato? ("pdf", "me dê o pdf", "agora em csv", "manda em excel")
function soFormato(t) {
  const resto = t.split(/[^a-z0-9]+/).filter((x) => x && !PARADAS.has(x) && !/^(pdf|csv|xlsx|excel|planilha|agora|agr|agra|ja|ta|pra|vc|pf|pfv|favor|manda|mande|envia|envie|gera|gere|gerar|quero|queria|isso|isto|esse|essa|mesmo|mesma|tambem|novamente|ai|la|aqui|dai|entao|so|apenas|formato|arquivo|dele|dela|disso|desse|dessa)$/.test(x));
  return resto.length === 0;
}

// ---------- aprendizado ----------
const avisoGravacao = (r) => (r.gravadoNoGitHub ? '' : '\n\n⚠️ Guardei só na memória deste servidor: no Render grátis isso some quando ele reinicia. Para guardar de forma permanente, configure `GITHUB_TOKEN_ESCRITA` (veja o README).');

// a frase que o Prodiginho não entendeu na rodada anterior (para "ensinar: <pedido>")
function frasePendente(messages) {
  const user = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  for (let i = messages.length - 2; i >= 1; i--) {
    if (!user(messages[i])) continue;
    const resposta = JSON.stringify(messages[i + 1]?.content || '');
    const f = lerUsuario(messages[i].content).texto;
    return /Não entendi esse pedido/.test(resposta) && f ? f : null;
  }
  return null;
}

async function ensinar(frase, pedido, usuario) {
  const nf = norm(frase);
  if (nf.length < 3 || nf.length > 120) return 'A frase precisa ter entre 3 e 120 caracteres.';
  if (/^[\d\s,;.-]+$/.test(nf)) return 'Não aprendo frases que são só números (SKUs). Escreva uma frase com palavras.';
  if (/^ensin|^esquec/.test(nf)) return 'Essa frase é um comando meu; escolha outra.';
  if (pedido.length > 200) return 'O pedido está longo demais (máximo 200 caracteres).';
  const teste = entender(pedido, [], pedido);
  if (!teste.chamada) return `Não consegui entender "${pedido}" como um pedido que eu sei fazer, então não guardei. Teste esse pedido sozinho primeiro; quando eu responder direito, use-o aqui.`;
  const r = await memoria.ensinar(frase, pedido, usuario);
  if (r.erro) return r.erro;
  return `${r.atualizada ? 'Atualizei' : 'Aprendi'}: sempre que alguém escrever **"${frase}"**, eu vou entender como **${teste.entendi}**.${avisoGravacao(r)}`;
}

function resumoChamada(i) {
  const c = i.chamada || {}; const f = (c.input?.filtros || []).map((x) => `${x.coluna} ${x.operador}${x.valor ? ' ' + String(x.valor).split('|')[0] : ''}`).join(', ');
  return `${String(c.name || '').replace(/_/g, ' ')}${f ? ` (${f})` : ''}${i.modelo ? ` — modelo: "${i.modelo.texto}"` : ''}`;
}
async function listaAprendida() {
  await memoria.carregar(true);
  const l = memoria.listar(), e = memoria.estado();
  if (!l.length) return 'Ainda não aprendi nenhuma frase. Eu aprendo sozinho quando o Claude, o Gemini ou o Groq resolvem um pedido que eu não entendi; você também pode ensinar com `ensinar: "frase" = pedido que eu já entendo`.';
  return `**O que eu aprendi** (${l.length})\n\n${tabela(['Frase', 'Significa', 'Como aprendeu', 'Usos'], l.slice(0, 50).map((i) => [i.frase, i.pedido || resumoChamada(i), i.auto ? 'sozinho' : `ensinado por ${i.por}`, i.usos]))}${l.length > 50 ? `\n\n*Mostrando 50 de ${l.length}.*` : ''}\n\nMemória guardada em: ${e.fonte === 'github' ? 'GitHub (permanente)' : 'disco do servidor (some ao reiniciar no Render grátis)'}.${e.erro ? `\n\n⚠️ Último erro ao falar com o GitHub: ${e.erro}` : ''}`;
}

// Usado pelo script scripts/testar-frases.mjs: mostra como uma frase seria entendida, sem executar nada.
export async function interpretar(texto) {
  const gl = aplicarGlossario(texto);
  const sin = sinonimos(gl.texto);
  const cor = await corrigir(sin.texto, { ignorar: PARADAS }).catch(() => ({ texto: sin.texto, trocas: [] }));
  const plano = entender(cor.texto, [], texto);
  return { trocas: [...(gl.usado ? [`${gl.usado.frase}→${gl.usado.pedido}`] : []), ...sin.trocas, ...cor.trocas], entendi: plano.entendi || null, ferramenta: plano.chamada?.name || null, input: plano.chamada?.input || null, naoEntendi: !!plano.naoEntendi, resposta: plano.resposta ? 'resposta direta' : null };
}
