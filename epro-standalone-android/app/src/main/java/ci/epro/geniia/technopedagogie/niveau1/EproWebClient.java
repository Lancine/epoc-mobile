package ci.epro.geniia.technopedagogie.niveau1;

import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

final class EproWebClient extends WebViewClient {
    private final SafeMainActivity activity;
    private final ActivationStore activation;

    EproWebClient(SafeMainActivity activity, ActivationStore activation) {
        this.activity = activity;
        this.activation = activation;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        return isLocal(uri) ? assetResponse(uri) : emptyResponse();
    }

    @SuppressWarnings("deprecation")
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return navigate(Uri.parse(url));
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return request.isForMainFrame() && navigate(request.getUrl());
    }

    private boolean navigate(Uri uri) {
        if (isLocal(uri)) {
            String path = assetPath(uri);
            if (!activation.isActivated() && !SafeMainActivity.ACTIVATION.equals(path)) {
                activity.openLocal(SafeMainActivity.ACTIVATION);
                return true;
            }
            return false;
        }
        activity.openExternal(uri);
        return true;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap icon) {
        activity.showLoading("Chargement de la formation…");
    }

    @Override
    public void onPageCommitVisible(WebView view, String url) {
        activity.showContent();
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        activity.showContent();
        if (url.endsWith("/" + SafeMainActivity.ACTIVATION) && activation.isActivated()) {
            activity.openLocal(SafeMainActivity.HOME);
        }
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) activity.showPageError();
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        activity.handleRendererCrash(view);
        return true;
    }

    private boolean isLocal(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
                && SafeMainActivity.HOST.equalsIgnoreCase(uri.getHost());
    }

    private WebResourceResponse assetResponse(Uri uri) {
        String path = assetPath(uri);
        try {
            return new WebResourceResponse(
                    mime(path), isText(path) ? "UTF-8" : null,
                    activity.getAssets().open("www/" + path));
        } catch (Exception missing) {
            String html = "<!doctype html><html lang='fr'><meta charset='utf-8'>" +
                    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
                    "<body style='font-family:sans-serif;padding:24px;color:#123b33'>" +
                    "<h1>Ressource introuvable</h1><p>" + escape(path) + "</p></body></html>";
            return new WebResourceResponse(
                    "text/html", "UTF-8",
                    new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        }
    }

    private WebResourceResponse emptyResponse() {
        return new WebResourceResponse(
                "text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
    }

    private String assetPath(Uri uri) {
        String path = Uri.decode(uri.getEncodedPath() == null ? "" : uri.getEncodedPath());
        while (path.startsWith("/")) path = path.substring(1);
        if (path.isEmpty()) path = SafeMainActivity.HOME;
        else if (path.endsWith("/")) path += SafeMainActivity.HOME;
        return path.contains("..") || path.contains("\\") ? "__invalid__" : path;
    }

    private boolean isText(String path) {
        String value = path.toLowerCase(Locale.ROOT);
        return value.endsWith(".html") || value.endsWith(".css") || value.endsWith(".js")
                || value.endsWith(".json") || value.endsWith(".svg")
                || value.endsWith(".txt") || value.endsWith(".xml")
                || value.endsWith(".md");
    }

    private String mime(String path) {
        String value = path.toLowerCase(Locale.ROOT);
        if (value.endsWith(".js")) return "application/javascript";
        if (value.endsWith(".css")) return "text/css";
        if (value.endsWith(".json")) return "application/json";
        if (value.endsWith(".svg")) return "image/svg+xml";
        if (value.endsWith(".pdf")) return "application/pdf";
        if (value.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        String guessed = URLConnection.guessContentTypeFromName(path);
        if (guessed != null) return guessed;
        String mapped = MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                MimeTypeMap.getFileExtensionFromUrl(path));
        return mapped == null ? "application/octet-stream" : mapped;
    }

    private String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
