# Como subir uma atualização

Fluxo de apagar o projeto antigo e usar o zip novo.

## O que o zip já traz pronto

- Dockerfile com `node:22-alpine` e heap de 6 GB
- Todos os arquivos do projeto

## O que o zip NÃO traz

A pasta `.git`. Ela guarda o vínculo com o GitHub e o histórico — não vai dentro de um zip. Por isso, ao substituir o projeto, você precisa reconectar.

## Passo a passo

Descompacte o zip por cima, e no Terminal:

```bash
cd ~/Downloads/wacrm-main
```

Confira que o Dockerfile veio certo:

```bash
grep -c "max-old-space-size" Dockerfile
```

Tem que retornar **1**. Se retornar 0, o build vai falhar com exit 255.

Reconecte ao repositório e envie:

```bash
git init
git config user.name "anonimuscrash"
git config user.email "kauam1024@gmail.com"
git add -A
git commit -m "atualização"
git branch -M main
git remote add origin https://github.com/anonimuscrash/crm-zelfyn.git
git push -f origin main
```

Quando pedir senha, cole o **Personal Access Token** (não a senha da conta).

Depois: **Redeploy** no Coolify.

## Alternativa: não apagar

Se preferir manter a pasta e só substituir os arquivos, a `.git` sobrevive e o envio vira uma linha:

```bash
git add -A && git commit -m "atualização" && git push
```

Descompacte o zip numa pasta separada e copie o conteúdo por cima da antiga, sem apagar nada. Os arquivos ocultos (`.git`, `.gitignore`, `.dockerignore`) ficam intactos.

## Se o build falhar

**exit code 255** durante `npm run build` → falta memória. Confira o `NODE_OPTIONS`. Se estiver lá, adicione swap na VPS:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**`Could not find i18n config at ./src/i18n/request.ts`** → os arquivos não subiram completos. Nunca use o uploader web do GitHub: ele descarta silenciosamente tudo acima de 100 arquivos, e este projeto tem 550.

## Migrations

Migration nova sempre vai **antes** do deploy. O código novo pode depender de uma função que ainda não existe no banco.

Aplicadas até agora: 040 a 048.
