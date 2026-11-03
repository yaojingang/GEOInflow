import { z } from 'zod';
import {
  crawlerHasControlCharacters,
  crawlerPathSchema,
  crawlerRobotsBotIds,
} from '../contracts/crawlers';
import { getCrawler } from './directory';

export const ROBOTS_MAX_BYTES = 256 * 1024;
export const ROBOTS_PARSE_MAX_BYTES = 512 * 1024;
// Some reviewed providers use digits or spaces outside RFC 9309's product-token grammar.
const reviewedRobotsTokens = new Set(
  crawlerRobotsBotIds.map(id => getCrawler(id).robotsToken.toLowerCase()),
);
const productToken = z
  .string()
  .min(1)
  .max(80)
  .refine(
    value =>
      !crawlerHasControlCharacters(value) &&
      (/^(?:[a-z_-]+|\*)$/i.test(value) || reviewedRobotsTokens.has(value.toLowerCase())),
    'Invalid robots user-agent token',
  );
const robotsPath = z
  .string()
  .max(8192)
  .refine(
    value =>
      (!value || value.startsWith('/')) &&
      !crawlerHasControlCharacters(value) &&
      !/[\s#]/u.test(value) &&
      !/%(?![a-f0-9]{2})/i.test(value) &&
      !/[\ud800-\udfff]/u.test(value),
    'Invalid robots path',
  );

export interface RobotsRule {
  directive: 'allow' | 'disallow';
  path: string;
  line: number;
}
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  otherDirectives: string[];
  startLine: number;
}
export interface RobotsDocument {
  text: string;
  groups: RobotsGroup[];
  issues: { line: number; reason: string }[];
  newline: '\n' | '\r\n' | '\r';
}

/** Parsing accepts the RFC 9309 minimum of 500 KiB; editing has a separate smaller bound. */
export function parseRobots(text: string): RobotsDocument {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > ROBOTS_PARSE_MAX_BYTES) {
    throw new Error('robots.txt access check is unsupported above the 512 KiB parser limit');
  }
  const document: RobotsDocument = {
    text,
    groups: [],
    issues: [],
    newline: text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n',
  };
  let group: RobotsGroup | null = null;
  let hasRules = false;
  for (const [index, original] of text.split(/\r\n|\n|\r/).entries()) {
    const line = index + 1;
    if (crawlerHasControlCharacters(original.replaceAll('\t', ''))) {
      document.issues.push({ line, reason: 'Invalid control character' });
      continue;
    }
    const record = original
      .replace(/^\ufeff/, '')
      .split('#', 1)[0]
      .trim();
    if (!record) continue;
    const colon = record.indexOf(':');
    if (colon < 1) {
      document.issues.push({ line, reason: 'Malformed record' });
      continue;
    }
    const directive = record.slice(0, colon).trim().toLowerCase();
    const value = record.slice(colon + 1).trim();
    if (directive === 'user-agent') {
      if (!productToken.safeParse(value).success) {
        document.issues.push({ line, reason: 'Invalid user-agent token' });
        // A malformed group boundary must not attach its rules to the preceding valid group.
        group = null;
        hasRules = false;
        continue;
      }
      if (!group || hasRules) {
        group = { agents: [], rules: [], otherDirectives: [], startLine: line };
        document.groups.push(group);
        hasRules = false;
      }
      group.agents.push(value);
    } else if (directive === 'allow' || directive === 'disallow') {
      hasRules = true;
      if (!robotsPath.safeParse(value).success) {
        document.issues.push({ line, reason: 'Invalid robots path' });
        continue;
      }
      if (group) group.rules.push({ directive, path: value, line });
    } else {
      // Sitemap and extension records never end an RFC 9309 group.
      if (!/^[a-z][a-z0-9_-]*$/i.test(directive)) {
        document.issues.push({ line, reason: 'Invalid directive name' });
      } else if (group && directive !== 'sitemap') {
        group.otherDirectives.push(original);
      }
    }
  }
  return document;
}

