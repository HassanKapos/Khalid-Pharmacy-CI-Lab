package com.khalidpharmacy.app.plugins;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Native activity exit used only when Android back is pressed at the dashboard root. */
@CapacitorPlugin(name = "AndroidNavigation")
public class AndroidNavigationPlugin extends Plugin {
    @PluginMethod
    public void exitApp(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().finish();
            call.resolve();
        });
    }
}
