package com.example.cilabprobe;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public final class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView label = new TextView(this);
        label.setText("GitHub Actions APK + Artifact probe passed");
        label.setTextSize(18);
        label.setPadding(32, 32, 32, 32);
        setContentView(label);
    }
}
