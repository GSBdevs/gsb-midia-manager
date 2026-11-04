# SB Signage — Plano de escala multiusuário (SaaS multi-cliente)

> Elaborado em 2026-11-04 a partir do código da versão 2.0 e de pesquisa de mercado.
> Complementa o `PLANO-TECNICO.md` (fases 2 e 3). Estimativas consideram 1–2 devs.

## 1. Objetivo

Vender o SB Signage para vários clientes ao mesmo tempo, cada um com **seu próprio ambiente
personalizado** (marca, usuários, telas, conteúdo, regras), e a **GrupoSB administrando todos
eles** a partir de um console central.

### Modelo em três níveis

```
Plataforma (GrupoSB)          ← console central: clientes, planos, uso, suporte, faturamento
 └─ Parceiro/revenda (opcional) ← vende e dá suporte a vários clientes com a própria marca
     └─ Cliente (organização)   ← ambiente próprio: marca, domínio, usuários, telas, conteúdo
         └─ Usuários com papel  ← dono · administrador · editor · leitor (por cliente)
             └─ Locais / grupos de telas (permissão pode ser limitada a eles)
```

O nível "parceiro" é opcional, mas vale prever no banco desde o início. Revenda com marca
própria é o canal mais comum de venda de signage, e o mercado vende "white-label" como
recurso de plano superior.

## 2. O que muda em relação à versão atual

| Área | Hoje (2.0) | Para escala | Por quê |
|---|---|---|---|
| Acesso | 1 senha de administrador | Usuários com e-mail, papéis por cliente, convites, MFA | Vários clientes e várias pessoas por cliente |
| Dados | `data.json` em disco | **PostgreSQL** com `org_id` em tudo + Row-Level Security | Concorrência, consultas, isolamento entre clientes |
| Mídia | Disco do servidor | **Cloudflare R2** (S3) + CDN | Disco do servidor não escala; R2 não cobra saída de dados |
| Processamento | Fila no mesmo processo | **Workers separados** (BullMQ + Redis) | Upload pesado de um cliente não pode travar os outros |
| Tempo real | 1 processo, salas globais | Socket.IO com **adapter Redis**, sala por cliente | Mais de uma instância de servidor; um cliente não recebe eventos de outro |
| Marca | Global (1 por instalação) | **Por cliente** + domínio próprio (`telas.cliente.com.br`) | "Cenário próprio customizável" |
| Limites | Nenhum | **Cotas por plano** (telas, GB, usuários, recursos) | Base da cobrança |
| Cobrança | — | Assinatura por tela/mês (Pix Automático, boleto, cartão) | Receita recorrente |
| Auditoria | — | Registro de quem fez o quê, inclusive acessos da GrupoSB | Confiança do cliente, LGPD, suporte |
| Operação | Logs no terminal | Métricas, alertas de frota, backups com restauração pontual | Operar sem "babá" |

**O que não muda (e é a base certa para escalar):**
- O **protocolo do player**: manifesto versionado, ETag e push só como aviso.
- O **pareamento por código**.
- As **regras de domínio** (`server/domain/manifest.js`, funções puras e testadas).
- A **separação** entre credencial de usuário e credencial de tela.
- O **perfil fixo de mídia**.

O player atual funciona sem alteração, só passando a receber um manifesto escopado ao cliente.

## 3. Arquitetura-alvo

```
                 ┌──────────────── Cloudflare ────────────────┐
 TVs / players ─▶│ CDN + R2 (mídia)   ·   domínios dos clientes │
 Painéis       ─▶│ (Cloudflare for SaaS: telas.cliente.com.br)  │
                 └──────────────┬──────────────────────────────┘
                                ▼
                    API Node (2+ instâncias, sem estado)
                    · auth (usuários, papéis, sessões)
                    · rotas atuais, escopadas por org_id
                    · Socket.IO + adapter Redis
                       │                 │
              PostgreSQL (RLS)        Redis ── BullMQ ──▶ Workers FFmpeg (escala por fila)
              · org, usuários,                               │
                telas, mídia, ...                            ▼
              · proof-of-play                           R2 (processados)
                (particionado por mês)

 Console central (GrupoSB) ── mesma API, rotas /platform/* exigem papel de plataforma
```

## 4. Decisões recomendadas

### 4.1 Evoluir o código atual, não reescrever
O `PLANO-TECNICO.md` previa NestJS + Next.js. A versão 2.0 já está modular, com rotas por
assunto, domínio puro e 43 testes. **Recomendo evoluir esta base** (Express + uma camada de
banco) em vez de reescrever. Uma reescrita custa semanas e reabre bugs já resolvidos, como os
de fuso horário, de vídeo vertical e do player. Adotar TypeScript gradualmente (`checkJs` →
`.ts`) dá a segurança de tipos do plano sem parar o produto.

