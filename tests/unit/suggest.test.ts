import { describe, expect, it } from 'vitest';
import { hexToRgb, nameColour } from '../../src/lib/colour';
import { suggestTags, type SuggestInput } from '../../src/lib/suggest';
import { normalizeTag } from '../../src/lib/tags';
import type { Swatch } from '../../src/types';

function input(overrides: Partial<SuggestInput> = {}): SuggestInput {
  return { title: '', notes: '', text: '', palette: [], tags: [], dismissed: [], library: new Map(), ...overrides };
}

function lib(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

function swatch(hex: string, weight: number, family?: string): Swatch {
  const rgb = hexToRgb(hex)!;
  const named = nameColour(rgb);
  return { hex, rgb, name: named.name, family: family ?? named.family, weight };
}

describe('suggestTags: basics', () => {
  it('returns nothing for an empty entry', () => {
    expect(suggestTags(input())).toEqual([]);
  });

  it('respects the limit', () => {
    const entry = input({ title: 'Brutalist concrete architecture photography exhibition catalogue design' });
    expect(suggestTags(entry)).toHaveLength(6);
    expect(suggestTags(entry, 2)).toHaveLength(2);
    expect(suggestTags(entry, 0)).toEqual([]);
    expect(suggestTags(entry, -3)).toEqual([]);
  });

  it('returns unique, normalised tags', () => {
    const tags = suggestTags(
      input({
        title: 'Café Posters — Typography Study',
        notes: 'POSTERS and posters; typography, TYPOGRAPHY.',
        text: '#Typography #Café_Society',
        library: lib({ typography: 3 }),
      }),
      20,
    );
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) expect(normalizeTag(tag)).toBe(tag);
    expect(tags).toContain('café');
  });

  it('is deterministic, including for differently ordered libraries', () => {
    const entries: [string, number][] = [['film-grain', 4], ['poster', 9], ['colour', 2], ['blue', 3], ['grain', 1]];
    const make = (library: Map<string, number>) =>
      input({
        title: 'Grain and colour',
        notes: 'Film grain on old posters, blue cast.',
        text: 'POSTER film grain colour test',
        palette: [swatch('#2a4fb0', 0.7)],
        library,
      });
    const first = suggestTags(make(new Map(entries)));
    expect(suggestTags(make(new Map(entries)))).toEqual(first);
    expect(suggestTags(make(new Map([...entries].reverse())))).toEqual(first);
  });

  it('tolerates missing fields', () => {
    const partial = { title: 'Brutalism' } as unknown as SuggestInput;
    expect(suggestTags(partial)).toEqual(['brutalism']);
  });
});

