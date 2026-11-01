import { describe, expect, it } from 'vitest';
import { crawlerDirectory } from './directory';
import {
  checkRobotsAccess,
  setRobotsAccess,
  mergeRobotsPolicy,
  parseRobots,
  ROBOTS_MAX_BYTES,
  ROBOTS_PARSE_MAX_BYTES,
} from './robots';

const blockDocs = {
  botIds: ['gptbot' as const],
  paths: [{ value: '/docs', match: 'prefix' as const }],
  action: 'block' as const,
};

describe('reviewed directory robots tokens', () => {
  it.each(['AI2Bot', 'Sogou web spider', 'Sogou inst spider', '360Spider', 'MJ12bot'])(
    'parses and evaluates the exact reviewed %s token with wildcard fallback',
    token => {
      const text = `User-agent: *\nDisallow: /fallback\nUser-agent: ${token}\nDisallow: /private\n`;
      expect(parseRobots(text).issues).toEqual([]);
      expect(checkRobotsAccess(text, token.toUpperCase(), '/private').allowed).toBe(false);
      expect(checkRobotsAccess(text, token, '/fallback').allowed).toBe(true);
      expect(
        checkRobotsAccess('User-agent: *\nDisallow: /fallback', token, '/fallback').allowed,
      ).toBe(false);
    },
  );

  it('evaluates and round-trips drafts for every supported directory entry', () => {
    const entries = crawlerDirectory.filter(bot => bot.robotsToken !== null);
    expect(entries.length).toBeGreaterThan(50);
    for (const bot of entries) {
      expect(
        checkRobotsAccess('User-agent: *\nDisallow: /private', bot.robotsToken, '/private').allowed,
        bot.id,
      ).toBe(false);
      const result = mergeRobotsPolicy('User-agent: *\nDisallow: /private\n', {
        ...blockDocs,
        botIds: [bot.id],
      });
      expect(result.safe, bot.id).toBe(true);
      expect(parseRobots(result.content).issues, bot.id).toEqual([]);
      expect(checkRobotsAccess(result.content, bot.robotsToken, '/private').allowed, bot.id).toBe(
        false,
      );
      expect(
        checkRobotsAccess(result.content, bot.robotsToken, '/docs/child').allowed,
        bot.id,
      ).toBe(false);
      expect(checkRobotsAccess(result.content, bot.robotsToken, '/public').allowed, bot.id).toBe(
        true,
      );
    }
  });

  it.each([
    'Other123Bot',
    'Other Bot',
    'Sogou  web spider',
    'Sogou\tweb spider',
    'AI2Bot/1',
    'AI2Bot\nDisallow: /',
    'GPTBot\n',
    'MJ12bot\u0085',
  ])('rejects unreviewed or control-bearing evaluation token %j', token => {
    expect(() => checkRobotsAccess('', token, '/')).toThrow();
  });

  it('keeps malformed group boundaries separate while accepting reviewed tokens', () => {
    const document = parseRobots(
      'User-agent: AI2Bot\nDisallow: /private\nUser-agent: Other123Bot\nDisallow: /public',
    );
    expect(document.issues).toEqual([{ line: 3, reason: 'Invalid user-agent token' }]);
    expect(checkRobotsAccess(document, 'AI2Bot', '/private').allowed).toBe(false);
    expect(checkRobotsAccess(document, 'AI2Bot', '/public').allowed).toBe(true);
  });
});