export function applicableRobotsGroups(document: RobotsDocument, token: string): RobotsGroup[] {
  const name = productToken.parse(token).toLowerCase();
  const matches = document.groups.filter(group =>
    group.agents.some(agent => agent !== '*' && agent.toLowerCase() === name),
  );
  return matches.length ? matches : document.groups.filter(group => group.agents.includes('*'));
}

function normalizeRobotsOctets(value: string, isPattern = false) {
  return Array.from(value)
    .map((character, index, characters) => {
      if (character === '*' && !isPattern) return '%2A';
      if (character === '$' && (!isPattern || index !== characters.length - 1)) return '%24';
      return character.codePointAt(0) > 127 ? encodeURIComponent(character) : character;
    })
    .join('')
    .replace(/%([a-f0-9]{2})/gi, (encoded, hex) => {
      const decoded = String.fromCharCode(parseInt(hex, 16));
      return /^[a-z0-9._~-]$/i.test(decoded) ? decoded : encoded.toUpperCase();
    });
}

// Ordered literal searches avoid constructing a regular expression from untrusted robots text.
function matchesRobotsPattern(pattern: string, path: string) {
  const anchored = pattern.endsWith('$');
  const value = anchored ? pattern.slice(0, -1) : pattern;
  const pieces = value.split('*');
  if (pieces.length === 1) return anchored ? path === value : path.startsWith(value);
  if (!path.startsWith(pieces[0])) return false;
  let cursor = pieces[0].length;
  for (let index = 1; index < pieces.length; index++) {
    const piece = pieces[index];
    if (anchored && index === pieces.length - 1) {
      return path.endsWith(piece) && path.length - piece.length >= cursor;
    }
    const found = path.indexOf(piece, cursor);
    if (found < 0) return false;
    cursor = found + piece.length;
  }
  return true;
}

export interface RobotsAccessResult {
  allowed: boolean;
  matchedRule: RobotsRule | null;
  applicableAgents: string[];
  caveat: string | null;
  issues: RobotsDocument['issues'];
}

