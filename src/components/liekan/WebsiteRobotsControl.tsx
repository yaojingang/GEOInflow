'use client';
import { lazy, Suspense, useState } from 'react';
import type { RobotsOverviewRange } from '@/lib/liekan/contracts/robots-overview';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { LiekanDialog } from './features/LiekanDialog';
import styles from '@/styles/liekan/WebsiteToolbar.module.css';
const Management = lazy(() =>
  import('./features/RobotsManagementPanel').then(module => ({
    default: module.RobotsManagementPanel,
  })),
);
export function WebsiteRobotsControl({
  websiteId,
  range,
}: {
  websiteId: string;
  range?: RobotsOverviewRange;
}) {
  const i18n = useLiekanI18n();
  const [opened, setOpened] = useState<{ websiteId: string; range?: RobotsOverviewRange } | null>(
    null,
  );
  return (
    <>
      <button
        type="button"
        className={styles.robotsButton}
        data-toolbar-robots
        onClick={() => setOpened({ websiteId, range: range ? { ...range } : undefined })}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M7 3h8l4 4v14H5V3h2Zm7 0v5h5M8 12h8M8 16h6" />
        </svg>
        {i18n.text('robots 管理')}
      </button>
      {opened?.websiteId === websiteId && (
        <LiekanDialog
          title={i18n.text('robots.txt 管理')}
          size="wide"
          onClose={() => setOpened(null)}
        >
          <Suspense fallback={<p role="status">{i18n.text('正在读取 robots 管理面板…')}</p>}>
            <Management
              key={websiteId}
              websiteId={websiteId}
              initialView="overview"
              range={opened.range}
            />
          </Suspense>
        </LiekanDialog>
      )}
    </>
  );
}
