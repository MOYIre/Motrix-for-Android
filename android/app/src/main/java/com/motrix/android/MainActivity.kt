package com.motrix.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.app.Activity
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView

/**
 * Single-activity shell: a WebView pointed at the loopback server the
 * foreground service runs.
 *
 * Because the WebView loads the server's own origin, the renderer's existing
 * same-origin cookie session, WebSocket event stream and RPC transport all work
 * unchanged — the shell only has to unlock the control plane once with the
 * operator token it provisioned for the server.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var status: TextView
    private var loadedOrigin: String? = null
    private var loginAttempted = false

    private val stateListener: (ServerState.Snapshot) -> Unit = { snapshot ->
        runOnUiThread { render(snapshot) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        RequestNotificationPermissionIfNeeded()
        buildUi()
        ServerService.start(this)
        ServerState.observe(stateListener)
    }

    private fun buildUi() {
        val container = FrameLayout(this)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setSupportZoom(false)
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            CookieManager.getInstance().setAcceptCookie(true)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val target = request.url
                    val isLoopback = target.host == "127.0.0.1" || target.host == "localhost"
                    if (!isLoopback) {
                        // External links open in the system browser instead of
                        // replacing the app's own UI.
                        runCatching {
                            startActivity(Intent(Intent.ACTION_VIEW, target))
                        }
                        return true
                    }
                    return false
                }

                override fun onPageFinished(view: WebView, url: String) {
                    maybeUnlockControlPlane(view, url)
                }
            }
        }
        container.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        status = TextView(this).apply {
            text = getString(R.string.startup_message)
            // Failure diagnostics are a log tail: keep it small, monospaced and
            // scrollable so the cause is readable on screen.
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            movementMethod = android.text.method.ScrollingMovementMethod()
            verticalScrollBarEnabled = true
        }
        container.addView(
            status,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        )
        setContentView(container)
    }

    private fun render(snapshot: ServerState.Snapshot) {
        when (snapshot.state) {
            ServerState.State.READY -> {
                val origin = snapshot.baseUrl ?: return
                status.visibility = View.GONE
                if (loadedOrigin != origin) {
                    loadedOrigin = origin
                    loginAttempted = false
                    webView.loadUrl(origin)
                }
            }
            ServerState.State.FAILED -> {
                status.visibility = View.VISIBLE
                status.text = buildString {
                    append(getString(R.string.startup_failed))
                    snapshot.detail?.takeIf { it.isNotBlank() }?.let { tail ->
                        append("\n\n")
                        append(tail)
                    }
                }
            }
            else -> {
                status.visibility = View.VISIBLE
                status.text = getString(R.string.startup_message)
            }
        }
    }

    /**
     * The server mints an operator token for its control plane; the shell holds
     * the same secret, so it proves possession once and reloads into the
     * unlocked UI.
     */
    private fun maybeUnlockControlPlane(view: WebView, url: String) {
        val token = ServerState.snapshot().operatorToken ?: return
        if (loginAttempted) return
        loginAttempted = true
        val script = """
            (async () => {
              try {
                await fetch('/rpc/auth/login', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'x-motrix-web-origin': location.origin },
                  credentials: 'same-origin',
                  body: JSON.stringify({ token: ${quote(token)} })
                });
              } catch (error) { /* the gate stays visible; the user can retry */ }
              const status = await fetch('/rpc/auth/status', { credentials: 'same-origin' })
                .then((response) => response.json())
                .catch(() => ({ authed: false }));
              if (!status.authed) window.location.reload();
            })();
        """.trimIndent()
        view.evaluateJavascript(script, null)
        // Give the login round-trip a moment, then refresh so the SPA boots
        // against the authenticated session.
        view.postDelayed({
            if (view.url?.startsWith(url) == true) view.reload()
        }, 1_500)
    }

    private fun quote(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun RequestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        runCatching {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 10)
        }.onFailure { Log.w(TAG, "notification permission request failed", it) }
    }

    private fun requestAllFilesAccessIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        if (Environment.isExternalStorageManager()) return
        runCatching {
            startActivity(
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.parse("package:$packageName")
                }
            )
        }.onFailure { Log.w(TAG, "all-files access intent failed", it) }
    }

    override fun onResume() {
        super.onResume()
        requestAllFilesAccessIfNeeded()
    }

    override fun onDestroy() {
        ServerState.removeObserver(stateListener)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MotrixMain"
    }
}
