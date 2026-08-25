#!/bin/bash
# ============================================================
# Envia o projeto para o GitHub.
#
# Coloque este arquivo DENTRO da pasta wacrm-main (a mesma onde
# está o package.json) e clique duas vezes nele.
# ============================================================

# Entra na pasta onde este arquivo está, seja lá de onde foi aberto.
cd "$(dirname "$0")" || exit 1

REPO="https://github.com/anonimuscrash/crm-zelfyn.git"
USUARIO="anonimuscrash"

# Cores para deixar a saída legível
VERDE='\033[0;32m'
VERMELHO='\033[0;31m'
AMARELO='\033[1;33m'
NEGRITO='\033[1m'
FIM='\033[0m'

erro() {
  echo ""
  echo -e "${VERMELHO}${NEGRITO}✗ ERRO${FIM}"
  echo -e "${VERMELHO}$1${FIM}"
  echo ""
  echo "Manda print desta janela que a gente resolve."
  echo ""
  echo "Aperte Enter para fechar."
  read -r
  exit 1
}

ok() {
  echo -e "${VERDE}✓${FIM} $1"
}

clear
echo -e "${NEGRITO}"
echo "════════════════════════════════════════════════"
echo "  Enviando o CRM para o GitHub"
echo "════════════════════════════════════════════════"
echo -e "${FIM}"
echo "Pasta: $(pwd)"
echo ""

# ---------- 1. Confere se está na pasta certa ----------
echo "[1/8] Verificando a pasta..."

if [ ! -f "package.json" ]; then
  erro "Não encontrei o package.json aqui.
Este script precisa estar DENTRO da pasta wacrm-main."
fi

if [ ! -f "src/i18n/request.ts" ]; then
  erro "A pasta src/ está faltando ou incompleta.
Descompacte o zip de novo e coloque este script na pasta certa."
fi

TOTAL=$(find . -type f -not -path "./.git/*" -not -path "./node_modules/*" | wc -l | tr -d ' ')
ok "Pasta correta — $TOTAL arquivos encontrados"

if [ "$TOTAL" -lt 400 ]; then
  erro "Só encontrei $TOTAL arquivos, esperava mais de 500.
A pasta parece incompleta. Descompacte o zip novamente."
fi

# ---------- 2. Confere o git ----------
echo ""
echo "[2/8] Verificando o git..."

if ! command -v git >/dev/null 2>&1; then
  erro "O git não está instalado.
Abra o Terminal, digite:  git --version
Vai aparecer uma janela pedindo para instalar. Aceite, espere terminar
e rode este script de novo."
fi
ok "git instalado — $(git --version)"

# ---------- 3. Identificação ----------
echo ""
echo "[3/8] Configurando sua identificação..."

EMAIL_ATUAL=$(git config user.email 2>/dev/null)
if [ -z "$EMAIL_ATUAL" ]; then
  echo ""
  echo -n "Digite o e-mail da sua conta GitHub: "
  read -r EMAIL
  if [ -z "$EMAIL" ]; then
    erro "E-mail em branco. Rode o script de novo."
  fi
else
  EMAIL="$EMAIL_ATUAL"
fi

# ---------- 4. Inicializa o repositório ----------
echo ""
echo "[4/8] Preparando o repositório..."

if [ ! -d ".git" ]; then
  git init -q || erro "Falhou ao rodar git init"
fi

git config user.name "$USUARIO"
git config user.email "$EMAIL"
ok "Repositório pronto ($EMAIL)"

# ---------- 5. Adiciona os arquivos ----------
echo ""
echo "[5/8] Adicionando os arquivos (pode demorar um pouco)..."

git add -A || erro "Falhou ao adicionar os arquivos"

# Conta o que realmente entrou no commit
NO_GIT=$(git diff --cached --numstat | wc -l | tr -d ' ')
if [ "$NO_GIT" -lt 100 ]; then
  # Pode ser que já esteja tudo commitado de uma tentativa anterior
  JA_TEM=$(git ls-files | wc -l | tr -d ' ')
  if [ "$JA_TEM" -lt 400 ]; then
    erro "Só $NO_GIT arquivos foram adicionados. Algo está errado."
  fi
  ok "Arquivos já estavam registrados ($JA_TEM no total)"
else
  ok "$NO_GIT arquivos adicionados"
fi

# ---------- 6. Commit ----------
echo ""
echo "[6/8] Criando o commit..."

if git diff --cached --quiet; then
  ok "Nada novo para commitar — seguindo para o envio"
else
  git commit -q -m "feat: plataforma de gestao comercial sobre o CRM" \
    || erro "Falhou ao criar o commit"
  ok "Commit criado"
fi

git branch -M main 2>/dev/null
git remote remove origin 2>/dev/null
git remote add origin "$REPO"

# ---------- 7. Token ----------
echo ""
echo "[7/8] Autenticação"
echo ""
echo -e "${AMARELO}Cole abaixo o seu Personal Access Token do GitHub.${FIM}"
echo "(começa com ghp_ — se não tiver, gere em:"
echo " https://github.com/settings/tokens → Generate new token (classic)"
echo " → marque a caixa 'repo' → Generate token)"
echo ""
echo -e "${AMARELO}Nada vai aparecer na tela enquanto você cola. É normal.${FIM}"
echo ""
echo -n "Token: "
read -rs TOKEN
echo ""

if [ -z "$TOKEN" ]; then
  erro "Token em branco. Rode o script de novo."
fi

# ---------- 8. Push ----------
echo ""
echo "[8/8] Enviando para o GitHub..."
echo ""

# O token vai só nesta chamada, não fica salvo no .git/config.
URL_COM_TOKEN="https://${USUARIO}:${TOKEN}@github.com/anonimuscrash/crm-zelfyn.git"

if git push -f "$URL_COM_TOKEN" main 2>&1 | sed "s|$TOKEN|••••••••|g"; then
  echo ""
  echo -e "${VERDE}${NEGRITO}"
  echo "════════════════════════════════════════════════"
  echo "  PRONTO! Projeto enviado."
  echo "════════════════════════════════════════════════"
  echo -e "${FIM}"
  echo "Agora confira se este link abre mostrando código:"
  echo ""
  echo "  https://github.com/anonimuscrash/crm-zelfyn/blob/main/src/i18n/request.ts"
  echo ""
  echo "Se abrir, vá no Coolify e clique em Redeploy."
  echo ""
else
  erro "O envio falhou.

Causas mais comuns:
  • Token errado, expirado, ou sem a permissão 'repo'
  • Sem conexão com a internet
  • Nome do repositório diferente de crm-zelfyn"
fi

echo "Aperte Enter para fechar esta janela."
read -r
