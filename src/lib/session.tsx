import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  api,
  ApiError,
  type Bootstrap,
  type Entitlement,
  type SessionUser,
  type PublicConfig,
} from './api';

interface SessionValue {
  user: SessionUser | null;
  entitlement: Entitlement | null;
  config: PublicConfig | null;
  ready: boolean;
  offline: boolean;
  isStaff: boolean;
  refresh: () => Promise<void>;
  setBootstrap: (payload: Bootstrap) => void;
  applyEntitlement: (entitlement: Entitlement) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Session state is never trusted for authorization: it only drives the UI.
 * The server re-checks the cookie, the role and the quota on every request.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<Bootstrap>('/auth/me');
      setUser(data.user);
      setEntitlement(data.entitlement);
      setConfig(data.config);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        setEntitlement(null);
        // Anonymous visitors still need the public config (price/trial copy).
        try {
          const cfg = await api.get<PublicConfig>('/config');
          setConfig(cfg);
        } catch {
          /* public config is optional for rendering */
        }
      }
    } finally {
      loaded.current = true;
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleOnline = () => {
      setOffline(false);
      void refresh();
    };
    const handleOffline = () => setOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      entitlement,
      config,
      ready,
      offline,
      isStaff: user?.role === 'owner' || user?.role === 'admin',
      refresh,
      setBootstrap: (payload) => {
        setUser(payload.user);
        setEntitlement(payload.entitlement);
        setConfig(payload.config);
      },
      applyEntitlement: (next) => setEntitlement(next),
      signOut: async () => {
        try {
          await api.post('/auth/logout');
        } catch {
          /* a failed logout still clears local state below */
        }
        setUser(null);
        setEntitlement(null);
      },
    }),
    [user, entitlement, config, ready, offline, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