describe('suggestTags: library tags', () => {
  it('matches multi-word tags written as phrases', () => {
    expect(suggestTags(input({ notes: 'Lovely film grain here.', library: lib({ 'film-grain': 3 }) }))).toContain('film-grain');
    expect(suggestTags(input({ text: 'FILM_GRAIN', library: lib({ 'film-grain': 3 }) }))).toContain('film-grain');
  });

  it('matches tags written together or apart', () => {
    expect(suggestTags(input({ notes: 'great filmgrain', library: lib({ 'film-grain': 1 }) }))).toContain('film-grain');
    expect(suggestTags(input({ notes: 'street photography', library: lib({ streetphotography: 1 }) }))).toContain(
      'streetphotography',
    );
    expect(suggestTags(input({ notes: 'shot in black and white', library: lib({ blackandwhite: 1 }) }))).toContain(
      'blackandwhite',
    );
  });

  it('does not match a phrase across punctuation', () => {
    expect(suggestTags(input({ notes: 'Shot on film. Grain was heavy', library: lib({ 'film-grain': 3 }) }))).not.toContain(
      'film-grain',
    );
  });

  it('folds case and diacritics', () => {
    expect(suggestTags(input({ title: 'CAFE culture', library: lib({ café: 2 }) }))).toContain('café');
    expect(suggestTags(input({ title: 'Café culture', library: lib({ cafe: 2 }) }))).toContain('cafe');
  });

  it('matches singular and plural forms', () => {
    expect(suggestTags(input({ title: 'Swiss posters', library: lib({ poster: 5 }) }))).toContain('poster');
    expect(suggestTags(input({ title: 'A Swiss poster', library: lib({ posters: 5 }) }))).toContain('posters');
    expect(suggestTags(input({ title: 'Short stories', library: lib({ story: 1 }) }))).toContain('story');
    expect(suggestTags(input({ title: 'Pencil sketches', library: lib({ sketch: 1 }) }))).toContain('sketch');
    expect(suggestTags(input({ title: 'Stained glasses', library: lib({ glass: 1 }) }))).toContain('glass');
  });

  it('matches on word boundaries only', () => {
    const tags = suggestTags(input({ title: 'The artist and the partisan', library: lib({ art: 9, tis: 2 }) }));
    expect(tags).not.toContain('art');
    expect(tags).not.toContain('tis');
    expect(suggestTags(input({ title: 'Street art', library: lib({ art: 9 }) }))).toContain('art');
  });

  it('ranks library tags above fresh keywords, even weak OCR matches', () => {
    const tags = suggestTags(
      input({
        title: 'Brutalism brutalism',
        notes: 'Concrete towers',
        text: 'a page that mentions modernism once among many words',
        library: lib({ modernism: 1 }),
      }),
    );
    expect(tags[0]).toBe('modernism');
    expect(tags).toContain('brutalism');
  });

  it('orders library matches by evidence and popularity', () => {
    const tags = suggestTags(
      input({ title: 'Poster', text: 'typography', library: lib({ poster: 1, typography: 1, grid: 50 }), notes: 'grid' }),
    );
    expect(tags.slice(0, 3)).toEqual(['poster', 'grid', 'typography']);
  });

  it('only counts a common-word tag when it is in the title', () => {
    const library = lib({ new: 4 });
    expect(suggestTags(input({ notes: 'this is new to me', library }))).not.toContain('new');
    expect(suggestTags(input({ title: 'New', library }))).toContain('new');
  });

  it('suggests only one of a singular/plural pair from the library', () => {
    const tags = suggestTags(input({ title: 'posters', library: lib({ poster: 2, posters: 7 }) }));
    expect(tags.filter((t) => t.startsWith('poster'))).toEqual(['posters']);
  });

  it('sees tags added to a library Map that is mutated in place', () => {
    const library = lib({ poster: 1 });
    const entry = input({ title: 'Kinetic typography', library });
    expect(suggestTags(entry)).toContain('typography'); // as a fresh keyword
    library.set('kinetic', 3);
    expect(suggestTags(entry)[0]).toBe('kinetic');
  });

  it('does not re-suggest the words of a matched multi-word tag', () => {
    const tags = suggestTags(input({ notes: 'film grain', library: lib({ 'film-grain': 1 }) }));
    expect(tags).toEqual(['film-grain']);
  });
});

describe('suggestTags: keywords', () => {
  it('weights the title above notes and notes above OCR text', () => {
    const tags = suggestTags(input({ title: 'Lithograph', notes: 'woodcut', text: 'engraving' }));
    expect(tags).toEqual(['lithograph', 'woodcut', 'engraving']);
  });

  it('counts repeats with diminishing returns', () => {
    const tags = suggestTags(input({ notes: 'risograph', text: 'halftone halftone halftone halftone halftone halftone' }));
    expect(tags).toEqual(['halftone', 'risograph']);
  });

  it('drops stopwords, short tokens, numbers and words with digits', () => {
    const tags = suggestTags(
      input({
        title: 'The best ink art from 2024',
        notes: 'Something about this really works. 1080p h264 35mm 4k x2',
        text: 'zine',
      }),
    );
    expect(tags).toEqual(['zine']);
  });

  it('ignores social media and screenshot chrome', () => {
    const text = `Follow · Following · Like · Liked by 2,301 others · Share · Reply · Repost · 1.2M views
      10:42 AM · Monday 14 March · View all comments · Translate post · Subscribe · Download
      https://www.example.com/path/to/page?ref=share  www.studio.co  @someone  hello@studio.com`;
    expect(suggestTags(input({ text }))).toEqual([]);
  });

  it('filters OCR garbage', () => {
    const tags = suggestTags(input({ text: 'rnrnrn lllll tHiS ThE SOMEthing xkcdqz bcdfgh aeiou Ilustration' }));
    expect(tags).toEqual(['ilustration']);
  });

  it('keeps legitimate mixed case words', () => {
    expect(suggestTags(input({ title: 'McQueen collection' }))).toEqual(['mcqueen', 'collection']);
    expect(suggestTags(input({ title: 'iPhone wallpaper' }))).toEqual(['iphone', 'wallpaper']);
  });

  it('orders equally strong words as they were written', () => {
    expect(suggestTags(input({ title: 'Woodcut lithograph etching' }))).toEqual(['woodcut', 'lithograph', 'etching']);
  });

  it('turns ligatures from OCR into plain letters', () => {
    expect(suggestTags(input({ title: 'ﬁligree' }))).toEqual(['filigree']);
  });

  it('suggests repeated two-word phrases instead of their words', () => {
    const tags = suggestTags(input({ title: 'Type design', notes: 'Notes on type design and spacing.' }));
    expect(tags[0]).toBe('type-design');
    expect(tags).not.toContain('type');
    expect(tags).not.toContain('design');
    expect(tags).toContain('spacing');
  });

  it('does not invent phrases from a single occurrence', () => {
    const tags = suggestTags(input({ title: 'Kinetic typography' }));
    expect(tags).toEqual(['kinetic', 'typography']);
  });

  it('needs a word to repeat in long OCR text, but not in a short caption', () => {
    const filler = Array.from({ length: 70 }, (_, i) => `wordform${String.fromCharCode(97 + (i % 26))}`).join(' ');
    // Every filler word appears at most three times; only "letterpress" repeats enough to stand out.
    const long = suggestTags(input({ text: `${filler} letterpress specimen letterpress` }), 50);
    expect(long).toContain('letterpress');
    expect(long).not.toContain('specimen');

    expect(suggestTags(input({ text: 'Bauhaus Dessau' }))).toEqual(['bauhaus', 'dessau']);
  });

  it('prefers words that already appear in the library vocabulary', () => {
    const tags = suggestTags(input({ notes: 'collage gouache', library: lib({ 'gouache-painting': 6 }) }));
    expect(tags).toEqual(['gouache', 'collage']);
  });

  it('uses the most common spelling of a word', () => {
    expect(suggestTags(input({ notes: 'Sketches, sketches and one sketch' }))).toEqual(['sketches']);
  });

  it('never suggests the entry’s tags or dismissed tags, nor their plural twins', () => {
    const entry = input({
      title: 'Posters from Paris',
      notes: 'Typography and lettering',
      tags: ['poster', '#Typography'],
      dismissed: ['paris', 'letterings'],
    });
    expect(suggestTags(entry)).toEqual([]);
  });
});

