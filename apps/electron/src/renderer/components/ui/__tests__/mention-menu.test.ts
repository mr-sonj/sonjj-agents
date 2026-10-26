/**
 * Tests for mention menu @ trigger detection
 *
 * The isValidMentionTrigger function determines when typing @ should open
 * the mention menu vs when it's part of an email address or other text.
 */

import { describe, it, expect, mock, beforeAll } from 'bun:test';

// mention-menu.tsx transitively imports pdfjs-dist via renderer component chain.
// Vite's ?url suffix isn't supported by bun — mock before dynamic import.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }));

type MentionMenuModule = typeof import('../mention-menu');
type MentionItem = import('../mention-menu').MentionItem;
type MentionSection = import('../mention-menu').MentionSection;
type LoadedSkill = import('../../../../shared/types').LoadedSkill;

let isValidMentionTrigger: MentionMenuModule['isValidMentionTrigger'];
let getSkillFolderLabel: MentionMenuModule['getSkillFolderLabel'];
let filterSections: MentionMenuModule['filterSections'];
let getSkillMentionItems: MentionMenuModule['getSkillMentionItems'];

beforeAll(async () => {
  const mod = await import('../mention-menu');
  isValidMentionTrigger = mod.isValidMentionTrigger;
  getSkillFolderLabel = mod.getSkillFolderLabel;
  filterSections = mod.filterSections;
  getSkillMentionItems = mod.getSkillMentionItems;
});

describe('getSkillFolderLabel', () => {
  it('names the folder that holds .agents/skills', () => {
    expect(getSkillFolderLabel({ source: 'project', path: '/w/projects/crm-app/.agents/skills/cron-enrich-links' }))
      .toBe('crm-app');
    expect(getSkillFolderLabel({ source: 'extra', path: '/w/projects/@team/.agents/skills/team-draft' })).toBe('@team');
    expect(getSkillFolderLabel({ source: 'project', path: '/w/app/.claude/skills/review' })).toBe('app');
  });

  it('names the folder that holds a plain skills folder', () => {
    expect(getSkillFolderLabel({ source: 'workspace', path: '/w/notes/my-bot/skills/daily' })).toBe('my-bot');
  });

  it('names an extra folder that is not called skills', () => {
    expect(getSkillFolderLabel({ source: 'extra', path: '/w/my-skill-pack/writer' })).toBe('my-skill-pack');
  });

  it('labels global skills ~/.agents', () => {
    expect(getSkillFolderLabel({ source: 'global', path: '/Users/me/.agents/skills/commit' })).toBe('~/.agents');
  });

  it('reads Windows paths', () => {
    expect(getSkillFolderLabel({ source: 'project', path: 'C:\\Users\\me\\proj\\.agents\\skills\\lint' })).toBe('proj');
  });
});

describe('getSkillMentionItems', () => {
  const loaded = (slug: string, source: LoadedSkill['source'], dir: string): LoadedSkill =>
    ({ slug, metadata: { name: slug, description: '' }, content: '', path: `${dir}/${slug}`, source });

  it('lists the working directory skills first, the others in their order, each with its folder', () => {
    const items = getSkillMentionItems([
      loaded('commit', 'global', '/Users/me/.agents/skills'),
      loaded('team-draft', 'extra', '/w/@team/.agents/skills'),
      loaded('cron-enrich-links', 'project', '/w/crm-app/.agents/skills'),
      loaded('daily', 'workspace', '/w/my-bot/skills'),
      loaded('crm-schema-sync', 'project', '/w/crm-app/.agents/skills'),
    ]);
    expect(items.map(item => [item.id, item.folder])).toEqual([
      ['cron-enrich-links', 'crm-app'],
      ['crm-schema-sync', 'crm-app'],
      ['commit', '~/.agents'],
      ['team-draft', '@team'],
      ['daily', 'my-bot'],
    ]);
  });
});

describe('filterSections', () => {
  const skill = (id: string, folder: string, source: LoadedSkill['source'] = 'extra'): MentionItem =>
    ({ id, type: 'skill', label: id, description: '', folder, skill: { source } as LoadedSkill });
  const sections: MentionSection[] = [
    {
      id: 'skills',
      label: 'Skills',
      items: [
        skill('cron-enrich-links', 'crm-app', 'project'),
        skill('crm-schema-sync', 'crm-app', 'project'),
        skill('team-draft', '@team'),
        skill('cron-backup', '~/.agents', 'global'),
      ],
    },
    { id: 'sources', label: 'Sources', items: [{ id: 'crm', type: 'source', label: 'CRM' }] },
    {
      id: 'files',
      label: 'Files',
      items: [
        { id: '/w/crm/notes.md', type: 'file', label: 'notes.md', description: 'crm/notes.md' },
        { id: '/w/src/cron.ts', type: 'file', label: 'cron.ts', description: 'src/cron.ts' },
      ],
    },
  ];
  const ids = (filter: string) => filterSections(sections, filter).flatMap(section => section.items).map(item => item.id);

  it('lists every skill of the folder named before /', () => {
    expect(ids('crm-app/')).toEqual(['crm-schema-sync', 'cron-enrich-links']);
  });

  it('matches the start of the folder name, ignoring case and a leading @ or ~/.', () => {
    expect(ids('CRM/')).toContain('cron-enrich-links');
    expect(ids('team/')).toEqual(['team-draft']);
    expect(ids('agents/')).toEqual(['cron-backup']);
  });

  it('filters the folder by the text after /', () => {
    expect(ids('crm/cron')).toEqual(['cron-enrich-links']);
  });

  it('keeps files whose path matches, and drops skills of other folders and sources', () => {
    expect(ids('crm/')).toEqual(['crm-schema-sync', 'cron-enrich-links', '/w/crm/notes.md']);
  });

  it('matches as before when no skill folder starts with the text before /', () => {
    expect(ids('src/')).toEqual(['/w/src/cron.ts']);
    expect(ids('./src')).toEqual([]);
  });

  it('puts working directory skills first among equally good matches', () => {
    expect(ids('cron').slice(0, 2)).toEqual(['cron-enrich-links', 'cron-backup']);
  });

  it('still ranks a better match above a working directory skill', () => {
    const ranked = filterSections(
      [{ id: 'skills', label: 'Skills', items: [skill('daily-cron', 'crm-app', 'project'), skill('cron-backup', '~/.agents', 'global')] }],
      'cron',
    );
    expect(ranked.flatMap(section => section.items).map(item => item.id)).toEqual(['cron-backup', 'daily-cron']);
  });

  it('does not match folder names without a /', () => {
    expect(ids('team')).toEqual(['team-draft']);
    expect(ids('app')).toEqual([]);
  });
});

