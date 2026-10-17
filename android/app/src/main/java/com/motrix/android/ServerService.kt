package com.motrix.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service that owns the Motrix server process.
 *
 * Android kills background processes aggressively, and the engine must keep
 * running while the user is elsewhere (or the screen is off), so the server
 * lives inside a `dataSync` foreground service.
 */
class ServerService : Service() {

    private var runtime: ServerRuntime? = null
    private var process: Process? = null
    private val starting = AtomicBoolean(false)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        if (process == null && starting.compareAndSet(false, true)) {
            Thread { launchServer() }.start()
        }
        return START_STICKY
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun launchServer() {
        val runtime = ServerRuntime(applicationContext)
        this.runtime = runtime
        try {
            runtime.appendLog("service start: abi=${Build.SUPPORTED_ABIS.firstOrNull()} api=${Build.VERSION.SDK_INT}")
            runtime.appendLog("node=${runtime.nodeBinary.absolutePath} exists=${runtime.nodeBinary.isFile}")
            runtime.appendLog("aria2=${runtime.aria2Binary.absolutePath} exists=${runtime.aria2Binary.isFile}")
            runtime.appendLog("finalize=${runtime.finalizeBinary.absolutePath} exists=${runtime.finalizeBinary.isFile}")
            runtime.appendLog("runtimeDir=${runtime.runtimeDir.absolutePath}")
            runtime.ensureRuntimeExtracted()
            runtime.appendLog("runtime extracted, starting node on port ${runtime.port}")
            val running = runtime.startServer()
            process = running
            pumpLogs(runtime, running)
            if (runtime.awaitReady(running)) {
                runtime.appendLog("server ready at ${runtime.baseUrl()}")
                ServerState.publish(
                    ServerState.State.READY,
                    runtime.baseUrl(),
                    runtime.operatorToken
                )
            } else {
                runtime.appendLog("server did not become ready (exit=${exitCode(running)})")
                ServerState.publish(
                    ServerState.State.FAILED,
                    null,
                    null,
                    runtime.logTail()
                )
            }
        } catch (error: Throwable) {
            runtime.appendLog("failed to start the bundled server: $error")
            runtime.appendLog(error.stackTraceToString())
            ServerState.publish(
                ServerState.State.FAILED,
                null,
                null,
                runtime.logTail()
            )
        } finally {
            starting.set(false)
        }
    }

    private fun exitCode(running: Process): String =
        runCatching { running.exitValue().toString() }.getOrDefault("running")

    private fun pumpLogs(runtime: ServerRuntime, running: Process) {
        Thread {
            runCatching {
                BufferedReader(InputStreamReader(running.inputStream)).useLines { lines ->
                    lines.forEach { runtime.appendLog(it) }
                }
            }
        }.apply { isDaemon = true }.start()
    }

    override fun onDestroy() {
        ServerRuntime.log("service destroyed, stopping server")
        process?.destroy()
        process = null
        ServerState.publish(ServerState.State.STOPPED, null, null)
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val intent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(intent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        )
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "motrix-server"
        private const val NOTIFICATION_ID = 1

        fun start(context: android.content.Context) {
            val intent = Intent(context, ServerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
