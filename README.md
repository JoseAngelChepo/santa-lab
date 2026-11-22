# Santa Lab

An OpenClaw plugin for finding real gifts in parallel, verifying published prices, and inspecting every Cerebras model call in a local HTML workbench.

Users send ordinary wishes. The plugin supplies the shopping strategy through OpenClaw's native **system-context hook**, rather than requiring a technical user prompt.

> Find five gifts: a manual coffee grinder, a Nintendo Switch 2, a Kindle Paperwhite, a LEGO rose bouquet, and a 32 oz Hydro Flask.

## What it does

- `firecrawl_search_batch`: N live searches launched concurrently.
- `firecrawl_scrape_batch`: N selected pages fetched concurrently, with fresh content (`maxAge: 0`).
- Balanced delivery: each item retains its own identity and quoted price evidence; the serialized tool envelope stays below 18,000 characters to avoid the host's 20,000-character truncation boundary.
- Efficient verification: require the requested model, published price, currency and retail link. Accept the first supported price. Only retry unresolved products; do not compare discounts or investigate stock.
- Local dashboard at **http://127.0.0.1:18891**: effective inputs, outputs, reasoning-token counts, parameters, timings, tools, errors and JSON export.
- Full raw Firecrawl responses remain in the local tracker. Products, prices and retail URLs are never hardcoded.

The Firecrawl API is official; the two batch tools are implemented by this plugin. They do not call OpenClaw's separate bundled single-item Firecrawl tools. No MCP server or additional npm dependencies are required for Santa Lab.

## Requirements

- Node **24.22.1+ within 24.x**, or **26.12.1+**.
- The OpenClaw source version described below, its pinned pnpm, and Git.
- Authorized `CEREBRAS_API_KEY` and `FIRECRAWL_API_KEY`.
- An isolated OpenClaw profile with Cerebras already configured.

This release targets the hackathon's pinned source build. It is **not** a verified drop-in package for arbitrary newer OpenClaw versions.

## Install

### 1. Prepare the official instrumented host

From a parent directory containing your checkouts:

```sh
git clone https://github.com/openclaw/openclaw.git openclaw-santa
cd openclaw-santa
git checkout -b santa-lab-host 8b18b5578f66eab1501cba4cef2310d88bfb9a41
cd ..
git clone https://github.com/wkasekende/openclaw-speed-patch.git
cd openclaw-santa
git am ../openclaw-speed-patch/openclaw-cerebras-kimi-on-8b18b55.patch
pnpm install --frozen-lockfile
pnpm build
cd ..
git clone https://github.com/JoseAngelChepo/santa-lab.git
```

Use the pnpm version specified in the host's `package.json`. Follow the [official speed patch instructions](https://github.com/wkasekende/openclaw-speed-patch) when preparing the Cerebras provider and isolated profile. Set `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` to that profile whenever running its onboarding/configuration commands. A separate gateway port such as **18890** avoids collisions with another OpenClaw installation.

### 2. Install Santa Lab into that profile

Stop the isolated Gateway first. The following paths are examples; substitute your own absolute paths:

```sh
cd santa-lab
node scripts/install.mjs /absolute/path/openclaw-santa /absolute/path/.openclaw-santa
```

The installer:

1. Checks source ancestry against the pinned OpenClaw base.
2. Adds the small provider tracking adapter using native `wrapStreamFn`, `onPayload`, `onResponse` and stream-result APIs.
3. Backs up the profile configuration and enables Santa Lab and its system-context permission.
4. Registers missing Kimi/Qwen model definitions, preserving existing definitions and credentials.
5. Generates `.local/openclaw-launcher.mjs` with **your installation's paths**; no developer-specific launcher is required.

Set both keys in the isolated profile's protected `.env` (see `.env.example`). Never commit that file. The plugin loads it at service startup. API-key access and quotas are supplied by your accounts.

Rebuild the host after installing the adapter, then start it:

```sh
cd /absolute/path/openclaw-santa
pnpm build
cd /absolute/path/santa-lab
node .local/openclaw-launcher.mjs gateway run
```

The generated launcher requires `pnpm` on PATH. Set `SANTA_LAB_PNPM` to its executable path if necessary.

Open **http://127.0.0.1:18891** and start a new run. The default request contains only the user's five wishes.

## Switch between Qwen and Kimi

Once installed and both models are available to your Cerebras key, change **only the primary model**:

```sh
# Provisional development / technical demo
node .local/openclaw-launcher.mjs config set agents.defaults.model.primary cerebras/qwen-3.8-27b

# Kimi on Cerebras
node .local/openclaw-launcher.mjs config set agents.defaults.model.primary cerebras/moonshotai-kimi-k3.1-pro-trial
```

Start a new session after switching. Tools, shopping system policy and tracker stay the same. The shared test setting is `thinkingDefault: low`; every submitted payload records its actual parameters.

**Qwen results are not Kimi measurements.** A bounty requiring Kimi must be demonstrated with Kimi. Our Kimi attempts encountered repeated Cerebras 429 responses; incomplete runs are not successful bounty entries. Do not present Qwen TPS as Kimi TPS.

## System strategy and reproducibility

- `prompts/five-wishes-user.txt`: the ordinary user request.
- `prompts/shopping-system.txt`: generic shopping/price policy, with no product-specific answers.
- `shopping-policy.mjs`: native `before_prompt_build` hook returning `prependSystemContext`.
- `protocol.promptPolicy`: policy ID, content hash and placement recorded for managed runs.

The installer enables `shoppingMode` and `hooks.allowPromptInjection`. Turn shoppingMode off for observation-only operation. Background cron/internal-maintenance calls are excluded from experiments.

The `five-wishes-fast.txt` and `five-wishes-priced-fast.txt` prompts are earlier experiment artifacts. The current workflow keeps strategy in system context. Historical captures retain their original language and contents.

You can launch the current example programmatically:

```sh
node scripts/run-baseline.mjs 'Five gift wishes' .local/run.json
```

Pass `--prompt-file FILE` for another user request; `--reload` reloads Santa Lab before execution. Set `SANTA_LAB_LAUNCHER` to override the generated launcher. The local API is bound to loopback and rejects cross-origin mutations.

## TPS and timing

### Optional lean shopping mode

For a dedicated shopping profile, reload the updated plugin manifest before enabling new settings, then run:

```sh
node .local/openclaw-launcher.mjs plugins reload santa-lab
node scripts/configure-shopping.mjs /absolute/path/.openclaw-santa lean
node .local/openclaw-launcher.mjs plugins reload santa-lab
```

This replaces the general system context with a compact shopping policy and allows only the two batch tools. Tool Search and Code Mode are disabled in that isolated profile so both schemas are directly callable. Model, credentials, reasoning effort and output-token limits stay unchanged. Use `standard` instead of `lean` to restore the saved tool presentation and the previous system policy, then reload.

The lean selector adds purchase intent when a query lacks it, requests five live candidates, and ranks matching direct product pages ahead of categories/reviews. If all search hits are non-product pages, it can reuse explicit retail product links already present in their live descriptions. Those links retain source provenance and still require a fresh page fetch and price verification. No stores, product IDs or prices are preset. Price excerpts are scoped to the product section to exclude recommendation prices. Raw responses remain available locally.

## Timing interpretation

The official patch supplies server generation metrics:

```text
TPS_call = completion_tokens / completion_time
mean TPS = arithmetic mean of successful measured call rates
```

Reasoning tokens are included in completion tokens. Failed calls and calls without valid server timings are excluded and counted visibly. The token-weighted rate is a separate diagnostic.

Queueing, prefill, tool waits and network time are not part of this server-generation TPS. Client wall time and first consumed delta are recorded separately; the latter is not the server's internal TTFT. The adapter observes the structured payload before serialization, **not raw HTTP packets**. Credentials and authorization headers are not logged.

Observed Qwen experiments completed the five-wish example in about 29 seconds with four measured model calls and ten Firecrawl requests. These are individual observations, not a guarantee or a controlled causal speedup. Service load, pages, model and quotas affect results.

## Tests

```sh
node --test test/*.test.mjs
```

The suite covers exact N-way parallelism, partial failures, bounded delivery of large pages, preserved price evidence, system/user separation, native stream identity, retry accounting, official TPS arithmetic, credential redaction and loopback API boundaries.

## Included and excluded

This repository contains plugin source, instrumentation, prompts, tests, installer and documentation. It excludes credentials, local database, private captured requests/responses, screenshots, installed dependencies and the upstream OpenClaw checkout. The official speed patch is linked rather than republished. The additional tracking adapter is experimental instrumentation; disclose it when reproducing results.
