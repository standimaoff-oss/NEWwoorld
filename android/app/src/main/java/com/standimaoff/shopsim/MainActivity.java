package com.standimaoff.shopsim;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * ShopSim для Android: WebView + встроенный HTTP-сервер на 127.0.0.1.
 *
 * Зачем сервер, а не file:// — ES-модули и importmap в WebView на file://
 * блокируются политикой CORS. Отдача через http://127.0.0.1 решает это
 * штатно и не требует ни сети, ни прав на внешний трафик.
 */
public class MainActivity extends Activity {
  private static final String HOST = "127.0.0.1";
  private static final int PORT = 8741;

  private WebView web;
  private AssetServer server;

  @SuppressLint("SetJavaScriptEnabled")
  @Override protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (Build.VERSION.SDK_INT >= 28) {
      getWindow().getAttributes().layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
    }
    // Первое окно — чёрный фон, чтобы не мелькала белая вспышка.
    View splash = new View(this);
    splash.setBackgroundColor(0xFF0B1014);
    setContentView(splash);

    new Thread(() -> {
      try {
        server = new AssetServer(getAssets(), HOST, PORT);
        server.start();
      } catch (IOException e) {
        server = null;
      }
      runOnUiThread(this::showGame);
    }, "shopsim-server").start();
  }

  @SuppressLint("SetJavaScriptEnabled")
  private void showGame() {
    if (isFinishing()) return;
    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setAllowFileAccessFromFileURLs(false);
    s.setAllowUniversalAccessFromFileURLs(false);
    s.setCacheMode(WebSettings.LOAD_NO_CACHE);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setTextZoom(100);
    if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false);
    web.setBackgroundColor(0xFF0B1014);
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    web.setLayerType(View.LAYER_TYPE_HARDWARE, null);

    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        // Всё, что ведёт наружу, в игре не нужно — оставляем внутри.
        String url = r.getUrl().toString();
        return !url.startsWith("http://" + HOST + ":" + PORT);
      }
    });

    setContentView(web);
    hideSystemBars();
    web.loadUrl("http://" + HOST + ":" + PORT + "/index.html");
  }

  private void hideSystemBars() {
    View decor = getWindow().getDecorView();
    decor.setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
  }

  @Override public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemBars();
  }

  @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); }
  @Override protected void onResume() {
    super.onResume();
    if (web != null) web.onResume();
    if (web != null) hideSystemBars();
  }

  @Override protected void onDestroy() {
    if (server != null) server.stop();
    if (web != null) {
      web.setWebChromeClient(null);
      web.stopLoading();
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }

  @Override public void onBackPressed() { finish(); }

  @Override public boolean onKeyDown(int code, KeyEvent event) {
    if (code == KeyEvent.KEYCODE_BACK) { finish(); return true; }
    return super.onKeyDown(code, event);
  }

  /** Минимальный HTTP/1.1-сервер: только loopback, только GET. */
  static final class AssetServer implements Runnable {
    private static final Map<String, String> MIME = new HashMap<>();
    static {
      MIME.put("html", "text/html; charset=utf-8");
      MIME.put("js", "text/javascript; charset=utf-8");
      MIME.put("mjs", "text/javascript; charset=utf-8");
      MIME.put("css", "text/css; charset=utf-8");
      MIME.put("json", "application/json; charset=utf-8");
      MIME.put("webmanifest", "application/manifest+json");
      MIME.put("png", "image/png");
      MIME.put("jpg", "image/jpeg");
      MIME.put("jpeg", "image/jpeg");
      MIME.put("webp", "image/webp");
      MIME.put("svg", "image/svg+xml");
      MIME.put("ico", "image/x-icon");
      MIME.put("glb", "model/gltf-binary");
      MIME.put("gltf", "model/gltf+json");
      MIME.put("wasm", "application/wasm");
      MIME.put("woff2", "font/woff2");
      MIME.put("ttf", "font/ttf");
      MIME.put("txt", "text/plain; charset=utf-8");
    }

    private final android.content.res.AssetManager assets;
    private final String host;
    private final int port;
    private java.net.ServerSocket socket;
    private volatile boolean running = true;

    AssetServer(android.content.res.AssetManager assets, String host, int port) {
      this.assets = assets;
      this.host = host;
      this.port = port;
    }

    void start() throws IOException {
      socket = new java.net.ServerSocket();
      socket.setReuseAddress(true);
      socket.bind(new java.net.InetSocketAddress(java.net.InetAddress.getByName(host), port));
      Thread t = new Thread(this, "shopsim-http");
      t.setDaemon(true);
      t.start();
    }

    void stop() {
      running = false;
      try { if (socket != null) socket.close(); } catch (IOException ignored) { }
    }

    @Override public void run() {
      while (running) {
        java.net.Socket client;
        try {
          client = socket.accept();
        } catch (IOException e) {
          if (running) continue;
          return;
        }
        try {
          handle(client);
        } catch (Exception ignored) {
          // Один сбойный запрос не должен ронять сервер.
        } finally {
          try { client.close(); } catch (IOException ignored) { }
        }
      }
    }

    private void handle(java.net.Socket client) throws IOException {
      InputStream in = client.getInputStream();
      java.io.OutputStream out = client.getOutputStream();
      String requestLine = readLine(in);
      if (requestLine == null) return;
      // Дочитываем заголовки запроса, иначе соединение сбрасывается.
      String line;
      while ((line = readLine(in)) != null && !line.isEmpty()) { /* пропускаем */ }

      String[] parts = requestLine.split(" ");
      if (parts.length < 2) { respond(out, 400, "text/plain", "bad request".getBytes("UTF-8")); return; }
      String method = parts[0];
      String rawPath = parts[1];
      if (!"GET".equals(method) && !"HEAD".equals(method)) {
        respond(out, 405, "text/plain", "method not allowed".getBytes("UTF-8"));
        return;
      }

      int q = rawPath.indexOf('?');
      if (q >= 0) rawPath = rawPath.substring(0, q);
      int hash = rawPath.indexOf('#');
      if (hash >= 0) rawPath = rawPath.substring(0, hash);
      String path = java.net.URLDecoder.decode(rawPath, "UTF-8");
      if (path.startsWith("/")) path = path.substring(1);
      if (path.isEmpty() || path.endsWith("/")) path = path + "index.html";

      // Защита от выхода за пределы assets.
      if (path.contains("..") || path.startsWith("/")) {
        respond(out, 403, "text/plain", "forbidden".getBytes("UTF-8"));
        return;
      }

      byte[] body;
      try {
        InputStream src = assets.open(path);
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream(Math.max(1024, src.available()));
        byte[] chunk = new byte[16384];
        int n;
        while ((n = src.read(chunk)) > 0) buf.write(chunk, 0, n);
        src.close();
        body = buf.toByteArray();
      } catch (IOException missing) {
        byte[] msg = ("404 " + path).getBytes("UTF-8");
        respond(out, 404, "text/plain; charset=utf-8", msg);
        return;
      }

      String ext = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1).toLowerCase() : "";
      String mime = MIME.getOrDefault(ext, "application/octet-stream");
      respond(out, 200, mime, body);
    }

    private void respond(java.io.OutputStream out, int code, String mime, byte[] body) throws IOException {
      StringBuilder h = new StringBuilder();
      h.append("HTTP/1.1 ").append(code).append(code == 200 ? " OK" : " ERR").append("\r\n");
      h.append("Content-Type: ").append(mime).append("\r\n");
      h.append("Content-Length: ").append(body.length).append("\r\n");
      h.append("Cache-Control: no-store\r\n");
      h.append("Access-Control-Allow-Origin: *\r\n");
      h.append("Connection: close\r\n\r\n");
      out.write(h.toString().getBytes("UTF-8"));
      out.write(body);
      out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
      java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream(128);
      int c;
      while ((c = in.read()) != -1) {
        if (c == '\n') break;
        if (c != '\r') buf.write(c);
        if (buf.size() > 8192) break;
      }
      if (c == -1 && buf.size() == 0) return null;
      return buf.toString("UTF-8");
    }
  }
}
