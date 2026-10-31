# Preserve the trusted local JavaScript bridge if minification is enabled later.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
