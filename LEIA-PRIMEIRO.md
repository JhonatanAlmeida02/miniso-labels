# Prodiginho V3 — Sync Produtos sob demanda com limite de 30 minutos

## Instalação

1. Faça backup dos arquivos atuais.
2. Substitua `actions.js` e `server.js` da versão V2 pelos correspondentes deste pacote. `ai.js` e `prodiginho.js` da V2 são incluídos para facilitar uma instalação completa.
3. Copie as opções de `.env.example` para seu `.env` (não sobrescreva suas chaves).
4. Configure `GITHUB_TOKEN_ACTIONS` com acesso ao repositório `tiny-erp`, permissão Actions: Read and write; o workflow Sync Produtos deve aceitar `workflow_dispatch`.
5. Faça deploy e teste a primeira consulta a um produto.

## O que acontece

- Em uma consulta que usa as bases, o Prodiginho verifica o histórico do workflow `Sync Produtos` no GitHub.
- Se a **última execução concluída com sucesso** terminou há **até 30 minutos**, não dispara nada.
- Se terminou há **mais de 30 minutos**, dispara **somente `Sync Produtos`** e aguarda o término (até `ACTION_TIMEOUT_S`, 180 s por padrão). Em seguida, busca o novo CSV de produtos diretamente da API GitHub.
- Se já existe uma execução na fila/em andamento, evita disparo duplicado e usa a base disponível.
- Se a API falha, o Prodiginho pode continuar com o cache e avisa sobre a falha.
- Várias consultas simultâneas compartilham a mesma checagem; o histórico é rechecado no máximo a cada 30 s (configurável).
- Tentativas de sync têm intervalo mínimo de 2 min para evitar disparos em loop em caso de falha.
- A rotina de **Sync Estoque não é disparada** por essa nova regra; continua com seu agendamento de 15 minutos.

## Configuração

```env
GITHUB_TOKEN_ACTIONS=seu_token_aqui
PRODIGINHO_SYNC_PRODUTOS=1
PRODIGINHO_PRODUTOS_MIN=30
PRODIGINHO_WORKFLOW_PRODUTOS=Sync Produtos
PRODIGINHO_CHECK_MS=30000
PRODIGINHO_RETRY_MS=120000
```

> `PRODIGINHO_SYNC_AO_PERGUNTAR` da V2 não é mais usado pelo Prodiginho. Para desligar a nova checagem, use `PRODIGINHO_SYNC_PRODUTOS=0`.

## Importante

O workflow de produtos deve de fato atualizar a base no GitHub. Se o GitHub Actions estiver indisponível ou sem permissões, a consulta informa que está usando a última base. Os testes estáticos de sintaxe não substituem um teste real com suas permissões e workflows.
