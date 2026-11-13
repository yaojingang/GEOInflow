import { z } from 'zod';
import type { LiekanContributor } from '@/lib/liekan/contracts/product';

const contributorsSchema = z.array(
  z.object({
    login: z
      .string()
      .regex(/^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\[bot\])?$/i)
      .max(100),
    avatar_url: z.url().startsWith('https://avatars.githubusercontent.com/'),
    html_url: z.url().startsWith('https://github.com/'),
  }),
);

let unavailableUntil = 0;
const unavailable = () =>
  Response.json(
    { error: 'GitHub contributors unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );

// Only public project metadata is exposed. The destination is fixed for every installation.
export async function GET() {
  if (Date.now() < unavailableUntil) return unavailable();
  try {
    const contributors: LiekanContributor[] = [];
    const signal = AbortSignal.timeout(10000);
    let page = 1;
    let hasNext: boolean;
    do {
      const response = await fetch(
        `https://api.github.com/repos/yaojingang/GEOInflow/contributors?per_page=100&page=${page}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'GEOInflow',
            'X-GitHub-Api-Version': '2026-03-10',
          },
          next: { revalidate: 3600 },
          signal,
        },
      );
      if (!response.ok) throw new Error('GitHub contributors unavailable');
      if (response.status === 204) break;
      const rows = contributorsSchema.parse(await response.json());
      for (const { login, avatar_url, html_url } of rows) {
        const avatar = new URL(avatar_url);
        avatar.searchParams.set('s', '96');
        contributors.push({
          login,
          avatarUrl: avatar.href,
          profileUrl: html_url,
        });
      }
      hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') || '');
      page++;
    } while (hasNext);
    return Response.json(
      { contributors },
      { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=3600' } },
    );
  } catch {
    // Failed fetches are not in Next's data cache; share a short outage cooldown.
    unavailableUntil = Date.now() + 30000;
    return unavailable();
  }
}
