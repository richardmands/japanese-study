// Reads Richard's two Japanese decks from Anki desktop (via AnkiConnect, read-only) and writes
// this repo's study files: a README for AI tutors, vocabulary and kanji lists by status, and
// JSON. With --push it commits and pushes when anything changed.
// Usage: node scripts/export.mjs [--push]
// Strictly read-only towards Anki: only the actions in `readOnly` can ever be sent.
import {writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = 'Richard Listening';
const DECKS = {vocab: '1749055672457', kanji: '1791558539736'};
const readOnly = new Set(['version', 'getActiveProfile', 'findCards', 'cardsInfo', 'getReviewsOfCards']);

async function anki(action, params = {}) {
  if (!readOnly.has(action)) throw Error(`Refusing AnkiConnect action "${action}".`);
  const r = await fetch('http://127.0.0.1:8765', {method: 'POST', body: JSON.stringify({action, version: 6, params}), signal: AbortSignal.timeout(180000)});
  const body = await r.json();
  if (body.error) throw Error(`AnkiConnect ${action}: ${body.error}`);
  return body.result;
}

const strip = s => String(s ?? '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/(, )+/g, ', ').trim();
const londonDay = ms => new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/London'}).format(new Date(ms));
const chunks = (a, n) => Array.from({length: Math.ceil(a.length / n)}, (_, i) => a.slice(i * n, i * n + n));
// Anki card state: type 0 new, 1 learning, 2 review, 3 relearning; queue -1 suspended.
const stateOf = c => c.type === 0 ? 'new' : c.type === 1 ? 'learning' : c.type === 3 ? 'relearning' : c.interval >= 21 ? 'mature' : 'young';

async function readDeck(did) {
  const ids = await anki('findCards', {query: `did:${did}`});
  const cards = [], reviews = {};
  for (const part of chunks(ids, 500)) {
    cards.push(...await anki('cardsInfo', {cards: part}));
    Object.assign(reviews, await anki('getReviewsOfCards', {cards: part.map(String)}));
  }
  return {cards, reviews};
}

// One entry per note: its active (not suspended) cards decide status, like the app does.
function notes(cards, reviews, pick) {
  const by = new Map();
  for (const c of cards) by.set(c.note, [...(by.get(c.note) ?? []), c]);
  const out = [];
  for (const all of by.values()) {
    const active = all.filter(c => c.queue !== -1);
    if (!active.length) continue;
    const states = active.map(stateOf);
    const status = states.every(s => s === 'mature') ? 'mature' : states.every(s => s === 'new') ? 'new' : states.some(s => s === 'learning' || s === 'relearning') ? 'learning' : 'young';
    const revs = active.flatMap(c => (reviews[c.cardId] ?? []).filter(r => r.type !== 4));
    const times = revs.map(r => r.id).sort((a, b) => a - b);
    out.push({
      ...pick(all[0].fields),
      status,
      interval: Math.min(...active.map(c => c.interval)),
      lapses: Math.max(...active.map(c => c.lapses ?? 0)),
      reviews: revs.length,
      first: times.length ? londonDay(times[0]) : null,
      last: times.length ? londonDay(times.at(-1)) : null,
    });
  }
  return out;
}

const vocabPick = f => ({word: strip(f['Vocabulary-Kanji']?.value), reading: strip(f['Vocabulary-Kana']?.value), meaning: strip(f['Vocabulary-English']?.value), pos: strip(f['Vocabulary-Pos']?.value), rank: Number(strip(f['Optimized-Voc-Index']?.value)) || null});
// Kun readings come as "か,わる</br>か,える": a comma marks where the okurigana starts.
const kun = raw => String(raw ?? '').split(/<\/?br\s*\/?>/i).map(x => strip(x)).filter(Boolean).map(x => x.includes(',') ? x.replace(',', '(') + ')' : x).join(', ');
const kanjiPick = f => ({kanji: strip(f.Kanji?.value), keyword: strip(f.Keyword_KKLC?.value || f.Keyword_RTK?.value).toLowerCase(), on: strip(f.Reading_On?.value).replace(/ ・ /g, ', '), kun: kun(f.Reading_Kun?.value), strokes: Number(strip(f.Info_Stroke_Count?.value)) || null, jlpt: strip(f.Info_JLPT_Level?.value) || null});

function activity(...decks) {
  const days = {};
  for (const {reviews} of decks) for (const list of Object.values(reviews)) for (const r of list) if (r.type !== 4) { const d = londonDay(r.id); days[d] = (days[d] ?? 0) + 1; }
  return days;
}
function streak(days, today) {
  const prev = d => new Date(Date.parse(d + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  let d = days[today] ? today : prev(today), n = 0;
  while (days[d]) { n++; d = prev(d); }
  return n;
}

const line = {
  vocab: v => `- ${v.word}${v.reading && v.reading !== v.word ? `（${v.reading}）` : ''} — ${v.meaning}${v.pos ? ` · ${v.pos.toLowerCase()}` : ''}${v.lapses >= 3 ? ` · forgotten ${v.lapses}×` : ''}`,
  kanji: k => `- ${k.kanji} — ${k.keyword}${k.on ? ` · on: ${k.on}` : ''}${k.kun ? ` · kun: ${k.kun}` : ''}${k.lapses >= 3 ? ` · forgotten ${k.lapses}×` : ''}`,
};
const page = (title, intro, items, fmt) => `# ${title}\n\n${intro}\n\n${items.length} items.\n\n${items.map(fmt).join('\n')}\n`;

async function main() {
  await anki('version');
  const profile = await anki('getActiveProfile');
  if (profile !== PROFILE) throw Error(`Anki has "${profile}" open, not "${PROFILE}"; nothing exported.`);
  const vRaw = await readDeck(DECKS.vocab), kRaw = await readDeck(DECKS.kanji);
  const vocab = notes(vRaw.cards, vRaw.reviews, vocabPick).sort((a, b) => (a.rank ?? 9e9) - (b.rank ?? 9e9));
  const kanji = notes(kRaw.cards, kRaw.reviews, kanjiPick);
  const now = new Date(), today = londonDay(now.getTime()), days = activity(vRaw, kRaw);
  const cut = new Date(Date.parse(today + 'T12:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
  const week = Array.from({length: 7}, (_, i) => days[new Date(Date.parse(today + 'T12:00:00Z') - (6 - i) * 86400000).toISOString().slice(0, 10)] ?? 0);
  const count = (list, s) => list.filter(x => x.status === s).length;
  const recent = list => list.filter(x => x.first && x.first >= cut && x.status !== 'new').sort((a, b) => b.first.localeCompare(a.first));
  const weak = list => list.filter(x => x.status !== 'new' && (x.lapses >= 3 || x.status === 'learning')).sort((a, b) => b.lapses - a.lapses);

  mkdirSync(join(root, 'vocabulary'), {recursive: true}); mkdirSync(join(root, 'kanji'), {recursive: true}); mkdirSync(join(root, 'data'), {recursive: true});
  const w = (p, s) => writeFileSync(join(root, p), s);
  const V = 'Japanese words from the Core 2k/6k deck, in frequency order. Format: word（reading）— meaning · part of speech.';
  const K = 'Kanji with keyword and on/kun readings.';
  w('vocabulary/mature.md', page('Vocabulary: mature (well known)', V + ' Reviewed successfully at intervals of 21 days or more.', vocab.filter(v => v.status === 'mature'), line.vocab));
  w('vocabulary/young.md', page('Vocabulary: young (known, still settling)', V + ' Learned, but intervals under 21 days.', vocab.filter(v => v.status === 'young'), line.vocab));
  w('vocabulary/learning.md', page('Vocabulary: learning', V + ' In the learning or relearning steps right now.', vocab.filter(v => v.status === 'learning'), line.vocab));
  w('vocabulary/recent.md', page('Vocabulary: started in the last 30 days', V + ' Newest first. The best list for reinforcement.', recent(vocab), line.vocab));
  w('vocabulary/weak.md', page('Vocabulary: weak spots', V + ' Forgotten 3 or more times, or currently relearning. Most-forgotten first.', weak(vocab), line.vocab));
  w('vocabulary/not-started.md', page('Vocabulary: not started yet', V + ' Not reviewed yet: do not assume these are known.', vocab.filter(v => v.status === 'new'), line.vocab));
  w('kanji/mature.md', page('Kanji: mature', K, kanji.filter(k => k.status === 'mature'), line.kanji));
  w('kanji/young.md', page('Kanji: young', K, kanji.filter(k => k.status === 'young'), line.kanji));
  w('kanji/learning.md', page('Kanji: learning', K, kanji.filter(k => k.status === 'learning'), line.kanji));
  w('kanji/recent.md', page('Kanji: started in the last 30 days', K + ' Newest first.', recent(kanji), line.kanji));
  w('kanji/weak.md', page('Kanji: weak spots', K + ' Forgotten 3 or more times, or relearning.', weak(kanji), line.kanji));
  w('data/vocabulary.json', JSON.stringify(vocab, null, 1));
  w('data/kanji.json', JSON.stringify(kanji, null, 1));
  w('data/activity.json', JSON.stringify(days, null, 1));

  const raw = 'https://raw.githubusercontent.com/richardmands/japanese-study/main/';
  const link = p => `[${p}](${raw}${p})`;
  w('README.md', `# Richard's Japanese study

This repo is the live state of my Japanese study in Anki, exported automatically so that AI tutors (ChatGPT, Claude) can teach me at exactly my level. Updated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.

## Where I am

- **${streak(days, today)}-day streak**, ${Math.round(week.reduce((a, b) => a + b, 0) / 7)} reviews a day over the last week.
- **Vocabulary** (Core 2k/6k, ${vocab.length} words): ${count(vocab, 'mature')} mature, ${count(vocab, 'young')} young, ${count(vocab, 'learning')} learning, ${count(vocab, 'new')} not started. ${recent(vocab).length} started in the last 30 days.
- **Kanji** (${kanji.length}): ${count(kanji, 'mature')} mature, ${count(kanji, 'young')} young, ${count(kanji, 'learning')} learning, ${count(kanji, 'new')} not started.

## How to help me (instructions for AI tutors)

Read the lists below first. Plain-text links are given because they are easiest to fetch.

**Targeted review (mature vocabulary).** Quiz me on words from \`vocabulary/mature.md\`. Mix question types: Japanese → English, English → Japanese, reading a word written in kanji, and short sentences that combine several mature words. Write any sentences you use yourself, using only words I know (mature or young) plus basic grammar.

**Reinforcement (newer vocabulary).** Test me on \`vocabulary/recent.md\` and \`vocabulary/weak.md\`. Use them in simple sentences built from my mature words, so the new word is the only unknown. Repeat anything I get wrong later in the session.

**Rules**
- Treat everything in \`not-started.md\` as unknown. Don't use it except as a clearly marked new word.
- One question at a time; wait for my answer; tell me briefly why it was right or wrong.
- Use kanji for words I know in kanji (see \`kanji/mature.md\`), otherwise kana.
- Keep a running score and finish with the words I missed.

## Files

| File | What |
|---|---|
| ${link('vocabulary/mature.md')} | Well known words: for targeted review |
| ${link('vocabulary/young.md')} | Known but still settling |
| ${link('vocabulary/recent.md')} | Started in the last 30 days: for reinforcement |
| ${link('vocabulary/weak.md')} | Often forgotten or relearning |
| ${link('vocabulary/learning.md')} | In learning steps now |
| ${link('vocabulary/not-started.md')} | Not studied yet |
| ${link('kanji/mature.md')} · ${link('kanji/young.md')} · ${link('kanji/recent.md')} · ${link('kanji/weak.md')} · ${link('kanji/learning.md')} | Kanji by status |
| ${link('data/vocabulary.json')} · ${link('data/kanji.json')} · ${link('data/activity.json')} | The same data as JSON, plus reviews per day |

Words, readings, meanings and keywords come from the Core 2k/6k and kanji decks; example sentences, audio and mnemonics from those decks are deliberately not included. Generated by \`scripts/export.mjs\` (read-only; it never changes Anki).
`);
  console.log(`Exported ${vocab.length} words and ${kanji.length} kanji (${count(vocab, 'mature')} mature words).`);

  if (process.argv.includes('--push')) {
    const git = (...a) => execFileSync('git', a, {cwd: root, encoding: 'utf8'});
    git('add', '-A');
    if (!git('status', '--porcelain').trim()) { console.log('No changes to push.'); return; }
    git('commit', '-q', '-m', `Sync from Anki: ${today}`);
    git('push', '-q');
    console.log('Pushed to GitHub.');
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
