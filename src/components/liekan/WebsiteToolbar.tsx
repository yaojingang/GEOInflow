'use client';
import type { ReactNode, Ref } from 'react';
import { WebsiteRobotsControl } from './WebsiteRobotsControl';
import type { RobotsOverviewRange } from '@/lib/liekan/contracts/robots-overview';
import { LanguageSelector } from './LanguageSelector';
import styles from '@/styles/liekan/WebsiteToolbar.module.css';

export function WebsiteToolbar({
  contextRef,
  actionsRef,
  actions,
  websiteId,
  range,
}: {
  contextRef: Ref<HTMLDivElement>;
  actionsRef?: Ref<HTMLDivElement>;
  actions?: ReactNode;
  websiteId?: string;
  range?: RobotsOverviewRange;
}) {
  return (
    <div className={styles.toolbar} data-website-toolbar data-website-context-frame>
      <div className={styles.context} ref={contextRef} data-website-toolbar-context />
      <div
        className={styles.actions}
        ref={actionsRef}
        data-website-toolbar-actions
        data-toolbar-action-rail
      >
        {actions}
        {websiteId && <WebsiteRobotsControl key={websiteId} websiteId={websiteId} range={range} />}
      </div>
      <LanguageSelector toolbar />
    </div>
  );
}
