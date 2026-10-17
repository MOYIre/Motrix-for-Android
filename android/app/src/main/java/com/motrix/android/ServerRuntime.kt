package com.motrix.android

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import java.security.SecureRandom
import java.util.zip.ZipInputStream

/**
 * Owns the bundled Motrix server: where its files live, how it is configured,
 * and how it is started.
 *
 * Everything the server *executes* has to come from the native library
 * directory (Android refuses to exec anything under app-private storage), so
 * the interpreter, the aria2 engine and the finalize sidecar are staged as
 * `lib*.so` entries there. Everything it merely *reads* ships inside
 * `assets/runtime.zip` and is unpacked into app-private storage on first run.
 */
class ServerRuntime(private val context: Context) {

    private val nativeLibDir = File(context.applicationInfo.nativeLibraryDir)
    private val assetManager = context.assets

    val nodeBinary = File(nativeLibDir, "libnode.so")
    val aria2Binary = File(nativeLibDir, "libaria2c.so")
    val finalizeBinary = File(nativeLibDir, "libmotrix-finalize-fs.so")

    val runtimeDir = File(context.filesDir, "runtime")
    val dataDir = File(context.filesDir, "data")
    val tempDir = File(context.cacheDir, "tmp")

    /**
     * The server hard-fails at startup when its save directory is not writable,
     * so the public Download folder is only advertised once all-files access has
     * been granted; before that, downloads land in app-private storage.
     */
    val downloadsDir: File = pickDownloadsDir(context)

    /** Loopback port the server listens on; chosen once per process start. */
    val port: Int = findFreePort()

    /** Operator secret the server accepts for the control plane. */
    val operatorToken: String = loadOrCreateToken()

    private val markerFile = File(dataDir, "runtime-version")

    /**
     * Diagnostic log. It lives in the public Download folder so a failure can be
     * read without adb or root; the app-private copy is the fallback when
     * all-files access has not been granted yet.
     */
    val logFile: File
        get() {
            val publicLog = File(downloadsDir, LOG_FILE_NAME)
            return if (downloadsDir.isDirectory && downloadsDir.canWrite()) {
                publicLog
            } else {
                File(dataDir, LOG_FILE_NAME)
            }
        }

    private fun findFreePort(): Int = ServerSocket(0).use { it.localPort }

    private fun pickDownloadsDir(context: Context): File {
        val public = File("/storage/emulated/0/Download")
        val writable = runCatching {
            if (!public.isDirectory) {
                return@runCatching false
            }
            val probe = File(public, ".motrix-write-probe-${Process.myPid()}")
            val created = probe.createNewFile()
            if (created) probe.delete()
            created
        }.getOrDefault(false)
        return if (writable) public else File(context.filesDir, "downloads")
    }

    private fun loadOrCreateToken(): String {
        val file = File(dataDir, "operator-token")
        if (file.isFile) {
            val existing = file.readText().trim()
            if (TOKEN_PATTERN.matches(existing)) return existing
        }
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        val token = android.util.Base64.encodeToString(
            bytes,
            android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP
        )
        file.parentFile?.mkdirs()
        file.writeText(token)
        return token
    }

