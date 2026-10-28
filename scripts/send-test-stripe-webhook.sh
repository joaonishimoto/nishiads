#!/usr/bin/env bash
# Envia um webhook de teste da Stripe, assinado como a Stripe assina (Stripe-Signature: t=...,v1=HMAC-SHA256).
#
# Uso: scripts/send-test-stripe-webhook.sh "<URL do webhook copiada no Nishistack - ADS>" "whsec_..." [payload.json]
set -euo pipefail
URL="$1"
SECRET="$2"
PAYLOAD="${3:-$(dirname "$0")/../supabase/functions/webhooks/fixtures/stripe-checkout-paid.json}"

# Pagamento novo a cada execução, para ver a venda aparecer.
BODY="$(sed "s/pi_teste_nishiads/pi_teste_$(date +%s)/" "$PAYLOAD" | tr -d '\n')"
T="$(date +%s)"
SIGNATURE="$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=$T,v1=$SIGNATURE" \
  --data-binary "$BODY"
echo
