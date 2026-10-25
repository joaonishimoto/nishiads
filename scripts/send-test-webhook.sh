#!/usr/bin/env bash
# Envia um webhook de teste da Kiwify, assinado como a Kiwify assina (HMAC-SHA1 do corpo, ?signature=).
#
# Uso: scripts/send-test-webhook.sh "<URL do webhook copiada no Nishiads>" "<token do webhook>" [payload.json]
#   ex.: scripts/send-test-webhook.sh \
#          "https://<ref>.supabase.co/functions/v1/webhooks/kiwify/<token-da-url>" "meu-token-kiwify"
set -euo pipefail
URL="$1"
SECRET="$2"
PAYLOAD="${3:-$(dirname "$0")/../supabase/functions/webhooks/fixtures/kiwify-order-approved.json}"

# Pedido novo a cada execução, para ver a venda aparecer.
BODY="$(sed "s/b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/teste-$(date +%s)/" "$PAYLOAD" | tr -d '\n')"
SIGNATURE="$(printf '%s' "$BODY" | openssl dgst -sha1 -hmac "$SECRET" | sed 's/^.* //')"

curl -sS -X POST "${URL}?signature=${SIGNATURE}" \
  -H "Content-Type: application/json" \
  --data-binary "$BODY"
echo