    /**
     * Unpack `assets/runtime.zip` whenever the packaged runtime differs from the
     * one already on disk. The marker holds the runtime manifest version so an
     * app update republishes the bundle without re-extracting on every launch.
     */
    fun ensureRuntimeExtracted() {
        val marker = runCatching { markerFile.readText().trim() }.getOrNull()
        val packaged = readAssetMarker()
        if (marker != null && packaged != null && marker == packaged && runtimeDir.isDirectory) {
            return
        }
        runtimeDir.deleteRecursively()
        runtimeDir.mkdirs()
        assetManager.open("runtime.zip").use { raw ->
            ZipInputStream(raw.buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val target = File(runtimeDir, entry.name)
                    if (!target.canonicalPath.startsWith(runtimeDir.canonicalPath)) {
                        throw IllegalStateException("unsafe archive entry: ${entry.name}")
                    }
                    if (entry.isDirectory) {
                        target.mkdirs()
                    } else {
                        target.parentFile?.mkdirs()
                        target.outputStream().use { zip.copyTo(it) }
                    }
                    zip.closeEntry()
                }
            }
        }
        markerFile.parentFile?.mkdirs()
        markerFile.writeText(packaged ?: "unknown")
    }

    private fun readAssetMarker(): String? = runCatching {
        assetManager.open(RUNTIME_VERSION_ASSET).bufferedReader().use { it.readText().trim() }
    }.getOrNull()

    /** Environment the server process starts with. */
    fun environment(): Map<String, String> = buildMap {
        put("MOTRIX_DATA_DIR", dataDir.absolutePath)
        put("MOTRIX_EXTRA_DIR", File(runtimeDir, "extra").absolutePath)
        put("MOTRIX_TEMP_DIR", tempDir.absolutePath)
        put("MOTRIX_ARIA2_BIN", aria2Binary.absolutePath)
        put("MOTRIX_FINALIZE_FS_BIN", finalizeBinary.absolutePath)
        put("MOTRIX_OPERATOR_TOKEN", operatorToken)
        put("MOTRIX_DEFAULT_SAVE_DIR", downloadsDir.absolutePath)
        put("PORT", port.toString())
        // Loopback only: the device already has a UI, and nothing else on the
        // LAN should be able to reach a download engine.
        put("HOST", "127.0.0.1")
        put("HOME", context.filesDir.absolutePath)
        put("TMPDIR", tempDir.absolutePath)
        put("LD_LIBRARY_PATH", nativeLibDir.absolutePath)
        put("NODE_ENV", "production")
    }

    fun startServer(): Process {
        tempDir.mkdirs()
        val builder = ProcessBuilder(nodeBinary.absolutePath, "dist/server/index.mjs")
            .directory(runtimeDir)
            .redirectErrorStream(true)
        builder.environment().putAll(environment())
        return builder.start()
    }

    /** Block until the HTTP control plane answers, or the process dies. */
    fun awaitReady(process: Process, timeoutMillis: Long = 120_000): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (System.currentTimeMillis() < deadline) {
            if (!process.isAlive) return false
            if (probeControlPlane()) return true
            Thread.sleep(250)
        }
        return false
    }

    private fun probeControlPlane(): Boolean {
        return runCatching {
            val connection = URL("http://127.0.0.1:$port/rpc/auth/status")
                .openConnection() as HttpURLConnection
            connection.connectTimeout = 1_000
            connection.readTimeout = 1_000
            connection.requestMethod = "GET"
            connection.setRequestProperty("x-motrix-web-origin", "http://127.0.0.1:$port")
            val code = connection.responseCode
            connection.disconnect()
            code in 200..499
        }.getOrDefault(false)
    }

    fun baseUrl(): String = "http://127.0.0.1:$port/"

    /** Append one diagnostic line, mirrored to logcat. Never throws. */
    @Synchronized
    fun appendLog(line: String) {
        Log.i(TAG, line)
        runCatching {
            val target = logFile
            target.parentFile?.mkdirs()
            if (target.length() > 512 * 1024) target.delete()
            target.appendText("${System.currentTimeMillis()} $line\n")
        }
    }

    /** Tail of the diagnostic log, for display in the failure state. */
    fun logTail(maxChars: Int = 4_000): String = runCatching {
        val target = logFile
        if (!target.isFile) return ""
        val text = target.readText()
        if (text.length <= maxChars) text else text.takeLast(maxChars)
    }.getOrDefault("")

    companion object {
        private const val TAG = "MotrixRuntime"
        private const val LOG_FILE_NAME = "motrix-android.log"
        private const val RUNTIME_VERSION_ASSET = "runtime-version.txt"
        private val TOKEN_PATTERN = Regex("^[A-Za-z0-9_-]{43,128}$")

        fun log(line: String) {
            Log.i(TAG, line)
        }
    }
}
