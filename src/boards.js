// Board validation, demo boards, and AI board generation (Claude Haiku 5.5).
import { SIZES, LIMITS } from './game.js';
import { audiencePrompt, BANDS, bandFor, cleanTune, ladder as ladderFor } from '../public/js/tuning.js';

export const MODEL = 'claude-haiku-5-5';

/* ---------------- validation ---------------- */

const clean = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function coreAnswer(response) {
  return clean(response, 200)
    .replace(/^(what|who|where|when|which)\s+(is|are|was|were)\s+/i, '')
    .replace(/[?.!]+$/, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s*\(.*\)\s*$/, '')
    .trim();
}

function asQuestion(response) {
  const r = clean(response, 120);
  if (!r) return r;
  if (/^(what|who|where|when|which)\s/i.test(r)) return r.endsWith('?') ? r : r + '?';
  return `What is ${r.replace(/[?.!]+$/, '')}?`;
}

const pct = (k) => (typeof k === 'number' && Number.isFinite(k) ? Math.min(100, Math.max(0, k)) : null);

// Normalises a board and reports problems. Hard errors make the board unusable.
// With a ladder (target percent known per row), each category is put in order of how well known
// its clues are, and clues far off their row's target come back in `tuning` for a rewrite.
export function validateBoard(raw, size, maxClue = 200, ladder = null) {
  const tuning = [];
  const { cols, rows } = SIZES[size] || SIZES['6x5'];
  const hard = [], soft = [], fixable = []; // fixable: problems tied to one clue, which a targeted rewrite can fix
  const flag = (c, r, msg) => { hard.push(msg); fixable.push({ c, r, msg }); };
  if (!raw || !Array.isArray(raw.categories)) return { board: null, hard: ['No categories came back.'], soft, fixable };
  if (raw.categories.length < cols) hard.push(`Expected ${cols} categories, got ${raw.categories.length}.`);
  const categories = raw.categories.slice(0, cols).map((cat, ci) => {
    const clues = Array.isArray(cat && cat.clues) ? cat.clues : [];
    if (clues.length < rows) hard.push(`Category ${ci + 1} has ${clues.length} clues, needs ${rows}.`);
    let list = clues.slice(0, rows).map((cl, r) => ({ cl, k: pct(cl && cl.known), r }));
    if (ladder) {
      // unrated clues (e.g. a repaired one) count as right on target for the row they sit in
      list.forEach((x) => { if (x.k == null) x.k = ladder[x.r]; });
      list = list.slice().sort((a, b) => b.k - a.k || a.r - b.r);
    }
    return {
      name: clean(cat && cat.name, 40) || `Category ${ci + 1}`,
      known: list.map((x) => x.k),
      clues: list.map(({ cl }) => ({ clue: clean(cl && cl.clue, 240), response: asQuestion(cl && cl.response) })),
    };
  });
  if (ladder) categories.forEach((cat, ci) => cat.known.forEach((k, r) => {
    const want = ladder[r];
    if (want != null && Math.abs(k - want) > 25) tuning.push({ c: ci, r, msg: `${cat.name} #${r + 1}: rated ${Math.round(k)}% known, but this row should be about ${want}%. Write a ${k > want ? 'harder' : 'easier'} clue that about ${want}% of this audience would get.` });
  }));
  categories.forEach((cat) => delete cat.known);
  const seenCats = new Set(), seenAns = new Map();
  categories.forEach((cat, ci) => {
    const k = cat.name.toLowerCase();
    if (seenCats.has(k)) hard.push(`Category "${cat.name}" appears twice.`);
    seenCats.add(k);
    cat.clues.forEach((cl, ri) => {
      const where = `${cat.name} #${ri + 1}`;
      if (!cl.clue || cl.clue.length < 12) flag(ci, ri, `${where}: clue is missing or too short.`);
      if (!cl.response) flag(ci, ri, `${where}: response is missing.`);
      if (cl.clue.length > Math.max(60, Math.round(maxClue * 1.35))) flag(ci, ri, `${where}: clue is ${cl.clue.length} characters; keep it under ${maxClue} for this audience.`);
      else if (cl.clue.length > maxClue) soft.push(`${where}: clue is long for this audience.`);
      const core = coreAnswer(cl.response).toLowerCase();
      if (core.length >= 4 && cl.clue.toLowerCase().includes(core)) flag(ci, ri, `${where}: the clue gives away the answer "${coreAnswer(cl.response)}".`);
      if (core) {
        if (seenAns.has(core)) flag(ci, ri, `${where}: same answer as ${seenAns.get(core)}.`);
        else seenAns.set(core, where);
      }
    });
  });
  let final = null;
  if (raw.final && raw.final.clue && raw.final.response) {
    final = { category: clean(raw.final.category, 40) || 'Final Jeopardy', clue: clean(raw.final.clue, 260), response: asQuestion(raw.final.response) };
    const core = coreAnswer(final.response).toLowerCase();
    if (core.length >= 4 && final.clue.toLowerCase().includes(core)) flag(-1, -1, 'Final: the clue gives away the answer.');
  } else soft.push('No Final Jeopardy clue.');
  const board = { title: clean(raw.title, 60), categories, final };
  return { board: hard.length ? null : board, hard, soft, fixable, tuning, draft: board };
}

