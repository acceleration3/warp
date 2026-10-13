package dev.sharefront.warp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super so the plugin is available to the first page load.
        registerPlugin(WarpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
