package dev.sharefront.warp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * Keeps the transfer engine alive.
 *
 * Android will otherwise freeze a backgrounded app's sockets within minutes:
 * Doze, App Standby buckets and OEM task killers all target exactly this kind
 * of long-running network job. Four things are needed to survive, and this
 * service holds all of them:
 *
 *   1. A foreground service of type dataSync - the only supported way to run
 *      indefinitely while the user is elsewhere. It shows a notification, which
 *      is the deal Android offers: visibility in exchange for not being killed.
 *   2. A partial wake lock - keeps the CPU running with the screen off.
 *   3. A high-performance Wi-Fi lock - stops the radio from being parked, which
 *      otherwise collapses throughput or drops the connection entirely.
 *   4. A multicast lock - without it the kernel drops the UDP discovery beacons
 *      addressed to the multicast group.
 *
 * The locks are acquired only while work is in flight, and released as soon as
 * the queue drains: holding them permanently would drain the battery and, from
 * Android 15, a dataSync foreground service is also capped at roughly six hours
 * per day, so it must not be squatted on.
 */
public class TransferService extends Service {

    private static final String TAG = "WarpService";
    private static final String CHANNEL_TRANSFERS = "transfers";
    private static final String CHANNEL_PRESENCE = "presence";
    private static final int NOTIFICATION_ID = 0x5741;

    public static final String ACTION_START = "dev.sharefront.warp.START";
    public static final String ACTION_STOP = "dev.sharefront.warp.STOP";
    public static final String ACTION_PAUSE_ALL = "dev.sharefront.warp.PAUSE_ALL";
    public static final String ACTION_RESUME_ALL = "dev.sharefront.warp.RESUME_ALL";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.MulticastLock multicastLock;
    private TransferEngine engine;
    private boolean foreground = false;

    public static void start(Context context) {
        Intent intent = new Intent(context, TransferService.class);
        intent.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();

        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "warp:transfer");
        wakeLock.setReferenceCounted(false);

        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wifi.createWifiLock(mode, "warp:wifi");
        wifiLock.setReferenceCounted(false);
        multicastLock = wifi.createMulticastLock("warp:multicast");
        multicastLock.setReferenceCounted(false);

        engine = TransferEngine.getInstance(getApplicationContext());
        engine.setServiceCallback(new TransferEngine.ServiceCallback() {
            @Override
            public void onBusyChanged(boolean busy, String summary, int percent) {
                if (busy) {
                    acquireLocks();
                    promote(summary, percent);
                } else {
                    releaseLocks();
                    demote();
                }
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        // A foreground service must post its notification within ~5 seconds of
        // being started, whatever the reason, or the system raises ANR.
        if (!foreground) {
            promote(getString(R.string.notification_idle), -1);
        }

        if (ACTION_STOP.equals(action)) {
            engine.pauseAll();
            releaseLocks();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE_ALL.equals(action)) {
            engine.pauseAll();
        } else if (ACTION_RESUME_ALL.equals(action)) {
            engine.resumeAll();
        } else {
            engine.start();
            // Discovery needs the multicast lock even when idle, so the device
            // stays findable by peers.
            if (!multicastLock.isHeld()) multicastLock.acquire();
        }

        // START_STICKY asks the system to recreate us if it ever does kill us.
        return START_STICKY;
    }

    private void acquireLocks() {
        try {
            if (!wakeLock.isHeld()) wakeLock.acquire();
            if (!wifiLock.isHeld()) wifiLock.acquire();
            if (!multicastLock.isHeld()) multicastLock.acquire();
        } catch (Exception e) {
            Log.w(TAG, "could not acquire wake locks", e);
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock.isHeld()) wakeLock.release();
            if (wifiLock.isHeld()) wifiLock.release();
        } catch (Exception e) {
            Log.w(TAG, "could not release wake locks", e);
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);

        NotificationChannel transfers = new NotificationChannel(
                CHANNEL_TRANSFERS, "Transfers", NotificationManager.IMPORTANCE_LOW);
        transfers.setDescription("Shown while files are being sent or received");
        transfers.setShowBadge(false);
        manager.createNotificationChannel(transfers);

        NotificationChannel presence = new NotificationChannel(
                CHANNEL_PRESENCE, "Visible on the network", NotificationManager.IMPORTANCE_MIN);
        presence.setDescription("Keeps this device discoverable by your other devices");
        presence.setShowBadge(false);
        manager.createNotificationChannel(presence);
    }

    /** Posts (or updates) the ongoing notification and enters the foreground. */
    private void promote(String text, int percent) {
        boolean busy = percent >= 0;

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openIntent = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent pause = new Intent(this, TransferService.class);
        pause.setAction(engine.isPausedGlobally() ? ACTION_RESUME_ALL : ACTION_PAUSE_ALL);
        PendingIntent pauseIntent = PendingIntent.getService(
                this, 1, pause, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, busy ? CHANNEL_TRANSFERS : CHANNEL_PRESENCE);
        } else {
            builder = new Notification.Builder(this);
        }

        builder.setContentTitle(busy ? getString(R.string.notification_active) : getString(R.string.notification_ready))
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentIntent(openIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true);

        if (busy) {
            builder.setProgress(100, percent, percent == 0);
            builder.addAction(new Notification.Action.Builder(
                    null,
                    engine.isPausedGlobally() ? "Resume" : "Pause",
                    pauseIntent).build());
        }

        Notification notification = builder.build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        foreground = true;
    }

    /**
     * Drops back to a minimal presence notification once the queue is empty, so
     * the daily dataSync budget is spent on actual transfers.
     */
    private void demote() {
        promote(getString(R.string.notification_idle), -1);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiping the app away must not abort a transfer in progress.
        if (engine.isBusy()) {
            Log.i(TAG, "task removed while busy - staying alive");
        } else {
            stopForeground(true);
            stopSelf();
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        try {
            if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