describe('suggestTags: hashtags in the source', () => {
  it('suggests hashtags written in the text', () => {
    const tags = suggestTags(input({ text: 'Some caption #Brutalism #goldenhour #film_grain' }));
    expect(tags).toEqual(expect.arrayContaining(['brutalism', 'goldenhour', 'film_grain']));
    expect(tags).not.toContain('film');
  });

  it('ranks a hashtag above loose OCR words', () => {
    const tags = suggestTags(input({ text: 'concrete #brutalism' }));
    expect(tags).toEqual(['brutalism', 'concrete']);
  });

  it('ignores hex colours, numbers and noise hashtags', () => {
    const tags = suggestTags(input({ text: '#fff #c0392b #1 #2024 #instagood #photooftheday #facade' }));
    expect(tags).toEqual(['facade']);
  });

  it('does not treat URL fragments as hashtags', () => {
    expect(suggestTags(input({ text: 'see example.org/page#section' }))).toEqual([]);
  });
});

describe('suggestTags: platforms', () => {
  it('suggests a platform when its domain appears', () => {
    expect(suggestTags(input({ text: 'instagram.com/p/Cx12Ab' }))).toEqual(['instagram']);
    expect(suggestTags(input({ notes: 'via https://youtu.be/abc123' }))).toEqual(['youtube']);
    expect(suggestTags(input({ notes: 'from are.na/someone/channel' }))).toEqual(['arena']);
    expect(suggestTags(input({ notes: 'behance.net/gallery/1' }))).toEqual(['behance']);
    expect(suggestTags(input({ notes: 'pin.it/xyz' }))).toEqual(['pinterest']);
  });

  it('ignores a bare platform name unless the library uses it', () => {
    expect(suggestTags(input({ text: 'Instagram' }))).toEqual([]);
    expect(suggestTags(input({ text: 'Instagram', library: lib({ instagram: 4 }) }))).toEqual(['instagram']);
  });

  it('prefers the library’s spelling of a platform', () => {
    expect(suggestTags(input({ text: 'x.com/someone/status/1', library: lib({ x: 2 }) }))).toEqual(['x']);
    expect(suggestTags(input({ text: 'twitter.com/someone' }))).toEqual(['twitter']);
    expect(suggestTags(input({ text: 'box.com/file' }))).toEqual([]);
  });

  it('ranks a platform the library uses with the library tier', () => {
    const tags = suggestTags(input({ title: 'Lithograph', text: 'dribbble.com/shots/1', library: lib({ dribbble: 1 }) }));
    expect(tags).toEqual(['dribbble', 'lithograph']);
  });
});