/* ---------------- demo boards (used when no AI key is configured) ---------------- */

const q = (clue, response) => ({ clue, response });
export const DEMO_BOARDS = [
  {
    title: '1800s History', match: /18|19th|history|victoria|railroad|gold|century|war/i,
    categories: [
      { name: 'Iron Horses', clues: [
        q("This British engineer's locomotive 'Rocket' won the 1829 Rainhill Trials.", 'Who is George Stephenson?'),
        q('In 1869 a golden spike joined two railroads at this Utah summit.', 'What is Promontory Summit?'),
        q('Before the telegraph took over, this 1860-61 mail service relayed riders across the West.', 'What is the Pony Express?'),
        q('Chartered in 1827, it was the first common-carrier railroad in the United States.', 'What is the Baltimore and Ohio Railroad?'),
        q('Thousands of workers from this country built much of the Central Pacific line through the Sierra Nevada.', 'What is China?'),
      ] },
      { name: 'Gold Rush Fever', clues: [
        q('The California Gold Rush began in 1848 after gold was found at this man\'s sawmill.', 'Who is John Sutter?'),
        q('Gold seekers who rushed west in 1849 got this nickname, later taken by a San Francisco football team.', 'What are the Forty-Niners?'),
        q("This late-1890s rush sent prospectors north to Canada's Yukon.", 'What is the Klondike Gold Rush?'),
        q('Miners swirled gravel and water in this shallow dish so heavy gold settled to the bottom.', 'What is a pan?'),
        q('Gold found on the Witwatersrand in 1886 led to the founding of this South African city.', 'What is Johannesburg?'),
      ] },
      { name: 'Revolutions of 1848', clues: [
        q('In 1848 Karl Marx and Friedrich Engels published this short political pamphlet.', 'What is The Communist Manifesto?'),
        q("The February Revolution of 1848 ended King Louis-Philippe's reign in this country.", 'What is France?'),
        q('In July 1848 this New York town hosted the first women\'s rights convention in the U.S.', 'What is Seneca Falls?'),
        q("Chancellor Metternich fled Vienna in 1848 as revolution shook this empire.", 'What is the Austrian Empire?'),
        q('This 1848 treaty ended the Mexican-American War.', 'What is the Treaty of Guadalupe Hidalgo?'),
      ] },
      { name: 'Painted in the 1800s', clues: [
        q('Vincent van Gogh painted this swirling night sky in 1889.', 'What is The Starry Night?'),
        q("Claude Monet's painting 'Impression, Sunrise' gave its name to this movement.", 'What is Impressionism?'),
        q("This Japanese artist made 'The Great Wave off Kanagawa' around 1831.", 'Who is Hokusai?'),
        q('Edgar Degas painted and sculpted dancers from this art form again and again.', 'What is ballet?'),
        q("Georges Seurat built 'A Sunday Afternoon on the Island of La Grande Jatte' out of tiny dots, a technique called this.", 'What is pointillism?'),
      ] },
      { name: "Inventors' Row", clues: [
        q('Alexander Graham Bell received a patent for this device in 1876.', 'What is the telephone?'),
        q("Thomas Edison's famous Menlo Park laboratory was in this U.S. state.", 'What is New Jersey?'),
        q("In 1844 Samuel Morse sent 'What hath God wrought' over this invention.", 'What is the telegraph?'),
        q('Karl Benz built an early practical automobile in 1885, powered by this kind of engine.', 'What is an internal combustion engine?'),
        q('Nikola Tesla championed this kind of electric current, now used by most power grids.', 'What is alternating current?'),
      ] },
      { name: 'The Victorians', clues: [
        q('She reigned over Britain from 1837 to 1901.', 'Who is Queen Victoria?'),
        q('Charles Dickens wrote this 1843 story about Ebenezer Scrooge.', 'What is A Christmas Carol?'),
        q('This glass-and-iron hall in London housed the Great Exhibition of 1851.', 'What is the Crystal Palace?'),
        q('Charles Darwin laid out natural selection in this 1859 book.', 'What is On the Origin of Species?'),
        q("Queen Victoria's German-born husband, he helped organize the Great Exhibition.", 'Who is Prince Albert?'),
      ] },
    ],
    final: { category: 'Famous Voyages', clue: 'Charles Darwin sailed around the world aboard this Royal Navy ship from 1831 to 1836.', response: 'What is HMS Beagle?' },
  },
  {
    title: 'The Ocean', match: /ocean|sea|marine|fish|beach|ship|water|whale/i,
    categories: [
      { name: 'Sea Creatures', clues: [
        q('This eight-armed animal can squirt ink to escape predators.', 'What is an octopus?'),
        q('The largest animal known to have ever lived, it feeds on tiny krill.', 'What is the blue whale?'),
        q('In this fish, named for a farm animal, the males carry the babies.', 'What is the seahorse?'),
        q('Its skeleton is made of cartilage, not bone; the great white is one.', 'What is a shark?'),
        q('Clownfish live safely among the stinging tentacles of this animal.', 'What is a sea anemone?'),
      ] },
      { name: 'Ocean Geography', clues: [
        q('This is the largest and deepest ocean on Earth.', 'What is the Pacific Ocean?'),
        q("The world's largest coral reef system lies off the coast of this country.", 'What is Australia?'),
        q('Challenger Deep, the deepest known point in the ocean, lies in this trench.', 'What is the Mariana Trench?'),
        q('The smallest ocean, it surrounds the North Pole.', 'What is the Arctic Ocean?'),
        q('This North Atlantic sea has no coastline and is named for its floating seaweed.', 'What is the Sargasso Sea?'),
      ] },
      { name: 'Ships & Sailors', clues: [
        q("Called unsinkable, this liner sank after hitting an iceberg in 1912.", 'What is the Titanic?'),
        q("Facing forward on a ship, the left side is called this.", 'What is port?'),
        q('In 1492 Columbus sailed with the Nina, the Pinta and this ship.', 'What is the Santa Maria?'),
        q('His expedition was the first to sail around the world, though he died on the way.', 'Who is Ferdinand Magellan?'),
        q('In a famous novel, this one-legged captain hunts the white whale Moby Dick.', 'Who is Captain Ahab?'),
      ] },
      { name: 'Waves & Weather', clues: [
        q("They rise and fall about twice a day, mostly because of the Moon's pull.", 'What are tides?'),
        q('A giant wave set off by an undersea earthquake.', 'What is a tsunami?'),
        q('In the Atlantic it is a hurricane; in the western Pacific the same kind of storm is called this.', 'What is a typhoon?'),
        q('This warm current carries water from the Gulf of Mexico across the Atlantic toward Europe.', 'What is the Gulf Stream?'),
        q("This periodic warming of the Pacific off South America is Spanish for 'the boy'.", 'What is El Nino?'),
      ] },
      { name: 'Beach Day', clues: [
        q('Tiny grains of worn-down rock and shell cover most beaches.', 'What is sand?'),
        q('This five-armed sea creature can regrow a lost arm.', 'What is a sea star?'),
        q('Hermit crabs move into these borrowed homes as they grow.', 'What are shells?'),
        q("Hawaiians practiced it for centuries and called it he'e nalu, or wave sliding.", 'What is surfing?'),
        q('This flat, round relative of the sea urchin often washes up looking like a coin.', 'What is a sand dollar?'),
      ] },
      { name: 'Deep Blue Words', clues: [
        q('A person who sails or works on a ship.', 'What is a sailor?'),
        q('This heavy hook keeps a ship from drifting.', 'What is an anchor?'),
        q('Sailors use this word for the floor of a ship.', 'What is the deck?'),
        q('This tall post holds up a ship\'s sails.', 'What is the mast?'),
        q('A nautical mile per hour is called this.', 'What is a knot?'),
      ] },
    ],
    final: { category: 'Ocean Explorers', clue: 'In 1960 Jacques Piccard and Don Walsh rode this bathyscaphe to the bottom of the Challenger Deep.', response: 'What is the Trieste?' },
  },
];

