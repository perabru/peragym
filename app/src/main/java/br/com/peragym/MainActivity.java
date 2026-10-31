package br.com.peragym;

import android.app.Activity;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.widget.FrameLayout;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;

/** Native offline host. Only packaged app assets can execute JavaScript. */
public final class MainActivity extends Activity {
    private WebView webView;
    private GymDatabase database;
    private SharedPreferences preferences;
    private FrameLayout viewport;
    private static final String HOME = "file:///android_asset/index.html";

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences("peragym_preferences", MODE_PRIVATE);
        database = new GymDatabase(this);
        applySystemTheme(theme());
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("dark".equals(theme()) ? "#211c26" : "#fff8f1"));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return !HOME.equals(url); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !HOME.equals(request.getUrl().toString()); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("file:///android_asset/") && !url.contains("..") && !url.contains("%2e") && !url.contains("%2E")) return null;
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
        });
        webView.addJavascriptInterface(new NativeBridge(), "PeraGymNative");
        viewport = new FrameLayout(this);
        viewport.setBackgroundColor(Color.parseColor("dark".equals(theme()) ? "#211c26" : "#fff8f1"));
        // Target 35 enforces edge-to-edge: keep controls clear of status bars and gesture navigation.
        viewport.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        viewport.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(viewport);
        viewport.requestApplyInsets();
        webView.loadUrl(HOME);
    }

    private String theme() {
        boolean systemDark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        return preferences.getString("theme", systemDark ? "dark" : "light");
    }

    private void applySystemTheme(String theme) {
        boolean dark = "dark".equals(theme);
        int background = Color.parseColor(dark ? "#211c26" : "#fff8f1");
        if (viewport != null) viewport.setBackgroundColor(background);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        int visibility = dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (android.os.Build.VERSION.SDK_INT >= 26 && !dark) visibility |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        getWindow().getDecorView().setSystemUiVisibility(visibility);
    }

    private interface Operation { JSONObject run() throws Exception; }
    private String response(Operation operation) {
        try { return operation.run().toString(); }
        catch (Exception error) {
            String message = error instanceof IllegalArgumentException ? error.getMessage() : "Não foi possível concluir a operação. Tente novamente.";
            try { return new JSONObject().put("ok", false).put("error", message).toString(); }
            catch (Exception ignored) { return "{\"ok\":false,\"error\":\"Não foi possível salvar os dados.\"}"; }
        }
    }

    public final class NativeBridge {
        @JavascriptInterface public String load() { return response(() -> database.loadData().put("theme", theme())); }
        @JavascriptInterface public String saveWorkout(String json) { return response(() -> database.saveWorkout(new JSONObject(json))); }
        @JavascriptInterface public String deleteWorkout(long id) { return response(() -> database.deleteWorkout(id)); }
        @JavascriptInterface public String updateWeight(long exerciseId, double weight) { return response(() -> database.updateWeight(exerciseId, weight)); }
        @JavascriptInterface public String finishWorkout(String json) { return response(() -> database.finishWorkout(new JSONObject(json))); }
        @JavascriptInterface public String setTheme(String value) {
            return response(() -> {
                if (!"light".equals(value) && !"dark".equals(value)) throw new IllegalArgumentException("Tema inválido.");
                if (!preferences.edit().putString("theme", value).commit()) throw new IllegalStateException("Falha ao salvar preferência.");
                runOnUiThread(() -> applySystemTheme(value));
                return new JSONObject().put("ok", true);
            });
        }
    }

    @Override public void onBackPressed() {
        if (webView == null) { super.onBackPressed(); return; }
        webView.evaluateJavascript("(function(){return typeof window.peraBack==='function' ? !!window.peraBack() : false;})()", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("PeraGymNative");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        viewport = null;
        if (database != null) database.close();
        super.onDestroy();
    }
}
