# HelpInk

App para tatuadores gerenciarem clientes, sessões, custos e estoque — publicado
inteiramente na **Cloudflare**, no plano gratuito:

| Peça | Serviço Cloudflare | Limite grátis (aprox.) |
|---|---|---|
| Site + API | **Workers** (com arquivos estáticos) | 100 mil requisições/dia |
| Banco de dados | **D1** (SQLite) | 5 GB, 100 mil gravações/dia |
| Login | **Cloudflare Access** (Zero Trust) | até 50 usuários |

O login é feito pelo Cloudflare Access **antes** de o site abrir: a pessoa digita o
e-mail, recebe um código (PIN) e entra. Não há senha para guardar.

## Contas e aprovação

Qualquer pessoa pode criar uma conta, mas só usa o app depois que um administrador aprova:

1. A pessoa abre o site, informa o e-mail e digita o código que recebe.
2. Na primeira vez, o HelpInk pede nome, nome do estúdio e telefone → **Pedir acesso**.
3. Ela vê "Cadastro enviado" até ser aprovada. Antes disso a API recusa qualquer dado.
4. O administrador vê os pedidos na aba **Usuários** (com o número de pendentes) e clica em
   **Aprovar** ou **Recusar**. Usuários aprovados podem ser **bloqueados** depois; pedidos
   recusados podem ser **removidos** (a pessoa pode pedir de novo).

Os administradores são definidos no segredo `ADMIN_EMAILS` do Worker
(**Workers & Pages → helpink → Settings → Variables and secrets**), separados por vírgula.
Eles são aprovados automaticamente. O segredo não fica no GitHub.

Cada e-mail que entra pelo Access ocupa uma das 50 vagas do plano Free, mesmo antes de ser
aprovado. Para liberar vagas de quem foi recusado, remova a pessoa também em
**Zero Trust → Users**.

## Estrutura

```
src/worker.js              API /api/* + verificação do login do Access + aprovação de contas
migrations/0001_init.sql   tabela de dados (records)
migrations/0002_users.sql  tabela de contas (users)
migrations/0003_forms.sql  fichas de anamnese assinadas (forms)
migrations/0004_sessao_agenda.sql  ficha por sessão e link da agenda do cliente
public/assinar/agenda/     página pública da agenda do cliente
public/index.html          página inicial pública (funcionalidades + botão Entrar)
public/app/index.html      o app (exige login)
public/assinar/index.html  página pública da ficha para o cliente
wrangler.jsonc             configuração do Worker (banco, Access)
```

## Passo a passo da publicação

