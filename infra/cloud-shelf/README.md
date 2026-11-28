# Cloud Shelf Deployment (Cloudflare Worker + R2)

The Cloud Shelf is an **untrusted** file shelf (~270 LOC Worker + 1 private R2 bucket). Every Desktop and iOS release is signed locally on your Mac/Mac mini before upload and verified offline on your devices before running.

## One-time Cloudflare Setup

Your current `wrangler` OAuth token only has `pages:write`; run `wrangler login` once to authorize `workers:write` and R2:

```bash
cd infra/cloud-shelf

# 1. Refresh Cloudflare OAuth scopes in browser
npx wrangler login

# 2. Create the private R2 bucket
npx wrangler r2 bucket create editable-paseo-artifacts

# 3. Set upload secret (and optional read token for raw channel.json)
npx wrangler secret put UPLOAD_TOKEN
# optional:
# npx wrangler secret put READ_TOKEN

# 4. Deploy the Worker
npx wrangler deploy
```

## Connect `paseo-ed` to Your Deployed Worker

```bash
# Save your Worker URL in ~/.editable-paseo/config.json
paseo-ed init --repo ~/www/paseo --branch paseo-customizations \
  --cloud-url https://editable-paseo-shelf.<your-subdomain>.workers.dev

# Upload signed releases (set UPLOAD_TOKEN in your shell/keychain)
export EDITABLE_CLOUD_UPLOAD_TOKEN="<same UPLOAD_TOKEN>"
paseo-ed ship <slug> --summary "..." --push --upload

# Pull signed releases onto another Mac
paseo-ed sync
```
