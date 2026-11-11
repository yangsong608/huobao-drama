package com.huobao.a1probe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.os.IBinder;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileWriter;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.InetAddress;

public class ProbeService extends Service {
    public static final String ACTION_RUN = "com.huobao.a1probe.RUN";
    private static final String CHANNEL = "a1probe";

    private Thread worker;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("A1 Probe")
                .setContentText("运行可行性检测")
                .build();
        startForeground(1, notification);

        if (worker == null || !worker.isAlive()) {
            worker = new Thread(this::runProbe, "a1-probe");
            worker.start();
        }
        return START_NOT_STICKY;
    }

    private void createChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, "A1 Probe", NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void runProbe() {
        File files = getFilesDir();
        File log = new File(files, "a1.log");
        try (PrintWriter out = new PrintWriter(new FileWriter(log, false))) {
            out.println("filesDir=" + files);
            out.println("targetSdk=" + getApplicationInfo().targetSdkVersion);
            out.println("abi=" + android.os.Build.SUPPORTED_ABIS[0]);
            writeResolvConf(files, out);

            File script = new File(files, "a1/test.sh");
            ProcessBuilder builder;
            if (script.isFile()) {
                builder = new ProcessBuilder("/system/bin/sh", script.getAbsolutePath());
            } else {
                builder = new ProcessBuilder(new File(files, "a1/proot").getAbsolutePath(), "--version");
            }
            builder.redirectErrorStream(true);
            builder.environment().put("HOME", files.getAbsolutePath());
            builder.environment().put("TZ", "Asia/Shanghai");
            builder.environment().put("LD_LIBRARY_PATH", new File(files, "a1/lib").getAbsolutePath());
            out.println("exec=" + builder.command());
            out.flush();

            Process process = builder.start();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    out.println(line);
                    out.flush();
                }
            }
            out.println("exit=" + process.waitFor());
        } catch (Exception e) {
            appendError(log, e);
        } finally {
            stopSelf();
        }
    }

    private void writeResolvConf(File files, PrintWriter out) {
        try {
            File etc = new File(files, "rootfs/etc");
            if (!etc.isDirectory()) {
                out.println("resolv=skip(rootfs missing)");
                return;
            }
            ConnectivityManager manager = getSystemService(ConnectivityManager.class);
            Network network = manager.getActiveNetwork();
            LinkProperties properties = network == null ? null : manager.getLinkProperties(network);
            if (properties == null) {
                out.println("resolv=skip(no network)");
                return;
            }
            StringBuilder content = new StringBuilder();
            int count = 0;
            for (InetAddress dns : properties.getDnsServers()) {
                content.append("nameserver ").append(dns.getHostAddress()).append('\n');
                count++;
            }
            try (FileWriter writer = new FileWriter(new File(etc, "resolv.conf"), false)) {
                writer.write(content.toString());
            }
            out.println("resolv=written(count=" + count + ")");
        } catch (Exception e) {
            out.println("resolv=error(" + e.getMessage() + ")");
        }
    }

    private void appendError(File log, Exception error) {
        try (PrintWriter out = new PrintWriter(new FileWriter(log, true))) {
            out.println("error=" + error);
            error.printStackTrace(out);
        } catch (Exception ignored) {
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
