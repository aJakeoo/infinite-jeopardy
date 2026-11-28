// Age bands and question styles. Shared by the TV (to pre-tick the fine-tune boxes) and the
// server (to build the AI prompt), so both always agree on what each band and style means.

// "10-12", "8+", "adults", "teens", "kids", "college" -> a single representative age (or null)
export function parseAge(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  const nums = (t.match(/\d+/g) || []).map(Number).filter((n) => n > 0 && n < 120);
  if (nums.length) return Math.min(...nums); // aim at the youngest player in the range
  if (/preschool|toddler/.test(t)) return 4;
  if (/family|everyone|all ages/.test(t)) return 8;
  if (/kid|child|little/.test(t)) return 8;
  if (/tween/.test(t)) return 11;
  if (/teen|high school/.test(t)) return 15;
  if (/adult|grown|college|parents/.test(t)) return 25;
  return null;
}

export const BANDS = {
  little: {
    label: 'Little kids', ages: '4 to 6', maxClue: 90,
    reading: 'Words a 5-year-old knows. One short sentence per clue. The clue will be read aloud, so it must work by ear.',
    easy: 'something every preschooler knows (colors, farm animals, a favorite cartoon)',
    hard: 'something a kindergartner has learned at school or from a picture book',
  },
  kids: {
    label: 'Kids', ages: '7 to 9', maxClue: 110,
    reading: 'Plain words at a second-to-fourth-grade reading level. Short sentences, no tricky vocabulary.',
    easy: 'something almost every 7-year-old knows',
    hard: 'something a curious 9-year-old who likes the topic would know',
  },
  tweens: {
    label: 'Tweens', ages: '10 to 12', maxClue: 130,
    reading: 'Middle-grade reading level. Clear sentences; school-subject vocabulary is fine.',
    easy: 'common knowledge for a 10-year-old',
    hard: 'what a strong sixth grader who studied the topic would know',
  },
  teens: {
    label: 'Teens', ages: '13 to 17', maxClue: 150,
    reading: 'High-school reading level.',
    easy: 'common knowledge for a 13-year-old',
    hard: 'what a high-school student who knows the topic well would know',
  },
  adults: {
    label: 'Adults', ages: '18 and up', maxClue: 160,
    reading: 'Adult vocabulary, written in the crisp style of TV quiz clues.',
    easy: 'general knowledge most adults have',
    hard: 'what a keen trivia player would know; real Jeopardy difficulty',
  },
};