describe('suggestTags: colour', () => {
  it('suggests a dominant colour family', () => {
    const tags = suggestTags(input({ palette: [swatch('#1f4fa8', 0.5), swatch('#f6f2e4', 0.4), swatch('#2a3c9e', 0.1)] }));
    expect(tags).toEqual(['blue']);
  });

  it('adds up swatches of the same family', () => {
    // Cobalt and sky are both blue: 0.3 + 0.2 crosses the 0.45 threshold together.
    const blues = [swatch('#1f4fa8', 0.3), swatch('#8cc4e6', 0.2), swatch('#f6f2e4', 0.5)];
    expect(suggestTags(input({ palette: blues }))).toEqual(['blue']);
    const mixed = [swatch('#1f4fa8', 0.3), swatch('#c82828', 0.2), swatch('#f6f2e4', 0.5)];
    expect(suggestTags(input({ palette: mixed }))).toEqual([]);
  });

  it('suggests nothing when no hue dominates', () => {
    expect(suggestTags(input({ palette: [swatch('#1f4fa8', 0.4), swatch('#fbfbf9', 0.6)] }))).toEqual([]);
    expect(
      suggestTags(input({ palette: [swatch('#1f4fa8', 0.35), swatch('#c82828', 0.35), swatch('#2a9d62', 0.3)] })),
    ).toEqual([]);
  });

  it('judges families from the colour, not the stored label', () => {
    expect(suggestTags(input({ palette: [swatch('#1f4fa8', 1, 'nonsense')] }))).toEqual(['blue']);
  });

  it('suggests monochrome for neutral-only images', () => {
    const palette = [swatch('#111111', 0.5), swatch('#888888', 0.3), swatch('#eeeeee', 0.2)];
    expect(suggestTags(input({ palette }))).toEqual(['monochrome']);
    expect(suggestTags(input({ palette, library: lib({ 'black-and-white': 3 }) }))).toEqual(['black-and-white']);
  });

  it('does not call a page of text monochrome', () => {
    const text = Array.from({ length: 30 }, () => 'the').join(' ');
    const page = [swatch('#ffffff', 0.85), swatch('#141414', 0.15)];
    expect(suggestTags(input({ palette: page, text }))).toEqual([]);
    expect(suggestTags(input({ palette: [swatch('#ffffff', 0.97), swatch('#141414', 0.03)] }))).toEqual([]);
  });

  it('does not call a tinted image monochrome', () => {
    const palette = [swatch('#111111', 0.4), swatch('#888888', 0.3), swatch('#c9952b', 0.3)];
    expect(suggestTags(input({ palette }))).toEqual([]);
  });

  it('ranks a colour the library uses with the library tier', () => {
    const tags = suggestTags(input({ title: 'Lithograph', palette: [swatch('#c82828', 0.8)], library: lib({ red: 2 }) }));
    expect(tags).toEqual(['red', 'lithograph']);
  });

  it('places a fresh colour below title words but above OCR words', () => {
    const tags = suggestTags(input({ title: 'Lithograph', text: 'engraving', palette: [swatch('#c82828', 0.8)] }));
    expect(tags).toEqual(['lithograph', 'red', 'engraving']);
  });

  it('does not suggest a colour already on the entry', () => {
    expect(suggestTags(input({ tags: ['blue'], palette: [swatch('#1f4fa8', 1)] }))).toEqual([]);
  });
});

describe('suggestTags: performance', () => {
  it('handles 10 KB of OCR text with a large library in under 5 ms', () => {
    const vocabulary = 'grid editorial serif kerning margin column folio spread masthead caption pull quote leading baseline'.split(' ');
    const words: string[] = [];
    for (let i = 0; words.join(' ').length < 10_240; i++) {
      words.push(i % 11 === 0 ? `${vocabulary[i % vocabulary.length]}.` : vocabulary[(i * 7) % vocabulary.length] + (i % 5));
      words.push(['the', 'and', 'of', 'Follow', 'typography', 'page', 'colour'][i % 7]);
    }
    const library = new Map<string, number>();
    for (let i = 0; i < 2000; i++) library.set(i % 3 ? `tag${i}` : `word${i}-thing${i}`, (i % 9) + 1);
    library.set('typography', 12);
    const entry = input({ title: 'Editorial grid systems', notes: 'Margins, columns and folios.', text: words.join(' '), library });

    for (let i = 0; i < 10; i++) suggestTags(entry); // warm up
    const runs: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      suggestTags(entry);
      runs.push(performance.now() - t);
    }
    runs.sort((a, b) => a - b);
    expect(runs[7]).toBeLessThan(5);
    expect(suggestTags(entry)[0]).toBe('typography');
  });
});