### 4.2 Isolamento entre clientes: banco compartilhado + Row-Level Security
- Toda tabela de negócio leva `org_id`. Uma **política RLS no PostgreSQL** impede, no próprio
  banco, que a consulta de um cliente leia dados de outro, mesmo se a aplicação errar um filtro.
- A conexão define `SET app.org_id = …` por requisição.
- Um cliente grande que exija isolamento físico pode ganhar banco próprio depois, sem mudar o
  código.
- **ORM:** Drizzle, mais leve e próximo do SQL. Isso facilita escrever as políticas RLS.

### 4.3 Autenticação: Better Auth (auto-hospedado)
- Biblioteca de autenticação **auto-hospedada**, com plugin de *organizations* para membros,
  convites e papéis (dono, administrador, membro) e papéis customizados por permissão.
- Os dados ficam **no seu Postgres**, sem custo por usuário ativo. Isso simplifica a LGPD, já que
  não há mais um operador de dados de login.
- **Alternativas:** Clerk (hospedado, pago por usuário ativo, mais rápido de integrar) e
  Supabase Auth (só compensa se adotar Supabase também como banco).
- **Antes de fechar:** confirme os detalhes do plugin na documentação oficial; parte do que
  encontrei vem de guias de terceiros.

### 4.4 Domínio próprio por cliente: Cloudflare for SaaS
- O cliente aponta `telas.cliente.com.br` para a plataforma e o certificado HTTPS é emitido
  automaticamente.
- **Custo:** os primeiros **100 domínios são incluídos** nos planos self-service; depois,
  **US$ 0,10 por domínio/mês**, até 50 mil.
- O mesmo arranjo resolve o HTTPS dos players, o que libera armazenamento persistente e Wake
  Lock.

### 4.5 Cobrança no Brasil: Asaas (ou iugu)
- Assinatura por tela/mês com **Pix Automático**, boleto e cartão.
- O **Asaas** expõe Pix Automático por API, inclusive com criação automática das cobranças da
  assinatura (`paymentCreationMode: SUBSCRIPTION`, desde maio/2026). Exige CNPJ aprovado.
- A **iugu** oferece o mesmo via assinaturas com Pix automático e eventos por webhook.
- Para clientes no exterior, Stripe.
- **Regra de produto:** cliente inadimplente tem o **painel bloqueado, mas as telas continuam
  exibindo** a última programação durante um período de carência. Tela preta por cobrança gera
  conflito e churn.

### 4.6 Mídia e entrega
- **R2** para original e processado, servido por CDN com URL imutável (já é o modelo atual: hash
  no nome).
- Entre clientes, URLs **assinadas com validade** ou um prefixo por cliente com token. Hoje a
  URL só é imprevisível, não secreta.
- **Transcodificação em workers separados**, escalados pela profundidade da fila e com limite
  de concorrência por cliente.

### 4.7 Docker e PostgreSQL: agora sim
Nesta fase os dois deixam de ser opcionais:
- **PostgreSQL gerenciado** (Neon, Supabase, RDS) com backup e restauração para um ponto no
  tempo.
- **Redis** gerenciado (Upstash) para fila e tempo real.
- **Containers:** API e workers, com o Dockerfile atual como ponto de partida.
- **Desenvolvimento local:** `docker compose` com Postgres, Redis e MinIO (S3 local).

## 5. Console central da GrupoSB (o "menu da empresa desenvolvedora")

| Módulo | O que faz |
|---|---|
| Clientes | Criar, editar, suspender e reativar; plano, limites e data de contrato |
| Uso | Telas ativas, armazenamento, exibições, banda — por cliente e no total |
| Saúde da frota | % de telas offline por cliente, versões de player, telas com falha de cache |
| Faturamento | Situação de cada assinatura, inadimplência, histórico |
| Acesso de suporte | "Entrar como" o cliente **com registro em auditoria** e aviso no painel do cliente |
| Planos e recursos | Quais recursos cada plano libera (HLS, relatórios, domínio próprio, API, marca) |
| Comunicados | Aviso no painel de todos os clientes (manutenção, novidades) |
| Parceiros | Revendas e os clientes de cada uma (se adotar o modelo de revenda) |

### No painel de cada cliente (sobre o que já existe)
- **Usuários e papéis**, com convite por e-mail. Editor pode ser limitado a certos locais ou
  grupos de telas.
- **Fluxo de aprovação:** o editor monta a playlist e o aprovador publica. É exigido por
  redes com agência de publicidade.
