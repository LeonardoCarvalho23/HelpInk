# HelpInk

App para tatuadores gerenciarem clientes, sessões, custos e estoque — publicado
inteiramente na **Cloudflare**, no plano gratuito:

| Peça | Serviço Cloudflare | Limite grátis (aprox.) |
|---|---|---|
| Site + API | **Workers** (com arquivos estáticos) | 100 mil requisições/dia |
| Banco de dados | **D1** (SQLite) | 5 GB, 100 mil gravações/dia |
| Login | **Cloudflare Access** (Zero Trust) | até 50 usuários |

O login é feito pelo Cloudflare Access **antes** de o site abrir: a pessoa digita o
e-mail, recebe um código (PIN) e entra. Não há senha para guardar. Cada e-mail
autorizado tem seus próprios dados, separados dos outros.

## Estrutura

```
public/index.html          o app (telas)
src/worker.js              API /api/* + verificação do login do Access
migrations/0001_init.sql   cria a tabela no D1
wrangler.jsonc             configuração do Worker (banco, Access)
```

## Passo a passo da publicação

Tudo pode ser feito pelo painel da Cloudflare (<https://dash.cloudflare.com>), sem instalar nada.

### 1. Criar o banco D1

1. **Storage & Databases → D1 SQL Database → Create**, nome `helpink`.
2. Copie o **Database ID** e cole em `wrangler.jsonc` no campo `database_id`.
3. Abra o banco → aba **Console**, cole o conteúdo de `migrations/0001_init.sql` e execute.

### 2. Publicar o Worker a partir do GitHub

1. Faça commit e push destas alterações.
2. **Workers & Pages → Create → Import a repository**, conecte o GitHub e escolha o repositório `HelpInk`.
3. Mantenha o comando de deploy `npx wrangler deploy` e clique em **Deploy**.
4. O site fica em `https://helpink.<sua-conta>.workers.dev`. A partir daqui, cada push na `main` publica de novo.

Nesse momento o site abre, mas mostra "Não autorizado" — falta ligar o login.

### 3. Ligar o Cloudflare Access (login)

1. No Worker: **Settings → Domains & Routes → workers.dev → Enable Cloudflare Access**.
   Se for o primeiro uso do Zero Trust, a Cloudflare pede para escolher um nome de equipe
   (ex.: `minhaequipe`) e um plano: escolha **Free**.
2. Ao ativar, a Cloudflare mostra o **AUD** (Application Audience Tag) da aplicação.
   Também fica em **Zero Trust → Access → Applications → (sua aplicação) → Overview**.
3. Em **Zero Trust → Access → Applications → (sua aplicação) → Policies**, edite a política
   para incluir quem pode entrar — por exemplo **Include → Emails** com o seu e-mail e o dos
   tatuadores. Quem não estiver na lista não consegue entrar.
4. O método de login **One-time PIN** (código por e-mail) já vem ativo. Em
   **Zero Trust → Settings → Authentication** dá para adicionar Google, GitHub etc.
5. Em `wrangler.jsonc`, preencha:
   - `ACCESS_TEAM_DOMAIN`: `https://minhaequipe.cloudflareaccess.com` (o nome da sua equipe)
   - `ACCESS_AUD`: o AUD copiado no passo 2
6. Commit e push. Pronto: ao abrir o site, aparece a tela de login da Cloudflare.

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
