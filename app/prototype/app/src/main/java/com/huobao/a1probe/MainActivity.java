package com.huobao.a1probe;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable poller = new Runnable() {
        @Override
        public void run() {
            refreshLog();
            handler.postDelayed(this, 1000);
        }
    };

    private TextView logView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int padding = Math.round(16 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padding, padding, padding, padding);

        TextView title = new TextView(this);
        title.setText("A1 运行时可行性原型");
        title.setTextSize(18);

        Button run = new Button(this);
        run.setText("运行检测");
        run.setOnClickListener(v -> startProbe());

        logView = new TextView(this);
        logView.setTextIsSelectable(true);
        logView.setTextSize(12);
        logView.setTypeface(Typeface.MONOSPACE);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(logView);

        root.addView(title);
        root.addView(run);
        root.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        if (getIntent().getBooleanExtra("autorun", false)) {
            startProbe();
        }
    }

    private void startProbe() {
        Intent intent = new Intent(this, ProbeService.class);
        intent.setAction(ProbeService.ACTION_RUN);
        startService(intent);
        handler.removeCallbacks(poller);
        handler.post(poller);
    }

    @Override
    protected void onStart() {
        super.onStart();
        handler.removeCallbacks(poller);
        handler.post(poller);
    }

    @Override
    protected void onStop() {
        super.onStop();
        handler.removeCallbacks(poller);
    }

    private void refreshLog() {
        File log = new File(getFilesDir(), "a1.log");
        String text = log.isFile() ? read(log) : "(等待运行)";
        if (!text.contentEquals(logView.getText())) {
            logView.setText(text);
        }
    }

    private String read(File file) {
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[(int) file.length()];
            int read = in.read(buffer);
            return new String(buffer, 0, Math.max(read, 0), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "读取日志失败: " + e;
        }
    }
}
