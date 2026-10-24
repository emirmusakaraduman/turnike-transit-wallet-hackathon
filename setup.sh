#!/usr/bin/env bash
# Usage: PRIVATE_KEY=0x<funded deployer> ./setup.sh
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
RPC="${RPC_URL:-https://rpc-testnet.monadinfra.com}"
: "${PRIVATE_KEY:?set PRIVATE_KEY to a funded Monad testnet deployer key}"

[ -d lib/forge-std ] || { echo "lib/forge-std missing: git clone https://github.com/foundry-rs/forge-std lib/forge-std"; exit 1; }

forge test

if [ -n "${TURNIKE_ADDRESS:-}" ]; then
  ADDR="$TURNIKE_ADDRESS"   # already deployed, skip redeploy
else
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast >/dev/null
  ADDR=$(node -e "
const j=JSON.parse(require('fs').readFileSync('broadcast/Deploy.s.sol/10143/run-latest.json','utf8'));
console.log(j.transactions.find(t=>t.contractName==='Turnike'&&t.transactionType==='CREATE').contractAddress);")
fi
echo "Turnike at $ADDR"

# faucet wallet (reuse if already present)
if [ -f web/.env.local ] && grep -q '^FAUCET_PRIVATE_KEY=' web/.env.local; then
  FAUCET_KEY=$(grep '^FAUCET_PRIVATE_KEY=' web/.env.local | cut -d= -f2)
else
  # `cast wallet new --json` is an array in older Foundry and {data:[...]} in newer ones
  FAUCET_KEY=$(cast wallet new --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);let w=Array.isArray(j)?j[0]:j.data;w=Array.isArray(w)?w[0]:(w.accounts?w.accounts[0]:w);console.log(w.private_key||w.privateKey)})")
fi
FAUCET_ADDR=$(cast wallet address --private-key "$FAUCET_KEY")
cast send "$FAUCET_ADDR" --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --value "${FAUCET_FUND:-5ether}" >/dev/null
echo "Faucet $FAUCET_ADDR funded"

# rotating-QR secrets: keep the existing ones, generate on first run
old() { [ -f web/.env.local ] && grep "^$1=" web/.env.local | cut -d= -f2 || true; }
QR_SECRET_V=$(old QR_SECRET); [ -n "$QR_SECRET_V" ] || QR_SECRET_V=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
GATE_KEY_V=$(old GATE_KEY);   [ -n "$GATE_KEY_V" ]   || GATE_KEY_V=$(node -e "console.log(require('crypto').randomBytes(9).toString('hex'))")

cat > web/.env.local <<EOF
VITE_TURNIKE_ADDRESS=$ADDR
VITE_RPC_URL=$RPC
FAUCET_PRIVATE_KEY=$FAUCET_KEY
QR_SECRET=$QR_SECRET_V
GATE_KEY=$GATE_KEY_V
EOF

cd web && npm install && npm run build
echo "Done. Local: cd web && npm run dev  (gate: #/gate)"