describe('isValidMentionTrigger', () => {
  describe('valid triggers (should open menu)', () => {
    it('returns true when @ is at the start of input', () => {
      expect(isValidMentionTrigger('@', 0)).toBe(true);
      expect(isValidMentionTrigger('@skill', 0)).toBe(true);
    });

    it('returns true when @ is preceded by a space', () => {
      expect(isValidMentionTrigger('hello @', 6)).toBe(true);
      expect(isValidMentionTrigger('hello @skill', 6)).toBe(true);
      expect(isValidMentionTrigger('use @mention here', 4)).toBe(true);
    });

    it('returns true when @ is preceded by a tab', () => {
      expect(isValidMentionTrigger('hello\t@', 6)).toBe(true);
      expect(isValidMentionTrigger('\t@skill', 1)).toBe(true);
    });

    it('returns true when @ is preceded by a newline', () => {
      expect(isValidMentionTrigger('hello\n@', 6)).toBe(true);
      expect(isValidMentionTrigger('line1\nline2\n@skill', 12)).toBe(true);
    });

    it('returns true when @ is preceded by carriage return', () => {
      expect(isValidMentionTrigger('hello\r@', 6)).toBe(true);
      expect(isValidMentionTrigger('hello\r\n@', 7)).toBe(true);
    });

    it('returns true when @ is preceded by multiple whitespace chars', () => {
      expect(isValidMentionTrigger('hello   @', 8)).toBe(true);
      expect(isValidMentionTrigger('hello\n\n@', 7)).toBe(true);
    });

    it('returns true when @ is preceded by opening parenthesis', () => {
      expect(isValidMentionTrigger('(@', 1)).toBe(true);
      expect(isValidMentionTrigger('use (@skill)', 5)).toBe(true);
      expect(isValidMentionTrigger('call(@mention', 5)).toBe(true);
    });

    it('returns true when @ is preceded by double quote', () => {
      expect(isValidMentionTrigger('"@', 1)).toBe(true);
      expect(isValidMentionTrigger('say "@skill"', 5)).toBe(true);
    });

    it('returns true when @ is preceded by single quote', () => {
      expect(isValidMentionTrigger("'@", 1)).toBe(true);
      expect(isValidMentionTrigger("use '@skill'", 5)).toBe(true);
    });
  });

  describe('invalid triggers (should NOT open menu)', () => {
    it('returns false for email addresses', () => {
      // test@example.com - @ at position 4
      expect(isValidMentionTrigger('test@', 4)).toBe(false);
      expect(isValidMentionTrigger('test@example', 4)).toBe(false);
      expect(isValidMentionTrigger('user@domain.com', 4)).toBe(false);
    });

    it('returns false when @ is preceded by letters', () => {
      expect(isValidMentionTrigger('hello@', 5)).toBe(false);
      expect(isValidMentionTrigger('contact@support', 7)).toBe(false);
    });

    it('returns false when @ is preceded by numbers', () => {
      expect(isValidMentionTrigger('user123@', 7)).toBe(false);
      expect(isValidMentionTrigger('99@bottles', 2)).toBe(false);
    });

    it('returns false when @ is preceded by other punctuation (not quotes/parens)', () => {
      expect(isValidMentionTrigger('hello.@', 6)).toBe(false);
      expect(isValidMentionTrigger('test-@user', 5)).toBe(false);
      expect(isValidMentionTrigger('foo_@bar', 4)).toBe(false);
      expect(isValidMentionTrigger('end)@start', 4)).toBe(false); // closing paren is not allowed
    });

    it('returns false for negative position', () => {
      expect(isValidMentionTrigger('test', -1)).toBe(false);
      expect(isValidMentionTrigger('@test', -1)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(isValidMentionTrigger('', 0)).toBe(true); // @ would be at start
      expect(isValidMentionTrigger('', -1)).toBe(false);
    });

    it('handles unicode whitespace', () => {
      // Non-breaking space (U+00A0) - treated as whitespace by \s
      expect(isValidMentionTrigger('hello\u00A0@', 6)).toBe(true);
    });

    it('handles position at end of string', () => {
      const text = 'hello ';
      expect(isValidMentionTrigger(text, text.length)).toBe(true); // space before
    });

    it('handles multiple @ symbols - checks specific position', () => {
      // "user@test @skill" - first @ is invalid (after 'r'), second is valid (after space)
      expect(isValidMentionTrigger('user@test @', 4)).toBe(false);  // first @
      expect(isValidMentionTrigger('user@test @', 10)).toBe(true); // second @
    });
  });
});