describe('RFC 9309 access checks', () => {
  it('matches the complete product token and keeps unrelated short tokens separate', () => {
    const text = 'User-agent: *\nDisallow: /private\nUser-agent: Bot\nAllow: /other\n';
    expect(checkRobotsAccess(text, 'GPTBot', '/private').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'gptbot', '/private').applicableAgents).toEqual(['*']);
    expect(checkRobotsAccess(text, 'Bot', '/private').allowed).toBe(true);
  });
  it('uses applicable group specificity and combines equal-specificity groups', () => {
    const text = [
      'User-agent: *',
      'Disallow: /all',
      'User-agent: GPT',
      'Disallow: /generic',
      'User-agent: GPTBot',
      'Disallow: /private',
      'User-agent: gptbot',
      'Disallow: /other',
    ].join('\n');
    expect(checkRobotsAccess(text, 'GPTBot', '/all').allowed).toBe(true);
    expect(checkRobotsAccess(text, 'GPTBot', '/generic').allowed).toBe(true);
    expect(checkRobotsAccess(text, 'GPTBot', '/private').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'GPTBot', '/other').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'ClaudeBot', '/all').allowed).toBe(false);
  });

  it('supports multiple UA lines, case-sensitive paths, longest path and Allow ties', () => {
    const text =
      'User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /private\nAllow: /private/open\nDisallow: /same\nAllow: /same\n';
    expect(checkRobotsAccess(text, 'claudebot', '/private').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'GPTBot', '/Private').allowed).toBe(true);
    expect(checkRobotsAccess(text, 'GPTBot', '/private/open/page').allowed).toBe(true);
    expect(checkRobotsAccess(text, 'GPTBot', '/same').matchedRule.directive).toBe('allow');
    expect(checkRobotsAccess('User-agent: *\nDisallow: /', 'GPTBot', '/robots.txt').allowed).toBe(
      true,
    );
  });

  it('supports wildcard and exact end patterns without untrusted regex evaluation', () => {
    const text = 'User-agent: *\nDisallow: /*/private$\nDisallow: /file*.pdf$\n';
    expect(checkRobotsAccess(text, 'GPTBot', '/a/private').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'GPTBot', '/a/private/more').allowed).toBe(true);
    expect(checkRobotsAccess(text, 'GPTBot', '/file-long.pdf').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'GPTBot', '/file-long.pdf?download=1').allowed).toBe(true);
    expect(checkRobotsAccess(text, 'GPTBot', '/file-long.pdfx').allowed).toBe(true);
    expect(
      checkRobotsAccess('User-agent: *\nDisallow: /a*b*c$', 'GPTBot', '/aZZbYYc').allowed,
    ).toBe(false);
  });

  it('counts wildcard and end-marker octets when choosing the most specific matching rule', () => {
    const wildcard = 'User-agent: Googlebot\nAllow: /page\nDisallow: /*.htm\n';
    expect(checkRobotsAccess(wildcard, 'Googlebot', '/page.htm')).toMatchObject({
      allowed: false,
      matchedRule: { directive: 'disallow', path: '/*.htm' },
    });
    const root = 'User-agent: *\nAllow: /\nDisallow: /$\n';
    expect(checkRobotsAccess(root, 'GPTBot', '/')).toMatchObject({
      allowed: false,
      matchedRule: { directive: 'disallow', path: '/$' },
    });
    expect(checkRobotsAccess(root, 'GPTBot', '/page').allowed).toBe(true);
    expect(
      checkRobotsAccess('User-agent: *\nDisallow: /page$\nAllow: /page$\n', 'GPTBot', '/page')
        .allowed,
    ).toBe(true);
  });

  it('compares RFC unreserved octets once and preserves reserved/double encoding distinctions', () => {
    const text =
      'User-agent: *\nDisallow: /foo/bar\nDisallow: /a%2Fb\nDisallow: /你好\nDisallow: /x%2A\n';
    expect(checkRobotsAccess(text, 'GPTBot', '/foo/%62ar').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'GPTBot', '/a/b').allowed).toBe(true);
    expect(checkRobotsAccess(text, 'GPTBot', '/a%2fb').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'GPTBot', '/a%252Fb').allowed).toBe(true);
    expect(checkRobotsAccess(text, 'GPTBot', '/x*').allowed).toBe(false);
    expect(checkRobotsAccess(text, 'GPTBot', '/%E4%BD%A0%E5%A5%BD').allowed).toBe(false);
  });

  it('keeps Sitemap/extension records inside their RFC group and comments untouched', () => {
    const text =
      '# heading\r\nUser-agent: GPTBot\r\nSitemap: https://example.com/map.xml\r\nX-Owner: test\r\nDisallow: /private # note\r\n';
    const parsed = parseRobots(text);
    expect(parsed.text).toBe(text);
    expect(parsed.newline).toBe('\r\n');
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].otherDirectives).toEqual(['X-Owner: test']);
    expect(checkRobotsAccess(parsed, 'GPTBot', '/private').allowed).toBe(false);
  });

  it('ignores empty and ungrouped rules and reports malformed records', () => {
    const text = 'Disallow: /ignored\nUser-agent: *\nDisallow:\nBad record\nDisallow: private\n';
    expect(checkRobotsAccess(text, 'GPTBot', '/ignored').allowed).toBe(true);
    expect(parseRobots(text).issues).toHaveLength(2);
    const broken = parseRobots(
      'User-agent: GPTBot\nDisallow: /old\nUser-agent: malicious/1\nDisallow: /new',
    );
    expect(checkRobotsAccess(broken, 'GPTBot', '/new').allowed).toBe(true);
  });

  it('marks user-triggered retrieval applicability caveats independently', () => {
    expect(checkRobotsAccess('', 'ChatGPT-User', '/').caveat).toContain('User-triggered');
    expect(checkRobotsAccess('', 'GPTBot', '/').caveat).toBeNull();
  });

  it('bounds inputs and rejects control payloads for evaluation', () => {
    expect(() => parseRobots('x'.repeat(ROBOTS_PARSE_MAX_BYTES + 1))).toThrow('unsupported');
    expect(() => checkRobotsAccess('', 'GPTBot\nDisallow:/', '/')).toThrow();
    expect(() => checkRobotsAccess('', 'GPTBot', '/x\u0000')).toThrow();
    expect(parseRobots('User-agent: *\nDisallow: /x\u0000').issues).toHaveLength(1);
  });
});

