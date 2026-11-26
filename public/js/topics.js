// The dice: broad, general topics. Each has a minimum age so younger groups get younger topics.
const TOPICS = [
  // [topic, minAge]
  ['Dinosaurs', 5], ['Outer Space', 5], ['Ocean Animals', 5], ['Fairy Tales', 5], ['Animals of the World', 5], ['Weather', 6],
  ['Bugs and Creepy Crawlies', 5], ['Colors and Shapes', 4], ['Famous Cartoons', 6], ['The Human Body', 7], ['Sports', 7],
  ['Food Around the World', 7], ['Volcanoes and Earthquakes', 7], ['Inventions', 8], ['World Landmarks', 8], ['Rainforests', 6],
  ['Ancient Egypt', 8], ['Knights and Castles', 8], ['Pirates', 7], ['Music Instruments', 7], ['Planets and Moons', 7],
  ['U.S. Presidents', 10], ['World Capitals', 10], ['Greek Mythology', 10], ['The Olympics', 9], ['Famous Scientists', 10],
  ['Rivers and Mountains', 9], ['Video Game History', 10], ['Classic Movies', 12], ['Architecture', 12], ['1800s History', 12],
  ['European Wars', 13], ['The Roman Empire', 11], ['Art History', 12], ['World Religions', 13], ['The Renaissance', 12],
  ['Inventions of the 1900s', 11], ['Space Race', 12], ['Shakespeare', 13], ['Famous Paintings', 11], ['The Cold War', 14],
  ['Ancient China', 11], ['Medieval Europe', 12], ['The Human Brain', 12], ['Chemistry', 13], ['Famous Bridges', 11],
  ['Broadway Musicals', 13], ['Mythical Creatures', 8], ['Board Games', 9], ['Codes and Ciphers', 12], ['Islands', 9],
  ['Explorers', 10], ['The Industrial Revolution', 13], ['Philosophy', 16], ['Economics', 16], ['Wine and Cheese', 21],
  ['Cocktail History', 21], ['Fashion Through the Decades', 14], ['1980s Pop Culture', 15], ['1990s Pop Culture', 15],
  ['Famous Speeches', 14], ['Ancient Wonders', 10], ['Deserts', 9], ['Birds', 7], ['Trains', 7], ['Chess', 10],
  ['Women in Science', 11], ['National Parks', 9], ['Languages of the World', 12], ['Typography and Fonts', 14],
];
const MIXERS = ['and', 'meets'];

// "10-12", "8+", "adults", "teens", "kids", "college" -> a single representative age (or null)
export function parseAge(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  if (/adult|grown|college|21|parents/.test(t)) return 25;
  if (/teen/.test(t)) return 15;
  if (/kid|child|little/.test(t)) return 8;
  if (/preschool|toddler/.test(t)) return 4;
  const nums = (t.match(/\d+/g) || []).map(Number).filter((n) => n > 0 && n < 120);
  if (!nums.length) return null;
  return Math.min(...nums); // aim at the youngest player in the range
}

export function rollTopic(ageText, rand = Math.random) {
  const age = parseAge(ageText);
  const pool = TOPICS.filter(([, min]) => age == null ? min >= 8 && min <= 16 : min <= age && min >= Math.min(age - 8, 12));
  const list = pool.length ? pool : TOPICS.filter(([, min]) => min <= (age ?? 99));
  const pickOne = () => list[Math.floor(rand() * list.length)][0];
  // Most rolls are one topic; sometimes two get mashed together for a stranger board.
  if (rand() < 0.22 && list.length > 4) {
    const a = pickOne(); let b = pickOne();
    for (let i = 0; i < 5 && b === a; i++) b = pickOne();
    if (a !== b) return `${a} ${MIXERS[Math.floor(rand() * MIXERS.length)]} ${b}`;
  }
  return pickOne();
}
