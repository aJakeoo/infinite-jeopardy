# Putting Infinite Jeopardy online

You need two accounts: **Cloudflare** (hosting, free plan) and **Anthropic** (the AI, pay as you go).
**Firebase is not needed.** The rooms and buzzers run on Cloudflare Durable Objects instead.
Do the steps in order. Every command runs in PowerShell from the `infinite-jeopardy` repo folder.

## 1. Cloudflare account and first deploy (about 10 minutes)

1. Make a free account at https://dash.cloudflare.com/sign-up.
2. In the repo folder, install and log in. A browser tab opens to approve it:
   ```
   npm install
   npx wrangler login
   ```
3. Deploy:
   ```
   npx wrangler deploy
   ```
   It prints a link like `https://infinite-jeopardy.<your-subdomain>.workers.dev`. Open it: the game already works,
   using the built-in demo boards.

## 2. The AI key (about 5 minutes, about $5)

1. Make an account at https://console.anthropic.com.
2. **Billing:** add a small amount of credit ($5 makes roughly 2,000 boards with Claude Haiku 5.5).
3. **Limits:** set a monthly spend limit (for example $5) so it can never cost more than that.
4. **API Keys:** create a key named `infinite-jeopardy`. Copy it.
5. Give it to Cloudflare as a secret (paste the key when it asks; it is never stored in the code):
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
6. Reload the site. The "No AI key yet" note on the setup screen disappears and any topic works.

Extra guards are built in and can be changed in `wrangler.jsonc`: `DAILY_BOARD_LIMIT` (100 boards a day for the
whole site) and `HOURLY_BOARDS_PER_IP` (12 an hour per network). Redeploy after changing them.

## 3. Put it on jeopardy.jakejuip.xyz

Cloudflare can only attach a Worker to a domain whose DNS it manages. Two choices:

**Option A, recommended: let Cloudflare run the DNS for jakejuip.xyz (free).** You keep the domain registered at IONOS.
1. Cloudflare dashboard, **Add a domain**, type `jakejuip.xyz`, pick the Free plan.
2. Cloudflare copies your existing DNS records. Compare them with IONOS (Domains & SSL, jakejuip.xyz, DNS) so the
   portfolio and any email records are all there before you switch.
3. At IONOS, change the domain's **name servers** to the two Cloudflare gives you. It can take a few hours.
4. When Cloudflare says the domain is active: Workers & Pages, `infinite-jeopardy`, Settings, **Domains & Routes**,
   **Add**, Custom domain, `jeopardy.jakejuip.xyz`. Cloudflare makes the DNS record and the HTTPS certificate.

**Option B: keep DNS at IONOS.** Use the `workers.dev` link as is, and embed it in the portfolio (step 4) or add a
link to it. A redirect from IONOS works too, but players would see the workers.dev address.

## 4. As a widget on the portfolio

Paste this where the game should appear on jakejuip.xyz (swap in the workers.dev link if you chose option B):

```html
<iframe src="https://jeopardy.jakejuip.xyz/" title="Infinite Jeopardy"
  style="width:100%;aspect-ratio:16/9;border:0;border-radius:16px"
  allow="fullscreen; autoplay"></iframe>
<p><a href="https://jeopardy.jakejuip.xyz/">Open Infinite Jeopardy full screen</a></p>
```

The game only allows itself to be framed by `jakejuip.xyz` and its subdomains (see `public/_headers`).
Phones should always use the real link (`/play`), not the embed.

## 5. The phone app

Nothing to set up: the site is already an installable app (PWA). On an iPhone, open the `/play` link in Safari, tap
**Share**, then **Add to Home Screen**. Inside the app, use **Scan the TV's QR** to join or to host.

## 6. Updating later

After any change: `npm test`, then `npx wrangler deploy`. Rooms in progress survive a deploy.

## Watching the AI

`npx wrangler tail --format pretty` streams live logs. Boards that needed fixing show up as `board call ... needs work`
with the reasons; a board that failed every try is rare and shows the players a "try again" message.

## What it costs

- **AI:** about $0.002 to $0.01 per board (up to three calls, including small clue repairs), capped by your Anthropic spend limit.
- **Cloudflare:** the free Workers plan, including SQLite-backed Durable Objects, should cover family game nights.
  Check Workers & Pages, `infinite-jeopardy`, Metrics if it ever gets busy.
