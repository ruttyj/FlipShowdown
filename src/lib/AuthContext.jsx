import React, { createContext, useState, useContext, useEffect } from 'react';
import { backend } from '@/api/backend';

/**
 * @typedef {object} AuthValue
 * @property {*} user  the signed-in account, or null
 * @property {boolean} isAuthenticated
 * @property {boolean} isLoadingAuth
 * @property {{type: string, message: string}|null} authError
 * @property {(shouldRedirect?: boolean) => void} logout
 * @property {() => void} navigateToLogin
 * @property {() => Promise<void>} checkAppState
 */

// Undefined outside an AuthProvider, which useAuth reports as an error.
/** @type {React.Context<AuthValue|undefined>} */
const AuthContext = createContext(undefined);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    checkAppState();
  }, []);

  // The app is public: pages call redirectToLogin themselves when they need a user,
  // so "not logged in" (401/403) is a normal state, not an auth error.
  const checkAppState = async () => {
    setIsLoadingAuth(true);
    setAuthError(null);

    try {
      const currentUser = await backend.auth.me();
      setUser(currentUser);
      setIsAuthenticated(true);
    } catch (error) {
      setUser(null);
      setIsAuthenticated(false);

      const isLoggedOut = error.status === 401 || error.status === 403;
      if (!isLoggedOut) {
        console.error('User auth check failed:', error);
        setAuthError({
          type: 'unknown',
          message: error.message || 'Failed to load app'
        });
      }
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);

    if (shouldRedirect) {
      // End the server session, then return to this page
      backend.auth.logout(window.location.href);
    } else {
      // End the server session and let the client choose where to go next
      backend.auth.logout();
    }
  };

  const navigateToLogin = () => {
    backend.auth.redirectToLogin(window.location.href);
  };

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      authError,
      logout,
      navigateToLogin,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
