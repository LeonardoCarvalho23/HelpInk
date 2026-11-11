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
public/index.html          o app (telas)
src/worker.js              API /api/* + verificação do login do Access + aprovação de contas
migrations/0001_init.sql   tabela de dados (records)
migrations/0002_users.sql  tabela de contas (users)
wrangler.jsonc             configuração do Worker (banco, Access)
```

## Passo a passo da publicação

Tudo pode ser feito pelo painel da Cloudflare (<https://dash.cloudflare.com>), sem instalar nada.

### 1. Criar o banco D1

1. **Storage & Databases → D1 SQL Database → Create**, nome `helpink`.
2. Copie o **Database ID** e cole em `wrangler.jsonc` no campo `database_id`.
3. Abra o banco → aba **Console**, cole e execute o conteúdo de `migrations/0001_init.sql` e depois o de `migrations/0002_users.sql`.

### 2. Publicar o Worker a partir do GitHub

1. Faça commit e push destas alterações.
2. **Workers & Pages → Create → Import a repository**, conecte o GitHub e escolha o repositório `HelpInk`.
3. Mantenha o comando de deploy `npx wrangler deploy` e clique em **Deploy**.
4. O site fica em `https://helpink.<sua-conta>.workers.dev`. A partir daqui, cada push na `main` publica de novo.

Nesse momento o site abre, mas mostra "Não autorizado" — falta ligar o login.

### 3. Ligar o Cloudflare Access (login)

1. Ative o **Zero Trust** no plano **Free** (Zero Trust → Get started). A Cloudflare pode
   pedir um cartão, mas o plano Free não cobra.
2. Em **Zero Trust → Integrations → Identity providers**, adicione **One-time PIN**
   (código por e-mail), para que qualquer pessoa consiga entrar com o próprio e-mail.
3. Em **Zero Trust → Access controls → Policies**, crie uma política **Allow** com
   **Include → Everyone**. Quem libera o uso de verdade é a aprovação dentro do app.
4. No Worker: aba **Access → Protect this Worker behind Access**, escopo **All traffic**,
   e escolha a política do passo 3. A tela mostra o **AUD tag** e o endereço da equipe (JWKS).
5. Em `wrangler.jsonc`, preencha:
   - `ACCESS_TEAM_DOMAIN`: `https://<sua-equipe>.cloudflareaccess.com`
   - `ACCESS_AUD`: o AUD tag do passo 4
6. Crie o segredo `ADMIN_EMAILS` com o seu e-mail (veja "Contas e aprovação").
7. Commit e push. Pronto: ao abrir o site, aparece a tela de login da Cloudflare.

O Worker não confia só na tela de login: em toda chamada à API ele confere a assinatura do
token do Access, a equipe, o AUD e a validade. Se alguém chegar ao site por outro endereço
sem passar pelo Access, a API recusa.

Se depois você usar um domínio próprio (ex.: `app.seuestudio.com.br`) com outra aplicação
do Access, adicione o AUD dela em `ACCESS_AUD`, separado por vírgula.

Dica: em **Settings → Domains & Routes**, desative **Preview URLs** se não for usá-las.

### Sair

Na aba **Conta** do app, o botão **Sair** encerra a sessão do Access.

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
