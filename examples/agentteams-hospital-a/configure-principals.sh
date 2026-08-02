#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${AGENTTEAMS_NAMESPACE:-agentteams-system}"
CREDENTIAL_BACKEND="${AGENTTEAMS_CREDENTIAL_BACKEND:-auto}"
CONTAINER_CMD="${AGENTTEAMS_CONTAINER_CMD:-docker}"
PRINCIPAL_FILE="${MEMORYVAULT_HTTP_PRINCIPALS_FILE:-$HOME/.memoryvault/agentteams-hospital-a-principals.json}"
MEMORYVAULT_CLI="${MEMORYVAULT_CLI:-memory-vault-cli}"

if [[ -e "$PRINCIPAL_FILE" ]]; then
  echo "Refusing to overwrite existing Principal file: $PRINCIPAL_FILE" >&2
  exit 1
fi

read_kubernetes_gateway_key() {
  kubectl --namespace "$NAMESPACE" get secret "$1" \
    --output 'jsonpath={.data.WORKER_GATEWAY_KEY}' | \
    node -e 'let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(Buffer.from(value, "base64").toString("utf8")));'
}

read_embedded_gateway_key() {
  local worker_name="$1"
  "$CONTAINER_CMD" exec agentteams-controller sh -c \
    '. "/data/worker-creds/$1.env"; printf "%s" "$WORKER_GATEWAY_KEY"' \
    sh "$worker_name"
}

resolve_backend() {
  case "$CREDENTIAL_BACKEND" in
    kubernetes|embedded) printf '%s' "$CREDENTIAL_BACKEND" ;;
    auto)
      if command -v kubectl >/dev/null 2>&1 && \
        kubectl --namespace "$NAMESPACE" get secret agentteams-creds-hospital-a-lead >/dev/null 2>&1; then
        printf 'kubernetes'
      elif command -v "$CONTAINER_CMD" >/dev/null 2>&1 && \
        "$CONTAINER_CMD" ps --format '{{.Names}}' | grep -qx agentteams-controller; then
        printf 'embedded'
      else
        echo "Cannot find AgentTeams Kubernetes Secrets or a running embedded controller" >&2
        exit 1
      fi
      ;;
    *)
      echo "Invalid AGENTTEAMS_CREDENTIAL_BACKEND: $CREDENTIAL_BACKEND" >&2
      exit 1
      ;;
  esac
}

BACKEND="$(resolve_backend)"

read_gateway_key() {
  local secret_name="$1"
  local worker_name="$2"
  if [[ "$BACKEND" == "kubernetes" ]]; then
    read_kubernetes_gateway_key "$secret_name"
  else
    read_embedded_gateway_key "$worker_name"
  fi
}

add_principal() {
  local secret_name="$1"
  local id="$2"
  local role="$3"
  export MEMORYVAULT_AGENTTEAMS_GATEWAY_KEY
  MEMORYVAULT_AGENTTEAMS_GATEWAY_KEY="$(read_gateway_key "$secret_name" "$id")"
  if [[ -z "$MEMORYVAULT_AGENTTEAMS_GATEWAY_KEY" ]]; then
    echo "Empty Gateway key in Secret: $secret_name" >&2
    exit 1
  fi
  "$MEMORYVAULT_CLI" http-principal add \
    --file "$PRINCIPAL_FILE" \
    --id "$id" \
    --role "$role" \
    --tenant agency \
    --projects hospital-a \
    --spaces hospital-a-copy \
    --token-env MEMORYVAULT_AGENTTEAMS_GATEWAY_KEY
  unset MEMORYVAULT_AGENTTEAMS_GATEWAY_KEY
}

add_principal agentteams-creds-hospital-a-lead hospital-a-lead manager
add_principal agentteams-creds-hospital-a-writer hospital-a-writer writer
add_principal agentteams-creds-hospital-a-reviewer hospital-a-reviewer reviewer

echo "MEMORYVAULT_HTTP_PRINCIPALS_FILE=$PRINCIPAL_FILE"
