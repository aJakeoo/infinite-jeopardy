# Infinite Jeopardy

A Jeopardy-style party game where an AI writes the board. One screen (TV or laptop) shows the board,
everyone buzzes in on their phone, and an optional host phone sees every answer.

- **Theme:** Horizon. Painted peach sky and a grainy blue hill, set in Newsreader and Instrument Sans.
- **AI:** Claude Haiku 5.5 writes 6 categories x 5 clues (or a quick 4 x 4) plus Final Jeopardy, about $0.002 per board.
  With no API key the game still runs on two built-in demo boards.
- **Hosting:** one Cloudflare Worker serves the site, runs the rooms (Durable Objects + WebSockets) and talks to the AI.

Setup and deploy steps: **[SETUP.md](SETUP.md)**.

## How a game works

1. Open the site on the TV and press **Start a game**. A QR code appears; the 4-letter room code lives in the
   hamburger menu (top right), along with the join QR, host phone QR, sound, full screen and the board code.
2. Phones scan the QR (or go to `/play` and type the room code) and type a name. Teams mode lets each phone pick a team.
3. Type a topic (or roll the dice) and press **Make the board**. A progress bar runs while the AI writes it.
   **Ages** is a dropdown of checkboxes (Little kids 4-6, Kids 7-9, Tweens 10-12, Teens 13-17, Adults 18+) plus an
   Other box; the youngest picked age wins. The ages pick a band (little kids 4-6, kids 7-9, tweens 10-12, teens, adults) that sets the reading level,
   clue length and how hard the $200 and $1000 clues are. **Difficulty** nudges it easier or harder, and
   **Fine tune the questions** has checkboxes for clue styles (Describe it, Extra hints, Same letter, Rhyme time,
   Wordplay, Before & After, Pop culture, Numbers & dates). Each band pre-ticks its own picks; tick or untick freely.
4. Click a clue. Buzzers open after the clue has had time to be read. Buzzing early locks you out for 0.25 s.
5. The fastest buzz wins, with lag compensation: each phone measures its own reaction time, and the server
   waits 120 ms after the first buzz for faster-but-laggier phones. A phone cannot claim a time faster than physics.
   Up to four buzzes line up in order (late buzzes while someone answers join the line).
6. The first in line answers out loud. Someone presses **Reveal answer**, then the check or the X. A wrong answer
   costs the points and passes straight to the next in line; when the line runs out the buzzers reopen.
   Tap any name in the line (on the TV or the host phone) to choose who is being judged.
7. Two Daily Doubles on a classic board (one on a quick board): the player in control wagers on their phone.
8. Final Jeopardy: everyone above $0 wagers and types an answer on their phone, then the TV reveals them lowest score first.
9. Every board gets a 6-character code so it can be played again later for free.

The host phone can do everything the TV can: set up the board (topic, dice, ages, difficulty, styles, size,
teams, board codes), remove players, pick clues, open buzzers, reveal, choose who answers, judge, fix scores
and run Final Jeopardy.

TV keyboard: `Space` continue/reveal, `R` reveal, `C` correct, `X` incorrect, `O` open buzzers now, `J` join code,
`H` host phone code, `M` mute, `F` full screen. Players on a laptop can buzz with `Space`.

## Code map

| Path | What it is |
|---|---|
| `src/game.js` | The rules: a pure state machine (clues, buzzing, scoring, Daily Doubles, Final, teams, what each screen may see) |
| `src/boards.js` | AI board generation, board validation (counts, leaked answers, duplicates), demo boards |
| `src/worker.js` | Cloudflare Worker: static site, room API, `Room` / `BoardVault` / `Limiter` Durable Objects |
| `public/index.html`, `public/js/tv.js`, `public/css/tv.css` | The TV / laptop screen |
| `public/play.html`, `public/js/phone.js`, `public/css/phone.css` | Player buzzer and host remote |
| `public/js/net.js` | WebSocket client: reconnects, clock sync, request/ack |
| `public/js/topics.js` | The dice: broad topics with minimum ages |
| `public/js/tuning.js` | Age bands, clue styles and the audience part of the AI prompt (shared by the TV and the server) |
| `public/js/sfx.js` | Synthesized sound effects and phone vibration |

## Develop and test

```
npm install
npm run dev            # http://127.0.0.1:8787 (local Durable Objects, no Cloudflare account needed)
npm test               # 38 rule and tuning tests
npm run e2e            # plays full games in Chrome: TV + iPhones + host (needs npm run dev running)
node test/e2e/host.mjs # the host phone sets up and runs a game on its own
```

AI path without a real key: run `node test/e2e/fake-anthropic.mjs`, start a second dev server with
`npx wrangler dev --port 8788 --var ANTHROPIC_API_KEY:test-key --var ANTHROPIC_BASE_URL:http://127.0.0.1:8799 --var DAILY_BOARD_LIMIT:3`,
then `node test/e2e/ai.mjs`.

The original two-screen game this grew from: [student-government-jeopardy](https://github.com/aJakeoo/student-government-jeopardy).
