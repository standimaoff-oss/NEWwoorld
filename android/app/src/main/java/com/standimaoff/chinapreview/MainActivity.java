package com.standimaoff.chinapreview;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Offline WebView shell for the standalone China graphics preview.
 *  No network permission is requested: every texture, font and shader is
 *  embedded in index.html under android_asset. */
public class MainActivity extends Activity {
  private WebView web;

  @SuppressLint("SetJavaScriptEnabled")
  @Override protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    web = new WebView(this);
    setContentView(web);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    s.setAllowContentAccess(false);
    s.setAllowUniversalAccessFromFileURLs(false);
    s.setCacheMode(WebSettings.LOAD_NO_CACHE);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setMediaPlaybackRequiresUserGesture(false);

    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new WebViewClient());
    web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
    web.setBackgroundColor(0xFF101614);
    web.setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_FULLSCREEN |
        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    if (savedInstanceState == null) {
      web.loadUrl("file:///android_asset/index.html?quality=medium");
    }
  }

  @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); }
  @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }

  @Override public void onBackPressed() { finish(); }
  @Override public boolean onKeyDown(int code, KeyEvent event) {
    if (code == KeyEvent.KEYCODE_BACK) { finish(); return true; }
    return super.onKeyDown(code, event);
  }
}
