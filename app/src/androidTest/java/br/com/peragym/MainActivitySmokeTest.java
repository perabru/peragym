package br.com.peragym;

import android.os.SystemClock;
import android.test.ActivityInstrumentationTestCase2;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Read-only integration check of the packaged page, Android WebView and real SQLite bridge. */
public final class MainActivitySmokeTest extends ActivityInstrumentationTestCase2<MainActivity> {
    public MainActivitySmokeTest() { super(MainActivity.class); }

    public void testBundledPageRendersWithCspAndNativeReadBridge() throws Exception {
        MainActivity activity = getActivity();
        assertNotNull("The launcher Activity must start", activity);
        AtomicReference<WebView> found = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> found.set(findWebView(activity.getWindow().getDecorView())));
        WebView webView = found.get();
        assertNotNull("The Activity must contain its local WebView", webView);

        // This probes the real bridge directly. It never calls a mutation, changes a theme,
        // or creates/deletes a workout. Test databases are managed by GymDatabaseTest separately.
        final String probe = "(function(){try {"
                + "var app=document.querySelector('#app');"
                + "var heading=document.querySelector('#main h1');"
                + "var csp=document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]');"
                + "var policy=csp ? csp.content : '';"
                + "var available=typeof window.PeraGymNative==='object' && typeof window.PeraGymNative.load==='function';"
                + "var data=available ? JSON.parse(window.PeraGymNative.load()) : {};"
                + "return {localUrl:location.href==='file:///android_asset/index.html',"
                + "appVisible:!!app && !app.hidden,"
                + "hasHeading:!!heading && heading.textContent.trim().length>0,"
                + "noError:!document.querySelector('.error-panel'),"
                + "styleLoaded:document.styleSheets.length>0,"
                + "cspPresent:policy.indexOf(\"script-src 'self' file:\")>=0 && policy.indexOf(\"connect-src 'none'\")>=0,"
                + "bridgeAvailable:available,"
                + "dataShape:data.ok===true && Array.isArray(data.workouts) && Array.isArray(data.sessions) && (data.theme==='light'||data.theme==='dark')};"
                + "} catch(e) {return {probeFailed:true};}})()";

        long deadline = SystemClock.uptimeMillis() + 15000;
        JSONObject status = new JSONObject();
        while (SystemClock.uptimeMillis() < deadline) {
            status = evaluate(webView, probe);
            if (status.optBoolean("appVisible") && status.optBoolean("hasHeading") && status.optBoolean("dataShape")) break;
            SystemClock.sleep(150); // The instrumentation test thread sleeps; the UI thread stays free.
        }
        assertTrue("Only the bundled application page should be loaded: " + status, status.optBoolean("localUrl"));
        assertTrue("Loading should finish and reveal the app within 15 seconds: " + status, status.optBoolean("appVisible"));
        assertTrue("The external app.js should render a real main heading: " + status, status.optBoolean("hasHeading"));
        assertTrue("Initialization should not show its error panel: " + status, status.optBoolean("noError"));
        assertTrue("The packaged style.css should load: " + status, status.optBoolean("styleLoaded"));
        assertTrue("The page should retain its restrictive content security policy: " + status, status.optBoolean("cspPresent"));
        assertTrue("The JavaScript should have the native Android bridge: " + status, status.optBoolean("bridgeAvailable"));
        assertTrue("The real native read must return the expected data shape: " + status, status.optBoolean("dataShape"));
    }

    private JSONObject evaluate(WebView webView, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        getInstrumentation().runOnMainSync(() -> webView.evaluateJavascript(script, value -> {
            result.set(value);
            completed.countDown();
        }));
        assertTrue("WebView evaluation should complete without blocking the UI thread", completed.await(3, TimeUnit.SECONDS));
        String json = result.get();
        return json != null && json.startsWith("{") ? new JSONObject(json) : new JSONObject();
    }

    private WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView result = findWebView(group.getChildAt(i));
                if (result != null) return result;
            }
        }
        return null;
    }
}
