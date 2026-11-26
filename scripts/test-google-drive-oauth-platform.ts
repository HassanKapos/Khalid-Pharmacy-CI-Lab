import fs from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

async function run(): Promise<void> {
  const root = process.cwd();
  const oauth = fs.readFileSync(path.join(root, 'src/services/googleDriveOAuthService.ts'), 'utf8');
  const plugin = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/khalidpharmacy/app/plugins/GoogleDriveAuthorizationPlugin.java'), 'utf8');
  const activity = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/khalidpharmacy/app/MainActivity.java'), 'utf8');
  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  console.log('Phase C platform-specific Google Drive OAuth verification');
  assert(oauth.includes("Capacitor.getPlatform() === 'android'"), 'OAuth service branches on native Android platform');
  assert(oauth.includes("registerPlugin<NativeGoogleDriveAuthorizationPlugin>('GoogleDriveAuthorization')"), 'TypeScript registers the native authorization bridge');
  assert(oauth.includes("import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID"), 'Web/PWA continues to use its own configured Web OAuth Client ID');
  assert(oauth.includes("https://www.googleapis.com/auth/drive.appdata"), 'Web OAuth retains the least-privilege appData scope');
  assert(oauth.includes('nativeGoogleDriveAuthorization.authorize()'), 'Android authorization is delegated to the native bridge');
  assert(oauth.includes('this.accessToken = result.accessToken'), 'Native bearer token is held by the in-memory service');
  assert(oauth.includes('await nativeGoogleDriveAuthorization.revokeAccess()'), 'Late Android consent is revoked after a disconnect race');
  assert(oauth.includes('handleUnauthorized()'), 'OAuth service supports invalidating stale tokens on HTTP 401');
  assert(oauth.includes('getAndroidDiagnostics()'), 'OAuth service exposes native Android diagnostics');
  assert(!['localStorage.', 'sessionStorage.', 'indexedDB.', 'document.cookie'].some((needle) => oauth.includes(needle)), 'OAuth service does not persist access tokens in browser storage');

  assert(/@CapacitorPlugin\s*\(\s*name\s*=\s*"GoogleDriveAuthorization"\s*\)/.test(plugin), 'Android plugin name matches TypeScript registerPlugin("GoogleDriveAuthorization")');
  assert(plugin.includes('Identity.getAuthorizationClient(getActivity())'), 'Android uses Google Play services AuthorizationClient');
  assert(plugin.includes('new Scope(DRIVE_APPDATA_SCOPE)'), 'Android requests only the appData scope');
  assert(plugin.includes('StartIntentSenderForResult'), 'Android consent resolution uses the Activity Result API');
  assert(plugin.includes('getAccessToken()'), 'Android returns the access token to the in-memory TypeScript service');
  assert(plugin.includes('getGrantedScopes()'), 'Android verifies that the requested appData scope was actually granted');
  assert(plugin.includes('revokeAccess(request)'), 'Android revokes the app grant and clears its local authorization cache on disconnect');
  assert(plugin.includes('authorizationInProgress = false;'), 'Android authorization lock is released on terminal paths');
  assert(plugin.includes('activityResultCode='), 'Android reports the actual authorization activity result code');
  assert(plugin.includes('resultData='), 'Android reports whether the authorization result intent was returned');
  assert(!plugin.includes('Google Drive authorization was cancelled'), 'Android does not mislabel every non-success activity result as a user cancellation');
  assert(plugin.includes('Unable to start Google Drive authorization'), 'Synchronous native authorization failures are surfaced and unlock the plugin');
  assert(plugin.includes('getDiagnostics(PluginCall call)'), 'Android exposes getDiagnostics plugin method for signing SHA-1 & Play Services checks');
  assert(/@PluginMethod\s+public\s+void\s+getDiagnostics\s*\(\s*PluginCall\s+call\s*\)/.test(plugin), 'getDiagnostics is annotated with @PluginMethod for Capacitor bridge dispatch');
  assert(plugin.includes('readSigningSha1'), 'Android reports live APK signing SHA-1 fingerprint');
  assert(plugin.includes('GET_SIGNING_CERTIFICATES') && plugin.includes('GET_SIGNATURES'), 'Android SHA-1 reader supports both API 28+ SigningInfo and legacy signatures');
  assert(plugin.includes('GoogleApiAvailability'), 'Android verifies Google Play Services availability before launching OAuth');
  assert(plugin.includes('CommonStatusCodes.DEVELOPER_ERROR'), 'Android formats SHA-1/package mismatch errors clearly');
  assert(
    ['packageName', 'sha1Fingerprint', 'playServicesAvailable', 'playServicesStatusCode', 'playServicesStatusMessage', 'developerError']
      .every((key) => plugin.includes(`response.put("${key}"`)),
    'Android getDiagnostics resolves all expected diagnostic fields',
  );
  assert(activity.includes('registerPlugin(GoogleDriveAuthorizationPlugin.class)'), 'MainActivity registers the native Google Drive plugin');
  assert(
    activity.indexOf('registerPlugin(GoogleDriveAuthorizationPlugin.class)') < activity.indexOf('super.onCreate(savedInstanceState)'),
    'MainActivity registers GoogleDriveAuthorizationPlugin before super.onCreate',
  );
  assert(gradle.includes("com.google.android.gms:play-services-auth:22.0.0"), 'Android build includes Google Play services authorization SDK');
  assert(index.includes('isClientIdConfigured()'), 'Cloud settings do not require a Web Client ID on native Android');
  assert(
    ['getAndroidDiagnostics', 'playServicesAvailable', 'packageName', 'sha1Fingerprint']
      .every((field) => index.includes(field)),
    'Cloud settings UI binds to Android diagnostics fields',
  );

  // Runtime execution verification through @capacitor/core native plugin proxy
  let mockPlatform: 'web' | 'android' = 'web';
  const nativeCalls: Array<{ pluginName: string; methodName: string }> = [];
  let diagnosticsBehavior: () => Promise<Record<string, unknown>> = async () => ({
    packageName: 'com.khalidpharmacy.app',
    sha1Fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD',
    playServicesAvailable: true,
    playServicesStatusCode: 0,
    playServicesStatusMessage: 'SUCCESS',
    developerError: false,
  });
  let authorizeCalls = 0;
  let revokeCalls = 0;

  // Ensure Capacitor global is initialized with PluginHeaders before importing the service
  await import('@capacitor/core');
  const capGlobal = (globalThis as any).Capacitor;
  assert(Boolean(capGlobal), 'Capacitor global runtime initialized for bridge tests');

  capGlobal.getPlatform = () => mockPlatform;
  capGlobal.isNativePlatform = () => mockPlatform !== 'web';
  capGlobal.PluginHeaders = [
    ...(Array.isArray(capGlobal.PluginHeaders) ? capGlobal.PluginHeaders : []),
    {
      name: 'GoogleDriveAuthorization',
      methods: [
        { name: 'authorize', rtype: 'promise' },
        { name: 'revokeAccess', rtype: 'promise' },
        { name: 'getDiagnostics', rtype: 'promise' },
      ],
    },
  ];
  capGlobal.nativePromise = async (pluginName: string, methodName: string) => {
    nativeCalls.push({ pluginName, methodName });
    if (pluginName !== 'GoogleDriveAuthorization') {
      throw new Error(`Unexpected plugin invocation: ${pluginName}.${methodName}`);
    }
    if (methodName === 'getDiagnostics') {
      return diagnosticsBehavior();
    }
    if (methodName === 'authorize') {
      authorizeCalls++;
      return { accessToken: 'native_android_token_123' };
    }
    if (methodName === 'revokeAccess') {
      revokeCalls++;
      return undefined;
    }
    throw new Error(`Unsupported method: ${methodName}`);
  };

  const { GoogleDriveOAuthService } = await import('../src/services/googleDriveOAuthService');
  const service = new GoogleDriveOAuthService();

  // 1. Web platform returns null without calling native bridge
  mockPlatform = 'web';
  const webDiag = await service.getAndroidDiagnostics();
  assert(webDiag === null, 'Runtime: getAndroidDiagnostics returns null on web platform');
  assert(nativeCalls.length === 0, 'Runtime: web diagnostics does not invoke Android plugin');

  // 2. Android platform returns Play Services + SHA-1 diagnostics via Capacitor proxy
  mockPlatform = 'android';
  assert(service.isClientIdConfigured() === true, 'Runtime: Android skips Web Client ID requirement');
  const okDiag = await service.getAndroidDiagnostics();
  assert(okDiag !== null, 'Runtime: Android getAndroidDiagnostics resolves diagnostics object');
  assert(
    nativeCalls.some((c) => c.pluginName === 'GoogleDriveAuthorization' && c.methodName === 'getDiagnostics'),
    'Runtime: getAndroidDiagnostics dispatches GoogleDriveAuthorization.getDiagnostics through Capacitor bridge',
  );
  assert(okDiag!.platform === 'android', 'Runtime: diagnostics platform equals android');
  assert(okDiag!.packageName === 'com.khalidpharmacy.app', 'Runtime: diagnostics packageName matches plugin payload');
  assert(okDiag!.sha1Fingerprint.startsWith('AA:BB:CC:DD'), 'Runtime: diagnostics preserves APK SHA-1 fingerprint');
  assert(okDiag!.playServicesAvailable === true && okDiag!.playServicesStatusCode === 0, 'Runtime: diagnostics reports available Google Play Services');

  // 3. Android DEVELOPER_ERROR / unavailable Play Services + empty package fallback
  diagnosticsBehavior = async () => ({
    packageName: '',
    sha1Fingerprint: '',
    playServicesAvailable: false,
    playServicesStatusCode: 10,
    playServicesStatusMessage: 'DEVELOPER_ERROR',
    developerError: true,
  });
  const devErrDiag = await service.getAndroidDiagnostics();
  assert(devErrDiag !== null, 'Runtime: DEVELOPER_ERROR payload still returns structured diagnostics');
  assert(devErrDiag!.packageName === 'com.khalidpharmacy.app', 'Runtime: missing packageName falls back to com.khalidpharmacy.app');
  assert(devErrDiag!.playServicesAvailable === false && devErrDiag!.playServicesStatusCode === 10, 'Runtime: diagnostics surfaces Play Services status code 10 (DEVELOPER_ERROR)');

  // 4. Native rejection fails closed to null
  diagnosticsBehavior = async () => {
    throw new Error('Unable to read Google Drive Android diagnostics');
  };
  const rejectedDiag = await service.getAndroidDiagnostics();
  assert(rejectedDiag === null, 'Runtime: native getDiagnostics failure returns null cleanly without throwing');

  // 5. Native connect/disconnect exercises authorize() and revokeAccess() via bridge
  const conn = await service.connect();
  assert(conn.accessToken === 'native_android_token_123' && authorizeCalls === 1, 'Runtime: Android connect() acquires token via native authorize()');
  assert(service.isConnected() && service.getAccessToken() === 'native_android_token_123', 'Runtime: Android token is held in memory');
  await service.disconnect();
  assert(revokeCalls === 1 && !service.isConnected() && service.getAccessToken() === null, 'Runtime: Android disconnect() revokes native access and clears token');

  console.log('All Phase C platform OAuth source and runtime checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