export function demoBoard(topic, size, rand = Math.random) {
  const { cols, rows } = SIZES[size] || SIZES['6x5'];
  let base = DEMO_BOARDS.find((b) => topic && b.match.test(topic));
  if (!base) base = DEMO_BOARDS[Math.floor(rand() * DEMO_BOARDS.length)];
  return {
    title: base.title,
    categories: base.categories.slice(0, cols).map((c) => ({ name: c.name, clues: c.clues.slice(0, rows).map((x) => ({ ...x })) })),
    final: { ...base.final },
    demo: true,
  };
}

/* ---------------- AI generation ---------------- */

const SYSTEM = `You write boards for Infinite Jeopardy, a Jeopardy-style party game played on a TV with phone buzzers.

Rules for every board:
- Exactly the number of categories and clues asked for. Category names are short (2 to 4 words, under 28 characters), distinct from each other, and playful but clear.
- Each clue is a statement that points to exactly one answer. Each response is phrased as a question: "What is ...?" or "Who is ...?" Keep responses short (1 to 5 words) so they can be judged out loud.
- Difficulty climbs within each category in steady steps, following the difficulty ladder in the request. Clues in the same row are equally hard across categories.
- Only use well-established facts. If you are not sure a fact is true, use a different clue. No trick questions, no opinions, nothing that changes year to year.
- Never put the answer, or an obvious form of it, inside the clue.
- Every response on the board is different, and every answer fits its category name.
- Clues are short enough for a room to read on a TV; the exact limit for this audience is in the request.
- Family friendly: no sexual content, slurs, graphic violence or drugs, unless the audience is explicitly adults, and even then keep it party-appropriate.
- The request describes the audience: its reading level, how hard the easiest and hardest clues should be, and which clue styles to use. Follow it closely. A board that is too hard or too wordy for its audience is a failed board.
- The final clue is the hardest on the board, with its own category name, and still fits the audience.`;