export function checkRobotsAccess(
  input: string | RobotsDocument,
  token: string,
  path: string,
): RobotsAccessResult {
  const document = typeof input === 'string' ? parseRobots(input) : input;
  const requestPath = z
    .string()
    .max(8192)
    .startsWith('/')
    .refine(
      value =>
        !crawlerHasControlCharacters(value) &&
        !/[\s#]/u.test(value) &&
        !/[\ud800-\udfff]/u.test(value),
    )
    .parse(path);
  const groups = applicableRobotsGroups(document, token);
  const normalizedPath = normalizeRobotsOctets(requestPath);
  let matchedRule: RobotsRule | null = null;
  let specificity = -1;
  if (normalizedPath !== '/robots.txt') {
    for (const rule of groups.flatMap(group => group.rules)) {
      if (!rule.path) continue;
      const normalized = normalizeRobotsOctets(rule.path, true);
      if (!matchesRobotsPattern(normalized, normalizedPath)) continue;
      const length = new TextEncoder().encode(normalized).length;
      if (length > specificity || (length === specificity && rule.directive === 'allow')) {
        matchedRule = rule;
        specificity = length;
      }
    }
  }
  const caveat = ['chatgpt-user', 'perplexity-user'].includes(token.toLowerCase())
    ? 'User-triggered retrieval may not apply robots.txt; use HTTP controls for enforced access.'
    : null;
  return {
    allowed: matchedRule?.directive !== 'disallow',
    matchedRule,
    applicableAgents: groups.flatMap(group => group.agents),
    caveat,
    issues: document.issues,
  };
}

export const crawlerRobotsPolicySchema = z.strictObject({
  botIds: z
    .array(z.enum(crawlerRobotsBotIds))
    .min(1)
    .max(10)
    .refine(ids => new Set(ids).size === ids.length),
  paths: z.array(crawlerPathSchema).min(1).max(10),
  action: z.enum(['allow', 'block']),
});
export type CrawlerRobotsPolicy = z.infer<typeof crawlerRobotsPolicySchema>;
export interface RobotsMergeResult {
  safe: boolean;
  content: string | null;
  fragment: string;
  reasons: string[];
}

function literalRobotsPath(path: string) {
  return path.replaceAll('*', '%2A').replaceAll('$', '%24');
}

/** A refused full export still returns a labeled fragment for manual reconciliation. */
export function mergeRobotsPolicy(text: string, input: CrawlerRobotsPolicy): RobotsMergeResult {
  const document = parseRobots(text);
  const policy = crawlerRobotsPolicySchema.parse(input);
  const directive = policy.action === 'block' ? 'Disallow' : 'Allow';
  const newline = document.newline;
  const generated = policy.paths.flatMap(path => {
    const value = literalRobotsPath(path.value);
    // Selectors target the pathname; robots rules also inspect the query suffix.
    const root = [`${directive}: ${value}$`, `${directive}: ${value}?`];
    return path.match === 'exact'
      ? root
      : value.endsWith('/')
        ? [`${directive}: ${value}`]
        : [...root, `${directive}: ${value}/`];
  });
  const fragment = [
    '# Liekan robots.txt fragment. Review with the existing file before publishing.',
    ...policy.botIds.flatMap(id => [
      ...(getCrawler(id).robotsApplicability === 'user_triggered_caveat'
        ? ['# User-triggered retrieval may not apply robots.txt.']
        : []),
      `User-agent: ${getCrawler(id).robotsToken}`,
      ...generated,
      '',
    ]),
  ].join(newline);
  const reasons: string[] = [];
  if (new TextEncoder().encode(text).length > ROBOTS_MAX_BYTES) {
    reasons.push('Existing file exceeds the 256 KiB editor limit.');
  }
  if (document.groups.length && !document.groups.at(-1).rules.length) {
    reasons.push('Final user-agent group has no rules; appending could change its access.');
  }
  if (document.issues.length)
    reasons.push('Existing robots.txt has malformed records requiring review.');
  const groups = policy.botIds.map(id => ({
    crawler: getCrawler(id),
    applicable: applicableRobotsGroups(document, getCrawler(id).robotsToken),
  }));
  for (const { crawler, applicable } of groups) {
    const rules = applicable.flatMap(group => group.rules);
    if (applicable.some(group => group.otherDirectives.length)) {
      reasons.push(`${crawler.name}: applicable extension directives require manual merge.`);
    }
    if (
      policy.action === 'allow' &&
      rules.some(rule => rule.directive === 'disallow' && rule.path)
    ) {
      reasons.push(`${crawler.name}: an Allow edit may weaken an existing Disallow.`);
    }
    if (policy.action === 'block' && rules.some(rule => rule.directive === 'allow' && rule.path)) {
      reasons.push(`${crawler.name}: existing Allow precedence requires manual merge.`);
    }
  }
  if (reasons.length) return { safe: false, content: null, fragment, reasons };
  const append = groups
    .flatMap(({ crawler, applicable }) => [
      '# Liekan addition. Applicable original rules are retained in this specific group.',
      ...(crawler.robotsApplicability === 'user_triggered_caveat'
        ? ['# User-triggered retrieval may not apply robots.txt.']
        : []),
      `User-agent: ${crawler.robotsToken}`,
      ...applicable.flatMap(group => group.rules).map(rule => `${rule.directive}: ${rule.path}`),
      ...generated,
      '',
    ])
    .join(newline);
  const content = `${text}${text.endsWith('\n') || text.endsWith('\r') || !text ? '' : newline}${newline}${append}`;
  if (new TextEncoder().encode(content).length > ROBOTS_MAX_BYTES) {
    return {
      safe: false,
      content: null,
      fragment,
      reasons: ['Merged file exceeds the 256 KiB editor limit.'],
    };
  }
  return { safe: true, content, fragment, reasons: [] };
}

/** Apply an explicitly selected directory policy while retaining other crawlers and scopes. */
export function setRobotsAccess(text: string, input: CrawlerRobotsPolicy): RobotsMergeResult {
  const policy = crawlerRobotsPolicySchema.parse(input);
  if (policy.botIds.length !== 1 || policy.paths.length !== 1 || policy.paths[0].match !== 'prefix')
    throw new Error('Select one crawler and directory');
  const document = parseRobots(text);
  const bot = getCrawler(policy.botIds[0]);
  const token = bot.robotsToken.toLowerCase();
  const applicable = applicableRobotsGroups(document, bot.robotsToken);
  const scope = normalizeRobotsOctets(literalRobotsPath(policy.paths[0].value));
  const rules = applicable.flatMap(group => group.rules);
  const fallback = mergeRobotsPolicy(text, policy);
  if (
    document.issues.length ||
    applicable.some(group => group.otherDirectives.length) ||
    (scope !== '/' && rules.some(rule => rule.path.includes('*')))
  ) {
    return {
      safe: false,
      content: null,
      fragment: fallback.fragment,
      reasons: ['Existing malformed, extension or wildcard rules require manual review.'],
    };
  }
  const crossesBoundary = (rule: RobotsRule) =>
    scope !== '/' &&
    !scope.endsWith('/') &&
    !rule.path.endsWith('$') &&
    normalizeRobotsOctets(rule.path) === scope;
  if (
    policy.action === 'block' &&
    rules.some(rule => rule.directive === 'allow' && crossesBoundary(rule))
  ) {
    return {
      safe: false,
      content: null,
      fragment: fallback.fragment,
      reasons: ['An existing Allow crosses the directory boundary and requires manual review.'],
    };
  }
  const inside = (path: string) => {
    const normalized = normalizeRobotsOctets(path.replace(/\$$/, ''));
    return (
      scope === '/' ||
      normalized === scope ||
      normalized.startsWith(scope.endsWith('/') ? scope : `${scope}/`) ||
      normalized.startsWith(`${scope}?`)
    );
  };
  // An unanchored boundary rule also covers sibling paths such as /docs-other.
  const retained = rules.filter(rule => crossesBoundary(rule) || !inside(rule.path));
  const lines = text.split(/\r\n|\n|\r/);
  const removed = new Set<number>();
  for (let index = 0; index < document.groups.length; index++) {
    const group = document.groups[index];
    if (!group.agents.some(agent => agent.toLowerCase() === token)) continue;
    const shared = group.agents.some(agent => agent.toLowerCase() !== token);
    const end = (document.groups[index + 1]?.startLine ?? lines.length + 1) - 1;
    for (let line = group.startLine; line <= end; line++) {
      const match = lines[line - 1]
        .replace(/^\ufeff/, '')
        .split('#', 1)[0]
        .match(/^\s*user-agent\s*:\s*(.*?)\s*$/i);
      if (match?.[1].toLowerCase() === token) removed.add(line);
    }
    if (!shared) for (const rule of group.rules) removed.add(rule.line);
  }
  let original = lines.filter((_, index) => !removed.has(index + 1)).join(document.newline);
  const finalGroup = parseRobots(original).groups.at(-1);
  // An empty Disallow keeps a trailing rule-free group open to all paths and ends its UA list.
  if (finalGroup && !finalGroup.rules.length)
    original += `${document.newline}Disallow:${document.newline}`;
  const path = literalRobotsPath(policy.paths[0].value);
  const directive = policy.action === 'allow' ? 'Allow' : 'Disallow';
  const generated = path.endsWith('/')
    ? [`${directive}: ${path}`]
    : [`${directive}: ${path}$`, `${directive}: ${path}?`, `${directive}: ${path}/`];
  const fragment = [
    `# GEOInflow managed access: ${bot.robotsToken}`,
    ...(bot.robotsApplicability === 'user_triggered_caveat'
      ? ['# User-triggered retrieval may not apply robots.txt.']
      : []),
    `User-agent: ${bot.robotsToken}`,
    ...retained.map(rule => `${rule.directive}: ${rule.path}`),
    ...generated,
    '',
  ].join(document.newline);
  const content = `${original}${document.newline}${document.newline}${fragment}`;
  if (new TextEncoder().encode(content).length > ROBOTS_MAX_BYTES)
    return {
      safe: false,
      content: null,
      fragment,
      reasons: ['Edited file exceeds the 256 KiB limit.'],
    };
  return { safe: true, content, fragment, reasons: [] };
}