describe('suggestTags: review regressions', () => {
  it('matches plurals whose singular ends in -ie, or in a silent -e after ch, sh, x, z or o', () => {
    const pairs: [string, string][] = [
      ['movie', 'favourite movies'],
      ['movies', 'one movie'],
      ['selfie', 'mirror selfies'],
      ['glaze', 'ceramic glazes'],
      ['glazes', 'a celadon glaze'],
      ['niche', 'niches'],
      ['bronze', 'cast bronzes'],
      ['hero', 'heroes'],
      ['shoe', 'shoes'],
      ['city', 'cities'],
      ['box', 'boxes'],
    ];
    for (const [tag, notes] of pairs) {
      const tags = suggestTags(input({ notes, library: lib({ [tag]: 3 }) }));
      expect(tags[0], `${tag} ← ${notes}`).toBe(tag);
    }
  });

  it('never offers a fresh plural twin of a library tag or an entry tag', () => {
    expect(suggestTags(input({ title: 'Movies', library: lib({ movie: 2 }) }))).toEqual(['movie']);
    expect(suggestTags(input({ title: 'Glazes', tags: ['glaze'] }))).toEqual([]);
    expect(suggestTags(input({ title: 'Selfies', dismissed: ['selfie'] }))).toEqual([]);
  });

  it('keeps real one-vowel words but still drops vowel-less debris', () => {
    expect(suggestTags(input({ title: 'Stretch scripts strength' }))).toEqual(['stretch', 'scripts', 'strength']);
    expect(suggestTags(input({ title: 'Scratch strings' }))).toEqual(['scratch', 'strings']);
    expect(suggestTags(input({ text: 'xkcdqz bcdfgh tttt' }))).toEqual([]);
  });

  it('keeps hyphenated hashtags whole', () => {
    const tags = suggestTags(input({ notes: 'love this #film-grain look' }));
    expect(tags[0]).toBe('film-grain');
    expect(tags).not.toContain('film');
    expect(tags).not.toContain('grain');
    expect(suggestTags(input({ notes: 'a #zine- and #risograph—print' }))).toEqual(['risograph', 'zine', 'print']);
  });

  it('matches run-together library tags when the text writes them apart in the plural', () => {
    expect(suggestTags(input({ notes: 'sand boxes', library: lib({ sandbox: 2 }) }))).toEqual(['sandbox']);
    expect(suggestTags(input({ notes: 'black berries', library: lib({ blackberry: 2 }) }))).toEqual(['blackberry']);
  });

  it('matches a multi-word tag written as one word, whatever its parts end in', () => {
    expect(suggestTags(input({ notes: 'a movieposter', library: lib({ 'movie-poster': 2 }) }))).toEqual(['movie-poster']);
    expect(suggestTags(input({ notes: 'shoebox archive', library: lib({ 'shoe-box': 2 }) }))[0]).toBe('shoe-box');
  });

  it('still only counts a common-word tag in the title when the text uses its plural', () => {
    const library = lib({ cookie: 2 });
    expect(suggestTags(input({ notes: 'accept cookies', library }))).not.toContain('cookie');
    expect(suggestTags(input({ title: 'Cookie', library }))).toContain('cookie');
  });

  it('judges colour dominance against the whole image, not just the listed swatches', () => {
    // 40% blue is not dominant, even when the palette lists only 70% of the image.
    expect(suggestTags(input({ palette: [swatch('#1f4fa8', 0.4), swatch('#f6f2e4', 0.3)] }))).toEqual([]);
    expect(suggestTags(input({ palette: [swatch('#1f4fa8', 0.46), swatch('#f6f2e4', 0.3)] }))).toEqual(['blue']);
    // Weights that over-sum are scaled to the image.
    expect(suggestTags(input({ palette: [swatch('#1f4fa8', 1.2), swatch('#f6f2e4', 0.8)] }))).toEqual(['blue']);
  });
});

describe('suggestTags: OCR line-break hyphenation', () => {
  it('rejoins words hyphenated across a line break in OCR text', () => {
    expect(suggestTags(input({ text: 'an apt solu-\ntion for lino-\r\n  cuts' }))).toEqual(['solution', 'linocuts']);
    expect(suggestTags(input({ text: 'typo-\ngraphy', library: lib({ typography: 2 }) }))).toEqual(['typography']);
  });

  it('leaves compounds broken before a capital alone', () => {
    expect(suggestTags(input({ text: 'Josef Müller-\nBrockmann' }))).toEqual(['josef', 'müller', 'brockmann']);
  });
});