describe('conservative robots merging', () => {
  it('retains wildcard restrictions when an unrelated short product token exists', () => {
    const original = 'User-agent: *\nDisallow: /private\nUser-agent: Bot\nAllow: /other\n';
    const blocked = mergeRobotsPolicy(original, blockDocs);
    expect(blocked.safe).toBe(true);
    expect(checkRobotsAccess(blocked.content, 'GPTBot', '/private').allowed).toBe(false);
    expect(mergeRobotsPolicy(original, { ...blockDocs, action: 'allow' })).toMatchObject({
      safe: false,
      content: null,
    });
  });
  it('parses at least 500 KiB while keeping full editor exports bounded at 256 KiB', () => {
    const text = `#${'a'.repeat(500 * 1024 - 40)}\nUser-agent: *\nDisallow: /private\n`;
    expect(text.length).toBeGreaterThan(ROBOTS_MAX_BYTES);
    expect(checkRobotsAccess(text, 'GPTBot', '/private').allowed).toBe(false);
    const result = mergeRobotsPolicy(text, blockDocs);
    expect(result).toMatchObject({ safe: false, content: null });
    expect(result.reasons).toContain('Existing file exceeds the 256 KiB editor limit.');
  });

  it('refuses appending to a final empty group so unrelated access remains unchanged', () => {
    const original = 'User-agent: *\nDisallow: /private\nUser-agent: OtherBot\n';
    expect(checkRobotsAccess(original, 'OtherBot', '/private').allowed).toBe(true);
    const result = mergeRobotsPolicy(original, blockDocs);
    expect(result).toMatchObject({ safe: false, content: null });
    expect(result.reasons).toContain(
      'Final user-agent group has no rules; appending could change its access.',
    );
    expect(result.fragment).toContain('User-agent: GPTBot');
  });

  it('retains comments, Sitemap, unknown unrelated groups and inherited wildcard restrictions', () => {
    const original =
      '# owner note\r\nUser-agent: *\r\nDisallow: /private\r\nSitemap: https://example.com/map.xml\r\n\r\nUser-agent: OtherBot\r\nX-Owner: keep\r\nDisallow: /other\r\n';
    const result = mergeRobotsPolicy(original, blockDocs);
    expect(result.safe).toBe(true);
    expect(result.content.startsWith(original)).toBe(true);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/private').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/docs').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/docs/page').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/docs-private').allowed).toBe(true);
    expect(checkRobotsAccess(result.content, 'OtherBot', '/other').allowed).toBe(false);
    expect(result.content).toContain('X-Owner: keep');
    expect(result.content).toContain('Sitemap: https://example.com/map.xml');
  });

  it('keeps GPTBot and OAI-SearchBot controls independent', () => {
    const result = mergeRobotsPolicy('', blockDocs);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/docs').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'OAI-SearchBot', '/docs').allowed).toBe(true);
  });

  it.each(['exact', 'prefix'] as const)(
    'applies %s pathname rules to query-bearing roots while keeping nearby paths distinct',
    match => {
      const result = mergeRobotsPolicy('', {
        ...blockDocs,
        paths: [{ value: '/docs', match }],
      });
      for (const path of ['/docs', '/docs?', '/docs?x=1']) {
        expect(checkRobotsAccess(result.content, 'GPTBot', path).allowed, path).toBe(false);
      }
      for (const path of ['/docs-private?x=1', '/docs%3Fx=1']) {
        expect(checkRobotsAccess(result.content, 'GPTBot', path).allowed, path).toBe(true);
      }
      expect(checkRobotsAccess(result.content, 'GPTBot', '/docs/child?x=1').allowed).toBe(
        match === 'exact',
      );
    },
  );

  it('retains encoded question marks and escaped literal dollars in query-bearing paths', () => {
    const result = mergeRobotsPolicy('', {
      ...blockDocs,
      paths: [{ value: '/docs%3Fcost$', match: 'exact' }],
    });
    expect(checkRobotsAccess(result.content, 'GPTBot', '/docs%3Fcost$?x=1').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/docs?cost$?x=1').allowed).toBe(true);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/docs%3Fcost$-private?x=1').allowed).toBe(
      true,
    );
  });

  it('supports Google-Extended only as a purpose token', () => {
    const result = mergeRobotsPolicy('', { ...blockDocs, botIds: ['google-extended'] });
    expect(result.safe).toBe(true);
    expect(result.fragment).toContain('User-agent: Google-Extended');
    expect(checkRobotsAccess(result.content, 'Google-Extended', '/docs').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'Googlebot', '/docs').allowed).toBe(true);
  });

  it('refuses ambiguous Allow precedence and unsafe Allow edits with a labeled fragment', () => {
    const blocked = mergeRobotsPolicy('User-agent: *\nAllow: /docs\n', blockDocs);
    expect(blocked).toMatchObject({ safe: false, content: null });
    expect(blocked.reasons[0]).toContain('Allow precedence');
    expect(blocked.fragment).toContain('fragment');
    const allowed = mergeRobotsPolicy('User-agent: *\nDisallow: /\n', {
      ...blockDocs,
      action: 'allow',
    });
    expect(allowed.safe).toBe(false);
    expect(allowed.reasons[0]).toContain('weaken');
  });

  it('refuses malformed or applicable extension directives without discarding the original', () => {
    expect(
      mergeRobotsPolicy('User-agent: *\nCrawl-delay: 10\nDisallow: /private\n', blockDocs).safe,
    ).toBe(false);
    expect(mergeRobotsPolicy('not a record', blockDocs).safe).toBe(false);
    expect(mergeRobotsPolicy('User-agent: *\nDisallow: private', blockDocs).content).toBeNull();
  });

  it('escapes literal wildcard characters and preserves trailing-slash semantics', () => {
    const exact = mergeRobotsPolicy('', {
      ...blockDocs,
      paths: [{ value: '/a*$+', match: 'exact' }],
    });
    expect(exact.fragment).toContain('/a%2A%24+$');
    expect(checkRobotsAccess(exact.content, 'GPTBot', '/a*$+').allowed).toBe(false);
    const trailing = mergeRobotsPolicy('', {
      ...blockDocs,
      paths: [{ value: '/docs/', match: 'prefix' }],
    });
    expect(checkRobotsAccess(trailing.content, 'GPTBot', '/docs').allowed).toBe(true);
    expect(checkRobotsAccess(trailing.content, 'GPTBot', '/docs/').allowed).toBe(false);
  });

  it('labels ChatGPT-User caveats in both fragment and merged content', () => {
    const result = mergeRobotsPolicy('', { ...blockDocs, botIds: ['chatgpt-user'] });
    expect(result.fragment).toContain('may not apply robots.txt');
    expect(result.content).toContain('may not apply robots.txt');
  });
});

