package com.khalidpharmacy.app;

import android.os.Bundle;
import android.view.View;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.khalidpharmacy.app.plugins.GoogleDriveAuthorizationPlugin;
import com.khalidpharmacy.app.plugins.MedicineTextRecognitionPlugin;
import com.khalidpharmacy.app.plugins.AndroidNavigationPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MedicineTextRecognitionPlugin.class);
        registerPlugin(GoogleDriveAuthorizationPlugin.class);
        registerPlugin(AndroidNavigationPlugin.class);
        super.onCreate(savedInstanceState);

        // Ensure Edge-to-Edge Android 15+ system navigation and status bars never overlap the WebView dock
        View contentView = findViewById(android.R.id.content);
        if (contentView != null) {
            ViewCompat.setOnApplyWindowInsetsListener(contentView, (view, windowInsets) -> {
                Insets systemInsets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                view.setPadding(
                    systemInsets.left,
                    systemInsets.top,
                    systemInsets.right,
                    systemInsets.bottom
                );
                return WindowInsetsCompat.CONSUMED;
            });
            ViewCompat.requestApplyInsets(contentView);
        }

        // Use AndroidX's dispatcher so both the system button and gesture navigation
        // reach the same handler on modern Android versions.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge != null && bridge.getWebView() != null) {
                    bridge.getWebView().evaluateJavascript(
                        "window.dispatchEvent(new Event('khalid:android-back'))",
                        null
                    );
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }
}
