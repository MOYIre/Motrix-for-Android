package com.motrix.android

/**
 * Observable server lifecycle shared between the service and the WebView shell.
 *
 * The service starts the engine in the background while the activity may still
 * be creating its WebView; this holder lets the activity observe readiness
 * without polling. A plain callback keeps the module free of third-party
 * dependencies.
 */
object ServerState {

    enum class State { IDLE, STARTING, READY, FAILED, STOPPED }

    data class Snapshot(
        val state: State,
        val baseUrl: String?,
        val operatorToken: String?
    )

    @Volatile
    private var current = Snapshot(State.IDLE, null, null)

    private val listeners = LinkedHashSet<(Snapshot) -> Unit>()

    fun snapshot(): Snapshot = current

    @Synchronized
    fun observe(listener: (Snapshot) -> Unit) {
        listeners.add(listener)
        listener(current)
    }

    @Synchronized
    fun removeObserver(listener: (Snapshot) -> Unit) {
        listeners.remove(listener)
    }

    @Synchronized
    fun publish(state: State, baseUrl: String?, operatorToken: String?) {
        current = Snapshot(state, baseUrl, operatorToken)
        val value = current
        listeners.toList().forEach { it(value) }
    }
}
