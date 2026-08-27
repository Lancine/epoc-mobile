package ci.epro.geniia.technopedagogie.niveau1;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String HOST = "epro.local";
    private static final String BASE = "https://" + HOST + "/";
    private static final String HOME = "index.html";
    private static final String ACTIVATION = "activation.html";
    private WebView webView;
    private ProgressBar progress;
    private ActivationStore activation;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        activation = new ActivationStore(this);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xff123b33);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this);
        FrameLayout.LayoutParams p = new FrameLayout.LayoutParams(64, 64);
        p.gravity = Gravity.CENTER;
        root.addView(progress, p);
        setContentView(root);
        configure();
        if (state != null) webView.restoreState(state); else open(activation.isActivated() ? HOME : ACTIVATION);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configure() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(false);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false); s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setBuiltInZoomControls(true); s.setDisplayZoomControls(false); s.setSupportZoom(true);
        s.setLoadWithOverviewMode(true); s.setUseWideViewPort(true); s.setDefaultTextEncodingName("UTF-8");
        s.setMediaPlaybackRequiresUserGesture(true); s.setSaveFormData(false);
        s.setUserAgentString(s.getUserAgentString() + " EProAndroid/2.1.0");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(false);
        webView.addJavascriptInterface(new Bridge(), "AndroidActivation");
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView v, int value) {
                progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
            }
        });
    }

    private void open(String path) { runOnUiThread(() -> webView.loadUrl(BASE + path)); }

    @Override protected void onSaveInstanceState(Bundle out) { webView.saveState(out); super.onSaveInstanceState(out); }
    @Override public void onBackPressed() { if (webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() {
        if (webView != null) { webView.removeJavascriptInterface("AndroidActivation"); webView.stopLoading(); webView.destroy(); }
        super.onDestroy();
    }

    private final class Bridge {
        @JavascriptInterface public boolean isActivated() { return activation.isActivated(); }
        @JavascriptInterface public String getVersion() { return "2.1.0"; }
        @JavascriptInterface public void openHome() { if (activation.isActivated()) open(HOME); }
        @JavascriptInterface public String activate(String serial) {
            JSONObject result = new JSONObject();
            try {
                boolean ok = activation.activate(serial);
                result.put("ok", ok);
                result.put("message", ok ? "Activation réussie." : "Numéro de série non reconnu.");
            } catch (Exception error) {
                try { result.put("ok", false); result.put("message", "Activation impossible sur cet appareil."); }
                catch (Exception ignored) { return "{\"ok\":false}"; }
            }
            return result.toString();
        }
    }

    private final class Client extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            return isLocal(uri) ? asset(uri) : empty();
        }
        @SuppressWarnings("deprecation")
        @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return navigate(Uri.parse(url)); }
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return request.isForMainFrame() && navigate(request.getUrl());
        }
        private boolean navigate(Uri uri) {
            if (isLocal(uri)) {
                String path = path(uri);
                if (!activation.isActivated() && !ACTIVATION.equals(path)) { open(ACTIVATION); return true; }
                if (document(path)) { shareDocument(path); return true; }
                return false;
            }
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
            catch (Exception error) { toast("Aucune application ne peut ouvrir ce lien."); }
            return true;
        }
        @Override public void onPageStarted(WebView v, String url, Bitmap icon) { progress.setVisibility(View.VISIBLE); }
        @Override public void onPageFinished(WebView v, String url) {
            progress.setVisibility(View.GONE);
            if (url.endsWith("/" + ACTIVATION) && activation.isActivated()) open(HOME);
        }
        @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (r.isForMainFrame()) toast("Une ressource locale n’a pas pu être affichée.");
        }
    }

    private boolean isLocal(Uri uri) { return "https".equalsIgnoreCase(uri.getScheme()) && HOST.equalsIgnoreCase(uri.getHost()); }
    private WebResourceResponse asset(Uri uri) {
        String path = path(uri);
        try { return new WebResourceResponse(mime(path), text(path) ? "UTF-8" : null, getAssets().open("www/" + path)); }
        catch (Exception missing) {
            String html = "<!doctype html><html lang='fr'><meta charset='utf-8'><meta name='viewport' content='width=device-width'><body><h1>Ressource introuvable</h1><p>" + path.replace("<", "&lt;") + "</p></body></html>";
            return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        }
    }
    private WebResourceResponse empty() { return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0])); }
    private String path(Uri uri) {
        String value = Uri.decode(uri.getEncodedPath() == null ? "" : uri.getEncodedPath());
        while (value.startsWith("/")) value = value.substring(1);
        if (value.isEmpty()) value = HOME; else if (value.endsWith("/")) value += HOME;
        return value.contains("..") || value.contains("\\") ? "__invalid__" : value;
    }
    private boolean text(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        return p.endsWith(".html") || p.endsWith(".css") || p.endsWith(".js") || p.endsWith(".json") || p.endsWith(".svg") || p.endsWith(".txt") || p.endsWith(".xml") || p.endsWith(".md");
    }
    private boolean document(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        return p.endsWith(".pdf") || p.endsWith(".docx") || p.endsWith(".doc") || p.endsWith(".xlsx") || p.endsWith(".pptx");
    }
    private String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".pdf")) return "application/pdf";
        if (p.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        String guessed = URLConnection.guessContentTypeFromName(path);
        if (guessed != null) return guessed;
        String mapped = MimeTypeMap.getSingleton().getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(path));
        return mapped == null ? "application/octet-stream" : mapped;
    }
    private void shareDocument(String assetPath) {
        try {
            File dir = new File(getCacheDir(), "shared"); if (!dir.exists() && !dir.mkdirs()) throw new Exception();
            String name = new File(assetPath).getName(); File target = new File(dir, name);
            try (InputStream in = getAssets().open("www/" + assetPath); FileOutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[65536]; int count; while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            }
            Uri uri = new Uri.Builder().scheme("content").authority(getPackageName() + ".files").appendPath(name).build();
            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime(name))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException error) { toast("Installez une application compatible pour ouvrir ce document."); }
        catch (Exception error) { toast("Impossible d’ouvrir ce document."); }
    }
    private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_LONG).show(); }
}