describe('explicit one-click directory edits', () => {
  it.each([
    ['Disallow: /private', false],
    ['Disallow: /\nAllow: /private', true],
  ])(
    'preserves boundary-crossing rules while allowing a directory: %s',
    (rules, outsideAllowed) => {
      const base = `User-agent: GPTBot\n${rules}\nDisallow: /private/secret\n`;
      expect(checkRobotsAccess(base, 'GPTBot', '/private-other').allowed).toBe(outsideAllowed);
      const result = setRobotsAccess(base, {
        botIds: ['gptbot'],
        paths: [{ value: '/private', match: 'prefix' }],
        action: 'allow',
      });
      expect(result.safe).toBe(true);
      expect(result.content).toContain('User-agent: GPTBot');
      for (const path of ['/private', '/private/', '/private/secret'])
        expect(checkRobotsAccess(result.content, 'GPTBot', path).allowed).toBe(true);
      expect(checkRobotsAccess(result.content, 'GPTBot', '/private-other').allowed).toBe(
        outsideAllowed,
      );
    },
  );
  it('refuses a scoped block whose boundary Allow also permits unrelated paths', () => {
    const base = 'User-agent: GPTBot\nDisallow: /\nAllow: /private\n';
    expect(checkRobotsAccess(base, 'GPTBot', '/private-other').allowed).toBe(true);
    const result = setRobotsAccess(base, {
      botIds: ['gptbot'],
      paths: [{ value: '/private', match: 'prefix' }],
      action: 'block',
    });
    expect(result.safe).toBe(false);
    expect(result.content).toBeNull();
    expect(result.fragment).toContain('Disallow: /private$');
    expect(result.reasons.join(' ')).toContain('boundary');
  });
  it('retains a broad Disallow while blocking selected descendants in a shared group', () => {
    const base =
      'User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /private\nAllow: /private/open\n';
    const result = setRobotsAccess(base, {
      botIds: ['gptbot'],
      paths: [{ value: '/private', match: 'prefix' }],
      action: 'block',
    });
    expect(result.safe).toBe(true);
    expect(result.content).toContain('User-agent: ClaudeBot');
    expect(checkRobotsAccess(result.content, 'GPTBot', '/private/open').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/private-other').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'ClaudeBot', '/private/open').allowed).toBe(true);
    expect(checkRobotsAccess(result.content, 'ClaudeBot', '/private-other').allowed).toBe(false);
  });
  it('switches all-site allow and block without affecting other crawlers', () => {
    const base = 'User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml\n';
    const block = setRobotsAccess(base, {
      botIds: ['gptbot'],
      paths: [{ value: '/', match: 'prefix' }],
      action: 'block',
    });
    expect(block.safe).toBe(true);
    expect(checkRobotsAccess(block.content, 'GPTBot', '/public').allowed).toBe(false);
    const allow = setRobotsAccess(block.content, {
      botIds: ['gptbot'],
      paths: [{ value: '/', match: 'prefix' }],
      action: 'allow',
    });
    expect(allow.safe).toBe(true);
    expect(checkRobotsAccess(allow.content, 'GPTBot', '/private').allowed).toBe(true);
    expect(checkRobotsAccess(allow.content, 'ClaudeBot', '/private').allowed).toBe(false);
    expect(allow.content).toContain('Sitemap: https://example.com/sitemap.xml');
  });
  it('splits a shared UA group and preserves unrelated scopes and identities', () => {
    const base =
      'User-agent: GPTBot\nUser-agent: ClaudeBot\nAllow: /docs/open\nDisallow: /private\n';
    const result = setRobotsAccess(base, {
      botIds: ['gptbot'],
      paths: [{ value: '/docs', match: 'prefix' }],
      action: 'block',
    });
    expect(result.safe).toBe(true);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/docs/open').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/private').allowed).toBe(false);
    expect(checkRobotsAccess(result.content, 'ClaudeBot', '/docs/open').allowed).toBe(true);
  });
  it('preserves rule-free trailing groups and refuses ambiguous scoped wildcard edits', () => {
    const result = setRobotsAccess('User-agent: OtherBot', {
      botIds: ['gptbot'],
      paths: [{ value: '/', match: 'prefix' }],
      action: 'block',
    });
    expect(checkRobotsAccess(result.content, 'OtherBot', '/').allowed).toBe(true);
    expect(checkRobotsAccess(result.content, 'GPTBot', '/').allowed).toBe(false);
    expect(
      setRobotsAccess('User-agent: *\nDisallow: /*.pdf$', {
        botIds: ['gptbot'],
        paths: [{ value: '/docs', match: 'prefix' }],
        action: 'allow',
      }).safe,
    ).toBe(false);
  });
});
