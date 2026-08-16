package org.sozvon.app

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Routes call audio to the loudspeaker (or a connected headset) instead of the
 * phone earpiece.
 *
 * A WebView running a WebRTC call makes Android treat the app like a phone
 * call: the audio mode becomes MODE_IN_COMMUNICATION, and in that mode the
 * system sends sound to the tiny earpiece you hold to your ear -- the wrong
 * place for a hands-free video call.  While a call is active we force the
 * built-in speaker, but defer to a wired / USB / Bluetooth / hearing-aid
 * headset when one is connected, and re-evaluate whenever headsets are plugged
 * in or pulled out mid-call.
 *
 * The web client signals call activity through the SozvonApp.setInCall() bridge
 * (a no-op in a normal browser); everything here is best-effort and never
 * throws into the call.
 */
class AudioRouter(context: Context) {
    private val audioManager =
        context.applicationContext.getSystemService(Context.AUDIO_SERVICE)
            as AudioManager
    private val handler = Handler(Looper.getMainLooper())

    private var active = false

    // Legacy (API < 31) state captured on enter() and restored on exit().
    private var savedSpeakerphoneOn = false

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) {
            if (active) apply()
        }

        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) {
            if (active) apply()
        }
    }

    /**
     * Mark a call as active or inactive.  Idempotent: repeated calls with the
     * same value do nothing, so it is safe to drive from a UI-refresh hook.
     */
    fun setActive(on: Boolean) {
        if (on == active)
            return
        active = on
        if (on) enter() else exit()
    }

    private fun enter() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            @Suppress("DEPRECATION")
            savedSpeakerphoneOn = audioManager.isSpeakerphoneOn
        }
        try {
            audioManager.registerAudioDeviceCallback(deviceCallback, handler)
        } catch (e: Exception) {
            // ignore: we just lose live re-routing on headset changes
        }
        apply()
    }

    private fun exit() {
        try {
            audioManager.unregisterAudioDeviceCallback(deviceCallback)
        } catch (e: Exception) {
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                audioManager.clearCommunicationDevice()
            } catch (e: Exception) {
            }
        } else {
            try {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = savedSpeakerphoneOn
            } catch (e: Exception) {
            }
        }
    }

    /** Pick the best output for a hands-free call and route to it. */
    private fun apply() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = audioManager.availableCommunicationDevices
            // A headset, if present, wins over the speaker; the earpiece never
            // does.
            val target = devices.firstOrNull { isHeadset(it.type) }
                ?: devices.firstOrNull {
                    it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                }
            if (target != null) {
                try {
                    audioManager.setCommunicationDevice(target)
                } catch (e: Exception) {
                }
            }
        } else {
            // Pre-12: speakerphone unless a headset is connected.  Only takes
            // effect once the call puts us in MODE_IN_COMMUNICATION, which the
            // WebView does itself when media starts flowing.
            try {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = !hasHeadsetLegacy()
            } catch (e: Exception) {
            }
        }
    }

    private fun isHeadset(type: Int): Boolean = when (type) {
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_HEARING_AID -> true
        else -> false
    }

    private fun hasHeadsetLegacy(): Boolean {
        val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        return devices.any { isHeadset(it.type) || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP }
    }
}