export function userPrompt({ topic, age, size, tune }, feedback) {
  const { cols, rows } = SIZES[size] || SIZES['6x5'];
  const aud = audiencePrompt(age, tune, rows);
  let p = `Make a board about: ${topic}\n\n${aud.text}\n\nCategories: ${cols}\nClues per category: ${rows} (easiest first)\nAlso write one Final Jeopardy clue.\nGive the board a short title (under 40 characters).`;
  if (feedback && feedback.length) p += `\n\nYour last attempt had these problems. Fix every one:\n- ${feedback.slice(0, 12).join('\n- ')}`;
  return p;
}

export async function generateBoard(env, req, deps = {}) {
  const topic = clean(req.topic, LIMITS.TOPIC);
  const age = clean(req.age, LIMITS.AGE);
  const size = SIZES[req.size] ? req.size : '6x5';
  const tune = cleanTune(req.tune, age);
  const band = bandFor(age);
  const maxClue = BANDS[band].maxClue;
  const lad = ladderFor(tune.level, (SIZES[size] || SIZES['6x5']).rows);
  if (!topic) throw new UserError('Type what the board should be about, or roll the dice.');
  if (!env.ANTHROPIC_API_KEY) {
    const b = demoBoard(topic, size);
    return { ...b, topic, age, band, demo: true };
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const { z } = await import('zod');
  const Schema = z.object({
    title: z.string(),
    categories: z.array(z.object({ name: z.string(), clues: z.array(z.object({ clue: z.string(), response: z.string(), known: z.number() })) })),
    final: z.object({ category: z.string(), clue: z.string(), response: z.string(), known: z.number() }),
  });
  const client = deps.client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 240_000, maxRetries: 1, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const FixSchema = z.object({ fixes: z.array(z.object({ id: z.number(), clue: z.string(), response: z.string() })) });
  const MAX_CALLS = 3;
  // Time budget: a room is waiting. No new full attempt after NEW_CALL_MS, no rewrite after FIX_MS,
  // and each request may only use what is left of TOTAL_MS (at least 20 s).
  const t0 = Date.now(), TOTAL_MS = 200_000, NEW_CALL_MS = 100_000, FIX_MS = 130_000;
  const elapsed = () => Date.now() - (deps.start || t0);
  let calls = 0, feedback = null, cutOff = false, last = null;
  const call = async (params) => {
    calls++;
    try { return await client.messages.parse({ model: MODEL, system: SYSTEM, ...params }, { timeout: Math.min(150_000, Math.max(20_000, TOTAL_MS - elapsed())) }); }
    catch (e) {
      if (e && e.status === 429) throw new UserError('The AI is busy right now. Try again in a minute.');
      if (e && (e.status === 401 || e.status === 403)) throw new UserError('The AI key was rejected. Check the ANTHROPIC_API_KEY secret.');
      if (e && e.status) throw new UserError('Could not reach the AI. Try again.');
      return null; // a reply that did not fit the schema: treat like a bad attempt
    }
  };
  const stats = { level: tune.level, calls: 0, offLadder: 0, ms: 0, notes: [] }; // notes: why each extra call happened
  const done = (b) => { stats.calls = calls; stats.ms = elapsed(); return { ...b, topic, age, band, demo: false, stats }; };
  const keep = (v) => done(v.draft);
  const dupOnly = (v) => v && v.draft && v.hard.length && v.hard.every((h) => /same answer as/.test(h));
  while (calls < MAX_CALLS && (calls === 0 || elapsed() < NEW_CALL_MS)) {
    const res = await call({
      max_tokens: 32000, // Haiku 5.5 thinks by default and thinking counts toward this cap; leave it plenty of room
      // Thinking helps fact quality, but it once ran past the cap on a wordplay-heavy board; if that happens, write straight out.
      ...(cutOff ? { thinking: { type: 'disabled' } } : {}),
      messages: [{ role: 'user', content: userPrompt({ topic, age, size, tune }, feedback) }],
      // Effort 'high' was tried for Extreme: Haiku thought for minutes and the room was left waiting. Medium for every level.
      output_config: { effort: cutOff ? 'low' : 'medium', format: zodOutputFormat(Schema) },
    });
    if (res && res.stop_reason === 'refusal') throw new UserError('The AI would not make a board about that. Try a different topic.');
    if (!res || res.stop_reason === 'max_tokens' || !res.parsed_output) {
      console.warn(`board call ${calls}: stop_reason=${res && res.stop_reason}, parsed=${!!(res && res.parsed_output)}`);
      cutOff = cutOff || !!(res && res.stop_reason === 'max_tokens');
      stats.notes.push(`call ${calls}: ${res ? (res.stop_reason === 'max_tokens' ? 'cut off' : 'did not fit the format') : 'no reply'}`);
      feedback = ['The answer was cut off or was not valid JSON. Keep clues shorter.'];
      continue;
    }
    let v = validateBoard(res.parsed_output, size, maxClue, lad);
    if (v.board) {
      stats.offLadder = v.tuning.length;
      // A playable board with a few clues far off their row's difficulty: rewrite just those, once.
      if (v.tuning.length && v.tuning.length <= 8 && calls < MAX_CALLS && elapsed() < FIX_MS) {
        console.warn(`board call ${calls} off the ladder (${band}, level ${tune.level}): ${v.tuning.map((t) => t.msg).join(' | ')}`);
        const fixed = await repairClues(call, FixSchema, zodOutputFormat, { ...v, fixable: v.tuning }, { topic, age, tune, rows: lad.length });
        const v2 = fixed && validateBoard(fixed, size, maxClue, lad);
        if (v2 && v2.board) { stats.rewritten = v.tuning.length; return done(v2.board); }
      }
      return done(v.board);
    }
    console.warn(`board call ${calls} needs work (${band}): ${v.hard.join(' | ')}`);
    stats.notes.push(`call ${calls}: ${v.hard.length} problem${v.hard.length === 1 ? '' : 's'}: ${v.hard.slice(0, 3).join(' | ').slice(0, 300)}`);
    // A few bad clues: rewrite just those instead of the whole board (a full rewrite tends to make new mistakes).
    if (v.fixable.length && v.fixable.length === v.hard.length && v.fixable.length <= 12 && calls < MAX_CALLS && elapsed() < FIX_MS) {
      const fixed = await repairClues(call, FixSchema, zodOutputFormat, v, { topic, age, tune, rows: lad.length });
      if (fixed) {
        const v2 = validateBoard(fixed, size, maxClue, lad);
        if (v2.board) return done(v2.board);
        console.warn(`repair call ${calls} left (${band}): ${v2.hard.join(' | ')}`);
        v = v2;
      }
    }
    last = v;
    feedback = v.hard;
  }
  // Out of calls: a repeated answer is a small flaw, a missing board stops the game.
  if (dupOnly(last)) { console.warn(`board kept with repeats (${band}): ${last.hard.join(' | ')}`); return keep(last); }
  throw new UserError('The AI board had problems. Try again or tweak the topic.');
}

// Rewrites only the clues the checker flagged, keeping the rest of the board.
async function repairClues(call, FixSchema, zodOutputFormat, v, { topic, age, tune, rows }) {
  const b = structuredClone(v.draft);
  const items = v.fixable.map((f, id) => {
    const cat = f.c < 0 ? null : b.categories[f.c];
    const cl = f.c < 0 ? b.final : cat.clues[f.r];
    return { id, f, text: `[${id}] ${f.c < 0 ? `Final Jeopardy (${b.final.category})` : `${cat.name}, row ${f.r + 1}`}. Problem: ${f.msg}\n    Old clue: ${cl.clue}\n    Old response: ${cl.response}` };
  });
  const taken = new Set();
  b.categories.forEach((c) => c.clues.forEach((x) => taken.add(coreAnswer(x.response))));
  const prompt = `Replace these clues on a board about: ${topic}\n\n${audiencePrompt(age, tune, rows).text}\n\nFor each one, write a new clue and response for the same category, at the difficulty the problem names (otherwise the same difficulty). The clue must never contain the answer or a form of it. Every new response must be different from all of these responses already on the board: ${[...taken].join('; ')}.\n\n${items.map((i) => i.text).join('\n')}`;
  const res = await call({ max_tokens: 16000, messages: [{ role: 'user', content: prompt }], output_config: { effort: 'low', format: zodOutputFormat(FixSchema) } });
  if (!res || !res.parsed_output || !Array.isArray(res.parsed_output.fixes)) return null;
  for (const fx of res.parsed_output.fixes) {
    const it = items.find((i) => i.id === fx.id);
    if (!it || !fx.clue || !fx.response) continue;
    if (it.f.c < 0) { b.final.clue = fx.clue; b.final.response = fx.response; }
    else b.categories[it.f.c].clues[it.f.r] = { clue: fx.clue, response: fx.response };
  }
  return b;
}

export class UserError extends Error {}
