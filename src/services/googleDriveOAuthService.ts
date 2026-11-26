/**
 * Khalid Pharmacy — Google Drive OAuth Service (Web GIS + Android native authorization)
 *
 * Security safeguards:
 * 1. Web/PWA uses Google Identity Services; Android uses Google Play services AuthorizationClient.
 * 2. Both platforms request only the `drive.appdata` scope.
 * 3. The JavaScript bearer token is held in memory only. Android's OS-managed Play services
 *    token cache is cleared during disconnect; the app does not persist tokens in browser storage.
 * 4. The Web Client ID is read from `import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID`; Android
 *    identifies the app through its registered package name and signing-certificate SHA-1.
 * 5. Web popup requests preserve the synchronous user-click context when GIS is pre-initialized.
 * 6. Web `expires_in` responses are validated; native tokens use a conservative 50-minute lifetime.
 * 7. Session ownership guards prevent stale callbacks from mutating a newer connection session.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

interface NativeGoogleDriveAuthorizationPlugin {
  authorize(): Promise<{ accessToken: string }>;
  revokeAccess(): Promise<void>;
  getDiagnostics?(): Promise<{
    packageName?: string;
    sha1Fingerprint?: string;
    playServicesAvailable?: boolean;
    playServicesStatusCode?: number;
  }>;
}

export interface AndroidDriveDiagnostics {
  platform: string;
  packageName: string;
  sha1Fingerprint: string;
  playServicesAvailable: boolean;
  playServicesStatusCode: number;
}

const nativeGoogleDriveAuthorization = registerPlugin<NativeGoogleDriveAuthorizationPlugin>('GoogleDriveAuthorization');

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => void;
            error_callback?: (err: { message: string }) => void;
          }) => {
            requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
          };
          revoke: (accessToken: string, done?: () => void) => void;
        };
      };
    };
  }
}

const SCOPE_APPDATA = 'https://www.googleapis.com/auth/drive.appdata';
const EXPIRY_SAFETY_BUFFER_SEC = 60;

export interface OAuthConnectResponse {
  accessToken: string;
}

export class GoogleDriveOAuthService {
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private tokenClient: { requestAccessToken: (config?: { prompt?: string }) => void } | null = null;
  private gisLoadPromise: Promise<void> | null = null;
  private currentSessionId: number = 0;
  private isConnecting: boolean = false;

  /**
   * Retrieves the Google OAuth Client ID directly from environment variables.
   * Never logs or exposes credentials.
   */
  public getClientId(): string {
    return import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || '';
  }

  /** Native Android uses Google Play services and does not require a Web OAuth Client ID. */
  public isClientIdConfigured(): boolean {
    return Capacitor.getPlatform() === 'android' || this.getClientId().trim().length > 0;
  }

  /**
   * Pre-loads the Google Identity Services (GIS) script and pre-configures tokenClient.
   * Must be called during UI initialization to preserve synchronous click context on user action.
   */
  public async initialize(): Promise<void> {
    if (Capacitor.getPlatform() === 'android') {
      // Android authorization is delegated to Google Play services, outside the WebView.
      return;
    }
    const clientId = this.getClientId();
    if (!clientId) {
      throw new Error('Client ID (VITE_GOOGLE_OAUTH_CLIENT_ID) is not configured in environment variables');
    }

    if (this.tokenClient) {
      return;
    }

    await this.ensureGisLoaded();
    this.setupTokenClient(clientId);
  }

  /**
   * Synchronously checks if a valid, unexpired access token exists in memory.
   */
  public isConnected(): boolean {
    return Boolean(this.accessToken && Date.now() < this.tokenExpiresAt);
  }

  /**
   * Returns current access token from memory if valid and unexpired; otherwise clears and returns null.
   */
  public getAccessToken(): string | null {
    if (this.isConnected()) {
      return this.accessToken;
    }
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    return null;
  }

  /**
   * Clears in-memory credentials immediately when Google Drive responds with HTTP 401.
   */
  public handleUnauthorized(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * Returns Android-specific package name, signing SHA-1 fingerprint, and Play Services status.
   * Returns null on non-Android platforms.
   */
  public async getAndroidDiagnostics(): Promise<AndroidDriveDiagnostics | null> {
    if (Capacitor.getPlatform() !== 'android') {
      return null;
    }
    if (typeof nativeGoogleDriveAuthorization.getDiagnostics !== 'function') {
      return null;
    }
    try {
      const diag = await nativeGoogleDriveAuthorization.getDiagnostics();
      return {
        platform: 'android',
        packageName: diag?.packageName || 'com.khalidpharmacy.app',
        sha1Fingerprint: diag?.sha1Fingerprint || '',
        playServicesAvailable: Boolean(diag?.playServicesAvailable),
        playServicesStatusCode: typeof diag?.playServicesStatusCode === 'number' ? diag.playServicesStatusCode : -1,
      };
    } catch {
      return null;
    }
  }

  /**
   * Connects to Google Drive using GIS Token Model.
   * If pre-initialized, calls `requestAccessToken()` synchronously within user click handler stack.
   */
  public connect(): Promise<OAuthConnectResponse> {
    if (Capacitor.getPlatform() === 'android') {
      return this.connectNative();
    }
    const clientId = this.getClientId();
    if (!clientId) {
      return Promise.reject(new Error('Client ID (VITE_GOOGLE_OAUTH_CLIENT_ID) is not configured in environment variables'));
    }

    if (this.isConnecting) {
      return Promise.reject(new Error('An OAuth connection request is already in progress'));
    }

    // Assign new session generation ID
    this.currentSessionId++;
    const activeSessionId = this.currentSessionId;
    this.isConnecting = true;

    // Fast-path: If tokenClient is already pre-initialized, trigger requestAccessToken() synchronously right here!
    if (this.tokenClient) {
      return this.executeAccessTokenRequest(activeSessionId);
    }

    // Fallback path: Load GIS script first if not pre-initialized, then request access token
    return this.ensureGisLoaded()
      .then(() => {
        if (activeSessionId !== this.currentSessionId) {
          throw new Error('OAuth connection session was cancelled or superseded');
        }
        this.setupTokenClient(clientId);
        return this.executeAccessTokenRequest(activeSessionId);
      })
      .catch((err) => {
        if (activeSessionId === this.currentSessionId) {
          this.isConnecting = false;
        }
        throw err;
      });
  }

  /**
   * Instantly revokes and wipes access token from memory, invalidating any in-flight callbacks.
   */
  public async disconnect(): Promise<void> {
    if (Capacitor.getPlatform() === 'android') {
      this.currentSessionId++;
      this.isConnecting = false;
      const tokenToRevoke = this.accessToken;
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      if (tokenToRevoke) {
        await nativeGoogleDriveAuthorization.revokeAccess();
      }
      return;
    }
    // Invalidate session generation counter immediately
    this.currentSessionId++;
    this.isConnecting = false;

    const tokenToRevoke = this.accessToken;
    this.accessToken = null;
    this.tokenExpiresAt = 0;

    if (tokenToRevoke && typeof window !== 'undefined' && window.google?.accounts?.oauth2?.revoke) {
      await new Promise<void>((resolve) => {
        try {
          window.google!.accounts!.oauth2.revoke(tokenToRevoke, () => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  /**
   * Requests the appData authorization through Google Play services on Android.
   * The returned bearer token is held only in this service's memory and is
   * conservatively treated as expired after 50 minutes.
   */
  private connectNative(): Promise<OAuthConnectResponse> {
    if (this.isConnecting) {
      return Promise.reject(new Error('An OAuth connection request is already in progress'));
    }
    this.currentSessionId++;
    const sessionId = this.currentSessionId;
    this.isConnecting = true;
    return nativeGoogleDriveAuthorization.authorize()
      .then(async (result) => {
        if (sessionId !== this.currentSessionId) {
          // A user may disconnect while Google's native consent screen is open.
          // Revoke after the late result arrives so that consent granted after the
          // disconnect action cannot leave a live Play services authorization behind.
          await nativeGoogleDriveAuthorization.revokeAccess();
          throw new Error('Google Drive authorization was cancelled or superseded');
        }
        if (!result || typeof result.accessToken !== 'string' || !result.accessToken.trim()) {
          throw new Error('Google Play services did not return a valid access token');
        }
        this.accessToken = result.accessToken;
        this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
        this.isConnecting = false;
        return { accessToken: result.accessToken };
      })
      .catch((error) => {
        if (sessionId === this.currentSessionId) this.isConnecting = false;
        throw error;
      });
  }

  /**
   * Internal helper to set up token client template.
   */
  private setupTokenClient(clientId: string): void {
    if (!window.google?.accounts?.oauth2) {
      throw new Error('Google Identity Services library is not loaded');
    }
    if (this.tokenClient) {
      return;
    }

    // Create persistent token client template
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE_APPDATA,
      callback: () => {
        // Individual requests register their own callbacks in executeAccessTokenRequest
      }
    });
  }

  /**
   * Internal helper that handles token client request with strict session ownership and expires_in checks.
   */
  private executeAccessTokenRequest(sessionId: number): Promise<OAuthConnectResponse> {
    const clientId = this.getClientId();

    return new Promise<OAuthConnectResponse>((resolve, reject) => {
      try {
        const tokenClient = window.google!.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE_APPDATA,
          callback: (response) => {
            // CRITICAL: Check session ownership FIRST before mutating ANY state or locks!
            if (sessionId !== this.currentSessionId) {
              reject(new Error('OAuth connection callback ignored due to session reset or disconnect'));
              return;
            }

            this.isConnecting = false;

            if (response.error || !response.access_token) {
              const errMsg = response.error_description || response.error || 'Failed to acquire access token from Google';
              reject(new Error(errMsg));
              return;
            }

            // Strict validation of expires_in: MUST be a number > EXPIRY_SAFETY_BUFFER_SEC
            const rawExpiresIn = response.expires_in;
            if (typeof rawExpiresIn !== 'number' || !Number.isFinite(rawExpiresIn) || rawExpiresIn <= EXPIRY_SAFETY_BUFFER_SEC) {
              reject(new Error(`Token expiration (expires_in=${rawExpiresIn}) must be greater than safety buffer of ${EXPIRY_SAFETY_BUFFER_SEC} seconds`));
              return;
            }

            const usableDurationSec = rawExpiresIn - EXPIRY_SAFETY_BUFFER_SEC;
            this.accessToken = response.access_token;
            this.tokenExpiresAt = Date.now() + usableDurationSec * 1000;

            resolve({ accessToken: response.access_token });
          },
          error_callback: (err) => {
            // CRITICAL: Check session ownership FIRST before mutating ANY state or locks!
            if (sessionId !== this.currentSessionId) {
              reject(new Error('OAuth connection error callback ignored due to session reset or disconnect'));
              return;
            }

            this.isConnecting = false;
            reject(new Error(err?.message || 'Google OAuth prompt was cancelled or closed'));
          }
        });

        // Request token synchronously within current execution context
        tokenClient.requestAccessToken({ prompt: 'consent' });
      } catch (err: any) {
        if (sessionId === this.currentSessionId) {
          this.isConnecting = false;
        }
        reject(new Error(err?.message || 'Error triggering Google OAuth prompt'));
      }
    });
  }

  /**
   * Single shared GIS script loader Promise to prevent duplicate script elements and handle concurrency.
   */
  private ensureGisLoaded(): Promise<void> {
    if (typeof window === 'undefined') {
      return Promise.reject(new Error('GIS script can only be loaded in browser environment'));
    }

    if (window.google?.accounts?.oauth2) {
      return Promise.resolve();
    }

    if (this.gisLoadPromise) {
      return this.gisLoadPromise;
    }

    this.gisLoadPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.gisLoadPromise = null;
        reject(new Error('Google Identity Services did not respond within 15 seconds. Check the internet connection, DNS, or content blockers, then retry.'));
      }, 15000);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this.gisLoadPromise = null;
        reject(new Error(message));
      };

      const existingScript = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
      if (existingScript) {
        if (window.google?.accounts?.oauth2) {
          finish();
          return;
        }
        existingScript.addEventListener('load', finish, { once: true });
        existingScript.addEventListener('error', () => {
          fail('Failed to load Google Identity Services script. Check the internet connection and retry.');
        }, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = finish;
      script.onerror = () => {
        fail('Failed to load Google Identity Services script from Google. Check the internet connection, DNS, or content blockers.');
      };
      document.head.appendChild(script);
    });

    return this.gisLoadPromise;
  }
}

export const googleDriveOAuthService = new GoogleDriveOAuthService();
export const getClientId = () => googleDriveOAuthService.getClientId();
export const isClientIdConfigured = () => googleDriveOAuthService.isClientIdConfigured();
export const initialize = () => googleDriveOAuthService.initialize();
export const isConnected = () => googleDriveOAuthService.isConnected();
export const connect = () => googleDriveOAuthService.connect();
export const disconnect = () => googleDriveOAuthService.disconnect();
export const getAccessToken = () => googleDriveOAuthService.getAccessToken();
export const handleUnauthorized = () => googleDriveOAuthService.handleUnauthorized();
export const getAndroidDiagnostics = () => googleDriveOAuthService.getAndroidDiagnostics();