Tudo pode ser feito pelo painel da Cloudflare (<https://dash.cloudflare.com>), sem instalar nada.

### 1. Criar o banco D1

1. **Storage & Databases → D1 SQL Database → Create**, nome `helpink`.
2. Copie o **Database ID** e cole em `wrangler.jsonc` no campo `database_id`.
3. Abra o banco → aba **Console**, cole e execute o conteúdo de `migrations/0001_init.sql` e depois os de `migrations/0002_users.sql` , `migrations/0003_forms.sql` e `migrations/0004_sessao_agenda.sql` (um comando por vez).
   Ao atualizar, rode a migração nova **antes** de publicar o código que depende dela.

### 2. Publicar o Worker a partir do GitHub

1. Faça commit e push destas alterações.
2. **Workers & Pages → Create → Import a repository**, conecte o GitHub e escolha o repositório `HelpInk`.
3. Mantenha o comando de deploy `npx wrangler deploy` e clique em **Deploy**.
4. A partir daqui, cada push na `main` publica de novo (endereço final no passo 4).

Nesse momento o site abre, mas mostra "Não autorizado" — falta ligar o login.

### 3. Ligar o Cloudflare Access (login)

1. Ative o **Zero Trust** no plano **Free** (Zero Trust → Get started). A Cloudflare pode
   pedir um cartão, mas o plano Free não cobra.
2. Em **Zero Trust → Integrations → Identity providers**, adicione **One-time PIN**
   (código por e-mail), para que qualquer pessoa consiga entrar com o próprio e-mail.
3. Em **Zero Trust → Access controls → Policies**, crie uma política **Allow** com
   **Include → Everyone**. Quem libera o uso de verdade é a aprovação dentro do app.
4. Em **Access controls → Applications → Create new application → Self-hosted**, crie a
   aplicação do app com dois destinos, `<domínio>/app` e `<domínio>/api`, e a política do
   passo 3. Só esses caminhos pedem login: a página inicial (`/`) é pública.
5. Em `wrangler.jsonc`, preencha:
   - `ACCESS_TEAM_DOMAIN`: `https://<sua-equipe>.cloudflareaccess.com`
   - `ACCESS_AUD`: o AUD da aplicação do passo 4 (aparece como `kid=` no endereço da tela de
     login, ou na aba **Access** do Worker em "Application values")
6. Crie o segredo `ADMIN_EMAILS` com o seu e-mail (veja "Contas e aprovação").
7. Commit e push. Pronto: o botão **Entrar** da página inicial leva à tela de login da Cloudflare.

Na aba **Access** do Worker, a proteção do Worker inteiro fica em **Previews only**: ela só cobre
as URLs de pré-visualização (desligadas), e o domínio principal segue as aplicações acima.
O próprio Cloudflare aplica a regra mais específica: primeiro as aplicações por caminho
(`/app`, `/api`, `/assinar`), depois a do Worker.

Situação atual:

| Caminho | Acesso |
|---|---|
| `/` (página inicial) | público |
| `/app/` e `/api/` | login (aplicação `helpink.app.br`, política "qualquer pessoa" + aprovação no app) |
| `/assinar/` (ficha e agenda do cliente) | público, só com o link pessoal (política de Bypass) |

O Worker não confia só na tela de login: em toda chamada à API ele confere a assinatura do
token do Access, a equipe, o AUD e a validade. Se alguém chegar ao site por outro endereço
sem passar pelo Access, a API recusa.

### 4. Domínio próprio

O HelpInk roda em **<https://helpink.app.br>** (domínio do registro.br com os servidores DNS
apontando para a Cloudflare). Em `wrangler.jsonc`:

- `routes` liga o Worker ao domínio (`custom_domain: true`);
- `workers_dev: false` e `preview_urls: false` desligam os endereços `*.workers.dev`,
  para o app existir em um único endereço.

Se um dia você criar outra aplicação do Access que emita login para o app, adicione o AUD dela em
`ACCESS_AUD`, separado por vírgula. Hoje ele lista o AUD da aplicação de `/app` e `/api` e o da
proteção antiga do Worker.

### Sair

Na aba **Conta** do app, o botão **Sair** encerra a sessão do Access.

## Ficha de anamnese e assinatura do cliente

1. A ficha é **por sessão (dia)**: cada sessão tem a própria ficha, que vale para todas as
   tatuagens daquela sessão. Ao salvar uma sessão nova, o app oferece **Enviar ficha**; também
   dá para enviar pelo botão **Ficha** da sessão. O app gera um link pessoal (válido por 7 dias,
   de uso único) e abre o WhatsApp com a mensagem pronta. A data e as tatuagens da sessão vão
   para o termo e para o documento assinado (seção "Procedimento"). Se a sessão mudar antes da
   assinatura, **Gerar novo link** atualiza as tatuagens da ficha.
2. O cliente abre `https://<domínio>/assinar/#<código>`, confere as tatuagens, preenche dados, anamnese, lê o termo,
   marca as declarações (riscos, veracidade, consentimento LGPD para dados de saúde e,
   opcionalmente, uso de imagem) e assina digitando o nome completo.
   Menores de 18 anos: o responsável legal preenche os dados dele e assina.
