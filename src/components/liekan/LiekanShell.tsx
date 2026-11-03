'use client';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { useLiekanPageTitle } from '@/lib/liekan/i18n/client';

import { type CSSProperties, createContext, type ReactNode, useContext, useState } from 'react';
import type { FeatureUser } from '@/lib/liekan/contracts/features';
import {
  geoPageFromPath,
  navigationFor,
  pageNavigation,
  websiteAnalysisFamily,
} from '@/lib/liekan/contracts/navigation';
import { useNavigation, useWebsiteQuery } from '@/lib/liekan/upstream/client';
import { featureSiteQuery } from '@/lib/liekan/upstream/features-client';
import { websiteMatchesHandle } from '@/lib/liekan/website-handle';
import reference from '@/styles/liekan/Reference.module.css';
import styles from '@/styles/liekan/Shell.module.css';
import localeStyles from '@/styles/liekan/LanguageSelector.module.css';
import { LanguageSelector } from './LanguageSelector';
import { AnalysisTabs } from './AnalysisTabs';
import { DataLoading } from './DataLoading';
import { featureNavigationHref, matchFeatureRoute } from './features/routes';
import { Navigation, useSidebarWidth } from './Navigation';
import { HistoryRepairNotice } from './features/HistoryRepairNotice';
import { ProductFooter } from './ProductFooter';
import { WebsiteToolbar } from './WebsiteToolbar';
import type { LiekanReport } from './types';
import type { RobotsOverviewRange } from '@/lib/liekan/contracts/robots-overview';
type ShellWebsite = LiekanReport['website'] & { robotsRange?: RobotsOverviewRange };

const ShellContext = createContext<{
  setWebsite: (website: ShellWebsite) => void;
  setBotCount: (count: number) => void;
  websiteActionsTarget: HTMLDivElement;
}>(null);
export const useLiekanShell = () => useContext(ShellContext);
export function LiekanShell({ children, user }: { children: ReactNode; user: FeatureUser }) {
  const i18n = useLiekanI18n();
  const { pathname, websiteId, query } = useNavigation();
  const [width, setWidth] = useSidebarWidth();
  const [website, setWebsite] = useState<ShellWebsite>(null);
  const [, setBotCount] = useState<number>(null);
  const isGeo = pathname.includes('/geo');
  const route = pathname.includes('/geo')
    ? { page: geoPageFromPath(pathname), websiteId }
    : matchFeatureRoute(pathname, query) || { page: 'websites' };
  useLiekanPageTitle(
    websiteAnalysisFamily(route)?.label || pageNavigation[route.page]?.title || '网站管理',
  );
  const metadata = useWebsiteQuery(isGeo ? websiteId : undefined, {
    ...featureSiteQuery(user.id, websiteId),
    placeholderData: undefined,
  });
  const metadataRestricted = [401, 403, 404].includes((metadata.error as any)?.status);
  const currentMetadata =
    !metadataRestricted && websiteMatchesHandle(metadata.data, websiteId)
      ? metadata.data
      : undefined;
  const currentWebsite =
    !metadataRestricted && websiteMatchesHandle(website, websiteId) ? website : undefined;
  const site = currentMetadata ? { ...currentWebsite, ...currentMetadata } : currentWebsite;
  const [websiteContextTarget, setWebsiteContextTarget] = useState<HTMLDivElement>(null);
  const [websiteActionsTarget, setWebsiteActionsTarget] = useState<HTMLDivElement>(null);
  const href = (page: string, params: Record<string, any> = {}) =>
    featureNavigationHref(route, query, page, params);
  return (
    <ShellContext.Provider value={{ setWebsite, setBotCount, websiteActionsTarget }}>
      <div
        className={styles.shell}
        style={{ '--lk-side-w': `${width}px` } as CSSProperties}
        data-liekan-ui
        lang={i18n.locale}
      >
        <Navigation
          user={user}
          route={route}
          site={site}
          width={width}
          onWidth={setWidth}
          href={href}
          websiteContextTarget={websiteContextTarget}
        />
        <div className={styles.content} id="main-content">
          <div className={`${styles.pageBody} ${isGeo ? reference.root : styles.coreFrame}`}>
            {navigationFor(route).scope === 'website' ? (
              <WebsiteToolbar
                contextRef={setWebsiteContextTarget}
                actionsRef={setWebsiteActionsTarget}
                websiteId={site?.id}
                range={currentWebsite?.robotsRange}
              />
            ) : (
              <div className={localeStyles.standalone}>
                <LanguageSelector toolbar />
              </div>
            )}
            {isGeo && !currentMetadata && metadata.isError ? (
              <>
                <div className={styles.header}>
                  <div className={styles.headerInner}>
                    <h1 data-liekan-page-title className="text-[16px] font-bold tracking-tight">
                      {i18n.system(
                        websiteAnalysisFamily(route)?.label || pageNavigation[route.page]?.title,
                      )}
                    </h1>
                  </div>
                </div>
                <div className={styles.tabsFrame}>
                  <AnalysisTabs route={route} href={href} />
                </div>
                <div className={styles.notice} role="status">
                  {i18n.fragment('无法读取网站信息', false, true)}
                  <button type="button" onClick={() => metadata.refetch()}>
                    {i18n.text('重试')}
                  </button>
                </div>
              </>
            ) : (
              <DataLoading loading={isGeo && !currentMetadata}>{children}</DataLoading>
            )}
          </div>
          <ProductFooter />
          <HistoryRepairNotice userId={user.id} />
        </div>
      </div>
    </ShellContext.Provider>
  );
}
