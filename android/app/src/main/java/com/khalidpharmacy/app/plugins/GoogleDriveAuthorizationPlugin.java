package com.khalidpharmacy.app.plugins;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentSender;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.auth.api.identity.RevokeAccessRequest;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;

import java.security.MessageDigest;
import java.util.Collections;
import java.util.List;

/**
 * Native Google Drive authorization for the Capacitor Android shell.
 * Google authorization UI is launched by Google Play services, never inside
 * the embedded WebView. Bearer tokens are returned to JavaScript for
 * in-memory use only.
 */
@CapacitorPlugin(name = "GoogleDriveAuthorization")
public class GoogleDriveAuthorizationPlugin extends Plugin {
    private static final String DRIVE_APPDATA_SCOPE =
        "https://www.googleapis.com/auth/drive.appdata";

    private ActivityResultLauncher<IntentSenderRequest> authorizationLauncher;
    private String pendingCallId;
    private boolean authorizationInProgress = false;

    @Override
    public void load() {
        authorizationLauncher = bridge.registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::handleAuthorizationActivityResult
        );
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        if (authorizationInProgress) {
            call.reject("A Google Drive authorization request is already in progress");
            return;
        }
        if (authorizationLauncher == null) {
            call.reject("Google Drive authorization is not ready. Reopen the app and retry.");
            return;
        }

        authorizationInProgress = true;
        try {
            AuthorizationRequest request = AuthorizationRequest.builder()
                .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_APPDATA_SCOPE)))
                .build();

            Identity.getAuthorizationClient(getActivity())
                .authorize(request)
                .addOnSuccessListener(getActivity(), result -> handleAuthorizationResult(call, result))
                .addOnFailureListener(getActivity(), error -> {
                    authorizationInProgress = false;
                    call.reject("Google Drive authorization failed: " + safeMessage(error), error);
                });
        } catch (Exception error) {
            authorizationInProgress = false;
            call.reject("Unable to start Google Drive authorization: " + safeMessage(error), error);
        }
    }

    /**
     * Reports the installed Android package's active signing certificate and
     * Google Play services availability so OAuth configuration can be checked.
     * This method does not expose tokens or request additional Google scopes.
     */
    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        try {
            GoogleApiAvailability availability = GoogleApiAvailability.getInstance();
            int statusCode = availability.isGooglePlayServicesAvailable(getContext());

            JSObject response = new JSObject();
            response.put("packageName", getContext().getPackageName());
            response.put("sha1Fingerprint", readSigningSha1());
            response.put("playServicesAvailable", statusCode == ConnectionResult.SUCCESS);
            response.put("playServicesStatusCode", statusCode);
            response.put("playServicesStatusMessage", availability.getErrorString(statusCode));
            response.put("developerError", statusCode == CommonStatusCodes.DEVELOPER_ERROR);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Unable to read Google Drive Android diagnostics: " + safeMessage(error), error);
        }
    }

    /**
     * Reads the SHA-1 fingerprint of the currently installed APK signing
     * certificate (the active signer, including on Android 9+).
     */
    private String readSigningSha1() throws Exception {
        PackageManager packageManager = getContext().getPackageManager();
        PackageInfo packageInfo;
        Signature[] signatures;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageInfo = packageManager.getPackageInfo(
                getContext().getPackageName(),
                PackageManager.GET_SIGNING_CERTIFICATES
            );
            SigningInfo signingInfo = packageInfo.signingInfo;
            signatures = signingInfo == null ? null : signingInfo.getApkContentsSigners();
        } else {
            packageInfo = packageManager.getPackageInfo(
                getContext().getPackageName(),
                PackageManager.GET_SIGNATURES
            );
            signatures = packageInfo.signatures;
        }

        if (signatures == null || signatures.length == 0 || signatures[0] == null) {
            return "";
        }

        byte[] digest = MessageDigest.getInstance("SHA-1").digest(signatures[0].toByteArray());
        StringBuilder fingerprint = new StringBuilder();
        for (int i = 0; i < digest.length; i++) {
            if (i > 0) fingerprint.append(':');
            fingerprint.append(String.format(java.util.Locale.US, "%02X", digest[i] & 0xff));
        }
        return fingerprint.toString();
    }

    private void handleAuthorizationResult(PluginCall call, AuthorizationResult result) {
        if (result == null) {
            authorizationInProgress = false;
            call.reject("Google returned an empty authorization result");
            return;
        }

        if (!result.hasResolution()) {
            authorizationInProgress = false;
            resolveAccessToken(call, result);
            return;
        }

        try {
            IntentSender pendingIntent = result.getPendingIntent().getIntentSender();
            pendingCallId = call.getCallbackId();
            bridge.saveCall(call);
            authorizationLauncher.launch(new IntentSenderRequest.Builder(pendingIntent).build());
        } catch (Exception error) {
            pendingCallId = null;
            authorizationInProgress = false;
            call.reject("Unable to launch Google's secure authorization screen", error);
            bridge.releaseCall(call);
        }
    }

    private void handleAuthorizationActivityResult(ActivityResult activityResult) {
        String callbackId = pendingCallId;
        pendingCallId = null;
        authorizationInProgress = false;

        PluginCall call = bridge.getSavedCall(callbackId);
        if (call == null) return;

        try {
            int resultCode = activityResult.getResultCode();
            Intent data = activityResult.getData();
            if (resultCode != Activity.RESULT_OK) {
                String resultDataState = data == null ? "missing" : "present";
                call.reject(
                    "Google Drive authorization did not complete (activityResultCode="
                        + resultCode
                        + ", resultData=" + resultDataState
                        + "). This result does not establish that the user manually cancelled. "
                        + "Check the Google Play services authorization result and the Android "
                        + "OAuth package-name/SHA-1 registration."
                );
                return;
            }

            AuthorizationResult result = Identity.getAuthorizationClient(getActivity())
                .getAuthorizationResultFromIntent(data);
            resolveAccessToken(call, result);
        } catch (Exception error) {
            call.reject("Unable to complete Google Drive authorization: " + safeMessage(error), error);
        } finally {
            bridge.releaseCall(call);
        }
    }

    private void resolveAccessToken(PluginCall call, AuthorizationResult result) {
        if (result == null) {
            call.reject("Google returned an empty authorization result");
            return;
        }

        List<String> grantedScopes = result.getGrantedScopes();
        if (grantedScopes == null || !grantedScopes.contains(DRIVE_APPDATA_SCOPE)) {
            call.reject("Google Drive app-data permission was not granted");
            return;
        }

        String accessToken = result.getAccessToken();
        if (accessToken == null || accessToken.trim().isEmpty()) {
            call.reject("Google did not return a usable Drive access token");
            return;
        }

        JSObject response = new JSObject();
        response.put("accessToken", accessToken);
        call.resolve(response);
    }

    @PluginMethod
    public void revokeAccess(PluginCall call) {
        try {
            RevokeAccessRequest request = RevokeAccessRequest.builder()
                .setScopes(Collections.singletonList(new Scope(DRIVE_APPDATA_SCOPE)))
                .build();

            Identity.getAuthorizationClient(getActivity())
                .revokeAccess(request)
                .addOnSuccessListener(getActivity(), unused -> call.resolve())
                .addOnFailureListener(getActivity(), error ->
                    call.reject("Google Drive access revocation failed: " + safeMessage(error), error)
                );
        } catch (Exception error) {
            call.reject("Unable to revoke Google Drive access: " + safeMessage(error), error);
        }
    }

    private String safeMessage(Exception error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty() ? "Unknown error" : message;
    }
}
