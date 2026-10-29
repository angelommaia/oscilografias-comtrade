# Deploy: GitHub + Railway

Guia para publicar o visualizador COMTRADE no [Railway](https://railway.app).

## Pré-requisitos

1. Conta no [GitHub](https://github.com)
2. Conta no [Railway](https://railway.app) (login com GitHub)
3. [Git for Windows](https://git-scm.com/download/win) instalado

Após instalar o Git, abra um **novo** terminal (PowerShell ou Git Bash).

---

## 1. Criar o repositório no GitHub

1. Acesse [github.com/new](https://github.com/new)
2. **Repository name:** `oscilografias-comtrade` (ou outro nome)
3. **Visibility:** Private (recomendado) ou Public
4. **Não** marque "Add a README" — o projeto já tem um
5. Clique em **Create repository**

Anote a URL do repositório, por exemplo:

```
https://github.com/SEU_USUARIO/oscilografias-comtrade.git
```

---

## 2. Enviar o código do seu PC para o GitHub

No PowerShell ou Git Bash:

```powershell
cd "C:\Users\Ich\OneDrive\Oscilografias"

git init
git add .
git status
git commit -m "Initial commit: visualizador COMTRADE com deploy Railway"

git branch -M main
git remote add origin https://github.com/SEU_USUARIO/oscilografias-comtrade.git
git push -u origin main
```

Na primeira vez, o GitHub pedirá login (navegador ou token).

### Se usar autenticação por token

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens**
2. Crie um token com permissão `repo`
3. Use o token como senha quando o `git push` solicitar

---

## 3. (Opcional) Incluir oscilografias de exemplo

Copie pares `.cfg` + `.dat` para a pasta `samples/`:

```powershell
# Exemplo: copiar um caso já anonimizado (veja samples/README.md)
Copy-Item "C:\caminho\para\registro.cfg" "samples\meu_caso\"
Copy-Item "C:\caminho\para\registro.dat" "samples\meu_caso\"
```

Por padrão, arquivos `.dat` estão no `.gitignore` (são grandes). Para incluí-los no deploy:

1. Edite `.gitignore` e comente ou remova as linhas `samples/**/*.dat`
2. Commit e push:

```powershell
git add samples/
git commit -m "Adiciona oscilografias de exemplo"
git push
```

Alternativa: use um **Volume** no Railway montado em `/app/samples` (sem commitar arquivos grandes).

---

## 4. Deploy no Railway

1. Acesse [railway.app](https://railway.app) e faça login com GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Autorize o Railway a acessar seus repositórios
4. Selecione `oscilografias-comtrade`
5. O Railway detecta o `Dockerfile` e inicia o build

### Variáveis de ambiente

No projeto Railway → serviço → **Variables**, adicione:

| Variável | Valor |
|----------|--------|
| `ENV` | `production` |
| `COMTRADE_SAMPLES_DIR` | `/app/samples` |
| `MAX_UPLOAD_BYTES` | `52428800` |
| `ALLOWED_ORIGINS` | `https://SEU-DOMINIO.up.railway.app` |

O Railway define `PORT` automaticamente — não precisa configurar.

### Domínio público

1. Serviço → **Settings** → **Networking**
2. **Generate Domain**
3. Copie a URL (ex.: `https://oscilografias-comtrade-production.up.railway.app`)
4. Atualize `ALLOWED_ORIGINS` com essa URL (se usar frontend em outro domínio; se tudo for o mesmo, pode deixar vazio)

---

## 5. Verificar

Abra a URL gerada pelo Railway. Deve carregar a interface.

Teste:

- [ ] Página inicial abre
- [ ] Upload de `.cfg` + `.dat` funciona
- [ ] Menu **Exemplos** (se houver arquivos em `samples/`)
- [ ] Zoom e canais funcionam

Health check: `https://SEU-DOMINIO.up.railway.app/api/health` → `{"status":"ok"}`

---

## 6. Atualizações futuras

Sempre que alterar o código localmente:

```powershell
cd "C:\Users\Ich\OneDrive\Oscilografias"
git add .
git commit -m "Descreva a alteração"
git push
```

O Railway redeploya automaticamente a cada push na branch `main`.

---

## Problemas comuns

| Problema | Solução |
|----------|---------|
| `git` não reconhecido | Instale [Git for Windows](https://git-scm.com/download/win) e abra um terminal novo |
| Build falha no Railway | Veja **Deployments** → logs; confira se o `Dockerfile` está na raiz |
| Exemplos não aparecem | Confirme arquivos em `samples/` e variável `COMTRADE_SAMPLES_DIR=/app/samples` |
| Upload falha (413) | Aumente `MAX_UPLOAD_BYTES` ou reduza o arquivo |
| App reiniciou e perdeu dados | Normal: registros ficam em memória; usuário refaz upload |