3. O servidor gera o documento final (HTML), calcula o **SHA-256**, grava a trilha de evidências
   (link criado, aberto, assinado, IP, país, navegador) e envia o SHA-256 ao
   **OpenTimestamps** (carimbo do tempo público e gratuito).
4. O cliente baixa a própria via e vê o código SHA-256. Depois disso o link não mostra mais os dados.
5. O tatuador vê o status, baixa o documento (o app confere o SHA-256), baixa o carimbo `.ots`
   e pode copiar os dados da ficha para o cadastro.

Proteções:
- O código do link fica depois do `#`, então nunca chega ao servidor nem aparece em logs;
  o banco guarda só o SHA-256 do código.
- Fichas assinadas não podem ser alteradas nem apagadas (triggers `forms_lock` e
  `forms_nodelete` no D1).
- As rotas públicas (`/assinar/` e `/assinar/api/*`) só respondem a quem tem o link e nunca
  devolvem dados de outras fichas.

Para conferir um documento: calcule o SHA-256 do arquivo (`certutil -hashfile arquivo.html SHA256`
no Windows ou `shasum -a 256 arquivo.html` no Mac/Linux) e compare com o código registrado.
O arquivo `.ots` pode ser conferido em <https://opentimestamps.org> junto com o `.html`
(a confirmação na blockchain leva algumas horas após a assinatura).

**Configuração no Access:** as rotas públicas precisam ficar fora do login. Em
**Zero Trust → Access controls → Applications** existe a aplicação *Self-hosted*
`helpink.app.br` com destino `helpink.app.br/assinar` e a política
**HelpInk - ficha publica (bypass)** (**Bypass → Everyone**). Ela deixa `/assinar/...` sem login
mesmo se um dia outra regra passar a proteger o domínio inteiro. `/app/` e `/api/` continuam
pedindo login, e a API do app ainda confere o token do Access no próprio Worker.

## Calendário

Na tela **Tatuagens**, o botão **Lista / Calendário** alterna entre a lista do mês e um
calendário (a escolha fica salva em cada aparelho). Tocar em um dia mostra as sessões dele e
permite marcar uma nova sessão naquele dia.

As **fotos do resultado das tatuagens** estão prontas no branch `fotos-r2`, mas ficaram de fora
por enquanto: elas precisam do R2 (armazenamento de arquivos da Cloudflare), que exige uma
assinatura com cobrança acima da faixa gratuita.

## Agenda do cliente e Google Agenda

- Em **Clientes → Fichas → Link da agenda**, o tatuador envia ao cliente um link pessoal
  (`https://<domínio>/assinar/agenda/#<código>`) com as próximas sessões: data, horário, status
  e tatuagens. Valores, observações e dados de saúde não aparecem. O link é sempre o mesmo
  (pode ser reenviado); **Gerar novo link** troca o código e desliga o anterior. Se o cliente
  for apagado, o link para de funcionar.
- Cada sessão tem o botão **Agenda**, que abre o Google Agenda com o evento pronto
  (cliente, horário, tatuagens e telefone) para o tatuador salvar. O mesmo aparece ao salvar
  uma sessão nova. Na página da agenda, o cliente também pode adicionar cada sessão à agenda dele.

O texto do termo fica em `src/worker.js` (`buildTerm`). Peça a um advogado para revisá-lo;
ao mudar o texto, altere também `TERM_VERSION`. Cada ficha guarda a versão do termo que foi assinada.

## Dados antigos

Na primeira vez que alguém entra numa conta vazia, se o navegador tiver dados da versão
antiga (salvos em cookies), o app oferece enviá-los para o banco. O backup/importação em
`.md` continua disponível na aba **Conta**.

## Desenvolvimento local (opcional, requer Node.js)

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

Localmente não há Cloudflare Access: o usuário é o e-mail definido em `.dev.vars`
(isso só vale em `localhost` e o arquivo não é publicado).

Também dá para publicar pela linha de comando: `npx wrangler login`, `npm run db:migrate` e `npm run deploy`.
