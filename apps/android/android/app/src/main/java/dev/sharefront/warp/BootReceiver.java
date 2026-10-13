package dev.sharefront.warp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Brings discovery back after a reboot or an app update, so the device stays
 * findable without someone having to open the app first.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            TransferService.start(context);
        }
    }
}
