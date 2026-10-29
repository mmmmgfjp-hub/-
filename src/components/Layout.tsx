import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { usePwa } from '../lib/pwa';
import { Modal } from './ui';
import './layout.css';

export function Logo({ size = 42 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }}>
      <svg
        width={size * 0.62}
        height={size * 0.62}
        viewBox="0 0 32 32"
        role="img"
        aria-label="Ibn Al Yemen AI"
      >
        <defs>
          <linearGradient id="iay-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f0dc9a" />
            <stop offset="55%" stopColor="#c9a227" />
            <stop offset="100%" stopColor="#7d6212" />
          </linearGradient>
        </defs>
        {/* stylised Yemeni mihrab arch framing a rising market line */}
        <path
          d="M16 3.2c5.2 3.1 8.4 7.3 8.4 12.4 0 5.4-3.8 9.2-8.4 13.2-4.6-4-8.4-7.8-8.4-13.2C7.6 10.5 10.8 6.3 16 3.2z"
          none-=""
          fill="none"
          stroke="url(#iay-gold)"
          strokeWidth="1.8"
        />
        <path
          d="M11.4 20.4l3.1-3.6 2.6 2.2 3.9-5.4"
          fill="none"
          stroke="url(#iay-gold)"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="21.1" cy="13.5" r="1.7" fill="#f0dc9a" />
        <path d="M13.2 25.6h5.6" stroke="url(#iay-gold)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function InstallPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const pwa = usePwa();
  const [state, setState] = useState<'idle' | 'busy' | 'manual'>('idle');

  return (
    <div className="stack">
      <p className="small">{t('installHint')}</p>
      {pwa.installed ? <p className="small muted">{t('installed')}</p> : null}
      {pwa.canPrompt ? (
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={state === 'busy'}
          onClick={async () => {
            setState('busy');
            const outcome = await pwa.promptInstall();
            setState(outcome === 'unavailable' ? 'manual' : 'idle');
            if (outcome !== 'unavailable') onClose();
          }}
        >
          {t('installApp')}
        </button>
      ) : null}
      <div className="alert alert--info small">
        {pwa.isIos ? t('installIos') : t('installAndroid')}
      </div>
      <p className="hint">{t('pwaNote')}</p>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { t, lang, toggle, dir } = useI18n();
  const { user, isStaff, signOut } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const links = [
    { to: '/', label: t('home'), exact: true },
    ...(user ? [{ to: '/history', label: t('history'), exact: false }] : []),
    { to: '/subscribe', label: t('subscription'), exact: false },
    ...(user ? [{ to: '/account', label: t('account'), exact: false }] : []),
    ...(isStaff ? [{ to: '/admin', label: t('admin'), exact: false }] : []),
  ];

  return (
    <div className="app-shell">
      <header className="topbar" ref={menuRef}>
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}>
          <Logo />
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span className="brand-name">{t('appName')}</span>
            <span className="brand-sub">{t('appSuffix')}</span>
          </span>
        </Link>

        <nav className="nav-links" aria-label="main">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.exact}
              className={({ isActive }) => (isActive ? 'is-active' : undefined)}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <span className="topbar-spacer" />

        <div className="topbar-actions">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            style={{ borderColor: 'var(--line)' }}
            onClick={() => setInstallOpen(true)}
            title={t('installApp')}
          >
            ⤓ <span className="sr-only">{t('installApp')}</span>
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={toggle}
            aria-label={t('language')}
          >
            {lang === 'ar' ? 'EN' : 'ع'}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {user ? (user.displayName || user.email).slice(0, 1).toUpperCase() : '☰'}
            <span className="sr-only">{t('account')}</span>
          </button>
        </div>

        {menuOpen ? (
          <div className="topbar-menu" role="menu">
            {user ? (
              <>
                <div className="menu-mail">{user.email}</div>
                <Link to="/account" role="menuitem">
                  👤 {t('profile')}
                </Link>
                <Link to="/history" role="menuitem">
                  🕘 {t('history')}
                </Link>
                <Link to="/subscribe" role="menuitem">
                  ⭐ {t('subscription')}
                </Link>
                {isStaff ? (
                  <Link to="/admin" role="menuitem">
                    ⚙ {t('admin')}
                  </Link>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    setMenuOpen(false);
                    await signOut();
                  }}
                >
                  ⎋ {t('signOut')}
                </button>
              </>
            ) : (
              <>
                <Link to="/login" role="menuitem">
                  {t('signIn')}
                </Link>
                <Link to="/register" role="menuitem">
                  {t('signUp')}
                </Link>
                <Link to="/subscribe" role="menuitem">
                  {t('subscription')}
                </Link>
                <button type="button" role="menuitem" onClick={toggle}>
                  {lang === 'ar' ? t('english') : t('arabic')}
                </button>
              </>
            )}
          </div>
        ) : null}
      </header>

      <nav className="bottom-nav" aria-label="sections" dir={dir}>
        {links.slice(0, 5).map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.exact}
            className={({ isActive }) => (isActive ? 'is-active' : undefined)}
          >
            <span className="nav-glyph" aria-hidden="true">
              {link.to === '/' ? '◈' : link.to === '/history' ? '🕘' : link.to === '/account' ? '👤' : link.to === '/admin' ? '⚙' : '⭐'}
            </span>
            {link.label}
          </NavLink>
        ))}
      </nav>

      <main className="page">{children}</main>

      <footer className="site-footer">
        <p>{t('riskDisclaimer')}</p>
        <p style={{ marginTop: 8 }}>{t('pwaNote')}</p>
      </footer>

      {installOpen ? (
        <Modal title={t('installApp')} onClose={() => setInstallOpen(false)}>
          <InstallPanel onClose={() => setInstallOpen(false)} />
        </Modal>
      ) : null}
    </div>
  );
}
