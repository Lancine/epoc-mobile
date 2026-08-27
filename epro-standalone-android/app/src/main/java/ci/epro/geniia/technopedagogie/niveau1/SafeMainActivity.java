package ci.epro.geniia.technopedagogie.niveau1;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

public final class SafeMainActivity extends Activity {
    static final String HOST = "epro.local";
    static final String BASE = "https://" + HOST + "/";
    static final String HOME = "index.html";
    static final String ACTIVATION = "activation.html";
    private static final String VERSION = "2.2.1";

    private FrameLayout root;
    private TextView status;
    private ProgressBar progress;
    private WebView webView;
    private ActivationStore activation;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        activation = new ActivationStore(this);
        createNativeLoadingScreen();
        createWebView(state);
    }

    private void createNativeLoadingScreen() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        setContentView(root);

        status = new TextView(this);
        status.setGravity(Gravity.CENTER);
        status.setBackgroundColor(Color.WHITE);
        status.setTextColor(0xff123b33);
        status.setTextSize(18f);
        status.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        status.setPadding(48, 48, 48, 48);
        status.setText("Chargement de la formation…");
        root.addView(status, fullScreen());

        progress = new ProgressBar(this);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(72, 72);
        params.gravity = Gravity.CENTER_HORIZONTAL | Gravity.BOTTOM;
        params.bottomMargin = 72;
        root.addView(progress, params);
    }

    private void createWebView(Bundle state) {
        try {
            webView = new WebView(this);
            webView.setBackgroundColor(Color.WHITE);
            webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
            root.addView(webView, 0, fullScreen());
            configureWebView();

            if (state != null && webView.restoreState(state) != null) {
                showLoading("Restauration de la formation…");
            } else {
                webView.post(() -> openLocal(activation.isActivated() ? HOME : ACTIVATION));
            }
        } catch (Throwable error) {
            showWebViewFailure();
        }
    }

    private FrameLayout.LayoutParams fullScreen() {
        return new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setDefaultTextEncodingName("UTF-8");
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSaveFormData(false);
        settings.setUserAgentString(settings.getUserAgentString() + " EProAndroid/" + VERSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        WebView.setWebContentsDebuggingEnabled(false);
        webView.addJavascriptInterface(new ActivationBridge(), "AndroidActivation");
        webView.setWebViewClient(new EproWebClient(this, activation));
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int value) {
                progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
            }
        });
    }

    void openLocal(String path) {
        if (webView == null) return;
        runOnUiThread(() -> {
            showLoading("Chargement de la formation…");
            webView.loadUrl(BASE + path);
        });
    }

    void showLoading(String message) {
        status.setText(message);
        status.setTextColor(0xff123b33);
        status.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
    }

    void showContent() {
        status.setVisibility(View.GONE);
        progress.setVisibility(View.GONE);
    }

    void showPageError() {
        progress.setVisibility(View.GONE);
        status.setTextColor(0xff9f1d20);
        status.setText(
                "La page locale n’a pas pu être affichée.\n\n" +
                "Fermez l’application, mettez à jour Android System WebView " +
                "ou Google Chrome, puis réessayez.");
        status.setVisibility(View.VISIBLE);
    }

    void handleRendererCrash(WebView failedView) {
        progress.setVisibility(View.GONE);
        try { root.removeView(failedView); } catch (Exception ignored) { }
        try { failedView.destroy(); } catch (Exception ignored) { }
        webView = null;
        status.setTextColor(0xff9f1d20);
        status.setText(
                "Le moteur d’affichage Android s’est arrêté.\n\n" +
                "Mettez à jour Android System WebView ou Google Chrome, " +
                "redémarrez le téléphone, puis relancez l’application.");
        status.setVisibility(View.VISIBLE);
    }

    private void showWebViewFailure() {
        progress.setVisibility(View.GONE);
        status.setTextColor(0xff9f1d20);
        status.setText(
                "Impossible d’initialiser l’affichage Android.\n\n" +
                "Mettez à jour Android System WebView ou Google Chrome, " +
                "redémarrez le téléphone, puis relancez l’application.");
        status.setVisibility(View.VISIBLE);
    }

    void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Toast.makeText(this, "Aucune application ne peut ouvrir ce lien.", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidActivation");
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private final class ActivationBridge {
        @JavascriptInterface public boolean isActivated() { return activation.isActivated(); }
        @JavascriptInterface public String getVersion() { return VERSION; }
        @JavascriptInterface public void openHome() { if (activation.isActivated()) openLocal(HOME); }

        @JavascriptInterface
        public String activate(String serial) {
            JSONObject result = new JSONObject();
            try {
                boolean ok = activation.activate(serial);
                result.put("ok", ok);
                result.put("message", ok ? "Activation réussie." : "Numéro de série non reconnu.");
            } catch (Exception error) {
                try {
                    result.put("ok", false);
                    result.put("message", "Activation impossible sur cet appareil.");
                } catch (Exception ignored) {
                    return "{\"ok\":false}";
                }
            }
            return result.toString();
        }
    }
}