// The age dropdown: one checkbox per band plus an "Other" text box, stored together as one string.
export const AGE_PRESETS = [['little', '4-6'], ['kids', '7-9'], ['tweens', '10-12'], ['teens', '13-17'], ['adults', '18+']];
export function composeAges(bandIds, other) {
  const parts = AGE_PRESETS.filter(([id]) => bandIds.includes(id)).map(([, r]) => r);
  const o = String(other || '').trim();
  if (o) parts.push(o);
  return parts.join(', ').slice(0, 30);
}
export function splitAges(text) {
  const bands = [], rest = [];
  for (const part of String(text || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const p = AGE_PRESETS.find(([, r]) => r === part);
    if (p) bands.push(p[0]); else rest.push(part);
  }
  return { bands, other: rest.join(', ') };
}
export function agesLabel(text) {
  const { bands, other } = splitAges(text);
  const names = bands.map((id) => BANDS[id].label);
  if (other) names.push(other);
  if (!names.length) return 'Any age';
  return names.length > 2 ? `${names[0]} + ${names.length - 1} more` : names.join(', ');
}

export function bandFor(ageText) {
  const a = parseAge(ageText);
  if (a == null) return 'adults';
  if (a <= 6) return 'little';
  if (a <= 9) return 'kids';
  if (a <= 12) return 'tweens';
  if (a <= 17) return 'teens';
  return 'adults';
}

// Each style: label on the TV, the instruction for the AI, and which bands tick it by default.
export const STYLES = {
  facts: { label: 'Straight facts', on: ['little', 'kids', 'tweens', 'teens', 'adults'],
    prompt: 'Straight facts: plain clues that describe the answer directly.' },
  describe: { label: 'Describe it', on: ['little', 'kids'],
    prompt: 'Describe it: clues about what something looks like, sounds like or does ("This big gray animal has a trunk").' },
  hints: { label: 'Extra hints', on: ['little', 'kids'],
    prompt: 'Extra hints: on the harder clues, add a helping hint such as the first letter, the number of letters, or a word it rhymes with ("It starts with the letter M"). Never name the answer itself.' },
  letters: { label: 'Same letter', on: ['kids', 'tweens'],
    prompt: 'Same letter: one category where every answer starts with the same letter, named like "Begins with B".' },
  // Rhyme time and Before & After are opt-in: live tests showed Haiku copying examples and writing pairs that do not work.
  rhyme: { label: 'Rhyme time', on: [],
    prompt: 'Rhyme time: one category whose answers are two-word rhyming phrases tied to the topic; the clue describes the phrase without using either word. Invent your own pairs.' },
  wordplay: { label: 'Wordplay', on: ['tweens', 'teens', 'adults'],
    prompt: 'Wordplay: punny category names and a few clues that play on words, while each answer stays a real fact.' },
  beforeafter: { label: 'Before & After', on: [],
    prompt: 'Before & After: one category where each answer joins two things that share a word. The clue describes both halves without naming either one ("16th president meets the DC monument with his statue" is "What is Abraham Lincoln Memorial?").' },
  pop: { label: 'Pop culture', on: ['teens'],
    prompt: 'Pop culture: tie some clues to movies, shows, games, music and famous people that this audience would know, keeping them tied to the topic.' },
  numbers: { label: 'Numbers & dates', on: ['teens', 'adults'],
    prompt: 'Numbers and dates: some answers can be years, counts or measurements, as long as they are well established.' },
};
export const STYLE_IDS = Object.keys(STYLES);

export const LEVELS = { '-1': 'Easier', '0': 'Just right', '1': 'Harder', '2': 'Extreme' };
export const LEVEL_IDS = [-1, 0, 1, 2];

// Percent of the audience who should get each row right, from the first row to the last.
// Playtesters found boards jumpy (an easy clue next to a brutal one), so every category follows one ladder.
const LADDER = { '-1': [95, 60], '0': [90, 35], '1': [75, 20], '2': [30, 3] };
export function ladder(level, rows = 5) {
  const [a, b] = LADDER[String(level)] || LADDER['0'];
  return Array.from({ length: rows }, (_, i) => Math.round(a + (b - a) * (rows < 2 ? 0 : i / (rows - 1))));
}

export function defaultTune(ageText) {
  const band = bandFor(ageText);
  return { level: 0, styles: STYLE_IDS.filter((id) => STYLES[id].on.includes(band)) };
}

// Cleans whatever a client sent; falls back to the age defaults.
export function cleanTune(t, ageText) {
  const d = defaultTune(ageText);
  if (!t || typeof t !== 'object') return d;
  const level = LEVEL_IDS.includes(Number(t.level)) ? Number(t.level) : 0;
  const styles = Array.isArray(t.styles) ? STYLE_IDS.filter((id) => t.styles.includes(id)) : d.styles;
  return { level, styles };
}

// The audience block of the AI prompt.
export function audiencePrompt(ageText, tune, rows = 5) {
  const bandId = bandFor(ageText);
  const b = BANDS[bandId];
  const t = cleanTune(tune, ageText);
  const lines = [
    `Audience: ${ageText ? `ages ${ageText}` : 'not given, so a general adult audience'} (the "${b.label}" band, ${b.ages}).`,
    `Reading level: ${b.reading}`,
    `Clue length: every clue under ${b.maxClue} characters.`,
  ];
  if (t.level === 2) {
    lines.push('Difficulty: EXTREME. This group asked for super niche deep cuts. Pick narrow, specific categories inside the topic.',
      `Even the first clue in each category should stump a casual fan: it is something a big fan of the topic would know. The last is a deep cut only a true expert or superfan would get.${bandId === 'adults' ? '' : ` The audience is still ${b.ages}: niche for that age, not adult-only facts.`}`,
      'The ANSWERS themselves must be niche. A famous answer (a hit movie, a household name, a landmark) is not Extreme, however obscure the detail in its clue, because players will guess it. Pick lesser-known works, people, places and things.',
      'Niche never means unsure: use only documented facts you are certain of. Each clue stays fair, with one clear answer.');
  } else {
    lines.push(`Difficulty: the first clue in each category is ${b.easy}; the last is ${b.hard}.`);
    if (t.level === -1) lines.push('Difficulty adjustment: make the whole board a clear notch easier than that.');
    if (t.level === 1) lines.push('Difficulty adjustment: make the whole board a clear notch harder than that, still fair.');
  }
  const lad = ladder(t.level, rows);
  lines.push('Difficulty ladder. Every category follows it, so clues in the same row feel equally hard across the whole board:',
    ...lad.map((p, i) => `- Row ${i + 1}${i === 0 ? ' (easiest)' : i === rows - 1 ? ' (hardest)' : ''}: about ${p}% of this audience would get it right.`),
    `- Final Jeopardy: about ${Math.max(2, Math.round(lad[rows - 1] * 0.7))}%.`,
    'Climb in steady, even steps. Difficulty comes only from how well known the fact is, never from vague, tricky or misleading wording.',
    'For every clue, set "known" to your honest estimate of the percent of this audience who would get it right. Rate strictly: if the answer is a name most of this audience has heard of, many will guess it from almost any clue, so rate it high.');
  if (t.styles.length) {
    lines.push('Clue styles to use (mix them across the board; every category still stays on the topic):');
    for (const id of t.styles) lines.push(`- ${STYLES[id].prompt}`);
    const off = STYLE_IDS.filter((id) => !t.styles.includes(id) && id !== 'facts').map((id) => STYLES[id].label);
    if (off.length) lines.push(`Do not use these styles: ${off.join(', ')}.`);
  } else {
    lines.push('Clue styles: use plain, direct clues.');
  }
  return { text: lines.join('\n'), band: bandId, maxClue: b.maxClue, tune: t, ladder: ladder(t.level, rows) };
}

export function tuneSummary(ageText, tune) {
  const b = BANDS[bandFor(ageText)];
  const t = cleanTune(tune, ageText);
  return `${b.label}, ${LEVELS[String(t.level)].toLowerCase()}, ${t.styles.length} style${t.styles.length === 1 ? '' : 's'}`;
}
