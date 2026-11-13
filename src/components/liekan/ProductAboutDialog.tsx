'use client';

import { useEffect, useState } from 'react';
import Link from '@/components/liekan/Link';
import {
  type LiekanContributor,
  liekanProduct,
  liekanProjectInitiators,
  liekanPublisherLinks,
} from '@/lib/liekan/contracts/product';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import styles from '@/styles/liekan/ProductAboutDialog.module.css';
import { DialogActions, LiekanDialog } from './features/LiekanDialog';

function GitHubIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.57.1.78-.25.78-.55v-2.12c-3.18.69-3.85-1.35-3.85-1.35-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.73-1.53-2.54-.29-5.21-1.27-5.21-5.66 0-1.25.44-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.13 1.17a10.9 10.9 0 0 1 5.7 0c2.17-1.48 3.12-1.17 3.12-1.17.63 1.57.24 2.73.12 3.02.73.8 1.18 1.82 1.18 3.07 0 4.4-2.68 5.37-5.23 5.65.41.36.78 1.05.78 2.12v3.14c0 .3.2.66.79.55A11.4 11.4 0 0 0 12 .8Z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M7 17 17 7M7 7h10v10" />
    </svg>
  );
}

export function ProductAboutDialog({ onClose }: { onClose: () => void }) {
  const i18n = useLiekanI18n();
  const [contributors, setContributors] = useState<LiekanContributor[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    async function loadContributors() {
      try {
        const response = await fetch(`${process.env.basePath || ''}/api/liekan/contributors`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Contributors unavailable');
        const data = await response.json();
        if (!controller.signal.aborted) setContributors(data.contributors);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    void loadContributors();
    return () => controller.abort();
  }, [attempt]);

  return (
    <LiekanDialog
      size="wide"
      className={styles.root}
      protectUnsaved={false}
      onClose={onClose}
      title={
        <span className={styles.heading}>
          <img src={`${process.env.basePath || ''}/liekan/features/logo.svg`} alt="" />
          <span>
            <span className={styles.titleLine}>
              <span>{liekanProduct.name}</span>
              <span className={styles.version}>v{liekanProduct.displayVersion}</span>
            </span>
            <span className={styles.caption}>
              {liekanProduct.caption} · {i18n.text('AI 与搜索流量分析')}
            </span>
          </span>
        </span>
      }
    >
      <div className={styles.columns} data-product-about>
        <div>
          <section>
            <h3 className={styles.sectionTitle}>{i18n.text('联合开源')}</h3>
            <div className={styles.publishers}>
              <div className={styles.publisherNames}>
                {liekanPublisherLinks.map(({ label, href }, index) => (
                  <span className={styles.publisher} key={href}>
                    {index > 0 && (
                      <span className={styles.times} aria-hidden="true">
                        ×
                      </span>
                    )}
                    <a
                      className={styles.publisherLink}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {label}
                    </a>
                  </span>
                ))}
              </div>
              <p className={styles.publisherNote}>
                {i18n.text('共同推动 GEO 分析工具的开放与共建')}
              </p>
            </div>
          </section>
          <section className={styles.initiators}>
            <h3 className={styles.sectionTitle}>{i18n.text('项目发起人')}</h3>
            {liekanProjectInitiators.map(
              ({ name, initial, description, descriptionValues, href, handle }, index) => (
                <div className={styles.person} key={name} data-project-initiator={name}>
                  <span
                    className={`${styles.avatar} ${index > 0 ? styles.neutralAvatar : ''}`}
                    aria-hidden="true"
                  >
                    {initial}
                  </span>
                  <div className={styles.personText}>
                    <div className={styles.personHeading}>
                      <span className={styles.personName}>{name}</span>
                      {href && handle && (
                        <a
                          className={styles.profile}
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={i18n.text('{v0}的 X 主页', [name])}
                        >
                          {handle}
                          <ExternalIcon />
                        </a>
                      )}
                    </div>
                    <span className={styles.personRole}>
                      {i18n.text(description, descriptionValues)}
                    </span>
                  </div>
                </div>
              ),
            )}
          </section>
        </div>
        <section className={styles.contributors} aria-label={i18n.text('开源贡献者')}>
          <div className={styles.contributorHead}>
            <h3>{i18n.text('开源贡献者')}</h3>
            <a
              className={styles.source}
              href={liekanProduct.links.github}
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitHubIcon />
              GitHub
            </a>
          </div>
          <p className={styles.thanks}>{i18n.text('感谢每一位参与 GEOInflow 建设的朋友。')}</p>
          {contributors?.length ? (
            <ul className={styles.contributorList}>
              {contributors.map(({ login, avatarUrl, profileUrl }) => (
                <li key={login}>
                  <a
                    className={styles.contributor}
                    href={profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={i18n.text('{v0}的 GitHub 主页', [login])}
                  >
                    <span className={styles.contributorAvatar} aria-hidden="true">
                      {login[0].toUpperCase()}
                      <img
                        src={avatarUrl}
                        alt=""
                        width="40"
                        height="40"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={event => {
                          event.currentTarget.style.visibility = 'hidden';
                        }}
                      />
                    </span>
                    <span>{login}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.pending} role="status" aria-live="polite">
              <GitHubIcon className={styles.pendingIcon} />
              <h4>
                {failed
                  ? i18n.text('暂时无法加载贡献者')
                  : contributors
                    ? i18n.text('暂无公开贡献者')
                    : i18n.text('正在加载贡献者…')}
              </h4>
              {failed && (
                <button className={styles.retry} onClick={() => setAttempt(value => value + 1)}>
                  {i18n.text('重试')}
                </button>
              )}
            </div>
          )}
          <a
            className={styles.allContributors}
            href={`${liekanProduct.links.github}/graphs/contributors`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {i18n.text('查看全部贡献者')}
            <ExternalIcon />
          </a>
        </section>
      </div>
      <DialogActions>
        <nav className={styles.actions} aria-label={i18n.text('项目相关链接')}>
          <Link prefetch={false} href={liekanProduct.links.changelog} onClick={onClose}>
            {i18n.text('更新日志')}
          </Link>
          <Link className="btn" prefetch={false} href={liekanProduct.links.about} onClick={onClose}>
            {i18n.text('项目说明')}
          </Link>
        </nav>
      </DialogActions>
    </LiekanDialog>
  );
}