- **Validade de conteúdo:** mídia ou item de playlist com data de início e fim, para que a
  campanha saia do ar sozinha. É o recurso mais pedido por quem vende espaço publicitário.
- **Marca e domínio próprios**, já iniciados na v2.0 em Configurações → Aparência.
- **Relatório de exibição por anunciante**, a partir do proof-of-play já existente.
- **Auditoria:** quem alterou o quê e quando.

## 6. Segurança e LGPD na escala

- **Acesso:** MFA para administradores; SSO (Google ou Microsoft) no plano empresarial.
- **Limites de uso por cliente:** chamadas de API e upload, além dos limites por IP que já
  existem.
- **LGPD:** a GrupoSB passa a ser **operadora** dos dados de cada cliente. Isso exige:
  - contrato de tratamento de dados (DPA) no contrato padrão;
  - lista de suboperadores (Cloudflare, hospedagem, banco, gateway de pagamento);
  - exportação e exclusão completa dos dados ao fim do contrato.

  Ver `CLAUDE/juridico/REGRAS-PRIVACIDADE-E-VENDA.md`.
- **Backups:** testados periodicamente com restauração real, não só agendados.
- **Isolamento:** testes automatizados que tentam ler dados de outro cliente e precisam falhar.
  É o teste mais importante de um SaaS multi-cliente.

## 7. Roteiro em fases

| Fase | Entrega | Estimativa |
|---|---|---|
| **A. Multiusuário** | Postgres + Drizzle + RLS; `org_id` em tudo; Better Auth (usuários, convites, papéis); importador do `data.json` atual; login por usuário | 3–4 semanas |
| **B. Infra de escala** | R2 + CDN; workers de transcodificação com BullMQ/Redis; Socket.IO com Redis; deploy em containers com 2+ instâncias; métricas e alertas | 3–4 semanas |
| **C. Console central** | Clientes, planos/limites, uso, saúde da frota, suspensão, "entrar como" com auditoria | 2–3 semanas |
| **D. Venda** | Assinatura com Asaas/iugu, carência na inadimplência, domínio próprio por cliente, e-mails com a marca do cliente | 2–3 semanas |
| **E. Contínuo** | Aprovação de conteúdo, validade de campanha, SSO/MFA, revenda, player Android em produção, atualização remota de players | contínuo |

**Pré-requisito antes da Fase A:** colocar o projeto sob controle de versão (git) com CI
rodando `npm test` em cada mudança.

## 8. Custos e preço (indicativos — confirmar antes de orçar)

- **Infra para começar** (até ~50 clientes / ~500 telas): uma API pequena em PaaS, Postgres e
  Redis gerenciados nos planos iniciais e R2. Na prática, dezenas de dólares por mês. O custo
  cresce com armazenamento de vídeo e processamento, não com o número de telas, porque a
  entrega via R2 e CDN não cobra saída de dados.
- **Mercado:** o preço publicado fica tipicamente entre **US$ 5 e 25 por tela/mês**, com desconto
  por volume. Revendas trabalham com margem de 30–60%, e marca própria costuma ser cobrada à
  parte ou ficar restrita a planos superiores.
- **Sugestão de pacotes** a validar com o comercial:
  - **Básico:** por tela, sem marca própria.
  - **Profissional:** relatórios, agenda avançada e HLS.
  - **Empresarial/Revenda:** marca e domínio próprios, SSO, API e suporte prioritário.

## Fontes

- [Cloudflare for SaaS — planos e preço por domínio](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)
- [Asaas — Pix Automático (documentação)](https://docs.asaas.com/docs/pix-automatico) · [changelog](https://docs.asaas.com/changelog/pix-automático-cobranças-recorrentes-automatizadas)
- [iugu — cobranças recorrentes com Pix Automático](https://dev.iugu.com/docs/cobranças-recorrentes-por-api-pix-automático)
- [Better Auth — plugin de organizações (guia de terceiros; confirmar na documentação oficial)](https://better-auth-ui.com/docs/shadcn/plugins/organization)
- Mercado de white-label/revenda e preço por tela: [fitgap](https://us.fitgap.com/search/digital-signage-software/white-label?page=1), [Juuno](https://juuno.co/digital-signage/white-label-digital-signage), [Look DS (Techloy)](https://www.techloy.com/look-digital-signage-review-2026.md), [NoviSign (Digital Signage Today)](https://www.digitalsignagetoday.com/press-releases/how-novisign-partners-are-building-recurring-revenue-with-digital-signage/), [comparativo Crown TV](https://www.crowntv-us.com/blog/screencloud-vs-optisigns-vs-yodeck/)
